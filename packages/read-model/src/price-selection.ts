// Price selection at a cutoff (ADR 0020, docs/calculation-and-reports.md §1).
//
// For each (base instrument, quote unit, price kind) asked for, the latest
// price whose effective time is at or before the cutoff and whose claim's
// parse run is **currently published**. The publication pointer
// (`published_parse_runs`, migration 0026) names one parse per artifact and
// parser, so a re-parse moves selection to the prices promoted from the new
// parse without any price row changing; the old rows stay for the contexts
// that used them (UC36/AT36).
//
// Only prices with an instant effective time are selectable: every rule in
// packages/domain/src/price-sources.ts produces one, and a date-only price
// cannot be ordered against an instant cutoff without a zone rule nobody has
// decided. Instants carry their own offsets, so they are compared through
// `julianday`, never as text. Ties at the same instant go to the later
// recorded row, then the higher id, so the choice is deterministic.
//
// Nothing here fetches a price, converts one, or treats a missing price as
// zero: an instrument with no selectable price is simply absent from the
// result, and the caller states that as a reason (INV05).
import {
  validKnownAtInstant,
  type KnowledgeMode,
  type PriceCandidate,
  type PriceKey,
} from "../../domain/src/market-data.ts";
import type { PriceKind, PriceObservation } from "../../domain/src/metrics.ts";
import { PRICE_KINDS } from "../../domain/src/metrics.ts";
import type { PriceClaimKind } from "../../domain/src/price-sources.ts";
import { validInstantText, validTemporalValue, type TemporalValue } from "../../domain/src/time.ts";
import type { SqlExecutor } from "./reader";

/** Base instruments one selection may name; a caller pages above this. */
export const PRICE_SELECTION_BOUND = 500;

/**
 * ?1 JSON array of base instrument refs, ?2 the cutoff instant (RFC 3339 with
 * an offset), ?3 the quote unit or NULL for any, ?4 the price kind or NULL
 * for any.
 */
export const PRICE_SELECTION_SQL = `WITH wanted AS (
 SELECT DISTINCT value AS base FROM json_each(?1)
), eligible AS (
 SELECT po.id, po.base_instrument_ref, po.base_quantity_coefficient, po.base_quantity_scale,
  po.quote_unit_ref, po.quote_amount_coefficient, po.quote_amount_scale, po.price_kind,
  po.effective_time, po.source_claim_ref, po.market_ref, po.adjustment_policy_ref, po.recorded_at,
  c.rule_id, c.claim_kind, c.observation_id, c.parse_run_id, c.json_path,
  julianday(json_extract(po.effective_time,'$.value')) AS effective_day
 FROM wanted
 JOIN price_observations po ON po.base_instrument_ref=wanted.base
 JOIN price_observation_claims c ON c.price_id=po.id
 JOIN published_parse_runs pub ON pub.parse_run_id=c.parse_run_id
 WHERE json_extract(po.effective_time,'$.kind')='instant'
   AND (?3 IS NULL OR po.quote_unit_ref=?3)
   AND (?4 IS NULL OR po.price_kind=?4)
), ranked AS (
 SELECT eligible.*, ROW_NUMBER() OVER (
   PARTITION BY base_instrument_ref, quote_unit_ref, price_kind
   ORDER BY effective_day DESC, recorded_at DESC, id DESC
 ) AS rank_in_key
 FROM eligible
 WHERE effective_day IS NOT NULL AND effective_day<=julianday(?2)
)
SELECT id, base_instrument_ref, base_quantity_coefficient, base_quantity_scale, quote_unit_ref,
 quote_amount_coefficient, quote_amount_scale, price_kind, effective_time, source_claim_ref,
 market_ref, adjustment_policy_ref, recorded_at, rule_id, claim_kind, observation_id,
 parse_run_id, json_path
FROM ranked WHERE rank_in_key=1
ORDER BY base_instrument_ref, quote_unit_ref, price_kind`;

export interface PriceSelectionQuery {
  baseInstrumentRefs: readonly string[];
  /** RFC 3339 instant with an offset; prices effective after it are not selected. */
  cutoff: string;
  quoteUnitRef?: string | null;
  priceKind?: PriceKind | null;
}

