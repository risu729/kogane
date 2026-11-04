// Cross-identifier instrument resolution (ADR 0055, docs/identity.md): which
// stored instrument identifiers may denote the same instrument, on what
// evidence, what keeps a pair apart, and where each identifier stands. A read
// only: it never writes and never adopts. A candidate names the existing
// commands a plan would carry to decide it (`identity.assign` to adopt,
// `relation.reject` of `listed_as` to keep apart); the change lifecycle
// grades who may plan, approve and commit them, and under today's grant lists
// only `OPERATOR_SUBJECTS` may approve or commit.
import {
  identifierResolutions,
  instrumentCandidates,
  INSTRUMENT_CANDIDATE_POLICY,
  listedAsKey,
  type CandidateConflict,
  type IdentifierResolutionState,
  type InstrumentCandidate,
  type InstrumentIdentifierFacts,
  type NameHint,
  type SeparatedPair,
} from "../../../domain/src/instrument-candidates.ts";
import type { StoredRelationStatus } from "../../../domain/src/decisions.ts";
import { record, string } from "../../../identity/src/types.ts";
import {
  INSTRUMENT_FACTS_ROW_BOUND,
  INSTRUMENT_HISTORY_BOUND,
  LISTED_AS_ROW_BOUND,
  readInstrumentFacts,
  readInstrumentHistory,
  readListedAs,
  type InstrumentFactsRow,
  type InstrumentHistoryRow,
} from "../../../read-model/src/instrument-resolution.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import type { IdentityAssignPayload, RelationPayload } from "../command/contract.ts";

/** A read past a bound is refused (413 at an HTTP adapter), never cut. */
export class InstrumentResolutionLimitError extends Error {
  constructor() {
    super("instrument_resolution_limit_exceeded");
  }
}

export interface ResolutionIdentifier {
  identifierId: string;
  instrumentId: string;
  kind: string;
  namespace: string;
  scope: string;
  value: string;
  /** The current mapping's display label: never evidence. */
  label: string;
  mappingMethod: "rule" | "manual";
  mappingStatus: InstrumentFactsRow["status"];
  mappingRevision: number;
  sources: string[];
  currencies: string[];
  /** A use as a security has no unit, or a unit that is not a resolved currency. */
  currencyUnconfirmed: boolean;
  /** The provider's own market wording, shown to a reviewer and never compared. */
  providerMarket: string | null;
  state: IdentifierResolutionState;
  sharedWith: string[];
  candidateIds: string[];
}

/** The payload of a command a person may plan, without the reason they must write. */
export interface CandidateCommands {
  /**
   * Null when the candidate has a `hold`: its subject is already settled and
   * adopting would re-map it.
   */
  adopt: { kind: "identity.assign"; payload: Omit<IdentityAssignPayload, "reason"> } | null;
  /** Always named: a `listed_as` rejection moves no mapping, so a held candidate can be closed. */
  keepApart: { kind: "relation.reject"; payload: Omit<RelationPayload, "reason"> };
}

export interface ResolutionCandidate extends InstrumentCandidate {
  /** Present only while the candidate is `proposed`. */
  commands: CandidateCommands | null;
}

export interface InstrumentResolution {
  policy: typeof INSTRUMENT_CANDIDATE_POLICY;
  identifiers: ResolutionIdentifier[];
  candidates: ResolutionCandidate[];
  separated: SeparatedPair[];
  hints: NameHint[];
  /** Counts only. */
  summary: {
    identifiers: number;
    unresolved: number;
    proposed: number;
    adopted: number;
    rejected: number;
    separated: number;
    hints: number;
  };
}

/**
 * The facts of one identifier from its stored rows. Only what an identity
 * rule recorded is read: the listing namespaces it wrote (`mic-symbol`'s
 * scope is a MIC, `ric`'s value a RIC, `isin`'s value an ISIN) and the
 * detail keys of the closed list below. `record` and `string` are the
 * identity rules' own readers, so a fact is read here exactly as a rule wrote
 * it (migration 0018 constrains `details_json` to valid JSON).
 */
function identifierFacts(rows: readonly InstrumentFactsRow[]): {
  facts: InstrumentIdentifierFacts;
  row: InstrumentFactsRow;
  providerMarket: string | null;
} {
  const row = rows[0]!;
  const stored = record(JSON.parse(row.details));
  const facts: InstrumentIdentifierFacts = {
    identifierId: row.identifierId,
    instrumentId: row.instrumentId,
    mappingMethod: row.method,
    kind: row.kind,
    namespace: row.namespace,
    scope: row.scope,
    value: row.value,
    sources: [...new Set(rows.map((item) => item.sourceId))].sort(),
    isin: row.namespace === "isin" ? string(row.value) : string(stored.isin),
    countryCode: string(stored.countryCode),
    securityCode: string(stored.securityCode),
    mic: row.namespace === "mic-symbol" ? string(row.scope) : null,
    ric: row.namespace === "ric" ? string(row.value) : string(stored.ric),
    shareClass: string(stored.shareClass),
    productClass: string(stored.productClass),
    currencies: [
      ...new Set(rows.flatMap((item) => (item.currency === null ? [] : [item.currency]))),
    ].sort(),
    currencyUnconfirmed: rows.some((item) => item.currencyUnconfirmed === 1),
    label: row.label,
  };
  return { facts, row, providerMarket: string(stored.providerMarket) };
}

