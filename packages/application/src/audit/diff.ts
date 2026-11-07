// The safe change diff of an audit record (ADR 0064, `diff_json`).
//
// One strict schema per kind, each holding only counts, revision numbers,
// booleans and codes from closed lists: a diff says *that* a schedule went
// from revision 4 to 5 and which of its fields changed, never what they
// changed to. Strict objects refuse an unknown key rather than dropping it,
// so a writer that tried to put a value into the diff fails here, before its
// batch is sent. The table's own trigger refuses free text a second time.
//
// The `lane` kind is a lane tick's record (plan slice S7): the sizes of the
// ranges its references name — decision revisions, economic commits and
// proposals by closed proposal kind — and none of `processor_lane_ticks`'
// cost or progress counts.
import * as z from "zod/mini";
import { OPERATION_STATUSES } from "../operations/requests.ts";
import {
  AUDIT_MAX_DIFF_BYTES,
  OVERFLOW_RESULTS,
  AUDIT_DAILY_CAPS,
  LANE_PROPOSAL_KINDS,
} from "./vocabulary.ts";

const count = z.int().check(z.nonnegative());
const revision = z.int().check(z.nonnegative());

/**
 * The field names a revision diff may name: the columns of the versioned
 * settings (collection schedules and maintenance rules), in snake case. A
 * field name is never followed by its value.
 */
export const REVISION_FIELDS = [
  "enabled",
  "timezone",
  "pattern",
  "scope",
  "source",
  "reference_url",
  "verified_at",
] as const;
export type RevisionField = (typeof REVISION_FIELDS)[number];

/**
 * The counts a decision diff may carry: a plan's simulation reduced to its
 * sizes (targets, attributed observations and relations before and after,
 * affected scopes and parse runs, invalidations, outbox targets). No id and
 * no scope name is copied.
 */
export const DECISION_COUNTS = [
  "targets",
  "attributedObservationsBefore",
  "attributedObservationsAfter",
  "relationsBefore",
  "relationsAfter",
  "affectedScopes",
  "affectedParseRuns",
  "invalidations",
  "outboxTargets",
] as const;
export type DecisionCount = (typeof DECISION_COUNTS)[number];

const decisionCounts = z.strictObject(
  Object.fromEntries(DECISION_COUNTS.map((name) => [name, z.optional(count)])) as Record<
    DecisionCount,
    z.ZodMiniOptional<typeof count>
  >,
);

const revisionDiff = z.strictObject({
  kind: z.literal("revision"),
  from: revision,
  to: revision.check(z.positive()),
  fields: z.array(z.enum(REVISION_FIELDS)).check(z.maxLength(REVISION_FIELDS.length)),
});
const decisionDiff = z.strictObject({
  kind: z.literal("decision"),
  decisionRevisions: count,
  /** `commit-seq:<epoch>:<n>` once an economic commit is referenced (ADR 0054); null otherwise. */
  commitSeq: z.nullable(
    z.string().check(z.regex(/^commit-seq:[a-z0-9.-]{1,64}:[1-9][0-9]{0,15}$/u)),
  ),
  counts: decisionCounts,
});
const requestDiff = z.strictObject({
  kind: z.literal("request"),
  status: z.enum(OPERATION_STATUSES),
});
const readDiff = z.strictObject({
  kind: z.literal("read"),
  rows: count,
  truncated: z.boolean(),
});
const releaseDiff = z.strictObject({
  kind: z.literal("release"),
  released: z.literal(true),
});
const overflowDiff = z.strictObject({
  kind: z.literal("overflow"),
  of: z.enum(OVERFLOW_RESULTS),
  count: count.check(z.positive()),
  cap: z.union([z.literal(AUDIT_DAILY_CAPS.read), z.literal(AUDIT_DAILY_CAPS.refused)]),
});
/**
 * What one lane tick wrote, as counts of the rows its references name: decision
 * revisions, economic commit-log rows, and proposals per closed kind (each kind
 * at most once, only kinds with rows). Nothing about the tick's cost or
 * progress (`processor_lane_ticks`) is copied.
 */
const laneDiff = z.strictObject({
  kind: z.literal("lane"),
  decisionRevisions: count,
  commits: count,
  proposals: z
    .array(z.strictObject({ kind: z.enum(LANE_PROPOSAL_KINDS), count: count.check(z.positive()) }))
    .check(
      z.maxLength(LANE_PROPOSAL_KINDS.length),
      z.refine((items) => new Set(items.map((item) => item.kind)).size === items.length),
    ),
});
const noneDiff = z.strictObject({ kind: z.literal("none") });

export const auditDiffSchema = z.discriminatedUnion("kind", [
  revisionDiff,
  decisionDiff,
  requestDiff,
  readDiff,
  releaseDiff,
  overflowDiff,
  laneDiff,
  noneDiff,
]);
export type AuditDiff = z.infer<typeof auditDiffSchema>;
export type AuditDiffKind = AuditDiff["kind"];

/**
 * The diff as stored: validated, its field list de-duplicated and sorted so
 * equal diffs are equal text, and bounded. Throws `AuditDiffError` (a code,
 * never the offending value) when the diff is not one of the closed shapes.
 */
export function auditDiffJson(value: AuditDiff): string {
  const parsed = auditDiffSchema.safeParse(value);
  if (!parsed.success) throw new AuditDiffError();
  const diff =
    parsed.data.kind === "revision"
      ? { ...parsed.data, fields: [...new Set(parsed.data.fields)].sort() }
      : parsed.data.kind === "lane"
        ? {
            ...parsed.data,
            proposals: [...parsed.data.proposals].sort((a, b) => a.kind.localeCompare(b.kind)),
          }
        : parsed.data;
  const text = JSON.stringify(diff);
  if (new TextEncoder().encode(text).byteLength > AUDIT_MAX_DIFF_BYTES) throw new AuditDiffError();
  return text;
}

class AuditDiffError extends Error {
  readonly code = "audit_diff_invalid";
  constructor() {
    super("audit_diff_invalid");
  }
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * The names of the fields whose value differs between two revisions (all of
 * `after`'s fields for a first revision). Only names leave this function.
 */
export function changedFields(
  before: Partial<Record<RevisionField, unknown>> | null,
  after: Partial<Record<RevisionField, unknown>>,
): RevisionField[] {
  return REVISION_FIELDS.filter(
    (field) =>
      field in after && (before === null || stableJson(before[field]) !== stableJson(after[field])),
  );
}
