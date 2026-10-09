// Lots of one holder and instrument scope at one knowledge cut (ADR 0059).
// Read-only and computed per request; nothing is stored, adopted or written.
//
//   identity    the current mapping of each asked instrument identifier
//               (`instrument_mappings` by its key, with its instrument), then
//               every identifier currently mapped to those instruments, so a
//               book is never computed from part of its instrument's history;
//   knowledge   the knowledge selector (ADR 0058) for the account and all
//               those identifiers at the asked cut (default: the latest
//               commit of the current core epoch);
//   lots        the C adapter and `computeLots` under the caller's explicit
//               policy, with the outer manifest (`lotsOnSelection`).
//
// Today no writer admits the `security-quantity` book (CORE 0070 refuses it),
// so the answer is `unsupported` (`security_quantity_writer_missing`) with
// the manifest still produced: the path runs end to end on any store. Without
// CORE 0070 it is `unavailable` (`economic_guard_missing`). No route, page or
// service calls this yet.
import { canonicalDigest } from "../../../domain/src/context.ts";
import { validKnowledgeCut, type KnowledgeCut } from "../../../domain/src/economic-contract.ts";
import { hasExactKeys, isRecord, isRefList, isText } from "../../../domain/src/guards.ts";
import {
  selectAdopted,
  type AdoptedSelection,
  type CutStanding,
  type SelectionScope,
} from "../../../domain/src/knowledge-selector.ts";
import {
  lotsOnSelection,
  validLotAdapterRequest,
  type LotAdaptation,
  type LotInstrumentMapping,
  type LotInstrumentStatus,
  type LotSelectionChoice,
  type LotsOnSelectionManifest,
  type LotsOnSelectionReason,
  type LotsOnSelectionStatus,
} from "../../../domain/src/lot-adapter.ts";
import type { LotPolicy, LotResult } from "../../../domain/src/lots.ts";
import { validInstantText } from "../../../domain/src/time.ts";
import {
  economicSelectorAvailable,
  loadSelectorRows,
  readSelectorMeta,
  resolveSelectorCut,
  selectorInput,
} from "../../../read-model/src/economic-selector.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

export const LOTS_ON_SELECTION_QUERY_SCHEMA = "lots-on-selection-query-v1";
/** The most instrument identifiers one query asks about. */
export const LOTS_QUERY_MAX_INSTRUMENTS = 16;
/**
 * The most identifiers one query reads for its instruments (the asked ones and
 * every other identifier currently mapped to the same instruments); the
 * selector's instrument scope holds no more. Past it the query is refused
 * (`instrument_identifier_bound_exceeded`), never cut.
 */
export const LOTS_QUERY_MAX_IDENTIFIERS = 64;

/**
 * ?1 JSON array of instrument identifier ids: the current mapping of each
 * (its highest revision, read by `UNIQUE(identifier_id, revision)`) and the
 * instrument it names (primary key). An identifier with no mapping is absent.
 */
export const LOT_INSTRUMENT_MAPPINGS_SQL = `SELECT w.value AS identifier_id,m.revision,m.instrument_id,m.status,i.kind
 FROM json_each(?1) w
 CROSS JOIN instrument_mappings m ON m.identifier_id=w.value
  AND m.revision=(SELECT max(n.revision) FROM instrument_mappings n WHERE n.identifier_id=w.value)
 CROSS JOIN instruments i ON i.id=m.instrument_id
 ORDER BY w.value`;