/** A selected price and the claim it was promoted from. */
export interface SelectedPrice {
  price: PriceObservation;
  recordedAt: string;
  claim: {
    ruleId: string;
    claimKind: PriceClaimKind;
    observationId: number;
    parseRunId: number;
    jsonPath: string;
  };
}

interface PriceSelectionRow {
  id: string;
  base_instrument_ref: string;
  base_quantity_coefficient: string;
  base_quantity_scale: number;
  quote_unit_ref: string;
  quote_amount_coefficient: string;
  quote_amount_scale: number;
  price_kind: PriceKind;
  effective_time: string;
  source_claim_ref: string;
  market_ref: string | null;
  adjustment_policy_ref: string | null;
  recorded_at: string;
  rule_id: string;
  claim_kind: PriceClaimKind;
  observation_id: number;
  parse_run_id: number;
  json_path: string;
}

export class PriceSelectionError extends Error {
  readonly code: "cutoff_invalid" | "too_many_instruments" | "price_kind_invalid";
  constructor(code: PriceSelectionError["code"]) {
    super(code);
    this.name = "PriceSelectionError";
    this.code = code;
  }
}

export function priceSelectionArgs(query: PriceSelectionQuery): unknown[] {
  if (!validInstantText(query.cutoff)) throw new PriceSelectionError("cutoff_invalid");
  if (query.baseInstrumentRefs.length > PRICE_SELECTION_BOUND)
    throw new PriceSelectionError("too_many_instruments");
  const kind = query.priceKind ?? null;
  if (kind !== null && !(PRICE_KINDS as readonly string[]).includes(kind))
    throw new PriceSelectionError("price_kind_invalid");
  return [
    JSON.stringify([...query.baseInstrumentRefs]),
    query.cutoff,
    query.quoteUnitRef ?? null,
    kind,
  ];
}

