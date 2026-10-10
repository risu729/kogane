// Pure temporal identity selection (ADR 0055). No reader, writer or policy default.
import { canonicalDigest, canonicalJson } from "./context.ts";
import { canonicalZone } from "./civil-date.ts";
import { validKnownAt, type KnowledgeCut } from "./economic-contract.ts";
import { hasExactKeys, isRecord, isRefList, isSafeInt, isText } from "./guards.ts";
import { canonicalCutInstant } from "./knowledge-selector.ts";
import { validLocalDateText, validTemporalValue, type TemporalValue } from "./time.ts";

export const INSTRUMENT_TEMPORAL_RELEASE = "instrument-temporal-v1";
/** A labelled selection reference, not authority to use a current-only command. */
export const INSTRUMENT_TEMPORAL_CONTEXT_PREFIX = "instrument-temporal:";
/** Also reserve malformed/unknown suffixes: they must never become manual context. */
export function instrumentTemporalContextRequested(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(INSTRUMENT_TEMPORAL_CONTEXT_PREFIX);
}

export const INSTRUMENT_TEMPORAL_BOUNDS = {
  identifiers: 256,
  acceptances: 5_000,
  versions: 5_000,
  legacy: 5_000,
  members: 256,
  periods: 256,
  evidence: 256,
} as const;

export type InstrumentReferenceRole = "trade" | "position" | "price";
/** A supplied contract, never an inferred financial policy. Other bases are unsupported. */
export interface InstrumentIntervalContract {
  version: string;
  endpoints: "half-open";
  basis: "business-date";
  zone: string;
  openEnded: "allowed" | "refused";
  referenceRole: InstrumentReferenceRole;
}
export type InstrumentSeries =
  | { kind: "mapping"; identifierId: string }
  | { kind: "listed_as"; fromRef: string; toRef: string };
export interface InstrumentPeriod {
  from: string;
  end: { kind: "bounded"; to: string } | { kind: "open-ended" };
  evidenceRefs: string[];
  reasonCode: string;
  /** Mapping target, or the assertion on this exact directed relation. */
  assertion: { targetRef: string } | { disposition: "accepted" | "rejected" };
}
export interface InstrumentDecisionVersion {
  versionId: string;
  series: InstrumentSeries;
  coreEpoch: string;
  acceptanceSeq: number;
  supersedes: string | null;
  supersedesLegacy: string[];
  contractVersion: string;
  zone: string;
  validity: { kind: "unknown" } | { kind: "periods"; periods: InstrumentPeriod[] };
  evidenceRefs: string[];
  reasonCode: string;
}
export interface InstrumentAcceptance {
  coreEpoch: string;
  sequence: number;
  knownAt: string;
  members: { versionId: string; series: InstrumentSeries; supersedes: string | null }[];
}
export interface InstrumentLegacyIdentity {
  id: string;
  series: InstrumentSeries;
  evidenceRefs: string[];
}
/** Complete journal and complete version/member rows, including unrelated members. */
export interface InstrumentTemporalInput {
  coreEpoch: string;
  acceptances: InstrumentAcceptance[];
  versions: InstrumentDecisionVersion[];
  legacy: InstrumentLegacyIdentity[];
}
export interface InstrumentTemporalRequest {
  identifierIds: string[];
  knowledge: { mode: "current" } | { mode: "known-at"; cut: KnowledgeCut };
  effective: { role: InstrumentReferenceRole; confirmed: boolean; time: TemporalValue };
  contract: InstrumentIntervalContract;
}
export type InstrumentTemporalReason =
  | "invalid_input"
  | "selector_bound_exceeded"
  | "invalid_cut"
  | "epoch_mismatch"
  | "journal_inconsistent"
  | "membership_inconsistent"
  | "chain_inconsistent"
  | "invalid_interval_set"
  | "unsupported_contract"
  | "reference_unresolved"
  | "validity_unknown"
  | "relation_validity_unknown"
  | "knowledge_unlogged"
  | "outside_coverage"
  | "mapping_relation_conflict";