/**
 * ?1 JSON array of instrument ids: every identifier any of whose mapping
 * revisions names one of them, with `current` 1 when its current mapping (its
 * highest revision) does. The current ones are the instrument's identifier
 * set, so a book is computed from all of it, not from the identifiers a caller
 * named; the others were remapped away, and their revisions under the old
 * instrument are not selected, so the answer needs review
 * (`instrument_identifier_remapped`) instead of silently missing them.
 * No index orders `instrument_mappings` by instrument (CORE 0018 keys it by
 * identifier and revision, and an index would be a migration), so this reads
 * the mapping table once, as `ACCOUNT_SOURCES_SQL` reads the account
 * mappings; each row's currency is checked by the `(identifier_id, revision)`
 * key. The table holds one row per identifier revision, curated by identity
 * runs and decisions, not one per observation. One row past the bound is read
 * so that a larger set is refused, never cut. It is a statement of its own,
 * with no snapshot shared with the mapping reads around it: a mapping that
 * moves in between is caught by the seal's pin, which must equal the mapping
 * revision the adapter is given.
 */
export const LOT_INSTRUMENT_IDENTIFIERS_SQL = `SELECT m.identifier_id,
 max(m.revision=(SELECT max(n.revision) FROM instrument_mappings n WHERE n.identifier_id=m.identifier_id)) AS current
 FROM instrument_mappings m
 WHERE m.instrument_id IN (SELECT value FROM json_each(?1))
 GROUP BY m.identifier_id ORDER BY m.identifier_id LIMIT ${LOTS_QUERY_MAX_IDENTIFIERS + 1}`;

/** Closed codes of `LotsOnSelectionRefusedError` raised by the query itself. */
export const LOTS_ON_SELECTION_REFUSALS = ["instrument_identifier_bound_exceeded"] as const;

export const LOTS_ON_SELECTION_INPUT_ERRORS = ["invalid_query", "cut_in_future"] as const;
export type LotsOnSelectionInputErrorCode = (typeof LOTS_ON_SELECTION_INPUT_ERRORS)[number];

export class LotsOnSelectionInputError extends Error {
  readonly code: LotsOnSelectionInputErrorCode;
  constructor(code: LotsOnSelectionInputErrorCode) {
    super(code);
    this.name = "LotsOnSelectionInputError";
    this.code = code;
  }
}

/** A refusal of the selector or the adapter: a programming error or a bound, never a partial answer. */
export class LotsOnSelectionRefusedError extends Error {
  readonly code: string;
  readonly refs: string[];
  constructor(code: string, refs: string[]) {
    super(code);
    this.name = "LotsOnSelectionRefusedError";
    this.code = code;
    this.refs = refs;
  }
}

export interface LotsOnSelectionInput {
  /** A resolved account id (`accounts.id`): the holder. */
  account: string;
  /** The holder's wrapper key, opaque (ADR 0051); its source is not decided (#545, #546). */
  wrapperKey: string;
  /** Instrument identifier ids, as security legs name their unit. */
  instruments: string[];
  /** Null for the latest commit of the current core epoch. */
  cut: KnowledgeCut | null;
  /** The caller's explicit policy; null is answered as the engine's `policy_missing`. */
  policy: LotPolicy | null;
  /** Specific-identification choices, read as given. */
  lotSelections: LotSelectionChoice[];
  /** The caller's clock (a UTC instant): only refuses a future cut and names an empty log's cut. */
  now: string;
}

export type LotsOnSelectionQueryStatus = "unavailable" | LotsOnSelectionStatus;
export type LotsOnSelectionQueryReason = "economic_guard_missing" | LotsOnSelectionReason;

/** The query's own pins around the adapter's outer manifest. */
export interface LotsOnSelectionQueryManifest {
  schemaVersion: typeof LOTS_ON_SELECTION_QUERY_SCHEMA;
  account: string;
  /** The asked instrument identifiers, sorted. */
  instruments: string[];
  /**
   * The selector's instrument scope: the asked identifiers and every other
   * identifier currently mapped to their instruments, sorted; the mappings
   * read are in `lots.instruments`.
   */
  scopeIdentifiers: string[];
  lots: LotsOnSelectionManifest;
}

