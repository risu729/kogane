// The wire shape of `GET /api/v2/changes` and `kogane.changes.since` (ADR 0127,
// packages/application/src/query/changes-since.ts). Every code, order, bound
// and handler is checked against the domain's closed lists, and every line
// against itself (a newest time only beside a count, a section null only when
// the grant cannot read it), so a reader never sees a line the digest cannot
// produce.
import {
  CHANGES_SINCE_CAPTURE_BOUND,
  CHANGES_SINCE_EVENT_WALK,
  CHANGES_SINCE_HANDLERS,
  CHANGES_SINCE_MAX_BYTES,
  CHANGES_SINCE_MAX_DAYS,
  CHANGES_SINCE_NOT_COVERED,
  CHANGES_SINCE_OBSERVATION_BOUND,
  CHANGES_SINCE_OBSERVATION_KINDS,
  CHANGES_SINCE_PARSE_STATES,
  CHANGES_SINCE_PARSE_WALK,
  CHANGES_SINCE_RUN_STATUSES,
  CHANGES_SINCE_RUN_WALK,
  CHANGES_SINCE_SECTIONS,
  CHANGES_SINCE_SOURCE_BOUND,
  CHANGES_SINCE_UNAVAILABLE,
  ECONOMIC_EVENT_KINDS,
} from "../../domain/src/changes-since.ts";

/** The route of the digest. */
export const CHANGES_SINCE_PATH = "/api/v2/changes";

const SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;
const RUN_ID = /^r_[1-9][0-9]{0,15}$/u;

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const counts = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(count);
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const source = (value: unknown): value is string => typeof value === "string" && SOURCE.test(value);
/** An instant in `toISOString` form, the only form the digest writes. */
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const none = (values: readonly number[]): boolean => values.every((n) => n === 0);

/** Positions of the parse states a reader may see (and whose artifact the line names). */
const RECORDED = (["published", "superseded", "failed"] as const).map((state) =>
  CHANGES_SINCE_PARSE_STATES.indexOf(state),
);
const OPEN = CHANGES_SINCE_RUN_STATUSES.indexOf("open");

function validLine(value: unknown, evidence: boolean): value is Record<string, any> {
  if (
    !record(value) ||
    !source(value.source) ||
    !Array.isArray(value.cut) ||
    !same(
      value.cut,
      CHANGES_SINCE_SECTIONS.filter((section) => (value.cut as unknown[]).includes(section)),
    ) ||
    (value.cut as unknown[]).length !== new Set(value.cut).size ||
    !counts(value.parses, CHANGES_SINCE_PARSE_STATES.length) ||
    !counts(value.observations, CHANGES_SINCE_OBSERVATION_KINDS.length)
  )
    return false;
  if (evidence) {
    if (!counts(value.runs, CHANGES_SINCE_RUN_STATUSES.length) || !count(value.captures))
      return false;
    // A time beside a new run; a sealed run id only beside a sealed new run.
    if ((value.newestRunAt === null) !== none(value.runs)) return false;
    if (value.newestRunAt !== null && !instant(value.newestRunAt)) return false;
    const sealed = value.runs.some((n: number, index: number) => index !== OPEN && n > 0);
    if (
      value.newestSealedRunId === null ? sealed : !sealed || !RUN_ID.test(value.newestSealedRunId)
    )
      return false;
  } else if (
    value.runs !== null ||
    value.captures !== null ||
    value.newestRunAt !== null ||
    value.newestSealedRunId !== null
  )
    return false;
  if ((value.newestParsedAt === null) !== none(value.parses)) return false;
  if (value.newestParsedAt !== null && !instant(value.newestParsedAt)) return false;
  const recorded = RECORDED.some((index) => value.parses[index] > 0);
  const artifact = value.newestParsedArtifactId;
  if (
    artifact === null
      ? recorded
      : !recorded || typeof artifact !== "number" || !Number.isSafeInteger(artifact) || artifact < 1
  )
    return false;
  // Observations only of a recorded parse.
  if (!recorded && !none(value.observations)) return false;
  // A listed line has something new or something cut.
  return (
    value.cut.length > 0 ||
    !none(value.parses) ||
    (evidence && (!none(value.runs) || value.captures > 0))
  );
}

function validEvents(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === "unavailable")
    return (
      (CHANGES_SINCE_UNAVAILABLE as readonly unknown[]).includes(value.reason) &&
      value.complete === false &&
      value.new === null &&
      value.revised === null &&
      value.newestAt === null
    );
  return (
    value.state === "counted" &&
    value.reason === null &&
    typeof value.complete === "boolean" &&
    counts(value.new, ECONOMIC_EVENT_KINDS.length) &&
    counts(value.revised, ECONOMIC_EVENT_KINDS.length) &&
    (value.newestAt === null) === (none(value.new) && none(value.revised)) &&
    (value.newestAt === null || instant(value.newestAt))
  );
}

export function validChangesSince(value: unknown): boolean {
  if (
    !record(value) ||
    value.apiVersion !== 2 ||
    value.schemaVersion !== "kogane-changes-since-v1" ||
    !instant(value.since) ||
    !instant(value.asOf) ||
    Date.parse(value.since) > Date.parse(value.asOf) ||
    !(value.after === null || source(value.after)) ||
    value.basis !== "recorded" ||
    !same(value.bounds, {
      maxDays: CHANGES_SINCE_MAX_DAYS,
      sources: CHANGES_SINCE_SOURCE_BOUND,
      runWalk: CHANGES_SINCE_RUN_WALK,
      captures: CHANGES_SINCE_CAPTURE_BOUND,
      parseWalk: CHANGES_SINCE_PARSE_WALK,
      observations: CHANGES_SINCE_OBSERVATION_BOUND,
      eventWalk: CHANGES_SINCE_EVENT_WALK,
      maxBytes: CHANGES_SINCE_MAX_BYTES,
    }) ||
    !same(value.order, {
      runs: CHANGES_SINCE_RUN_STATUSES,
      parses: CHANGES_SINCE_PARSE_STATES,
      observations: CHANGES_SINCE_OBSERVATION_KINDS,
      events: ECONOMIC_EVENT_KINDS,
    }) ||
    !record(value.sections) ||
    !["counted", "unauthorized"].includes(value.sections.runs) ||
    !same(value.sections, {
      runs: value.sections.runs,
      captures: value.sections.runs,
      parses: "counted",
      observations: "counted",
    }) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.unchanged) ||
    !value.unchanged.every(source) ||
    !validEvents(value.events) ||
    !same(value.handlers, CHANGES_SINCE_HANDLERS) ||
    !same(value.notCovered, CHANGES_SINCE_NOT_COVERED)
  )
    return false;
  const evidence = value.sections.runs === "counted";
  if (!value.sources.every((line: unknown) => validLine(line, evidence))) return false;
  // Every source once, all after `after`, and the continuation the last of them.
  const listed = [
    ...value.sources.map((line: Record<string, any>) => line.source as string),
    ...(value.unchanged as string[]),
  ].sort();
  if (new Set(listed).size !== listed.length) return false;
  if (value.after !== null && listed.some((id) => id <= value.after)) return false;
  for (const list of [
    value.sources.map((line: Record<string, any>) => line.source),
    value.unchanged,
  ])
    if (!same(list, [...list].sort())) return false;
  if (value.next === null) return true;
  return record(value.next) && source(value.next.after) && value.next.after === listed.at(-1);
}
