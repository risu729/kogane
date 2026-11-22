// The latest-balance read model (review D10/D11, addendum A07). Pure: no D1,
// no clock, no HTTP. The job in services/processor supplies the
// candidates and writes the rows; everything that decides a state lives here
// so it can be tested against the scenario fixtures in packages/domain.
//
// Addendum 05 section 5, steps 2-7, are performed by `selectAdoptedSet` in
// packages/domain. This module does step 1 (which candidates belong to the
// perimeter and the target), turns typed entity relations and the source
// authority policy into scope relations, and records the outcome per
// candidate with its reason code. It never sums across units, never turns a
// missing value into zero, and never reads an unknown overlap as disjoint.

import { encodeDecimal } from "../../storage-d1/src/codecs/decimal.ts";
import { fromNormalizedDecimal, type ValueState } from "../../domain/src/values.ts";
import {
  METRIC_REGISTRY,
  METRIC_REGISTRY_RELEASE,
  resolveMetric,
  UNKNOWN_METRIC,
  type MetricDefinition,
} from "../../domain/src/metrics.ts";
import {
  selectAdoptedSet,
  type AdoptionTarget,
  type MeasureCandidate,
  type ScopeRelation,
  type ScopeRelationClaim,
} from "../../domain/src/scope.ts";
import {
  validInstantText,
  validLocalDateText,
  type TemporalReference,
  type TemporalValue,
} from "../../domain/src/time.ts";
import { validZoneOffsetInstantText } from "../../domain/src/zone-offset.ts";
import type { NormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";
import { canonicalDigest } from "../../domain/src/context.ts";
import { AUTHORITY_POLICY_RELEASE, AUTHORITY_RANKS } from "./authority";
import type { MeasureView } from "./scope";

export const BALANCE_PROJECTION_RELEASE = "balance-projection-v1";
/**
 * v2: the declared relations are the newest decision of each relation triple
 * (`projectionRelationsSql`), so a later rejection withdraws an earlier
 * acceptance; v1 read every stored row. The release is part of the build
 * digest, so the first tick after a deploy captures afresh instead of serving
 * a v1 snapshot as current (ADR 0001's amendment of 2026-11-06).
 *
 * v3: adoption reads `same` as an equivalence, so two scopes each accepted as
 * the same account as a third are one measurement whatever the candidate
 * order; v2's grouping depended on the order and could adopt two of them
 * (INV06; ADR 0001's amendment of 2026-11-18).
 */
export const SCOPE_RELATION_RELEASE = "scope-relations-v3";
/**
 * The disjointness the policy asserts, and the evidence it rests on.
 *
 * v3: two scopes the current identity mapping maps to one account entity are
 * never declared disjoint, whatever else the policy would say of them. v2
 * declared two references of one source disjoint (or two identified
 * references of two sources) without reading the entity, so a second
 * reference of one account was adopted beside the first and counted twice
 * (INV06; ADR 0001's amendment of 2026-11-20). The release is part of the
 * build digest, so the first tick after a deploy builds a new snapshot.
 */
export const DISJOINT_ACCOUNTS_POLICY = "distinct-identified-accounts-v3";

/**
 * The reason a candidate is left unresolved when another contender of its
 * target is a different reference the current identity mapping maps to the
 * same account entity, and no decision says whether the two are one
 * measurement (ADR 0001's amendment of 2026-11-20), or when the mapping is
 * what forces the two to overlap. It replaces the generic `overlap_unknown`
 * only for that cause, so the entity is shown, not counted. A pair accepted
 * decisions alone force to overlap keeps `overlap_unknown` even when the
 * policy withheld its disjointness because a mapped scope lies on the way:
 * no entity is shared there, and the reason must not say one is.
 */
const ACCOUNT_ENTITY_SHARED = "account_entity_shared";

/**
 * Build budget: distinct measurement scopes considered together for one
 * (metric, unit). Adoption compares scopes pairwise, so an unbounded target
 * would make a rebuild unbounded. A target above the bound is recorded
 * `unresolved`/`adoption_target_oversized` for every candidate: never
 * silently adopted, never silently summed, and visible as a reason code.
 */
export const ADOPTION_SUBJECT_BOUND = 250;

export const PROJECTION_STATES = [
  "adopted",
  "excluded",
  "unresolved",
  "conflict",
  "stale",
] as const;
export type ProjectionState = (typeof PROJECTION_STATES)[number];

/** Identity status of the scope a candidate measures; from the organized read. */
export const SUBJECT_STATUSES = [
  "identified",
  "provider-local",
  "aggregate",
  "unresolved",
] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];

interface CandidateFreshness {
  state: "current" | "stale" | "unknown";
  /** Why the newest fetch did not replace this scope (SC15 reason codes). */
  reasonCode: string | null;
}

