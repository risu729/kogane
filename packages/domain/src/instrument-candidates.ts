// Cross-identifier instrument candidates (ADR 0046, docs/identity.md).
//
// Two stored instrument identifiers can denote the same instrument: the same
// security seen under a listing identifier at one source and under a bare
// provider code at another, or at two brokers. This module only ever
// *proposes* that. It reads the identifier facts the identity rules already
// stored, pairs identifiers that share an identifier value of a closed list
// (ISIN, RIC, country-scoped security code), keeps apart every pair whose
// stated market, currency, share class, product class, country or instrument
// kind disagree, and names what it could not compare. Nothing here changes a
// mapping: adoption is a human `identity.assign` through the change lifecycle,
// and a candidate whose two identifiers already map to one instrument is
// reported as adopted because of that mapping, never because of this module
// (INV07).
//
// A display name is never evidence. Two identifiers whose names are equal
// after normalisation, and that share no identifier value, are at most a
// `hint`: a separate list with no status and nothing to adopt.
import { RELATION_STATUS_STORAGE, type StoredRelationStatus } from "./decisions.ts";

/** The policy every answer names, so a later rule change is a new context. */
export const INSTRUMENT_CANDIDATE_POLICY = "instrument-candidates-v1";

/** Instrument kinds a candidate can pair. Money and reward units are out of scope. */
export const CANDIDATE_INSTRUMENT_KINDS = ["security", "crypto", "product"] as const;

/** Pairs one answer may evaluate; a larger store is refused, never cut. */
export const CANDIDATE_PAIR_LIMIT = 5_000;
/** Name hints one answer may list; a larger set is refused, never cut. */
export const CANDIDATE_HINT_LIMIT = 1_000;

/**
 * What the identity rules stored about one identifier, plus where it is used.
 * Every field is a stored fact or `null`; nothing is inferred from a name.
 */
export interface InstrumentIdentifierFacts {
  /** `instrument_identifiers.id`. */
  identifierId: string;
  /** The current mapping's target, `instruments.id`. */
  instrumentId: string;
  /** How the current mapping was made. */
  mappingMethod: "rule" | "manual";
  /** The current target instrument's kind. */
  kind: string;
  namespace: string;
  scope: string;
  value: string;
  /** Source ids whose currently published observations use the identifier, sorted. */
  sources: readonly string[];
  /**
   * An ISIN as an identity rule recorded it, or null. Validating its format is
   * the recording rule's job; no rule records one today.
   */
  isin: string | null;
  /** The country the identity rule recorded for the code, as recorded. */
  countryCode: string | null;
  /** The provider's security code, as recorded. */
  securityCode: string | null;
  /** An ISO 10383 market the identity rule resolved, or null. */
  mic: string | null;
  /** A provider-reported RIC, or null. */
  ric: string | null;
  shareClass: string | null;
  productClass: string | null;
  /**
   * Distinct currencies the observations using it as a security state its
   * trade or amount in, sorted. Empty when no observation states one.
   */
  currencies: readonly string[];
  /** Display only. Never evidence. */
  label: string;
}

/** Shared identifier values that make a pair a candidate. A closed list. */
export const CANDIDATE_EVIDENCE = ["isin-equal", "ric-equal", "security-code-equal"] as const;
export type CandidateEvidence = (typeof CANDIDATE_EVIDENCE)[number];

/** Stated facts on both sides that disagree: the pair is kept apart. */
export const CANDIDATE_CONFLICTS = [
  "kind-differs",
  "isin-differs",
  "ric-differs",
  "country-differs",
  "market-differs",
  "currency-differs",
  "share-class-differs",
  "product-class-differs",
] as const;
export type CandidateConflict = (typeof CANDIDATE_CONFLICTS)[number];

