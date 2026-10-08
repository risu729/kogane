import { DurableObject } from "cloudflare:workers";
import {
  afterMaintenance,
  nextNominal,
  type SchedulePattern,
} from "../../../packages/collection/src/schedule-model";
import { collectorBindingName } from "./collector-binding";
import { jobFor, readSchedule, maintenanceForSchedule, bootstrapSchedules } from "./schedule-store";
interface DispatchResult {
  status: "completed" | "failed";
  runIds: string[];
  failureCode: string | null;
}
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
    try {
      await this.performAlarm();
    } catch {
      // D1 or dispatch bookkeeping can be unavailable longer than native
      // alarm retries. Re-arm recovery explicitly; the persisted occurrence
      // claim and next nominal prevent a repeated provider submission.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      console.error(
        JSON.stringify({ event: "schedule_bookkeeping_retry", code: "scheduling_unavailable" }),
      );
    }
  }
  private async performAlarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>("job");
    if (!id) return;
    const pending = await this.ctx.blockConcurrencyWhile(async () => {
      const row = await readSchedule(this.env.DB, id);
      if (!row.enabled || !row.next_nominal_at) {
        await this.ctx.storage.deleteAlarm();
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
        return null;
      }
      const nominal = Date.parse(row.next_nominal_at);
      if (nominal > now) {
        await this.ctx.storage.setAlarm(nominal);
        return null;
      }
      const next = nextNominal(JSON.parse(row.pattern_json) as SchedulePattern, row.timezone, now),
        nextDue = afterMaintenance(next, rules);
      // Reserve the next occurrence BEFORE claiming or contacting the provider.
      await this.ctx.storage.setAlarm(nextDue);
      const occurrenceId = `scheduled:${id}:${nominal}`;
      const results = await this.env.DB.batch([
        this.env.DB.prepare(`INSERT OR IGNORE INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status)
          SELECT ?,id,next_nominal_at,?,'started' FROM collection_schedules WHERE id=? AND revision=? AND enabled=1 AND next_nominal_at=?`).bind(
          occurrenceId,
          new Date(now).toISOString(),
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
      ]);
      if (results[0]?.meta.changes !== 1) {
        await this.env.DB.prepare(
          "UPDATE collection_schedule_occurrences SET status='uncertain',failure_code='dispatch_uncertain',finished_at=? WHERE id=? AND status='started'",
        )
          .bind(new Date(now).toISOString(), occurrenceId)
          .run();
        return null;
      }
      return { job: jobFor(id), nominal, occurrenceId };
    });
    if (!pending) return;
    let result: DispatchResult;
    try {
      if (pending.job.kind === "processor") {
        // The idempotent processor also repairs reservations whose configuration
        // was saved while another object's RPC was unavailable.
        await this.ctx.exports.ScheduledPipeline.runTick();
        await bootstrapSchedules(this.env);
        result = { status: "completed", runIds: [], failureCode: null };
      } else {
        const binding = collectorBindingName(pending.job.workspace!) as keyof Env;
        const target = this.env[binding] as unknown as {
          runScheduled(cron: string, time: number): Promise<DispatchResult>;
        };
        result = await target.runScheduled(pending.job.cron!, pending.nominal);
      }
    } catch {
      result = { status: "failed", runIds: [], failureCode: "dispatch_uncertain" };
    }
    // Never throw a provider uncertainty back into an automatic login retry.
    await this.env.DB.prepare(
      "UPDATE collection_schedule_occurrences SET status=?,run_ids_json=?,failure_code=?,finished_at=? WHERE id=? AND status='started'",
    )
      .bind(
        result.failureCode === "dispatch_uncertain" ? "uncertain" : result.status,
        JSON.stringify(result.runIds),
        result.failureCode,
        new Date().toISOString(),
        pending.occurrenceId,
      )
      .run();
  }
}