/** One candidate measurement, after same-provider-witness bundling. */
export interface ProjectionCandidate {
  /** Unique key of this candidate row: source, unit key, parser family, account, metric, unit. */
  scopeKey: string;
  /** The scope whose relations decide adoption; shared by every route to it. */
  subjectScopeKey: string;
  subjectStatus: SubjectStatus;
  observationId: number;
  parseRunId: number;
  fetchArtifactId: number;
  sourceId: string;
  sourceAccount: string;
  parser: string;
  parserName: string;
  metric: string;
  instrument: string;
  amountMinor: string | null;
  amountText: string | null;
  asOf: string | null;
  observedAt: string | null;
  normalized: NormalizedDecimal;
  /** Every witness bundled into this measurement, the representative included. */
  memberEvidence: EvidenceRef[];
  /** The strict same-provider-witness rule found disagreeing evidence. */
  witnessConflict: boolean;
  coverage: { completeness: "complete" | "partial" | "unknown"; reasonCode: string | null };
  freshness: CandidateFreshness;
  /**
   * Source authority as the caller's policy decides it (0 = most
   * authoritative). It never establishes that two scopes are the same
   * measurement; it only decides which side of an unproven overlap stays
   * adopted. Equal ranks leave both sides unresolved.
   */
  authorityRank: number;
  measureView: MeasureView;
  /** Whether the row is the latest witness of its group; see the view predicate. */
  latestInGroup: boolean;
  /**
   * The account entity the current identity mapping gives the candidate's
   * reference (`account_mappings.account_id`), or null when no mapping
   * organizes it. It never makes two scopes one measurement; it only keeps
   * the disjointness policy from declaring apart two references of one
   * entity, or two scopes accepted decisions and the mapping force to
   * overlap. An input captured before this field existed has no value here
   * and builds as v2 did.
   */
  accountEntity: string | null;
}

/**
 * One witness of a measurement. The provider metric travels with the
 * reference so a page can say which column each piece of evidence came from
 * without a second read, and so evidence count stays distinct from the number
 * of balances shown (addendum 11 section 4).
 */
export interface EvidenceRef {
  ref: string;
  observationId: number;
  metric: string;
}

export interface ProjectionRow {
  scopeKey: string;
  subjectScopeKey: string;
  rowSeq: number;
  representativeObservationRef: string;
  memberEvidence: EvidenceRef[];
  /** Distinct provider metrics among the witnesses; the metric filter reads this. */
  memberMetrics: string[];
  evidenceCount: number;
  metricId: string;
  definitionRelease: string;
  quantityCoefficient: string | null;
  quantityScale: number | null;
  valueStatus: ValueState["status"];
  unitRef: string;
  state: ProjectionState;
  reasonCode: string | null;
  asOfRole: TemporalReference["role"];
  asOfKind: TemporalValue["kind"];
  asOfValue: string | null;
  temporal: TemporalReference;
  freshness: CandidateFreshness["state"];
  freshnessReason: string | null;
  sortAsOf: string;
  sourceId: string;
  sourceAccount: string;
  metric: string;
  instrument: string;
  parser: string;
  observationId: number;
  parseRunId: number;
  fetchArtifactId: number;
  amountMinor: string | null;
  amountText: string | null;
  asOf: string | null;
  observedAt: string | null;
  measureView: MeasureView;
  latestInGroup: boolean;
}

export interface DerivedScopeRelation {
  fromScopeKey: string;
  toScopeKey: string;
  relation: ScopeRelation;
  source: "policy" | "decision" | "derived";
  decisionRevisionId: string | null;
  release: string;
}

export interface ProjectionBuild {
  rows: ProjectionRow[];
  relations: DerivedScopeRelation[];
  /** Distinct reason codes present, sorted; the page reports them verbatim. */
  reasons: string[];
  completeness: "complete" | "partial" | "unknown";
  stale: boolean;
}

// ── time ─────────────────────────────────────────────────────────────────

/**
 * `+09:00` is the fixed-offset zone `Etc/GMT-9`; the POSIX sign is inverted.
 * The caller passes only offsets zones use (-12:00 to +14:00): past them no
 * `Etc/GMT` zone exists.
 */
function offsetZone(text: string): string | null {
  if (text === "Z") return "UTC";
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(text);
  if (!match || match[3] !== "00") return null;
  const hours = Number(match[2]);
  if (hours === 0) return "UTC";
  return `Etc/GMT${match[1] === "+" ? "-" : "+"}${String(hours)}`;
}

/**
 * The stored `as_of` / `observed_at` strings become a role-typed reference.
 * A date-only value stays a date: it is never given a time of day, and a
 * value that is neither a date nor an instant with a whole-hour offset that
 * a zone uses (-12:00 to +14:00) is reported as unknown rather than guessed
 * (root review 07 section 5).
 */
export function temporalReferenceFor(
  asOf: string | null,
  observedAt: string | null,
): TemporalReference {
  const [text, role] =
    asOf !== null && asOf !== ""
      ? ([asOf, "effective"] as const)
      : observedAt !== null && observedAt !== ""
        ? ([observedAt, "observed"] as const)
        : ([null, "effective"] as const);
  if (text === null) return { role, time: { kind: "unknown", reasonCode: "no_recorded_time" } };
  return { role, time: temporalValueFor(text) };
}

function temporalValueFor(candidate: unknown): TemporalValue {
  if (validLocalDateText(candidate))
    return { kind: "local-date", value: candidate, zone: null, basis: "provider" };
  if (validInstantText(candidate)) {
    const zone = validZoneOffsetInstantText(candidate)
      ? offsetZone(candidate.endsWith("Z") ? "Z" : candidate.slice(-6))
      : null;
    if (zone !== null) return { kind: "instant", value: candidate, zone, basis: "provider" };
    return { kind: "unknown", reasonCode: "offset_zone_unsupported" };
  }
  return { kind: "unknown", reasonCode: "time_text_unrecognised" };
}