export interface InstrumentTemporalOutcome {
  identifierId: string;
  status: "resolved" | "unresolved" | "conflict";
  targetRef: string | null;
  mappingVersionId: string | null;
  relationVersionIds: string[];
  legacyIds: string[];
  reasonCodes: InstrumentTemporalReason[];
  evidenceRefs: string[];
}
export interface InstrumentSelectedRelation {
  series: Extract<InstrumentSeries, { kind: "listed_as" }>;
  versionId: string;
  status: "applicable" | "released" | "unresolved";
  disposition: "accepted" | "rejected" | null;
  reasonCodes: InstrumentTemporalReason[];
  evidenceRefs: string[];
}
export interface InstrumentTemporalSelectionBody {
  selectorRelease: typeof INSTRUMENT_TEMPORAL_RELEASE;
  contract: InstrumentIntervalContract;
  effective: InstrumentTemporalRequest["effective"];
  resolvedCut: { coreEpoch: string; commitSeq: number; knownAt: string | null };
  acceptances: InstrumentAcceptance[];
  versions: InstrumentDecisionVersion[];
  legacy: InstrumentLegacyIdentity[];
  outcomes: InstrumentTemporalOutcome[];
  relations: InstrumentSelectedRelation[];
}
export type InstrumentTemporalSelection =
  | { status: "refused"; reasonCode: InstrumentTemporalReason }
  | {
      status: "selected";
      setVersion: string;
      contextId: string;
      /** Use this labelled reference at command boundaries; contextId remains the digest. */
      contextRef: string;
      manifest: {
        request: InstrumentTemporalRequest;
        cutStanding: "final" | "provisional";
        setVersion: string;
        selection: InstrumentTemporalSelectionBody;
      };
    };

const textOrNull = (v: unknown): v is string | null => v === null || isText(v);
const role = (v: unknown): v is InstrumentReferenceRole =>
  v === "trade" || v === "position" || v === "price";
/** Holes are absent evidence, never an explicit empty set or a relation release. */
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false;
  return true;
}
const refs = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= INSTRUMENT_TEMPORAL_BOUNDS.evidence &&
  denseArray(v) &&
  isRefList(v, INSTRUMENT_TEMPORAL_BOUNDS.evidence);
