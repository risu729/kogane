import { z } from "zod";
import { DELEGATED_MAINTENANCE_REASONS, TIME, ZONES } from "../../../collection/src/schedule-model";
const sourceId = z.string().regex(/^[a-z0-9-]{1,100}$/u);
const clock = z.string().regex(TIME);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const weekday = z.int().min(0).max(6);

/** `kogane.schedules.maintenance.update`: one revision of one rule of one source. */
export const delegatedMaintenancePayloadSchema = z.strictObject({
  source: sourceId,
  /** Omitted to create a rule; the writer then chooses its id. */
  ruleId: sourceId.optional(),
  /** The rule's current revision; 0 to create. */
  revision: z.int().min(0),
  timezone: z.enum(ZONES),
  pattern: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("weekly"),
      weekdays: z.array(weekday).min(1).max(7),
      start: clock,
      end: clock,
    }),
    z.strictObject({
      kind: z.literal("monthly"),
      weekday,
      nth: z.int().min(1).max(5),
      offsetDays: z.int().min(0).max(6),
      start: clock,
      end: clock,
    }),
    z.strictObject({ kind: z.literal("once"), from: instant, to: instant }),
  ]),
  enabled: z.boolean(),
  scope: z.enum(["collection", "session", "feature-only"]),
  referenceUrl: z
    .string()
    .regex(/^https:\/\//u)
    .max(1500),
  verifiedAt: instant,
  /** Why, as a closed code; never free text. */
  reason: z.enum(DELEGATED_MAINTENANCE_REASONS),
});

export const delegatedMaintenanceSchema = delegatedMaintenancePayloadSchema.extend({
  step: z.enum(["apply", "prepare", "confirm"]),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  confirmationDigest: z
    .string()
    .regex(/^cfm_[0-9a-f]{64}$/u)
    .optional(),
});
export const delegatedMaintenanceResultSchema = z
  .strictObject({
    saved: z.literal(true),
    ruleId: z.string().regex(/^[a-z0-9-]{1,100}$/u),
    revision: z.int().min(1),
    replayed: z.boolean(),
    reconciliation: z.enum(["completed", "pending"]).nullable(),
  })
  .refine((value) =>
    value.replayed ? value.reconciliation === null : value.reconciliation !== null,
  );
