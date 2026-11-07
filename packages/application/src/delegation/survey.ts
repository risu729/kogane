// `kogane.schedules.survey.decide` (ADR 0050 as amended 2026-11-07): one
// decision on one re-survey proposal of one schedule source. A rejection is
// R1 and direct; an acceptance is R2, prepared and confirmed against the
// proposal's base revision.
import { z } from "zod";
const sourceId = z.string().regex(/^[a-z0-9-]{1,100}$/u);
const proposalId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** What the App and the Processor agree on; the digest binds exactly this. */
export const delegatedSurveyPayloadSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("reject"), source: sourceId, proposalId }),
  z.strictObject({
    decision: z.literal("accept"),
    source: sourceId,
    proposalId,
    /** The proposal's base revision the caller read (`kogane.schedules.survey.read`). */
    baseRevision: z.int().min(0),
  }),
]);
export type DelegatedSurveyPayload = z.infer<typeof delegatedSurveyPayloadSchema>;

const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const confirmationDigest = z.string().regex(/^cfm_[0-9a-f]{64}$/u);
/** The tool's arguments: `apply` rejects; `prepare` then `confirm` accepts. */
export const delegatedSurveySchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("reject"),
    source: sourceId,
    proposalId,
    step: z.literal("apply"),
    idempotencyKey,
  }),
  z.strictObject({
    decision: z.literal("accept"),
    source: sourceId,
    proposalId,
    baseRevision: z.int().min(0),
    step: z.enum(["prepare", "confirm"]),
    idempotencyKey,
    confirmationDigest: confirmationDigest.optional(),
  }),
]);

/** A fresh decision's answer, and the shape a replay answers from its record. */
export const delegatedSurveyResultSchema = z.discriminatedUnion("decided", [
  z.strictObject({ decided: z.literal("rejected"), replayed: z.boolean() }),
  z.strictObject({
    decided: z.literal("accepted"),
    ruleId: sourceId,
    revision: z.int().min(1),
    reservation: z.enum(["armed", "pending"]).nullable(),
    replayed: z.boolean(),
  }),
]);