function validSeries(v: unknown): v is InstrumentSeries {
  if (!isRecord(v)) return false;
  return v.kind === "mapping"
    ? hasExactKeys(v, ["kind", "identifierId"]) && isText(v.identifierId)
    : v.kind === "listed_as" &&
        hasExactKeys(v, ["kind", "fromRef", "toRef"]) &&
        isText(v.fromRef) &&
        isText(v.toRef) &&
        v.fromRef !== v.toRef;
}
function seriesKey(v: InstrumentSeries): string {
  return canonicalJson(v);
}
function validPeriod(v: unknown, kind: InstrumentSeries["kind"]): v is InstrumentPeriod {
  if (
    !isRecord(v) ||
    !hasExactKeys(v, ["from", "end", "evidenceRefs", "reasonCode", "assertion"]) ||
    !validLocalDateText(v.from) ||
    !refs(v.evidenceRefs) ||
    v.evidenceRefs.length === 0 ||
    !isText(v.reasonCode, 64) ||
    !isRecord(v.end) ||
    !isRecord(v.assertion)
  )
    return false;
  const end =
    v.end.kind === "open-ended"
      ? hasExactKeys(v.end, ["kind"])
      : v.end.kind === "bounded" &&
        hasExactKeys(v.end, ["kind", "to"]) &&
        validLocalDateText(v.end.to) &&
        v.from < v.end.to;
  const assertion =
    kind === "mapping"
      ? hasExactKeys(v.assertion, ["targetRef"]) && isText(v.assertion.targetRef)
      : hasExactKeys(v.assertion, ["disposition"]) &&
        (v.assertion.disposition === "accepted" || v.assertion.disposition === "rejected");
  return end && assertion;
}
function validVersion(v: unknown): v is InstrumentDecisionVersion {
  if (
    !isRecord(v) ||
    !hasExactKeys(v, [
      "versionId",
      "series",
      "coreEpoch",
      "acceptanceSeq",
      "supersedes",
      "supersedesLegacy",
      "contractVersion",
      "zone",
      "validity",
      "evidenceRefs",
      "reasonCode",
    ]) ||
    !isText(v.versionId) ||
    !validSeries(v.series) ||
    !isText(v.coreEpoch, 64) ||
    !isSafeInt(v.acceptanceSeq, 1) ||
    !textOrNull(v.supersedes) ||
    !refs(v.supersedesLegacy) ||
    !isText(v.contractVersion) ||
    !isText(v.zone, 64) ||
    !refs(v.evidenceRefs) ||
    v.evidenceRefs.length === 0 ||
    !isText(v.reasonCode, 64) ||
    !isRecord(v.validity)
  )
    return false;
  if (v.validity.kind === "unknown") return hasExactKeys(v.validity, ["kind"]);
  const seriesKind = v.series.kind;
  return (
    v.validity.kind === "periods" &&
    hasExactKeys(v.validity, ["kind", "periods"]) &&
    Array.isArray(v.validity.periods) &&
    v.validity.periods.length <= INSTRUMENT_TEMPORAL_BOUNDS.periods &&
    denseArray(v.validity.periods) &&
    v.validity.periods.every((p) => validPeriod(p, seriesKind))
  );
}
function validAcceptance(v: unknown): v is InstrumentAcceptance {
  return (
    isRecord(v) &&
    hasExactKeys(v, ["coreEpoch", "sequence", "knownAt", "members"]) &&
    isText(v.coreEpoch, 64) &&
    isSafeInt(v.sequence, 1) &&
    validKnownAt(v.knownAt) &&
    Array.isArray(v.members) &&
    v.members.length > 0 &&
    v.members.length <= INSTRUMENT_TEMPORAL_BOUNDS.members &&
    denseArray(v.members) &&
    v.members.every(
      (m) =>
        isRecord(m) &&
        hasExactKeys(m, ["versionId", "series", "supersedes"]) &&
        isText(m.versionId) &&
        validSeries(m.series) &&
        textOrNull(m.supersedes),
    )
  );
}
function validLegacy(v: unknown): v is InstrumentLegacyIdentity {
  return (
    isRecord(v) &&
    hasExactKeys(v, ["id", "series", "evidenceRefs"]) &&
    isText(v.id) &&
    validSeries(v.series) &&
    refs(v.evidenceRefs)
  );
}
function validRequest(v: unknown): v is InstrumentTemporalRequest {
  if (
    !isRecord(v) ||
    !hasExactKeys(v, ["identifierIds", "knowledge", "effective", "contract"]) ||
    !isRefList(v.identifierIds, INSTRUMENT_TEMPORAL_BOUNDS.identifiers) ||
    !denseArray(v.identifierIds) ||
    v.identifierIds.length === 0 ||
    !isRecord(v.knowledge) ||
    !isRecord(v.effective) ||
    !isRecord(v.contract)
  )
    return false;
  const k = v.knowledge;
  const knowledge =
    k.mode === "current"
      ? hasExactKeys(k, ["mode"])
      : k.mode === "known-at" &&
        hasExactKeys(k, ["mode", "cut"]) &&
        isRecord(k.cut) &&
        isText(k.cut.coreEpoch, 64) &&
        ((hasExactKeys(k.cut, ["coreEpoch", "commitSeq"]) && isSafeInt(k.cut.commitSeq, 0)) ||
          (hasExactKeys(k.cut, ["coreEpoch", "instant"]) && isText(k.cut.instant, 64)));
  const c = v.contract;
  return (
    knowledge &&
    hasExactKeys(v.effective, ["role", "confirmed", "time"]) &&
    role(v.effective.role) &&
    typeof v.effective.confirmed === "boolean" &&
    validTemporalValue(v.effective.time) &&
    hasExactKeys(c, ["version", "endpoints", "basis", "zone", "openEnded", "referenceRole"]) &&
    isText(c.version) &&
    c.endpoints === "half-open" &&
    c.basis === "business-date" &&
    isText(c.zone, 64) &&
    (c.openEnded === "allowed" || c.openEnded === "refused") &&
    role(c.referenceRole)
  );
}
const uniqueSorted = (v: readonly string[]): string[] => [...new Set(v)].sort();
function canonicalVersion(v: InstrumentDecisionVersion): InstrumentDecisionVersion {
  return {
    ...v,
    evidenceRefs: uniqueSorted(v.evidenceRefs),
    supersedesLegacy: uniqueSorted(v.supersedesLegacy),
    validity:
      v.validity.kind === "unknown"
        ? v.validity
        : {
            kind: "periods",
            periods: [...v.validity.periods]
              .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
              .map((p) => ({ ...p, evidenceRefs: uniqueSorted(p.evidenceRefs) })),
          },
  };
}
function intervalError(
  v: InstrumentDecisionVersion,
  contract: InstrumentIntervalContract,
): boolean {
  if (
    v.contractVersion !== contract.version ||
    v.zone !== contract.zone ||
    canonicalZone(v.zone) !== v.zone
  )
    return true;
  if (v.validity.kind === "unknown") return false;
  const periods = [...v.validity.periods].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    if (p.end.kind === "open-ended" && contract.openEnded === "refused") return true;
    if (i > 0) {
      const previous = periods[i - 1]!;
      if (previous.end.kind === "open-ended" || previous.end.to > p.from) return true;
    }
  }
  return false;
}
function periodAt(v: InstrumentDecisionVersion, date: string): InstrumentPeriod | null {
  if (v.validity.kind === "unknown") return null;
  return (
    v.validity.periods.find(
      (p) => p.from <= date && (p.end.kind === "open-ended" || date < p.end.to),
    ) ?? null
  );
}
const refuses = (reasonCode: InstrumentTemporalReason): InstrumentTemporalSelection => ({
  status: "refused",
  reasonCode,
});

