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
import type { PriceKind, PriceObservation } from "../../domain/src/metrics.ts";
import { PRICE_KINDS } from "../../domain/src/metrics.ts";
import type { PriceClaimKind } from "../../domain/src/price-sources.ts";
import { validInstantText, validTemporalValue } from "../../domain/src/time.ts";
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