/** Stated facts on both sides that agree. */
export const CANDIDATE_AGREEMENTS = [
  "kind-agrees",
  "country-agrees",
  "market-agrees",
  "currency-agrees",
  "share-class-agrees",
  "product-class-agrees",
] as const;
export type CandidateAgreement = (typeof CANDIDATE_AGREEMENTS)[number];

/** Facts one side or both sides do not state, so they could not be compared. */
export const CANDIDATE_GAPS = [
  "isin-unconfirmed",
  "market-unconfirmed",
  "currency-unconfirmed",
  "share-class-unconfirmed",
  "product-class-unconfirmed",
] as const;
export type CandidateGap = (typeof CANDIDATE_GAPS)[number];

/**
 * Where a candidate stands, read from stored records only:
 * - `adopted`: both identifiers currently map to one instrument;
 * - `rejected`: the latest `listed_as` relation between one identifier and the
 *   other's current instrument is rejected, and they do not share one;
 * - `proposed`: neither.
 */
export const CANDIDATE_STATUSES = ["proposed", "adopted", "rejected"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface InstrumentCandidate {
  /** Orientation-free id: `instrument-candidate:<lower id>|<higher id>`. */
  candidateId: string;
  /** The identifier whose instrument the subject would be assigned to. */
  anchorIdentifierId: string;
  /** The identifier an adoption would re-map. */
  subjectIdentifierId: string;
  evidence: CandidateEvidence[];
  agreements: CandidateAgreement[];
  gaps: CandidateGap[];
  /** The two identifiers are used by different sources. */
  crossSource: boolean;
  status: CandidateStatus;
}

/** A pair that shares an identifier value but states a conflicting fact. */
export interface SeparatedPair {
  pairId: string;
  identifierIds: [string, string];
  evidence: CandidateEvidence[];
  conflicts: CandidateConflict[];
  /**
   * The two already map to one instrument (a manual decision): the stated
   * facts now contradict that decision, which stays as it is until a person
   * corrects it.
   */
  sharedInstrument: boolean;
}

/** Equal display names and no shared identifier value. Never adoptable. */
export interface NameHint {
  pairId: string;
  identifierIds: [string, string];
  reason: "same-display-name";
  /** Stated facts that already show the two apart. */
  conflicts: CandidateConflict[];
}

export interface InstrumentCandidateSet {
  policy: typeof INSTRUMENT_CANDIDATE_POLICY;
  candidates: InstrumentCandidate[];
  separated: SeparatedPair[];
  hints: NameHint[];
}

export type InstrumentCandidateResult =
  | { ok: true; set: InstrumentCandidateSet }
  | { ok: false; error: "candidate_limit_exceeded" | "duplicate_identifier" };

/**
 * The latest `listed_as` status per relation, keyed by `listedAsKey`. The
 * caller reads the newest row per (from, to) as the change lifecycle does.
 */
export type ListedAsStatuses = ReadonlyMap<string, StoredRelationStatus>;

export function listedAsKey(instrumentId: string, identifierId: string): string {
  return `instrument:${instrumentId}|identifier:${identifierId}`;
}

/**
 * Normalised display name for the hint comparison only: NFKC, whitespace
 * collapsed, lower case. Equality after this is the only "similarity" used.
 */
export function normalisedDisplayName(label: string): string {
  return label.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

interface Comparison {
  evidence: CandidateEvidence[];
  conflicts: CandidateConflict[];
  agreements: CandidateAgreement[];
  gaps: CandidateGap[];
}

function compareOptional(
  a: string | null,
  b: string | null,
  out: Comparison,
  codes: { agree: CandidateAgreement; differ: CandidateConflict; gap: CandidateGap },
): void {
  if (a !== null && b !== null) {
    if (a === b) out.agreements.push(codes.agree);
    else out.conflicts.push(codes.differ);
  } else if (a !== null || b !== null) out.gaps.push(codes.gap);
}

/** Compares two identifiers' stated facts. Names are not read. */
export function compareIdentifierFacts(
  a: InstrumentIdentifierFacts,
  b: InstrumentIdentifierFacts,
): Comparison {
  const out: Comparison = { evidence: [], conflicts: [], agreements: [], gaps: [] };
  if (a.kind === b.kind) out.agreements.push("kind-agrees");
  else out.conflicts.push("kind-differs");

  if (a.isin !== null && b.isin !== null) {
    if (a.isin === b.isin) out.evidence.push("isin-equal");
    else out.conflicts.push("isin-differs");
  } else if (a.isin !== null || b.isin !== null) out.gaps.push("isin-unconfirmed");

  // A RIC names one listing: two different RICs are two listings, whatever
  // else they share.
  const bothRic = a.ric !== null && b.ric !== null;
  if (bothRic) {
    if (a.ric === b.ric) out.evidence.push("ric-equal");
    else out.conflicts.push("ric-differs");
  }

  if (a.countryCode !== null && b.countryCode !== null) {
    if (a.countryCode === b.countryCode) {
      out.agreements.push("country-agrees");
      if (a.securityCode !== null && a.securityCode === b.securityCode)
        out.evidence.push("security-code-equal");
    } else out.conflicts.push("country-differs");
  }

  // Market: only standardised identifiers are compared. A provider's own
  // market wording is not comparable across datasets or providers, so a pair
  // without two MICs (or two equal RICs) has an unconfirmed market.
  if (a.mic !== null && b.mic !== null) {
    if (a.mic === b.mic) out.agreements.push("market-agrees");
    else out.conflicts.push("market-differs");
  } else if (bothRic && a.ric === b.ric) out.agreements.push("market-agrees");
  else if (!bothRic) out.gaps.push("market-unconfirmed");

  // Currency: two single stated currencies agree or differ; two disjoint sets
  // differ; anything else (none stated, several stated) is unconfirmed.
  const shared = a.currencies.filter((currency) => b.currencies.includes(currency));
  if (a.currencies.length > 0 && b.currencies.length > 0 && shared.length === 0)
    out.conflicts.push("currency-differs");
  else if (a.currencies.length === 1 && b.currencies.length === 1)
    out.agreements.push("currency-agrees");
  else out.gaps.push("currency-unconfirmed");

  compareOptional(a.shareClass, b.shareClass, out, {
    agree: "share-class-agrees",
    differ: "share-class-differs",
    gap: "share-class-unconfirmed",
  });
  compareOptional(a.productClass, b.productClass, out, {
    agree: "product-class-agrees",
    differ: "product-class-differs",
    gap: "product-class-unconfirmed",
  });
  return out;
}

/** ISIN-bearing identifiers first, then listing identifiers (RIC, MIC), then provider codes; ties by id. */
function anchorRank(facts: InstrumentIdentifierFacts): number {
  if (facts.isin !== null) return 0;
  if (facts.ric !== null || facts.mic !== null) return 1;
  return 2;
}

function orient(
  a: InstrumentIdentifierFacts,
  b: InstrumentIdentifierFacts,
): [InstrumentIdentifierFacts, InstrumentIdentifierFacts] {
  const rank = anchorRank(a) - anchorRank(b);
  if (rank !== 0) return rank < 0 ? [a, b] : [b, a];
  return a.identifierId < b.identifierId ? [a, b] : [b, a];
}

function byIdentifier(a: InstrumentIdentifierFacts, b: InstrumentIdentifierFacts): number {
  return a.identifierId < b.identifierId ? -1 : a.identifierId > b.identifierId ? 1 : 0;
}

function pairId(prefix: string, a: string, b: string): string {
  return a < b ? `${prefix}:${a}|${b}` : `${prefix}:${b}|${a}`;
}

/** Both identifiers are used by one source only, the same one. */
function sameSingleSource(a: InstrumentIdentifierFacts, b: InstrumentIdentifierFacts): boolean {
  return a.sources.length === 1 && b.sources.length === 1 && a.sources[0] === b.sources[0];
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function candidateStatus(
  anchor: InstrumentIdentifierFacts,
  subject: InstrumentIdentifierFacts,
  listedAs: ListedAsStatuses,
): CandidateStatus {
  if (anchor.instrumentId === subject.instrumentId) return "adopted";
  // Either orientation: which identifier is the anchor can change when an
  // identifier later gains an ISIN, and a rejection must not be lost then.
  const rejected = [
    listedAs.get(listedAsKey(anchor.instrumentId, subject.identifierId)),
    listedAs.get(listedAsKey(subject.instrumentId, anchor.identifierId)),
  ].some((status) => status === RELATION_STATUS_STORAGE.rejected);
  return rejected ? "rejected" : "proposed";
}

/** Evidence keys an identifier carries, so only pairs that share one are compared. */
function evidenceKeys(facts: InstrumentIdentifierFacts): string[] {
  const keys: string[] = [];
  if (facts.isin !== null) keys.push(`isin\u0000${facts.isin}`);
  if (facts.ric !== null) keys.push(`ric\u0000${facts.ric}`);
  if (facts.countryCode !== null && facts.securityCode !== null)
    keys.push(`code\u0000${facts.countryCode}\u0000${facts.securityCode}`);
  return keys;
}

/**
 * Every candidate, separated pair and name hint among `facts`. Deterministic
 * and independent of input order. Identifiers outside
 * `CANDIDATE_INSTRUMENT_KINDS` are ignored.
 */
export function instrumentCandidates(
  facts: readonly InstrumentIdentifierFacts[],
  listedAs: ListedAsStatuses = new Map(),
): InstrumentCandidateResult {
  const eligible = facts
    .filter((row) => (CANDIDATE_INSTRUMENT_KINDS as readonly string[]).includes(row.kind))
    .sort(byIdentifier);
  const byId = new Map<string, InstrumentIdentifierFacts>();
  for (const row of eligible) {
    if (byId.has(row.identifierId)) return { ok: false, error: "duplicate_identifier" };
    byId.set(row.identifierId, row);
  }

  const groups = new Map<string, string[]>();
  for (const row of eligible)
    for (const key of evidenceKeys(row)) {
      const members = groups.get(key) ?? [];
      members.push(row.identifierId);
      groups.set(key, members);
    }
  const pairs = new Set<string>();
  for (const members of groups.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        pairs.add(`${members[i]}\u0000${members[j]}`);
        if (pairs.size > CANDIDATE_PAIR_LIMIT)
          return { ok: false, error: "candidate_limit_exceeded" };
      }

  const candidates: InstrumentCandidate[] = [];
  const separated: SeparatedPair[] = [];
  for (const pair of [...pairs].sort()) {
    const [leftId, rightId] = pair.split("\u0000") as [string, string];
    const left = byId.get(leftId)!;
    const right = byId.get(rightId)!;
    const comparison = compareIdentifierFacts(left, right);
    if (comparison.evidence.length === 0) continue;
    if (comparison.conflicts.length > 0) {
      separated.push({
        pairId: pairId("instrument-pair", leftId, rightId),
        identifierIds: sortedPair(leftId, rightId),
        evidence: comparison.evidence,
        conflicts: comparison.conflicts,
        sharedInstrument: left.instrumentId === right.instrumentId,
      });
      continue;
    }
    const [anchor, subject] = orient(left, right);
    candidates.push({
      candidateId: pairId("instrument-candidate", leftId, rightId),
      anchorIdentifierId: anchor.identifierId,
      subjectIdentifierId: subject.identifierId,
      evidence: comparison.evidence,
      agreements: comparison.agreements,
      gaps: comparison.gaps,
      crossSource: !sameSingleSource(anchor, subject),
      status: candidateStatus(anchor, subject, listedAs),
    });
  }

  // Hints: equal normalised names, no shared evidence key.
  const byName = new Map<string, string[]>();
  for (const row of eligible) {
    const name = normalisedDisplayName(row.label);
    if (name === "") continue;
    const members = byName.get(name) ?? [];
    members.push(row.identifierId);
    byName.set(name, members);
  }
  const hints: NameHint[] = [];
  for (const members of byName.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const left = byId.get(members[i]!)!;
        const right = byId.get(members[j]!)!;
        if (pairs.has(`${left.identifierId}\u0000${right.identifierId}`)) continue;
        const comparison = compareIdentifierFacts(left, right);
        if (comparison.evidence.length > 0) continue;
        hints.push({
          pairId: pairId("instrument-pair", left.identifierId, right.identifierId),
          identifierIds: sortedPair(left.identifierId, right.identifierId),
          reason: "same-display-name",
          conflicts: comparison.conflicts,
        });
        if (hints.length > CANDIDATE_HINT_LIMIT)
          return { ok: false, error: "candidate_limit_exceeded" };
      }
  hints.sort((a, b) => (a.pairId < b.pairId ? -1 : a.pairId > b.pairId ? 1 : 0));

  return {
    ok: true,
    set: { policy: INSTRUMENT_CANDIDATE_POLICY, candidates, separated, hints },
  };
}

/**
 * Where one identifier stands across identifiers:
 * - `unresolved-candidates`: at least one candidate awaits a decision;
 * - `resolved-by-decision`: it shares its instrument with another identifier
 *   and a manual mapping made that so;
 * - `shared-without-decision`: it shares its instrument and no manual mapping
 *   among the sharers explains it. No rule produces this today; it is shown
 *   instead of being read as resolved;
 * - `kept-separate`: every candidate it had was rejected;
 * - `no-candidate`: nothing pairs it. It stays what its own mapping says
 *   (provider-local, for example), which is not a global identification.
 */
export const IDENTIFIER_RESOLUTION_STATES = [
  "unresolved-candidates",
  "resolved-by-decision",
  "shared-without-decision",
  "kept-separate",
  "no-candidate",
] as const;
export type IdentifierResolutionState = (typeof IDENTIFIER_RESOLUTION_STATES)[number];

export interface IdentifierResolution {
  identifierId: string;
  state: IdentifierResolutionState;
  /** Other identifiers among the facts that map to the same instrument now, sorted. */
  sharedWith: string[];
  /** Candidate ids this identifier takes part in, sorted. */
  candidateIds: string[];
}

export function identifierResolutions(
  facts: readonly InstrumentIdentifierFacts[],
  set: InstrumentCandidateSet,
): IdentifierResolution[] {
  const byInstrument = new Map<string, InstrumentIdentifierFacts[]>();
  for (const row of facts) {
    const members = byInstrument.get(row.instrumentId) ?? [];
    members.push(row);
    byInstrument.set(row.instrumentId, members);
  }
  return [...facts].sort(byIdentifier).map((row) => {
    const sharers = byInstrument.get(row.instrumentId) ?? [];
    const sharedWith = sharers
      .filter((other) => other.identifierId !== row.identifierId)
      .map((other) => other.identifierId)
      .sort();
    const mine = set.candidates.filter(
      (candidate) =>
        candidate.anchorIdentifierId === row.identifierId ||
        candidate.subjectIdentifierId === row.identifierId,
    );
    let state: IdentifierResolutionState;
    if (mine.some((candidate) => candidate.status === "proposed")) state = "unresolved-candidates";
    else if (sharedWith.length > 0)
      state = sharers.some((other) => other.mappingMethod === "manual")
        ? "resolved-by-decision"
        : "shared-without-decision";
    else if (mine.some((candidate) => candidate.status === "rejected")) state = "kept-separate";
    else state = "no-candidate";
    return {
      identifierId: row.identifierId,
      state,
      sharedWith,
      candidateIds: mine.map((candidate) => candidate.candidateId).sort(),
    };
  });
}