/**
 * The paging sort key. This is an ordering, not a semantic time comparison:
 * it is the recorded effective time as text, falling back to the observed
 * time, so a row with no recorded time sorts last under the descending order
 * and never borrows another row's date. The precision and basis of the value
 * travel separately in `temporal`, where a date is still a date.
 */
function sortKeyFor(asOf: string | null, observedAt: string | null): string {
  return asOf ?? observedAt ?? "";
}

// ── targets ──────────────────────────────────────────────────────────────

/**
 * The measurement a candidate contends for. A metric the registry does not
 * know is targeted per provider metric: unknown meanings are stored and
 * displayed but never pooled with each other, so an unknown column can never
 * become a contender for another unknown column's value.
 */
function adoptionTargetKey(definition: MetricDefinition, candidate: ProjectionCandidate): string {
  return definition.metricId === UNKNOWN_METRIC.metricId
    ? `unknown:${candidate.sourceId}:${candidate.parserName}:${candidate.metric}|${candidate.instrument}`
    : `${definition.metricId}|${candidate.instrument}`;
}

// ── relations ────────────────────────────────────────────────────────────

/** Typed relation rows of migration 0029, as the projection reads them. */
export interface EntityRelationRow {
  id: string;
  kind: string;
  from_ref: string;
  to_ref: string;
  status: string;
  decision_revision_id: string | null;
}

const CONTAINMENT_KINDS = new Set([
  "connection_contains",
  "account_has_pocket",
  "statement_covers",
]);

/**
 * Adopted typed relations become scope relations. `same_account` is the only
 * kind that makes two scopes one measurement; a containment kind makes the
 * contained scope a subset. A relation that is only proposed contributes
 * nothing, so an unconfirmed correspondence stays an unknown overlap (SC06).
 * `rows` must hold one row per relation triple, its current row
 * (`projectionRelationsSql`); this function does not order a triple's history.
 */
export function scopeRelationsFromEntityRelations(
  rows: readonly EntityRelationRow[],
): DerivedScopeRelation[] {
  const relations: DerivedScopeRelation[] = [];
  for (const row of rows) {
    if (row.status !== "accepted") continue;
    if (row.kind === "same_account")
      relations.push({
        fromScopeKey: row.from_ref,
        toScopeKey: row.to_ref,
        relation: "same",
        source: "decision",
        decisionRevisionId: row.decision_revision_id,
        release: SCOPE_RELATION_RELEASE,
      });
    else if (CONTAINMENT_KINDS.has(row.kind))
      relations.push({
        // `subset` reads left ⊂ right: the contained scope is the left side.
        fromScopeKey: row.to_ref,
        toScopeKey: row.from_ref,
        relation: "subset",
        source: "decision",
        decisionRevisionId: row.decision_revision_id,
        release: SCOPE_RELATION_RELEASE,
      });
  }
  return relations;
}

function claim(relation: DerivedScopeRelation): ScopeRelationClaim {
  return {
    left: relation.fromScopeKey,
    right: relation.toScopeKey,
    relation: relation.relation,
    evidenceRefs: [],
    decisionRef: relation.decisionRevisionId,
  };
}

// ── build ────────────────────────────────────────────────────────────────

const EVIDENCE_REF = (id: number): string => `balance:${String(id)}`;

function valueOf(candidate: ProjectionCandidate): ValueState {
  return fromNormalizedDecimal(candidate.normalized);
}

interface Subject {
  status: SubjectStatus;
  sourceId: string;
  depositInstitution: string | null;
}

/**
 * The order accepted decisions and the current identity mapping put scopes
 * in, read once per build from every accepted decision and every candidate,
 * so a chain through scopes outside a target still counts.
 *
 * Scopes are read as non-empty sets. An accepted `same` makes two scopes
 * equal and a containment makes its part a subset of its whole. Two
 * references the current mapping gives one account entity may be one
 * measurement, so they are read as equal too; a scope's entities are those of
 * every candidate of it, in every target, because the mapping belongs to the
 * reference and not to a metric. Under those constraints two scopes are
 * forced to overlap exactly when some scope lies at or below both of them (a
 * common lower bound): the set of scopes at or below each scope satisfies
 * every constraint and keeps any other pair apart. An accepted `disjoint`
 * forces no overlap (that same model satisfies it whenever the decisions are
 * consistent), and the build reads none.
 */
