// One closed settings intent on the public adapter and private Processor boundary.
import { z } from "zod";
import type { CommandStore } from "../command/contract.ts";
import type { AuditRow } from "../audit/record.ts";
import { AUDIT_ID } from "../audit/vocabulary.ts";
import { DelegatedOperationError } from "./execution.ts";
import { canonicalDigest } from "../../../domain/src/context.ts";
import { TIME, ZONES } from "../../../collection/src/schedule-model.ts";
const delegatedSchedulePatternSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("daily"),
    time: z.string().regex(TIME),
    weekdays: z
      .array(z.int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
  }),
  z.strictObject({ kind: z.literal("interval"), minutes: z.int().min(5).max(1440) }),
]);
export const delegatedJobPayloadSchema = z.strictObject({
  jobId: z.string().regex(/^[a-z0-9-]{1,100}$/u),
  source: z
    .string()
    .regex(/^[a-z0-9-]{1,100}$/u)
    .nullable(),
  revision: z.int().min(1),
  enabled: z.boolean(),
  timezone: z.enum(ZONES),
  pattern: delegatedSchedulePatternSchema,
});
export const delegatedJobSchema = delegatedJobPayloadSchema.extend({
  step: z.enum(["prepare", "confirm"]),
  revertsAuditId: z.string().regex(AUDIT_ID).optional(),
  confirmationDigest: z
    .string()
    .regex(/^cfm_[0-9a-f]{64}$/u)
    .optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
});
export type DelegatedJobPayload = z.infer<typeof delegatedJobPayloadSchema>;

/** A reversal restores the snapshot immediately before the still-current effect.
 * Native job writes always advance revision, so their unchanged CAS also pins
 * this checked original effect during a concurrent settings change. */
export async function assertDelegatedJobReversal(
  store: CommandStore,
  subject: string,
  principal: string,
  payload: DelegatedJobPayload,
  revertsAuditId: string,
): Promise<void> {
  const invalid = (): never => {
    throw new DelegatedOperationError("revert_invalid");
  };
  if (!AUDIT_ID.test(revertsAuditId)) invalid();
  const row = await store.first<AuditRow>(
    "SELECT * FROM audit_records WHERE audit_id=? AND subject=? AND principal IN (?,?) AND operation='schedules.job.update' AND result='applied'",
    [revertsAuditId, subject, principal, subject],
  );
  if (
    !row ||
    row.target_ref !== `schedule:${payload.jobId}` ||
    row.scope_namespace !== (payload.source === null ? null : "schedule-source") ||
    row.scope_source !== payload.source
  )
    return invalid();
  const refs = JSON.parse(row.refs_json) as unknown;
  const diff = JSON.parse(row.diff_json) as Record<string, unknown>;
  if (
    !Array.isArray(refs) ||
    refs.length !== 1 ||
    refs[0] !== `schedule:${payload.jobId}@${payload.revision}` ||
    diff.kind !== "revision" ||
    diff.to !== payload.revision ||
    diff.from !== payload.revision - 1
  )
    return invalid();
  interface Snapshot {
    enabled: number;
    timezone: string;
    pattern_json: string;
    actor: string;
  }
  const current = await store.first<{
    revision: number;
    source: string | null;
    updated_by: string;
    enabled: number;
    timezone: string;
    pattern_json: string;
  }>(
    "SELECT revision,source,updated_by,enabled,timezone,pattern_json FROM collection_schedules WHERE id=?",
    [payload.jobId],
  );
  const produced = await store.first<Snapshot>(
    "SELECT enabled,timezone,pattern_json,actor FROM collection_schedule_revisions WHERE schedule_id=? AND revision=?",
    [payload.jobId, payload.revision],
  );
  const before = await store.first<Snapshot>(
    "SELECT enabled,timezone,pattern_json,actor FROM collection_schedule_revisions WHERE schedule_id=? AND revision=?",
    [payload.jobId, payload.revision - 1],
  );
  if (
    !current ||
    !produced ||
    !before ||
    current.revision !== payload.revision ||
    current.source !== payload.source ||
    current.updated_by !== row.principal ||
    produced.actor !== row.principal
  )
    return invalid();
  const snapshot = (value: { enabled: number; timezone: string; pattern_json: string }) => ({
    enabled: value.enabled === 1,
    timezone: value.timezone,
    pattern: JSON.parse(value.pattern_json) as unknown,
  });
  if (
    (await canonicalDigest(snapshot(current))) !== (await canonicalDigest(snapshot(produced))) ||
    (await canonicalDigest({
      enabled: payload.enabled,
      timezone: payload.timezone,
      pattern: payload.pattern,
    })) !== (await canonicalDigest(snapshot(before)))
  )
    return invalid();
}

/** Persistence and alarm reservation are distinct. A replay never re-observes
 * the alarm, so it returns null reservation metadata rather than claiming the
 * original transient observation is the current reservation. */
export const delegatedJobResultSchema = z
  .strictObject({
    saved: z.literal(true),
    jobId: z.string().regex(/^[a-z0-9-]{1,100}$/u),
    revision: z.int().min(2),
    replayed: z.boolean(),
    reservation: z.enum(["pending", "armed", "disabled"]).nullable(),
    actualAlarmAt: z.iso.datetime().nullable(),
  })
  .refine((value) =>
    value.replayed
      ? value.reservation === null && value.actualAlarmAt === null
      : value.reservation !== null,
  );
export type DelegatedJobResult = z.infer<typeof delegatedJobResultSchema>;