/** The latest published price per (base, quote, kind) at the cutoff. */
export async function selectPrices(
  sql: SqlExecutor,
  query: PriceSelectionQuery,
): Promise<SelectedPrice[]> {
  if (query.baseInstrumentRefs.length === 0) return [];
  const rows = await sql.all<PriceSelectionRow>(PRICE_SELECTION_SQL, priceSelectionArgs(query));
  const selected: SelectedPrice[] = [];
  for (const row of rows) {
    let effectiveTime: unknown;
    try {
      effectiveTime = JSON.parse(row.effective_time);
    } catch {
      continue;
    }
    // A stored value the domain does not accept is not a price.
    if (!validTemporalValue(effectiveTime)) continue;
    selected.push({
      price: {
        id: row.id,
        baseInstrumentRef: row.base_instrument_ref,
        baseQuantity: {
          coefficient: row.base_quantity_coefficient,
          scale: row.base_quantity_scale,
        },
        quoteUnitRef: row.quote_unit_ref,
        quoteAmount: { coefficient: row.quote_amount_coefficient, scale: row.quote_amount_scale },
        priceKind: row.price_kind,
        effectiveTime,
        sourceClaimRef: row.source_claim_ref,
        marketRef: row.market_ref,
        adjustmentPolicyRef: row.adjustment_policy_ref,
      },
      recordedAt: row.recorded_at,
      claim: {
        ruleId: row.rule_id,
        claimKind: row.claim_kind,
        observationId: row.observation_id,
        parseRunId: row.parse_run_id,
        jsonPath: row.json_path,
      },
    });
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Candidates for an as-of selection under a policy (ADR 0056).
//
// `selectPrices` above picks one row per key in SQL and stays as shipped. A
// policy needs more than one row: a top that is excluded by rule, kind or
// basis must give way to the next, prices tied at one instant must be
// compared, and a key with no fresh price must say how old its newest one is.
// So this read returns, per wanted key, every row whose effective time falls
// in a coarse window (compared through `julianday`, a day of margin on each
// side), every row of the newest instant before the window (so `stale` can be
// told from `missing`), and every row whose effective time SQL cannot place
// (a date-only row is placed by its date; an unreadable one is returned as
// `unordered`, never dropped). The domain (`selectPrice` in
// packages/domain/src/market-data.ts) decides every row exactly. A read that
// would return more than `PRICE_CANDIDATE_ROW_BOUND` rows is refused, never
// cut.
//
// Which parses count is the knowledge mode, and the two modes are two texts:
//
//   current   the claim's parse run is named by `published_parse_runs` now;
//   known-at  the price was recorded at or before K, and the claim's parse run
//             is the one the newest `publication_events` row of its artifact
//             and parser at or before K adopted, so a re-parse published after
//             K, or a rollback, is seen as it stood at K. SQLite compares in
//             milliseconds, so K may carry at most three fractional digits
//             (`validKnownAtInstant`), and the domain re-checks each row's
//             `recorded_at` against K exactly. An event time is compared at
//             the millisecond only (writers store milliseconds). A row whose
//             `recorded_at` or event time SQLite cannot read as a time is not
//             shown to be known at K and is not read.
//
// `snapshotParseRunId` narrows a key to prices promoted from one parse run
// (`same-snapshot`); the publication condition still applies.
// ---------------------------------------------------------------------------

/** Rows one candidate read may return; more is a refusal (413 at an HTTP edge), never a cut. */
export const PRICE_CANDIDATE_ROW_BOUND = 2000;

/**
 * ?1 JSON array of wanted keys, each `[base, quote, kind, parse run or null,
 * window from, window to]` (instants with offsets), ?2 the row limit
 * (bound + 1). Current publications.
 */
export const PRICE_CANDIDATES_SQL = `WITH wanted AS (
 SELECT CAST(w.key AS INTEGER) AS want,
  json_extract(w.value,'$[0]') AS base, json_extract(w.value,'$[1]') AS quote,
  json_extract(w.value,'$[2]') AS kind, json_extract(w.value,'$[3]') AS scope_run,
  julianday(json_extract(w.value,'$[4]')) AS window_from,
  julianday(json_extract(w.value,'$[5]')) AS window_to
 FROM json_each(?1) w
), keyed AS MATERIALIZED (
 SELECT wanted.want, wanted.window_from, wanted.window_to,
  po.id, po.base_instrument_ref, po.base_quantity_coefficient, po.base_quantity_scale,
  po.quote_unit_ref, po.quote_amount_coefficient, po.quote_amount_scale, po.price_kind,
  po.effective_time, po.source_claim_ref, po.market_ref, po.adjustment_policy_ref, po.recorded_at,
  c.rule_id, c.claim_kind, c.observation_id, c.parse_run_id, c.json_path,
  julianday(json_extract(po.effective_time,'$.value')) AS effective_day
 FROM wanted
 CROSS JOIN price_observations po ON po.base_instrument_ref=wanted.base
  AND po.quote_unit_ref=wanted.quote AND po.price_kind=wanted.kind
 CROSS JOIN price_observation_claims c ON c.price_id=po.id
 CROSS JOIN published_parse_runs pub ON pub.parse_run_id=c.parse_run_id
 WHERE wanted.scope_run IS NULL OR c.parse_run_id=wanted.scope_run
), older AS (
 SELECT keyed.*, RANK() OVER (PARTITION BY want ORDER BY effective_day DESC) AS older_rank
 FROM keyed WHERE effective_day<window_from
)
SELECT want, 'window' AS reach, id, base_instrument_ref, base_quantity_coefficient,
 base_quantity_scale, quote_unit_ref, quote_amount_coefficient, quote_amount_scale, price_kind,
 effective_time, source_claim_ref, market_ref, adjustment_policy_ref, recorded_at, rule_id,
 claim_kind, observation_id, parse_run_id, json_path
FROM keyed WHERE effective_day>=window_from AND effective_day<=window_to
UNION ALL
SELECT want, 'unordered', id, base_instrument_ref, base_quantity_coefficient,
 base_quantity_scale, quote_unit_ref, quote_amount_coefficient, quote_amount_scale, price_kind,
 effective_time, source_claim_ref, market_ref, adjustment_policy_ref, recorded_at, rule_id,
 claim_kind, observation_id, parse_run_id, json_path
FROM keyed WHERE effective_day IS NULL
UNION ALL
SELECT want, 'before-window', id, base_instrument_ref, base_quantity_coefficient,
 base_quantity_scale, quote_unit_ref, quote_amount_coefficient, quote_amount_scale, price_kind,
 effective_time, source_claim_ref, market_ref, adjustment_policy_ref, recorded_at, rule_id,
 claim_kind, observation_id, parse_run_id, json_path
FROM older WHERE older_rank=1
ORDER BY want, id
LIMIT ?2`;

/**
 * The same read as known at ?3 (an instant with an offset): prices recorded at
 * or before it, of the parse run the newest publication event at or before it
 * adopted for the claim's artifact and parser.
 */
export const PRICE_CANDIDATES_KNOWN_AT_SQL = `WITH wanted AS (
 SELECT CAST(w.key AS INTEGER) AS want,
  json_extract(w.value,'$[0]') AS base, json_extract(w.value,'$[1]') AS quote,
  json_extract(w.value,'$[2]') AS kind, json_extract(w.value,'$[3]') AS scope_run,
  julianday(json_extract(w.value,'$[4]')) AS window_from,
  julianday(json_extract(w.value,'$[5]')) AS window_to
 FROM json_each(?1) w
), keyed AS MATERIALIZED (
 SELECT wanted.want, wanted.window_from, wanted.window_to,
  po.id, po.base_instrument_ref, po.base_quantity_coefficient, po.base_quantity_scale,
  po.quote_unit_ref, po.quote_amount_coefficient, po.quote_amount_scale, po.price_kind,
  po.effective_time, po.source_claim_ref, po.market_ref, po.adjustment_policy_ref, po.recorded_at,
  c.rule_id, c.claim_kind, c.observation_id, c.parse_run_id, c.json_path,
  julianday(json_extract(po.effective_time,'$.value')) AS effective_day
 FROM wanted
 CROSS JOIN price_observations po ON po.base_instrument_ref=wanted.base
  AND po.quote_unit_ref=wanted.quote AND po.price_kind=wanted.kind
 CROSS JOIN price_observation_claims c ON c.price_id=po.id
 CROSS JOIN parse_runs pr ON pr.id=c.parse_run_id
 WHERE (wanted.scope_run IS NULL OR c.parse_run_id=wanted.scope_run)
  AND julianday(po.recorded_at)<=julianday(?3)
  AND c.parse_run_id=(SELECT e.new_parse_run_id FROM publication_events e
   WHERE e.fetch_artifact_id=pr.fetch_artifact_id AND e.parser_name=pr.parser_name
    AND julianday(e.occurred_at)<=julianday(?3)
   ORDER BY e.id DESC LIMIT 1)
), older AS (
 SELECT keyed.*, RANK() OVER (PARTITION BY want ORDER BY effective_day DESC) AS older_rank
 FROM keyed WHERE effective_day<window_from
)
SELECT want, 'window' AS reach, id, base_instrument_ref, base_quantity_coefficient,
 base_quantity_scale, quote_unit_ref, quote_amount_coefficient, quote_amount_scale, price_kind,
 effective_time, source_claim_ref, market_ref, adjustment_policy_ref, recorded_at, rule_id,
 claim_kind, observation_id, parse_run_id, json_path
FROM keyed WHERE effective_day>=window_from AND effective_day<=window_to
UNION ALL
SELECT want, 'unordered', id, base_instrument_ref, base_quantity_coefficient,
 base_quantity_scale, quote_unit_ref, quote_amount_coefficient, quote_amount_scale, price_kind,
 effective_time, source_claim_ref, market_ref, adjustment_policy_ref, recorded_at, rule_id,
 claim_kind, observation_id, parse_run_id, json_path
FROM keyed WHERE effective_day IS NULL
UNION ALL
SELECT want, 'before-window', id, base_instrument_ref, base_quantity_coefficient,
 base_quantity_scale, quote_unit_ref, quote_amount_coefficient, quote_amount_scale, price_kind,
 effective_time, source_claim_ref, market_ref, adjustment_policy_ref, recorded_at, rule_id,
 claim_kind, observation_id, parse_run_id, json_path
FROM older WHERE older_rank=1
ORDER BY want, id
LIMIT ?2`;

/** One key to read candidates for. */
export interface PriceCandidateWant {
  key: PriceKey;
  /** Only prices promoted from this parse run (`same-snapshot`), or null for any published one. */
  snapshotParseRunId: number | null;
  /** Coarse bounds (instants with offsets); `selectionReadWindow` in the domain computes them. */
  window: { from: string; to: string };
}

export interface PriceCandidateQuery {
  wants: readonly PriceCandidateWant[];
  knowledge: KnowledgeMode;
}

/** How a row was reached: inside the window, as the newest before it, or with a time SQL cannot place. */
export type CandidateReach = "window" | "before-window" | "unordered";

export interface ReadPriceCandidate {
  reach: CandidateReach;
  candidate: PriceCandidate;
}

interface PriceCandidateRow extends PriceSelectionRow {
  want: number;
  reach: CandidateReach;
}

export class PriceCandidateError extends Error {
  readonly code:
    | "too_many_keys"
    | "too_many_candidates"
    | "window_invalid"
    | "knowledge_invalid"
    | "key_invalid";
  constructor(code: PriceCandidateError["code"]) {
    super(code);
    this.name = "PriceCandidateError";
    this.code = code;
  }
}

/** The text and arguments of one candidate read; refuses rather than guesses. */
export function priceCandidateArgs(query: PriceCandidateQuery): { sql: string; args: unknown[] } {
  if (query.wants.length > PRICE_SELECTION_BOUND) throw new PriceCandidateError("too_many_keys");
  const wanted = query.wants.map((want) => {
    const { key, window, snapshotParseRunId } = want;
    if (
      typeof key.baseInstrumentRef !== "string" ||
      key.baseInstrumentRef === "" ||
      typeof key.quoteUnitRef !== "string" ||
      key.quoteUnitRef === "" ||
      !(PRICE_KINDS as readonly string[]).includes(key.priceKind) ||
      !(snapshotParseRunId === null || Number.isSafeInteger(snapshotParseRunId))
    )
      throw new PriceCandidateError("key_invalid");
    if (!validInstantText(window.from) || !validInstantText(window.to))
      throw new PriceCandidateError("window_invalid");
    return [
      key.baseInstrumentRef,
      key.quoteUnitRef,
      key.priceKind,
      snapshotParseRunId,
      window.from,
      window.to,
    ];
  });
  const limit = PRICE_CANDIDATE_ROW_BOUND + 1;
  if (query.knowledge.mode === "current")
    return { sql: PRICE_CANDIDATES_SQL, args: [JSON.stringify(wanted), limit] };
  if (query.knowledge.mode !== "known-at" || !validKnownAtInstant(query.knowledge.knownAt))
    throw new PriceCandidateError("knowledge_invalid");
  return {
    sql: PRICE_CANDIDATES_KNOWN_AT_SQL,
    args: [JSON.stringify(wanted), limit, query.knowledge.knownAt],
  };
}

/** A stored effective time the domain accepts, or `unknown` with the reason it was not read. */
function storedEffectiveTime(text: string): TemporalValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unknown", reasonCode: "stored_effective_time_invalid" };
  }
  return validTemporalValue(value)
    ? value
    : { kind: "unknown", reasonCode: "stored_effective_time_invalid" };
}