export interface LotsOnSelectionQueryResult {
  schemaVersion: typeof LOTS_ON_SELECTION_QUERY_SCHEMA;
  status: LotsOnSelectionQueryStatus;
  reasons: LotsOnSelectionQueryReason[];
  /** The selector's standing of the cut (`provisional` never answers complete); null when unavailable. */
  cutStanding: CutStanding | null;
  account: string;
  instruments: string[];
  knowledge: {
    setVersion: string;
    coverage: AdoptedSelection["coverage"];
    revisions: number;
    unlogged: AdoptedSelection["unlogged"];
    inconsistent: AdoptedSelection["inconsistent"];
    identityChanged: AdoptedSelection["identityChanged"];
    conflicts: AdoptedSelection["conflicts"];
    unsupported: AdoptedSelection["unsupported"];
  } | null;
  adaptation: LotAdaptation | null;
  lots: LotResult | null;
  manifest: LotsOnSelectionQueryManifest | null;
  /** `canonicalDigest` of the manifest. */
  contextId: string | null;
}

interface MappingRow {
  identifier_id: string;
  revision: number;
  instrument_id: string;
  status: string;
  kind: string;
}

function checkInput(input: LotsOnSelectionInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "account",
      "wrapperKey",
      "instruments",
      "cut",
      "policy",
      "lotSelections",
      "now",
    ]) ||
    !isText(input.account, 248) ||
    !isRefList(input.instruments, LOTS_QUERY_MAX_INSTRUMENTS) ||
    input.instruments.length === 0 ||
    input.instruments.some((id) => id.length > 128) ||
    !validInstantText(input.now) ||
    !(input.cut === null || validKnowledgeCut(input.cut)) ||
    (input.cut !== null && "instant" in input.cut && !validInstantText(input.cut.instant)) ||
    // The rest of the request is the adapter's: one wrapper, the policy, the choices.
    !validLotAdapterRequest({
      holders: [{ accountId: input.account, wrapperKey: input.wrapperKey }],
      instruments: [],
      lotSelections: input.lotSelections,
      remappedIdentifiers: [],
      policy: input.policy,
    })
  )
    throw new LotsOnSelectionInputError("invalid_query");
  if (
    input.cut !== null &&
    "instant" in input.cut &&
    Date.parse(input.cut.instant) > Date.parse(input.now)
  )
    throw new LotsOnSelectionInputError("cut_in_future");
}

/**
 * The current mapping of each asked identifier. A class is stated only where
 * the instrument's kind says it: `crypto` is a crypto asset; a `security` may
 * be a listed share or a fund unit, which nothing recorded tells apart, so its
 * class is null and the adapter refuses it (`instrument_unresolved`).
 */
async function readMappings(
  sql: SqlExecutor,
  identifiers: readonly string[],
): Promise<{ mappings: LotInstrumentMapping[]; instrumentIds: string[] }> {
  const rows = await sql.all<MappingRow>(LOT_INSTRUMENT_MAPPINGS_SQL, [
    JSON.stringify([...identifiers].sort()),
  ]);
  const statuses: readonly string[] = ["identified", "provider-local", "aggregate", "unresolved"];
  return {
    mappings: rows.map((row) => ({
      unitRef: row.identifier_id,
      mappingRevision: row.revision,
      instrumentRef: `instrument:${row.instrument_id}`,
      status: (statuses.includes(row.status) ? row.status : "unresolved") as LotInstrumentStatus,
      instrumentClass: row.kind === "crypto" ? ("crypto-asset" as const) : null,
    })),
    instrumentIds: [...new Set(rows.map((row) => row.instrument_id))].sort(),
  };
}

/**
 * One holder (account and wrapper key), some instrument identifiers, at one
 * cut, under the caller's policy. Throws `LotsOnSelectionInputError` for a
 * query it does not answer, `EconomicSelectorError` for a bound or a cut the
 * log cannot answer, and `LotsOnSelectionRefusedError` for a refused
 * selection; nothing is cut.
 */