function commandsFor(
  candidate: InstrumentCandidate,
  byId: ReadonlyMap<string, InstrumentIdentifierFacts>,
  revisions: ReadonlyMap<string, number>,
): CandidateCommands | null {
  if (candidate.status !== "proposed") return null;
  const anchor = byId.get(candidate.anchorIdentifierId)!;
  const subject = byId.get(candidate.subjectIdentifierId)!;
  return {
    // A hold withholds adoption only: re-mapping a settled subject would
    // undo or split a decision. Keeping the pair apart moves nothing.
    adopt:
      candidate.hold !== null
        ? null
        : {
            kind: "identity.assign",
            payload: {
              subject: "instrument",
              referenceId: subject.identifierId,
              targetId: anchor.instrumentId,
              candidate: {
                candidateId: candidate.candidateId,
                anchorIdentifierId: anchor.identifierId,
                anchorMappingRevision: revisions.get(anchor.identifierId)!,
                subjectMappingRevision: revisions.get(subject.identifierId)!,
              },
            },
          },
    keepApart: {
      kind: "relation.reject",
      payload: {
        relationKind: "listed_as",
        fromRef: `instrument:${anchor.instrumentId}`,
        toRef: `identifier:${subject.identifierId}`,
        validFrom: null,
        validTo: null,
        evidenceRefs: [`identifier:${anchor.identifierId}`, `identifier:${subject.identifierId}`],
      },
    },
  };
}

export async function queryInstrumentResolution(sql: SqlExecutor): Promise<InstrumentResolution> {
  const [factRows, relationRows] = await Promise.all([readInstrumentFacts(sql), readListedAs(sql)]);
  if (factRows.length > INSTRUMENT_FACTS_ROW_BOUND || relationRows.length > LISTED_AS_ROW_BOUND)
    throw new InstrumentResolutionLimitError();

  const grouped = new Map<string, InstrumentFactsRow[]>();
  for (const row of factRows) {
    const rows = grouped.get(row.identifierId) ?? [];
    rows.push(row);
    grouped.set(row.identifierId, rows);
  }
  const built = [...grouped.values()].map(identifierFacts);
  const facts = built.map((item) => item.facts);
  const byId = new Map(facts.map((item) => [item.identifierId, item]));

  const listedAs = new Map<string, StoredRelationStatus>();
  for (const relation of relationRows)
    listedAs.set(
      listedAsKey(
        relation.fromRef.slice("instrument:".length),
        relation.toRef.slice("identifier:".length),
      ),
      relation.status,
    );

  const result = instrumentCandidates(facts, listedAs);
  if (!result.ok) throw new InstrumentResolutionLimitError();
  const resolutions = new Map(
    identifierResolutions(facts, result.set).map((item) => [item.identifierId, item]),
  );
  const identifiers = built.map(({ facts: item, row, providerMarket }) => {
    const resolution = resolutions.get(item.identifierId)!;
    return {
      identifierId: item.identifierId,
      instrumentId: item.instrumentId,
      kind: item.kind,
      namespace: item.namespace,
      scope: item.scope,
      value: item.value,
      label: item.label,
      mappingMethod: item.mappingMethod,
      mappingStatus: row.status,
      mappingRevision: row.revision,
      sources: [...item.sources],
      currencies: [...item.currencies],
      currencyUnconfirmed: item.currencyUnconfirmed,
      providerMarket,
      state: resolution.state,
      sharedWith: resolution.sharedWith,
      candidateIds: resolution.candidateIds,
    };
  });
  const revisions = new Map(built.map(({ row }) => [row.identifierId, row.revision]));
  const candidates = result.set.candidates.map((candidate) => ({
    ...candidate,
    commands: commandsFor(candidate, byId, revisions),
  }));
  const count = (status: InstrumentCandidate["status"]) =>
    candidates.filter((candidate) => candidate.status === status).length;
  return {
    policy: result.set.policy,
    identifiers,
    candidates,
    separated: result.set.separated,
    hints: result.set.hints,
    summary: {
      identifiers: identifiers.length,
      unresolved: identifiers.filter((item) => item.state === "unresolved-candidates").length,
      proposed: count("proposed"),
      adopted: count("adopted"),
      rejected: count("rejected"),
      separated: result.set.separated.length,
      hints: result.set.hints.length,
    },
  };
}

export interface HistoryEntry {
  entry: InstrumentHistoryRow["entry"];
  revision: number;
  createdAt: string;
  method: string;
  decisionOrigin: InstrumentHistoryRow["decisionOrigin"];
  decisionKind: string | null;
  reason: string;
  instrumentId: string | null;
  status: string | null;
  label: string | null;
  policyVersion: number | null;
  recordId: string;
  supersededBy: string | null;
  relationStatus: string | null;
  fromRef: string | null;
}

export interface IdentifierHistory {
  identifierId: string;
  /** Oldest first. Nothing in it is ever rewritten: a correction is a later entry. */
  entries: HistoryEntry[];
}

/**
 * The correction history of up to `INSTRUMENT_HISTORY_BOUND` identifiers:
 * every mapping revision (rule or manual), every decision about the mapping,
 * and every `listed_as` relation naming the identifier.
 */
export async function queryInstrumentHistory(
  sql: SqlExecutor,
  identifierIds: readonly string[],
): Promise<IdentifierHistory[]> {
  const wanted = [...new Set(identifierIds)].sort();
  if (wanted.length > INSTRUMENT_HISTORY_BOUND) throw new InstrumentResolutionLimitError();
  if (wanted.length === 0) return [];
  const rows = await readInstrumentHistory(sql, wanted);
  return wanted.map((identifierId) => ({
    identifierId,
    entries: rows
      .filter((row) => row.identifierId === identifierId)
      .map(({ identifierId: _id, ...entry }) => entry),
  }));
}

/** Conflicts a hint or a separated pair names, for adapters that label them. */
export type { CandidateConflict };
