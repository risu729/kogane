import { DurableObject } from "cloudflare:workers";
import {
  afterMaintenance,
  nextNominal,
  type SchedulePattern,
} from "../../../packages/collection/src/schedule-model";
import { alarmClaimWrite } from "../../../packages/application/src/index.ts";
import { isLeaseAbortCode } from "../../../packages/collection/src/schedule-result";
import { collectorBindingName } from "./collector-binding";
import {
  jobFor,
  readSchedule,
  maintenanceForSchedule,
  bootstrapSchedules,
  expireStaleLeases,
} from "./schedule-store";
interface DispatchResult {
  status: "completed" | "failed";
  runIds: string[];
  failureCode: string | null;
}
/**
 * Closed classes of a thrown error. Only the class and the error's `name` are
 * logged: a collector's error message may carry provider text.
 */
type AlarmErrorKind =
  | "network_lost"
  | "object_reset"
  | "timeout"
  | "limit_exceeded"
  | "overloaded"
  | "d1"
  | "other";
export function alarmErrorKind(error: unknown): AlarmErrorKind {
  let message: string;
  try {
    message = error instanceof Error ? String(error.message) : String(error);
  } catch {
    // A value that cannot be turned into text (no prototype, a throwing getter).
    return "other";
  }
  if (/network connection lost/iu.test(message)) return "network_lost";
  if (
    /blockConcurrencyWhile|durable object (?:was )?reset|code was updated|object.*broken/iu.test(
      message,
    )
  )
    return "object_reset";
  if (/timed? ?out/iu.test(message)) return "timeout";
  if (/exceeded/iu.test(message)) return "limit_exceeded";
  if (/overloaded/iu.test(message)) return "overloaded";
  if (/D1_|SQLITE/u.test(message)) return "d1";
  return "other";
}
function errorName(error: unknown): string {
  try {
    const name: unknown = error instanceof Error ? error.name : typeof error;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? name : "other";
  } catch {
    return "other";
  }
}
/**
 * One structured line per alarm decision (ADR 0085 follow-up): which job,
 * which occurrence, and what the alarm did with it. Identifiers, instants and
 * closed codes only.
 */