export async function queryLotsOnSelection(
  sql: SqlExecutor,
  input: LotsOnSelectionInput,
): Promise<LotsOnSelectionQueryResult> {
  checkInput(input);
  const instruments = [...input.instruments].sort();
  const empty = {
    schemaVersion: LOTS_ON_SELECTION_QUERY_SCHEMA as typeof LOTS_ON_SELECTION_QUERY_SCHEMA,
    account: input.account,
    instruments,
  };
  if (!(await economicSelectorAvailable(sql)))
    return {
      ...empty,
      status: "unavailable",
      reasons: ["economic_guard_missing"],
      cutStanding: null,
      knowledge: null,
      adaptation: null,
      lots: null,
      manifest: null,
      contextId: null,
    };

  const meta = await readSelectorMeta(sql);
  const requested: KnowledgeCut =
    input.cut ??
    (meta.log.lastSeq === null
      ? { coreEpoch: meta.currentCoreEpoch, instant: new Date(Date.parse(input.now)).toISOString() }
      : { coreEpoch: meta.currentCoreEpoch, commitSeq: meta.log.lastSeq });
  const cut = await resolveSelectorCut(sql, meta, requested);
  // A book is the instrument's: read every identifier currently mapped to the
  // instruments the asked identifiers name, and select all of them; those
  // mapped to them earlier but not now are named, never silently dropped.
  const { instrumentIds } = await readMappings(sql, instruments);
  const related =
    instrumentIds.length === 0
      ? []
      : await sql.all<{ identifier_id: string; current: number }>(LOT_INSTRUMENT_IDENTIFIERS_SQL, [
          JSON.stringify(instrumentIds),
        ]);
  const scopeIdentifiers = [
    ...new Set([
      ...instruments,
      ...related.filter((row) => row.current === 1).map((row) => row.identifier_id),
    ]),
  ].sort();
  const remappedIdentifiers = related
    .filter((row) => row.current !== 1)
    .map((row) => row.identifier_id)
    .sort();
  if (
    related.length > LOTS_QUERY_MAX_IDENTIFIERS ||
    scopeIdentifiers.length > LOTS_QUERY_MAX_IDENTIFIERS
  )
    throw new LotsOnSelectionRefusedError("instrument_identifier_bound_exceeded", [
      `identifiers:>${LOTS_QUERY_MAX_IDENTIFIERS}`,
    ]);
  const scope: SelectionScope = {
    accounts: [input.account],
    instruments: scopeIdentifiers,
    kinds: null,
    legEffects: null,
    basis: null,
    range: null,
  };
  const rows = await loadSelectorRows(sql, scope);
  const selected = await selectAdopted(selectorInput(meta, cut, scope, rows));
  if (!selected.ok) throw new LotsOnSelectionRefusedError(selected.error.code, selected.error.refs);
  const selection = selected.selection;
  const { mappings } = await readMappings(sql, scopeIdentifiers);
  const answered = await lotsOnSelection(selection, {
    holders: [{ accountId: input.account, wrapperKey: input.wrapperKey }],
    instruments: mappings,
    lotSelections: input.lotSelections,
    remappedIdentifiers,
    policy: input.policy,
  });
  if (!answered.ok) throw new LotsOnSelectionRefusedError(answered.error.code, answered.error.refs);
  const result = answered.result;
  const manifest: LotsOnSelectionQueryManifest = {
    schemaVersion: LOTS_ON_SELECTION_QUERY_SCHEMA,
    account: input.account,
    instruments,
    scopeIdentifiers,
    lots: result.manifest,
  };
  return {
    ...empty,
    status: result.status,
    reasons: result.reasons,
    cutStanding: result.cutStanding,
    knowledge: {
      setVersion: selection.setVersion,
      coverage: selection.coverage,
      revisions: selection.revisions.length,
      unlogged: selection.unlogged,
      inconsistent: selection.inconsistent,
      identityChanged: selection.identityChanged,
      conflicts: selection.conflicts,
      unsupported: selection.unsupported,
    },
    adaptation: result.adaptation,
    lots: result.lots,
    manifest,
    contextId: await canonicalDigest(manifest),
  };
}