interface ScopeOrder {
  /** The equality class of a scope: accepted `same` and shared entities join scopes. */
  classOf: (scope: string) => string;
  /** Class → the classes a decision makes a part of one of its scopes. */
  parts: ReadonlyMap<string, ReadonlySet<string>>;
  /** Classes with a scope the current mapping maps to an account entity. */
  mapped: ReadonlySet<string>;
  /** Scope → the account entities of its candidates. */
  entities: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * `readEntities: false` gives the order accepted decisions alone make, which
 * only names the cause of an unknown overlap (`entityTakesPart`).
 */
function scopeOrder(
  candidates: readonly ProjectionCandidate[],
  decisions: readonly DerivedScopeRelation[],
  readEntities = true,
): ScopeOrder {
  const parent = new Map<string, string>();
  const classOf = (key: string): string => {
    let at = key;
    for (let next = parent.get(at); next !== undefined; next = parent.get(at)) {
      const grand = parent.get(next);
      if (grand !== undefined) parent.set(at, grand);
      at = grand ?? next;
    }
    return at;
  };
  const join = (left: string, right: string) => {
    const [x, y] = [classOf(left), classOf(right)];
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  const entities = new Map<string, Set<string>>();
  for (const candidate of candidates)
    // `typeof` and not `!== null`: an input captured before the field
    // existed lacks it.
    if (readEntities && typeof candidate.accountEntity === "string") {
      const held = entities.get(candidate.subjectScopeKey) ?? new Set<string>();
      held.add(candidate.accountEntity);
      entities.set(candidate.subjectScopeKey, held);
    }
  for (const relation of decisions)
    if (relation.relation === "same") join(relation.fromScopeKey, relation.toScopeKey);
  const holder = new Map<string, string>();
  for (const [scope, held] of entities)
    for (const entity of held) {
      const first = holder.get(entity);
      if (first === undefined) holder.set(entity, scope);
      else join(first, scope);
    }
  const parts = new Map<string, Set<string>>();
  // `subset` reads from ⊂ to: the part is the left side.
  for (const relation of decisions)
    if (relation.relation === "subset") {
      const [part, whole] = [classOf(relation.fromScopeKey), classOf(relation.toScopeKey)];
      if (part === whole) continue;
      const set = parts.get(whole) ?? new Set<string>();
      set.add(part);
      parts.set(whole, set);
    }
  return { classOf, parts, mapped: new Set([...entities.keys()].map(classOf)), entities };
}

/** Classes as bits over one target's lower closure: a pair is compared in a few words. */
type ClassBits = Uint32Array;

// Indexed loops: a pair is compared for every two subjects of a target.
function orInto(target: ClassBits, source: ClassBits): void {
  for (let index = 0; index < source.length; index += 1)
    target[index] = target[index]! | source[index]!;
}

function bitsMeet(left: ClassBits, right: ClassBits): boolean {
  for (let index = 0; index < left.length; index += 1)
    if ((left[index]! & right[index]!) !== 0) return true;
  return false;
}

interface LowerSets {
  /** Class → its position in the bit sets. */
  position: ReadonlyMap<string, number>;
  /** Position → the classes at or below it. */
  below: readonly ClassBits[];
  /** Position → the classes at or below a mapped class at or below it. */
  belowMapped: readonly ClassBits[];
}

/**
 * The lower sets of every class at or below one of `starts`, over the
 * decided parts. A decided cycle (`a ⊂ b` and `b ⊂ a`, or a chain whose ends
 * share an entity) makes its classes equal, so they are read as one
 * strongly connected set, found with Tarjan's algorithm without recursion.
 * Tarjan completes a set only after every set it reaches, so each set's
 * lower sets are the union of its own members and its parts' lower sets.
 */
function lowerSets(starts: Iterable<string>, order: ScopeOrder): LowerSets {
  const nodes: string[] = [];
  const position = new Map<string, number>();
  const visit = (key: string) => {
    if (position.has(key)) return;
    position.set(key, nodes.length);
    nodes.push(key);
  };
  for (const start of starts) visit(start);
  for (let at = 0; at < nodes.length; at += 1)
    for (const part of order.parts.get(nodes[at]!) ?? []) visit(part);
  const edges = nodes.map((key) =>
    [...(order.parts.get(key) ?? [])].map((part) => position.get(part)!),
  );
  const words = Math.ceil(nodes.length / 32);
  const index = new Int32Array(nodes.length).fill(-1);
  const low = new Int32Array(nodes.length);
  const open = new Uint8Array(nodes.length);
  const setOf = new Int32Array(nodes.length).fill(-1);
  const setBelow: ClassBits[] = [];
  const setBelowMapped: ClassBits[] = [];
  const stack: number[] = [];
  let counter = 0;
  const enter = (node: number) => {
    index[node] = counter;
    low[node] = counter;
    counter += 1;
    stack.push(node);
    open[node] = 1;
  };
  for (let start = 0; start < nodes.length; start += 1) {
    if (index[start] !== -1) continue;
    enter(start);
    const work: [number, number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const [node, next] = frame;
      const out = edges[node]!;
      if (next < out.length) {
        frame[1] = next + 1;
        const to = out[next]!;
        if (index[to] === -1) {
          enter(to);
          work.push([to, 0]);
        } else if (open[to] === 1) low[node] = Math.min(low[node]!, index[to]!);
        continue;
      }
      work.pop();
      const caller = work.at(-1);
      if (caller !== undefined) low[caller[0]] = Math.min(low[caller[0]]!, low[node]!);
      if (low[node] !== index[node]) continue;
      const set = setBelow.length;
      const members: number[] = [];
      for (let member = stack.pop()!; ; member = stack.pop()!) {
        open[member] = 0;
        setOf[member] = set;
        members.push(member);
        if (member === node) break;
      }
      const below = new Uint32Array(words);
      const belowMapped = new Uint32Array(words);
      for (const member of members)
        below[member >>> 5] = below[member >>> 5]! | (1 << (member & 31));
      for (const member of members)
        for (const to of edges[member]!)
          if (setOf[to] !== set) {
            orInto(below, setBelow[setOf[to]!]!);
            orInto(belowMapped, setBelowMapped[setOf[to]!]!);
          }
      if (members.some((member) => order.mapped.has(nodes[member]!))) orInto(belowMapped, below);
      setBelow.push(below);
      setBelowMapped.push(belowMapped);
    }
  }
  return {
    position,
    below: nodes.map((_, node) => setBelow[setOf[node]!]!),
    belowMapped: nodes.map((_, node) => setBelowMapped[setOf[node]!]!),
  };
}

function shareAccountEntity(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): boolean {
  for (const entity of left ?? []) if (right?.has(entity)) return true;
  return false;
}

/** Scope pairs a relation in `relations` relates directly. */
function relatedPairs(
  relations: readonly DerivedScopeRelation[],
): (left: string, right: string) => boolean {
  const pairs = new Map<string, Set<string>>();
  for (const relation of relations)
    for (const [from, to] of [
      [relation.fromScopeKey, relation.toScopeKey],
      [relation.toScopeKey, relation.fromScopeKey],
    ] as const) {
      const set = pairs.get(from) ?? new Set<string>();
      set.add(to);
      pairs.set(from, set);
    }
  return (left, right) => pairs.get(left)?.has(right) ?? false;
}

/**
 * Whether the current identity mapping takes part in forcing two subjects to
 * overlap (`ScopeOrder`): some scope lies at or below both, and a mapped
 * class lies on the way up from it to one of them. With `c ≤ m ≤ a` and
 * `c ≤ b`, `m` mapped, the classes below a mapped class below `a` meet the
 * classes below `b`. Two scopes that only lie below one mapped scope (two
 * pockets of one account) have no common lower bound and are not forced to
 * overlap. A forced overlap with no mapped class on any way is the
 * decision-only nesting v2 left to the policy, and stays so. A pair a
 * decision relates directly is read against its own entities: the decision
 * already keeps the pair from being adopted twice, and a policy claim that
 * contradicts it still degrades the pair to unknown as under v2.
 * `declared` is the target's relations.
 */
function entitySharing(
  subjects: Iterable<string>,
  order: ScopeOrder,
  declared: readonly DerivedScopeRelation[],
): (left: string, right: string) => boolean {
  const { position, below, belowMapped } = lowerSets(
    [...subjects].map((key) => order.classOf(key)),
    order,
  );
  const related = relatedPairs(declared);
  return (left, right) => {
    if (related(left, right))
      return shareAccountEntity(order.entities.get(left), order.entities.get(right));
    const l = position.get(order.classOf(left));
    const r = position.get(order.classOf(right));
    if (l === undefined || r === undefined) return false;
    return bitsMeet(belowMapped[l]!, below[r]!) || bitsMeet(belowMapped[r]!, below[l]!);
  };
}

/**
 * Whether the current identity mapping is what keeps two subjects from being
 * declared disjoint, so the reason may name it: the two share an entity of
 * their own, or `entitySharing` withholds the pair and accepted decisions
 * alone (`decided`, the order read without entities) would not force it to
 * overlap. A pair decisions alone force to overlap is withheld only because a
 * mapped scope lies on the way, and no entity is shared there, so its unknown
 * overlap keeps `overlap_unknown`. The decided lower sets are built only when
 * a withheld pair is asked about.
 */
function entityTakesPart(
  subjects: Iterable<string>,
  order: ScopeOrder,
  decided: ScopeOrder,
  sharesEntity: (left: string, right: string) => boolean,
): (left: string, right: string) => boolean {
  const starts = [...subjects];
  let sets: LowerSets | undefined;
  return (left, right) => {
    if (!sharesEntity(left, right)) return false;
    if (shareAccountEntity(order.entities.get(left), order.entities.get(right))) return true;
    sets ??= lowerSets(
      starts.map((key) => decided.classOf(key)),
      decided,
    );
    const l = sets.position.get(decided.classOf(left));
    const r = sets.position.get(decided.classOf(right));
    if (l === undefined || r === undefined) return true;
    return !bitsMeet(sets.below[l]!, sets.below[r]!);
  };
}

// Only banks whose own deposit readings are in the deposit.balance registry
// entry qualify. An unknown source stays outside this policy (ADR 0093).
const DEPOSIT_INSTITUTIONS = new Map([
  ["sbi-shinsei-bank", "sbi-shinsei"],
  ["smbc-bank", "smbc"],
  ["mizuho-bank", "mizuho"],
]);

/**
 * Which scope pairs the policy declares disjoint, and on what evidence.
 *
 * Within one source: two distinct non-aggregate scopes, because the provider
 * itself listed them as separate accounts or pockets. That is the same
 * account-list evidence a bank's own screen gives, written as an explicit
 * relation so it can be inspected and revoked.
 *
 * Across sources: identified accounts, or direct deposit.balance readings
 * from the metric registry at different listed institutions. The latter
 * excludes aggregate and unresolved scopes and changes no identity mapping.
 *
 * Never between two scopes the current identity mapping maps to one account
 * entity: being listed apart, being identified or sitting at two
 * institutions says nothing when identity says both references are one
 * account, so their overlap stays unknown until a decision accepts them as
 * the same account or a mapping revision separates them (v3). Nor between
 * two scopes that accepted decisions and those mappings force to overlap
 * with a mapped scope on the way (`entitySharing`), so a decision cannot
 * carry a shared entity past the policy.
 *
 * Everything else is deliberately absent. An aggregate or total scope, an
 * aggregator line with no terminal account, and a provider-local label seen
 * through a second route all keep an unknown overlap, which is what makes
 * SC01 and SC06 come out as possible duplicates rather than as sums (INV06).
 */
function policyDisjointness(
  subjects: Map<string, Subject>,
  sharesEntity: (left: string, right: string) => boolean,
): DerivedScopeRelation[] {
  const entries = [...subjects.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const relations: DerivedScopeRelation[] = [];
  for (const [index, [left, leftSubject]] of entries.entries())
    for (const [right, rightSubject] of entries.slice(index + 1)) {
      const sameSource = leftSubject.sourceId === rightSubject.sourceId;
      const listedApart =
        sameSource && leftSubject.status !== "aggregate" && rightSubject.status !== "aggregate";
      const bothIdentified =
        leftSubject.status === "identified" && rightSubject.status === "identified";
      const differentDepositInstitutions =
        leftSubject.depositInstitution !== null &&
        rightSubject.depositInstitution !== null &&
        leftSubject.depositInstitution !== rightSubject.depositInstitution;
      if (!listedApart && !bothIdentified && !differentDepositInstitutions) continue;
      if (sharesEntity(left, right)) continue;
      relations.push({
        fromScopeKey: left,
        toScopeKey: right,
        relation: "disjoint",
        source: "policy",
        decisionRevisionId: null,
        release: DISJOINT_ACCOUNTS_POLICY,
      });
    }
  return relations;
}

interface Outcome {
  state: ProjectionState;
  reasonCode: string | null;
}

function adoptionOutcomes(
  target: AdoptionTarget,
  candidates: readonly ProjectionCandidate[],
  declared: readonly DerivedScopeRelation[],
  order: ScopeOrder,
  decided: ScopeOrder,
): { outcomes: Map<string, Outcome>; relations: DerivedScopeRelation[] } {
  const outcomes = new Map<string, Outcome>();
  const subjects = new Map<string, Subject>();
  for (const candidate of candidates) {
    const institution =
      target.metricId === "deposit.balance" &&
      candidate.authorityRank === AUTHORITY_RANKS.direct &&
      candidate.subjectStatus !== "aggregate" &&
      candidate.subjectStatus !== "unresolved"
        ? (DEPOSIT_INSTITUTIONS.get(candidate.sourceId) ?? null)
        : null;
    const previous = subjects.get(candidate.subjectScopeKey);
    subjects.set(candidate.subjectScopeKey, {
      status: candidate.subjectStatus,
      sourceId: candidate.sourceId,
      // Every witness of a scope must qualify at the same institution. A
      // second unlisted or lower-authority route cannot gain disjointness
      // merely by appearing before a listed witness in the input.
      depositInstitution:
        previous === undefined || previous.depositInstitution === institution ? institution : null,
    });
  }
  if (subjects.size > ADOPTION_SUBJECT_BOUND) {
    for (const candidate of candidates)
      outcomes.set(candidate.scopeKey, {
        state: "unresolved",
        reasonCode: "adoption_target_oversized",
      });
    return { outcomes, relations: [] };
  }
  const sharesEntity = entitySharing(subjects.keys(), order, declared);
  const policy = policyDisjointness(subjects, sharesEntity);
  const claims = [...declared.map(claim), ...policy.map(claim)];
  const measures: MeasureCandidate[] = candidates.map((candidate) => ({
    ref: candidate.scopeKey,
    scopeRef: candidate.subjectScopeKey,
    metricId: target.metricId,
    quantity: { unitRef: candidate.instrument, value: valueOf(candidate) },
    coverage: { completeness: candidate.coverage.completeness },
    ownership: { kind: "full" },
    authorityRank: candidate.authorityRank,
  }));
  const result = selectAdoptedSet(target, measures, claims);
  for (const adopted of result.adopted)
    outcomes.set(adopted.ref, { state: "adopted", reasonCode: null });
  for (const excluded of result.excluded)
    outcomes.set(excluded.ref, { state: "excluded", reasonCode: excluded.reasonCode });
  const namedShared = entitySharingCandidates(
    candidates,
    declared,
    entityTakesPart(subjects.keys(), order, decided, sharesEntity),
    new Set(result.excluded.map((excluded) => excluded.ref)),
  );
  for (const unresolved of result.unresolved)
    outcomes.set(unresolved.ref, {
      state: unresolved.reasonCode === "conflicting_evidence" ? "conflict" : "unresolved",
      reasonCode:
        unresolved.reasonCode === "overlap_unknown" && namedShared.has(unresolved.ref)
          ? ACCOUNT_ENTITY_SHARED
          : unresolved.reasonCode,
    });
  return { outcomes, relations: policy };
}

/**
 * The candidates step 7 of `selectAdoptedSet` leaves unresolved at least
 * because of a contender that is another reference of the same account
 * entity: a candidate of another scope, not excluded, of no worse authority
 * rank (the side step 7 compares against), with no declared relation to it,
 * whose overlap with this one the mapping takes part in (`entityTakesPart`).
 * Only such a candidate's `overlap_unknown` is named `account_entity_shared`;
 * every other unknown overlap keeps its code.
 */
function entitySharingCandidates(
  candidates: readonly ProjectionCandidate[],
  declared: readonly DerivedScopeRelation[],
  namesEntity: (left: string, right: string) => boolean,
  excluded: ReadonlySet<string>,
): Set<string> {
  const related = relatedPairs(declared);
  const found = new Set<string>();
  for (const candidate of candidates) {
    const contender = candidates.some(
      (other) =>
        other.subjectScopeKey !== candidate.subjectScopeKey &&
        !excluded.has(other.scopeKey) &&
        other.authorityRank <= candidate.authorityRank &&
        !related(candidate.subjectScopeKey, other.subjectScopeKey) &&
        namesEntity(candidate.subjectScopeKey, other.subjectScopeKey),
    );
    if (contender) found.add(candidate.scopeKey);
  }
  return found;
}

/**
 * Build the rows of one snapshot. The order is the read contract: the
 * temporal ordering key descending, then the scope key ascending. `rowSeq` is
 * that order made dense, so a cursor is a position rather than a business
 * value.
 */
export function buildBalanceProjection(
  candidates: readonly ProjectionCandidate[],
  declaredRelations: readonly DerivedScopeRelation[],
): ProjectionBuild {
  const byScope = new Set<string>();
  for (const candidate of candidates) {
    if (byScope.has(candidate.scopeKey))
      throw new Error("balance-projection: candidate scope keys must be unique");
    byScope.add(candidate.scopeKey);
  }
  const definitions = new Map<string, MetricDefinition>();
  const targets = new Map<string, ProjectionCandidate[]>();
  for (const candidate of candidates) {
    const definition = resolveMetric({
      family: "balance",
      sourceId: candidate.sourceId,
      parserName: candidate.parserName,
      metric: candidate.metric,
      sourceAccount: candidate.sourceAccount,
      amountBasis: null,
    });
    definitions.set(candidate.scopeKey, definition);
    const key = adoptionTargetKey(definition, candidate);
    const bucket = targets.get(key);
    if (bucket) bucket.push(candidate);
    else targets.set(key, [candidate]);
  }
  const outcomes = new Map<string, Outcome>();
  const policyRelations: DerivedScopeRelation[] = [];
  const order = scopeOrder(candidates, declaredRelations);
  const decided = scopeOrder(candidates, declaredRelations, false);
  for (const [, bucket] of [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = bucket[0]!;
    const target: AdoptionTarget = {
      metricId: definitions.get(first.scopeKey)!.metricId,
      unitRef: first.instrument,
    };
    const relevant = declaredRelations.filter((relation) =>
      bucket.some(
        (candidate) =>
          candidate.subjectScopeKey === relation.fromScopeKey ||
          candidate.subjectScopeKey === relation.toScopeKey,
      ),
    );
    // The target's own relations decide; every decision and every
    // candidate's entity feed the scope order, so a chain through scopes
    // outside the target still counts.
    const resolved = adoptionOutcomes(target, bucket, relevant, order, decided);
    for (const [ref, outcome] of resolved.outcomes) outcomes.set(ref, outcome);
    policyRelations.push(...resolved.relations);
  }

  const rows: Omit<ProjectionRow, "rowSeq">[] = candidates.map((candidate) => {
    const definition = definitions.get(candidate.scopeKey)!;
    const value = valueOf(candidate);
    const adoption = outcomes.get(candidate.scopeKey) ?? {
      state: "unresolved" as const,
      reasonCode: "not_evaluated",
    };
    // Freshness and witness disagreement are stated before the adoption
    // outcome: a row nobody re-observed, or one whose own evidence disagrees,
    // is not described as "excluded because a total covers it".
    const outcome: Outcome =
      candidate.freshness.state === "stale"
        ? { state: "stale", reasonCode: candidate.freshness.reasonCode ?? "no_new_observation" }
        : candidate.witnessConflict
          ? { state: "conflict", reasonCode: "witness_value_conflict" }
          : adoption;
    const temporal = temporalReferenceFor(candidate.asOf, candidate.observedAt);
    const evidence = [
      ...new Map(
        [
          {
            ref: EVIDENCE_REF(candidate.observationId),
            observationId: candidate.observationId,
            metric: candidate.metric,
          },
          ...candidate.memberEvidence,
        ].map((item) => [item.ref, item]),
      ).values(),
    ];
    return {
      scopeKey: candidate.scopeKey,
      subjectScopeKey: candidate.subjectScopeKey,
      representativeObservationRef: EVIDENCE_REF(candidate.observationId),
      memberEvidence: evidence,
      memberMetrics: [...new Set(evidence.map((item) => item.metric))].sort(),
      evidenceCount: evidence.length,
      metricId: definition.metricId,
      definitionRelease: definition.definitionRelease,
      // One definition of the decimal-v1 columns, shared with every CORE
      // writer (packages/storage-d1/src/codecs, U05): a non-exact value writes
      // NULL twice and is never stored as zero.
      quantityCoefficient: encodeDecimal(value).coefficient,
      quantityScale: encodeDecimal(value).scale,
      valueStatus: value.status,
      unitRef: candidate.instrument,
      state: outcome.state,
      reasonCode: outcome.reasonCode,
      asOfRole: temporal.role,
      asOfKind: temporal.time.kind,
      asOfValue:
        temporal.time.kind === "instant" || temporal.time.kind === "local-date"
          ? temporal.time.value
          : null,
      temporal,
      freshness: candidate.freshness.state,
      freshnessReason: candidate.freshness.reasonCode,
      sortAsOf: sortKeyFor(candidate.asOf, candidate.observedAt),
      sourceId: candidate.sourceId,
      sourceAccount: candidate.sourceAccount,
      metric: candidate.metric,
      instrument: candidate.instrument,
      parser: candidate.parser,
      observationId: candidate.observationId,
      parseRunId: candidate.parseRunId,
      fetchArtifactId: candidate.fetchArtifactId,
      amountMinor: candidate.amountMinor,
      amountText: candidate.amountText,
      asOf: candidate.asOf,
      observedAt: candidate.observedAt,
      measureView: candidate.measureView,
      latestInGroup: candidate.latestInGroup,
    };
  });

  rows.sort((a, b) =>
    a.sortAsOf > b.sortAsOf ? -1 : a.sortAsOf < b.sortAsOf ? 1 : a.scopeKey < b.scopeKey ? -1 : 1,
  );
  const ordered: ProjectionRow[] = rows.map((row, index) => ({ ...row, rowSeq: index }));
  const reasons = [
    ...new Set(
      ordered.flatMap((row) =>
        row.state === "adopted" || row.reasonCode === null
          ? []
          : [`${row.state}:${row.reasonCode}`],
      ),
    ),
  ].sort();
  const stale = ordered.some((row) => row.state === "stale" || row.freshness === "stale");
  const unresolved = ordered.some((row) => row.state === "unresolved" || row.state === "conflict");
  const unknownCoverage = candidates.some(
    (candidate) => candidate.coverage.completeness === "unknown",
  );
  return {
    rows: ordered,
    relations: [...declaredRelations, ...dedupe(policyRelations)],
    reasons,
    completeness: unknownCoverage ? "unknown" : unresolved || stale ? "partial" : "complete",
    stale,
  };
}

function dedupe(relations: readonly DerivedScopeRelation[]): DerivedScopeRelation[] {
  const seen = new Map<string, DerivedScopeRelation>();
  for (const relation of relations)
    seen.set(`${relation.fromScopeKey} ${relation.toScopeKey} ${relation.release}`, relation);
  return [...seen.values()];
}

/**
 * Which metrics may be added into a per-unit subtotal of known assets.
 *
 * Only `sum-disjoint` currency stocks with an asset-positive sign and no
 * overlap group qualify. Aggregates, capacities, statement amounts, period
 * totals and reward units are excluded by their own registry entries, and
 * `select-one` measures (a balance reported after a transaction) are excluded
 * because they restate a balance another metric already carries for the same
 * account (INV06). Nothing here makes a metric net-asset eligible: the
 * registry keeps `netAssetEligible: false` for every entry, and the result is
 * published as a known-assets subtotal with unknown liability coverage.
 */
export const KNOWN_ASSETS_POLICY = "known-assets-subtotal-v1";
export function knownAssetMetricIds(): string[] {
  return [
    ...new Set(
      METRIC_REGISTRY.filter(
        ({ definition }) =>
          definition.measurementKind === "stock" &&
          definition.unitDimension === "currency" &&
          definition.signMeaning === "asset-positive" &&
          definition.aggregationRule === "sum-disjoint" &&
          definition.overlapGroup === null,
      ).map(({ definition }) => definition.metricId),
    ),
  ].sort();
}

/** The releases a snapshot id digests; a change in any of them is a new snapshot. */
export interface ProjectionInputs {
  /** Newest published parse run; a later publication is a new context. */
  publishedHighWaterParseRunId: number;
  /**
   * Visible financial fetch runs. An exclusion annotation or an unsealed run
   * changes what a reader may see without publishing anything, so the count
   * and the high-water id are declared inputs too; otherwise a snapshot could
   * keep serving evidence that has since left the visible set.
   */
  visibleFetchRunCount: number;
  visibleFetchRunHighWater: number;
  /**
   * Adopted judgements. A decision that accepts a `same_account` or a
   * containment changes which scopes overlap, and therefore which candidates
   * are adopted, without publishing a single new parse. Counting the adopted
   * relations and the decision revisions makes that a declared input, so a
   * published decision produces a new snapshot id instead of leaving the old
   * one silently wrong. Both tables are append-only, so a count is a sound
   * change detector.
   */
  adoptedRelationCount: number;
  decisionRevisionCount: number;
  identityRelease: string;
  decimalPolicyRelease: string;
}

export interface ProjectionInputManifest extends ProjectionInputs {
  metricRegistryRelease: string;
  projectionRelease: string;
  authorityPolicyRelease: string;
  scopeRelationRelease: string;
}

export function projectionInputManifest(inputs: ProjectionInputs): ProjectionInputManifest {
  return {
    ...inputs,
    metricRegistryRelease: METRIC_REGISTRY_RELEASE,
    projectionRelease: BALANCE_PROJECTION_RELEASE,
    authorityPolicyRelease: AUTHORITY_POLICY_RELEASE,
    scopeRelationRelease: SCOPE_RELATION_RELEASE,
  };
}

/**
 * The build's own identity: the releases and bounds that decide what the
 * captured input becomes. It is the second half of
 * `snapshotId = sha256(inputContentDigest ‖ projectionBuildDigest ‖ contractVersion)`
 * (05 §4), so a code change that would produce different rows from the same
 * input produces a different snapshot instead of overwriting the old one.
 */
export async function projectionBuildDigest(): Promise<string> {
  return await canonicalDigest({
    projectionRelease: BALANCE_PROJECTION_RELEASE,
    metricRegistryRelease: METRIC_REGISTRY_RELEASE,
    authorityPolicyRelease: AUTHORITY_POLICY_RELEASE,
    scopeRelationRelease: SCOPE_RELATION_RELEASE,
    disjointnessPolicy: DISJOINT_ACCOUNTS_POLICY,
    knownAssetsPolicy: KNOWN_ASSETS_POLICY,
    adoptionSubjectBound: ADOPTION_SUBJECT_BOUND,
  });
}