/**
 * All acceptance memberships and chains are validated before effective filtering.
 * This validates a supplied immutable snapshot; it cannot prove a database batch
 * was atomic, a loader was complete, or a caller was authorized.
 */
export async function selectInstrumentTemporal(
  input: unknown,
  request: unknown,
): Promise<InstrumentTemporalSelection> {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["coreEpoch", "acceptances", "versions", "legacy"]) ||
    !isText(input.coreEpoch, 64) ||
    !Array.isArray(input.acceptances) ||
    !Array.isArray(input.versions) ||
    !Array.isArray(input.legacy)
  )
    return refuses("invalid_input");
  if (
    input.acceptances.length > INSTRUMENT_TEMPORAL_BOUNDS.acceptances ||
    input.versions.length > INSTRUMENT_TEMPORAL_BOUNDS.versions ||
    input.legacy.length > INSTRUMENT_TEMPORAL_BOUNDS.legacy ||
    (isRecord(request) &&
      Array.isArray(request.identifierIds) &&
      request.identifierIds.length > INSTRUMENT_TEMPORAL_BOUNDS.identifiers)
  )
    return refuses("selector_bound_exceeded");
  if (
    !denseArray(input.acceptances) ||
    !denseArray(input.versions) ||
    !denseArray(input.legacy) ||
    !input.acceptances.every(validAcceptance) ||
    !input.versions.every(validVersion) ||
    !input.legacy.every(validLegacy) ||
    !validRequest(request)
  )
    return refuses("invalid_input");
  // Copy synchronously before any digest yields: returned pins never alias caller arrays.
  let data: InstrumentTemporalInput;
  let req: InstrumentTemporalRequest;
  try {
    data = JSON.parse(canonicalJson(input)) as InstrumentTemporalInput;
    req = JSON.parse(canonicalJson(request)) as InstrumentTemporalRequest;
  } catch {
    return refuses("invalid_input");
  }
  req.identifierIds.sort();
  if (canonicalZone(req.contract.zone) !== req.contract.zone)
    return refuses("unsupported_contract");
  const journal = [...data.acceptances].sort((a, b) => a.sequence - b.sequence);
  const versions = new Map(data.versions.map((v) => [v.versionId, v]));
  const legacy = new Map(data.legacy.map((v) => [v.id, v]));
  if (
    versions.size !== data.versions.length ||
    legacy.size !== data.legacy.length ||
    data.versions.some((v) => legacy.has(v.versionId))
  )
    return refuses("membership_inconsistent");
  let previousTime: string | null = null;
  const membership = new Map<string, InstrumentAcceptance>();
  for (let i = 0; i < journal.length; i++) {
    const a = journal[i]!;
    if (a.coreEpoch !== data.coreEpoch) return refuses("epoch_mismatch");
    if (a.sequence !== i + 1 || (previousTime !== null && a.knownAt < previousTime))
      return refuses("journal_inconsistent");
    previousTime = a.knownAt;
    const series = new Set<string>();
    for (const m of a.members) {
      const key = seriesKey(m.series);
      const v = versions.get(m.versionId);
      if (
        membership.has(m.versionId) ||
        series.has(key) ||
        !v ||
        v.coreEpoch !== data.coreEpoch ||
        v.acceptanceSeq !== a.sequence ||
        seriesKey(v.series) !== key ||
        v.supersedes !== m.supersedes
      )
        return refuses("membership_inconsistent");
      membership.set(m.versionId, a);
      series.add(key);
    }
  }
  if (membership.size !== versions.size) return refuses("membership_inconsistent");
  const heads = new Map<string, InstrumentDecisionVersion>();
  const legacySuperseders = new Map<string, InstrumentDecisionVersion>();
  for (const a of journal)
    for (const m of a.members) {
      const v = versions.get(m.versionId)!;
      const key = seriesKey(v.series);
      const before = heads.get(key);
      if ((before?.versionId ?? null) !== v.supersedes) return refuses("chain_inconsistent");
      for (const id of v.supersedesLegacy) {
        const old = legacy.get(id);
        if (!old || seriesKey(old.series) !== key || legacySuperseders.has(id))
          return refuses("chain_inconsistent");
        legacySuperseders.set(id, v);
      }
      heads.set(key, v);
    }
  let sequence = journal.length;
  let standing: "final" | "provisional" = "final";
  if (req.knowledge.mode === "known-at") {
    const cut = req.knowledge.cut;
    if (cut.coreEpoch !== data.coreEpoch) return refuses("epoch_mismatch");
    if ("commitSeq" in cut) {
      if (cut.commitSeq > journal.length) return refuses("invalid_cut");
      sequence = cut.commitSeq;
    } else {
      const bound = canonicalCutInstant(cut.instant);
      if (bound === null) return refuses("invalid_cut");
      sequence = journal.filter((a) => a.knownAt <= bound).at(-1)?.sequence ?? 0;
      standing = previousTime === null || bound >= previousTime ? "provisional" : "final";
    }
  }
  const atCut = new Map<string, InstrumentDecisionVersion>();
  for (const a of journal)
    if (a.sequence <= sequence)
      for (const m of a.members) {
        const v = versions.get(m.versionId)!;
        atCut.set(seriesKey(v.series), v);
      }
  const identifiers = new Set(req.identifierIds);
  const relevant = (series: InstrumentSeries): boolean =>
    series.kind === "mapping"
      ? identifiers.has(series.identifierId)
      : identifiers.has(series.toRef);
  const selected = [...atCut.values()]
    .filter((v) => relevant(v.series))
    .map(canonicalVersion)
    .sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0));
  if (selected.some((v) => intervalError(v, req.contract))) return refuses("invalid_interval_set");
  const unlogged = data.legacy
    .filter(
      (v) =>
        relevant(v.series) && (legacySuperseders.get(v.id)?.acceptanceSeq ?? Infinity) > sequence,
    )
    .map((v) => ({ ...v, evidenceRefs: uniqueSorted(v.evidenceRefs) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const effective = req.effective;
  const time = effective.time;
  const date =
    effective.confirmed &&
    effective.role === req.contract.referenceRole &&
    time.kind === "local-date" &&
    time.basis === "provider" &&
    time.zone === req.contract.zone &&
    validLocalDateText(time.value)
      ? time.value
      : null;
  const relations: InstrumentSelectedRelation[] = selected
    .filter((v) => v.series.kind === "listed_as")
    .map((v) => {
      const p = date === null ? null : periodAt(v, date);
      const release = v.validity.kind === "periods" && v.validity.periods.length === 0;
      const unknown = v.validity.kind === "unknown";
      return {
        series: v.series as Extract<InstrumentSeries, { kind: "listed_as" }>,
        versionId: v.versionId,
        status:
          date === null ? "unresolved" : release ? "released" : p ? "applicable" : "unresolved",
        disposition: p && "disposition" in p.assertion ? p.assertion.disposition : null,
        reasonCodes:
          date === null
            ? ["reference_unresolved"]
            : release
              ? []
              : p
                ? []
                : unknown
                  ? ["relation_validity_unknown"]
                  : ["outside_coverage"],
        evidenceRefs: uniqueSorted([...v.evidenceRefs, ...(p?.evidenceRefs ?? [])]),
      };
    });
  const outcomes: InstrumentTemporalOutcome[] = req.identifierIds.map((identifierId) => {
    const v = selected.find(
      (v) => v.series.kind === "mapping" && v.series.identifierId === identifierId,
    );
    const rs = relations.filter((r) => r.series.toRef === identifierId);
    const olds = unlogged.filter((v) =>
      v.series.kind === "mapping"
        ? v.series.identifierId === identifierId
        : v.series.toRef === identifierId,
    );
    const reasons: InstrumentTemporalReason[] = [];
    if (date === null) reasons.push("reference_unresolved");
    const p = v && date !== null ? periodAt(v, date) : null;
    if (!v || v.validity.kind === "unknown") reasons.push("validity_unknown");
    else if (date !== null && !p) reasons.push("outside_coverage");
    if (olds.length > 0) reasons.push("knowledge_unlogged");
    if (olds.some((v) => v.series.kind === "listed_as")) reasons.push("relation_validity_unknown");
    // A relevant unknown/released/gapped relation is no affirmative proof. A
    // release/gap does not obstruct an independently evidenced mapping; legacy
    // and explicitly unknown validity do obstruct it.
    if (rs.some((r) => r.reasonCodes.includes("relation_validity_unknown")))
      reasons.push("relation_validity_unknown");
    const target = p && "targetRef" in p.assertion ? p.assertion.targetRef : null;
    const conflict =
      target !== null &&
      rs.some(
        (r) =>
          r.status === "applicable" && r.disposition === "rejected" && r.series.fromRef === target,
      );
    if (conflict) reasons.push("mapping_relation_conflict");
    return {
      identifierId,
      status: conflict
        ? "conflict"
        : reasons.length === 0 && target !== null
          ? "resolved"
          : "unresolved",
      targetRef: reasons.length === 0 ? target : null,
      mappingVersionId: v?.versionId ?? null,
      relationVersionIds: uniqueSorted(rs.map((r) => r.versionId)),
      legacyIds: olds.map((v) => v.id),
      reasonCodes: uniqueSorted(reasons) as InstrumentTemporalReason[],
      evidenceRefs: uniqueSorted([
        ...(v?.evidenceRefs ?? []),
        ...(p?.evidenceRefs ?? []),
        ...rs.flatMap((r) => r.evidenceRefs),
        ...olds.flatMap((v) => v.evidenceRefs),
      ]),
    };
  });
  const selection: InstrumentTemporalSelectionBody = {
    selectorRelease: INSTRUMENT_TEMPORAL_RELEASE,
    contract: req.contract,
    effective: req.effective,
    resolvedCut: {
      coreEpoch: data.coreEpoch,
      commitSeq: sequence,
      knownAt: journal[sequence - 1]?.knownAt ?? null,
    },
    acceptances: journal
      .filter((a) => selected.some((v) => v.acceptanceSeq === a.sequence))
      .map((a) => ({
        ...a,
        members: [...a.members].sort((a, b) =>
          a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0,
        ),
      })),

    versions: selected,
    legacy: unlogged,
    outcomes,
    relations,
  };
  const setVersion = await canonicalDigest(selection);
  const manifest = { request: req, cutStanding: standing, setVersion, selection };
  const contextId = await canonicalDigest(manifest);
  return {
    status: "selected",
    setVersion,
    contextId,
    contextRef: `${INSTRUMENT_TEMPORAL_CONTEXT_PREFIX}${contextId}`,
    manifest,
  };
}