function logAlarm(record: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(record));
  } catch {
    /* Logging never changes the alarm's outcome. */
  }
}
/** Where an alarm was when it threw, so a lost bookkeeping step is named. */
type AlarmPhase = "load" | "plan" | "claim" | "dispatch" | "record";
export class ScheduleAlarm extends DurableObject<Env> {
  async alarmTime(): Promise<string | null> {
    const value = await this.ctx.storage.getAlarm();
    return value === null ? null : new Date(value).toISOString();
  }
  async reconcile(id: string): Promise<string | null> {
    jobFor(id);
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put("job", id);
      const row = await readSchedule(this.env.DB, id);
      if (!row.enabled || !row.next_nominal_at) {
        await this.ctx.storage.deleteAlarm();
        return null;
      }
      const due = afterMaintenance(
        Date.parse(row.next_nominal_at),
        await maintenanceForSchedule(this.env.DB, row),
      );
      // Don't move an overdue reservation backward across a currently active maintenance.
      const actual = afterMaintenance(
        Math.max(due, Date.now()),
        await maintenanceForSchedule(this.env.DB, row),
      );
      await this.ctx.storage.setAlarm(actual);
      await this.env.DB.prepare(
        "UPDATE collection_schedules SET next_run_at=? WHERE id=? AND revision=? AND next_nominal_at=?",
      )
        .bind(new Date(actual).toISOString(), id, row.revision, row.next_nominal_at)
        .run();
      return new Date(actual).toISOString();
    });
  }
  override async alarm(): Promise<void> {
    const trace: { jobId: string | null; occurrenceId: string | null; phase: AlarmPhase } = {
      jobId: null,
      occurrenceId: null,
      phase: "load",
    };
    try {
      await this.performAlarm(trace);
    } catch (error) {
      // Logged first: a reset object can refuse the re-arm below as well.
      // The log never stands between the failure and the re-arm.
      try {
        console.error(
          JSON.stringify({
            event: "schedule_bookkeeping_retry",
            code: "scheduling_unavailable",
            jobId: trace.jobId,
            occurrenceId: trace.occurrenceId,
            phase: trace.phase,
            errorName: errorName(error),
            errorKind: alarmErrorKind(error),
          }),
        );
      } catch {
        /* Logging never changes the alarm's outcome. */
      }
      // D1 or dispatch bookkeeping can be unavailable longer than native
      // alarm retries. Re-arm recovery explicitly; the persisted occurrence
      // claim and next nominal prevent a repeated provider submission.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }
  private async performAlarm(trace: {
    jobId: string | null;
    occurrenceId: string | null;
    phase: AlarmPhase;
  }): Promise<void> {
    const id = await this.ctx.storage.get<string>("job");
    if (!id) {
      logAlarm({ event: "schedule_alarm", outcome: "no_job" });
      return;
    }
    trace.jobId = id;
    const pending = await this.ctx.blockConcurrencyWhile(async () => {
      const row = await readSchedule(this.env.DB, id);
      trace.phase = "plan";
      if (!row.enabled || !row.next_nominal_at) {
        await this.ctx.storage.deleteAlarm();
        logAlarm({ event: "schedule_alarm", jobId: id, outcome: "disabled" });
        return null;
      }
      const rules = await maintenanceForSchedule(this.env.DB, row),
        now = Date.now();
      const due = afterMaintenance(
        Math.max(Date.parse(row.next_run_at ?? row.next_nominal_at), now),
        rules,
      );
      if (due > now) {
        await this.ctx.storage.setAlarm(due);
        await this.env.DB.prepare(
          "UPDATE collection_schedules SET next_run_at=? WHERE id=? AND revision=? AND next_nominal_at=?",
        )
          .bind(new Date(due).toISOString(), id, row.revision, row.next_nominal_at)
          .run();
        logAlarm({
          event: "schedule_alarm",
          jobId: id,
          outcome: "deferred",
          nominalAt: row.next_nominal_at,
          runAt: row.next_run_at,
          dueAt: new Date(due).toISOString(),
        });
        return null;
      }
      const nominal = Date.parse(row.next_nominal_at);
      if (nominal > now) {
        await this.ctx.storage.setAlarm(nominal);
        logAlarm({
          event: "schedule_alarm",
          jobId: id,
          outcome: "early",
          nominalAt: row.next_nominal_at,
        });
        return null;
      }
      const next = nextNominal(JSON.parse(row.pattern_json) as SchedulePattern, row.timezone, now),
        nextDue = afterMaintenance(next, rules);
      // Reserve the next occurrence BEFORE claiming or contacting the provider.
      await this.ctx.storage.setAlarm(nextDue);
      const occurrenceId = `scheduled:${id}:${nominal}`;
      trace.occurrenceId = occurrenceId;
      trace.phase = "claim";
      const job = jobFor(id);
      const claimedAt = new Date(now).toISOString();
      // A collection occurrence's claim carries its audit record as the last
      // statement of the claim batch, joined to the occurrence row it wrote
      // (ADR 0064, plan slice S7). The processor tick and keepalive record none.
      const audit =
        job.kind === "collection"
          ? alarmClaimWrite(
              {
                jobId: id,
                source: job.source,
                occurrenceId,
                scheduleRevision: row.revision,
                claimedAt,
              },
              crypto.randomUUID(),
            )
          : null;
      const results = await this.env.DB.batch([
        this.env.DB.prepare(`INSERT OR IGNORE INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status)
          SELECT ?,id,next_nominal_at,?,'started' FROM collection_schedules WHERE id=? AND revision=? AND enabled=1 AND next_nominal_at=?`).bind(
          occurrenceId,
          claimedAt,
          id,
          row.revision,
          row.next_nominal_at,
        ),
        this.env.DB.prepare(
          "UPDATE collection_schedules SET next_nominal_at=?,next_run_at=? WHERE id=? AND revision=? AND next_nominal_at=?",
        ).bind(
          new Date(next).toISOString(),
          new Date(nextDue).toISOString(),
          id,
          row.revision,
          row.next_nominal_at,
        ),
        ...(audit ? [this.env.DB.prepare(audit.sql).bind(...audit.binds)] : []),
      ]);
      if (results[0]?.meta.changes !== 1) {
        await this.env.DB.prepare(
          "UPDATE collection_schedule_occurrences SET status='uncertain',failure_code='dispatch_uncertain',finished_at=? WHERE id=? AND status='started'",
        )
          .bind(new Date(now).toISOString(), occurrenceId)
          .run();
        logAlarm({
          event: "schedule_alarm",
          jobId: id,
          occurrenceId,
          outcome: "claim_conflict",
          scheduleRevision: row.revision,
        });
        return null;
      }
      logAlarm({
        event: "schedule_alarm",
        jobId: id,
        occurrenceId,
        outcome: "claimed",
        nominalAt: row.next_nominal_at,
        lagMs: now - nominal,
        claimMs: Date.now() - now,
        nextDueAt: new Date(nextDue).toISOString(),
      });
      return { job: jobFor(id), nominal, occurrenceId };
    });
    if (!pending) return;
    trace.phase = "dispatch";
    const dispatchStarted = Date.now();
    // Written before the call, so a log that has this line and no result
    // below shows the alarm stopped while the collector call was open.
    logAlarm({
      event: "schedule_dispatch_start",
      jobId: id,
      occurrenceId: pending.occurrenceId,
      target: pending.job.kind === "processor" ? "processor" : pending.job.workspace,
    });
    let result: DispatchResult;
    let thrown: unknown = null;
    try {
      if (pending.job.kind === "processor") {
        // The idempotent processor also repairs reservations whose configuration
        // was saved while another object's RPC was unavailable.
        await this.ctx.exports.ScheduledPipeline.runTick();
        // Only this alarm frees silent leases: each release is recorded with
        // `alarm:processor-tick` as its principal (ADR 0085). It runs before
        // the reservation repair, so a failing reconcile cannot keep a silent
        // lease held.
        await expireStaleLeases(this.env.DB);
        await bootstrapSchedules(this.env);
        result = { status: "completed", runIds: [], failureCode: null };
      } else {
        const binding = collectorBindingName(pending.job.workspace!) as keyof Env;
        const target = this.env[binding] as unknown as {
          runScheduled(cron: string, time: number): Promise<DispatchResult>;
        };
        result = await target.runScheduled(pending.job.cron!, pending.nominal);
      }
    } catch (error) {
      thrown = error;
      result = { status: "failed", runIds: [], failureCode: "dispatch_uncertain" };
    }
    logAlarm({
      event: "schedule_dispatch_result",
      jobId: id,
      occurrenceId: pending.occurrenceId,
      status: result.status,
      failureCode: result.failureCode,
      runCount: Array.isArray(result.runIds) ? result.runIds.length : 0,
      durationMs: Date.now() - dispatchStarted,
      ...(thrown === null
        ? {}
        : { errorName: errorName(thrown), errorKind: alarmErrorKind(thrown) }),
    });
    trace.phase = "record";
    // Never throw a provider uncertainty back into an automatic login retry.
    await this.env.DB.prepare(
      "UPDATE collection_schedule_occurrences SET status=?,run_ids_json=?,failure_code=?,finished_at=? WHERE id=? AND status='started'",
    )
      .bind(
        // A lost dispatch answer, or a holder that stopped itself after it may
        // have contacted the provider (ADR 0085): uncertain, never replayed.
        result.failureCode === "dispatch_uncertain" || isLeaseAbortCode(result.failureCode)
          ? "uncertain"
          : result.status,
        JSON.stringify(result.runIds),
        result.failureCode,
        new Date().toISOString(),
        pending.occurrenceId,
      )
      .run();
  }
}