/**
 * Candidates per wanted key, in the order asked (one list per want, possibly
 * empty). Every row read is returned with how it was reached; nothing is
 * selected here.
 */
export async function selectPriceCandidates(
  sql: SqlExecutor,
  query: PriceCandidateQuery,
): Promise<ReadPriceCandidate[][]> {
  const read = priceCandidateArgs(query);
  const result: ReadPriceCandidate[][] = query.wants.map(() => []);
  if (query.wants.length === 0) return result;
  const rows = await sql.all<PriceCandidateRow>(read.sql, read.args);
  if (rows.length > PRICE_CANDIDATE_ROW_BOUND) throw new PriceCandidateError("too_many_candidates");
  for (const row of rows) {
    const list = result[row.want];
    if (list === undefined) throw new PriceCandidateError("key_invalid");
    list.push({
      reach: row.reach,
      candidate: {
        price: {
          id: row.id,
          baseInstrumentRef: row.base_instrument_ref,
          baseQuantity: {
            coefficient: row.base_quantity_coefficient,
            scale: row.base_quantity_scale,
          },
          quoteUnitRef: row.quote_unit_ref,
          quoteAmount: { coefficient: row.quote_amount_coefficient, scale: row.quote_amount_scale },
          priceKind: row.price_kind,
          effectiveTime: storedEffectiveTime(row.effective_time),
          sourceClaimRef: row.source_claim_ref,
          marketRef: row.market_ref,
          adjustmentPolicyRef: row.adjustment_policy_ref,
        },
        recordedAt: row.recorded_at,
        claim: {
          ruleId: row.rule_id,
          claimKind: row.claim_kind,
          observationId: row.observation_id,
          parseRunId: row.parse_run_id,
          jsonPath: row.json_path,
        },
      },
    });
  }
  return result;
}
