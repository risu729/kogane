// The `price_promotion` lane (ADR 0020, docs/calculation-and-reports.md §1,
// docs/processor.md §6): provider prices already stored as observations become
// `price_observations` rows by the closed rule list of
// packages/domain/src/price-sources.ts, each with the claim it came from in
// `price_observation_claims` (migration 0053).
//
//   * It reads successful parse runs, published or not: which price a reader
//     uses is decided at read time by joining the claim's parse run to
//     `published_parse_runs` (packages/read-model/src/price-selection.ts), so
//     a parse published later is not missed and a re-parse needs no rewrite.
//   * One cursor per claim kind (`valuation`, `position`) in
//     `price_promotion_cursor`. A tick examines at most PRICE_PROMOTION_BATCH
//     claims in all, valuation claims first; a claim the rule refuses is
//     counted and passed, never retried under the same rules.
//   * Every write is `INSERT … WHERE NOT EXISTS` keyed by the price id,
//     `price_<sha256(rule, claimRef)>`, and the prices, their claims and the
//     cursor move in one batch. Running the lane again over the same
//     observations, even from a reset cursor, writes nothing.
//   * Its log line and tick record carry counts only: `scanned`, `promoted`,
//     `basis_unverified`, `unsupported_currency` and `written`. No price,
//     quantity, code or account label leaves the lane.
import {
  domesticCurrentPrice,
  foreignStockPrice,
  fxBoardPrice,
  inDomesticRecord,
  priceId,
  SBI_SHINSEI_FX_QUOTE_BASIS,
  type FxQuoteBasisTable,
  type PriceClaimKind,
  type PriceVerdict,
} from "../../../packages/domain/src/price-sources.ts";

/** Claims examined per tick, over both claim kinds. */
export const PRICE_PROMOTION_BATCH = 500;

interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface PricePromotionResult {
  /** Claims examined this tick. */
  scanned: number;
  /** Claims whose rule produced a price (new or already stored). */
  promoted: number;
  /** Claims refused because the basis check did not hold or could not be made. */
  basis_unverified: number;
  /** Claims refused because the currency is not one the rule admits. */
  unsupported_currency: number;
  /** Price rows this tick newly wrote. */
  written: number;
}

export interface PricePromotionOptions {
  limit?: number;
  now?: string;
  /** Tests only: the verified FX quote basis table (production: none verified). */
  fxQuoteBasis?: FxQuoteBasisTable;
}

const CURSOR_SQL = "SELECT claim_kind,last_observation_id FROM price_promotion_cursor";

const VALUATION_PARSERS = ["sbi-shinsei-exchange-rate", "sbi-domestic-cash-positions"] as const;

// ?1 cursor, ?2 upper bound (the table's max id read in the same batch), ?3 limit.
const VALUATION_CANDIDATES_SQL = `SELECT v.id,v.parse_run_id,a.source_id,p.parser_name,v.source_account,
 v.subject,v.metric,v.currency,v.amount_text,v.as_of,v.raw_locator,a.fetched_at
 FROM valuation_observations v
 JOIN parse_runs p ON p.id=v.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE v.id>?1 AND v.id<=?2 AND p.status='ok'
   AND ((p.parser_name='${VALUATION_PARSERS[0]}'
         AND v.metric IN ('bank_mid_rate','bank_buy_rate','bank_sell_rate'))
     OR (p.parser_name='${VALUATION_PARSERS[1]}' AND v.metric='current_price'))
 ORDER BY v.id LIMIT ?3`;
/**
 * How far a tick may read: the highest id, but never at or past a row of a
 * parse that is still `pending`. The parse writer inserts observations before
 * the batch that marks the run `ok` (worker.ts), so a cursor that passed such
 * a row would miss it for good; this bound waits for it instead.
 */
const upperBoundSql = (table: string): string => `SELECT min(
 coalesce((SELECT max(id) FROM ${table}),0),
 coalesce((SELECT min(o.id)-1 FROM parse_runs p JOIN ${table} o ON o.parse_run_id=p.id
   WHERE p.status='pending'),9007199254740991)) AS max_id`;
const VALUATION_MAX_SQL = upperBoundSql("valuation_observations");

const POSITION_CANDIDATES_SQL = `SELECT po.id,po.parse_run_id,a.source_id,p.parser_name,po.security_code,
 po.market,po.quantity_text,po.currency,po.as_of,po.extra_json,a.fetched_at
 FROM position_observations po
 JOIN parse_runs p ON p.id=po.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE po.id>?1 AND po.id<=?2 AND p.status='ok' AND p.parser_name='sbi-foreign-cash-positions'
 ORDER BY po.id LIMIT ?3`;
const POSITION_MAX_SQL = upperBoundSql("position_observations");

/** What the same parse runs hold beside a domestic `current_price`: positions and market values. */
const DOMESTIC_RECORD_SQL = `SELECT 'position' AS role,po.parse_run_id,po.source_account,
 po.security_code AS code,po.market,po.quantity_text AS amount_text,NULL AS currency,po.as_of,po.raw_locator
 FROM position_observations po WHERE po.parse_run_id IN (SELECT value FROM json_each(?1))
 UNION ALL
 SELECT 'market_value',v.parse_run_id,v.source_account,v.subject,NULL,v.amount_text,v.currency,
  v.as_of,v.raw_locator
 FROM valuation_observations v
 WHERE v.parse_run_id IN (SELECT value FROM json_each(?1)) AND v.metric='market_value'`;

const INSERT_PRICES_SQL = `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,
 base_quantity_scale,quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,
 source_claim_ref,market_ref,adjustment_policy_ref,recorded_at)
 SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.base'),json_extract(j.value,'$.baseCoefficient'),
  json_extract(j.value,'$.baseScale'),json_extract(j.value,'$.quote'),json_extract(j.value,'$.quoteCoefficient'),
  json_extract(j.value,'$.quoteScale'),json_extract(j.value,'$.kind'),json_extract(j.value,'$.effectiveTime'),
  json_extract(j.value,'$.claimRef'),json_extract(j.value,'$.market'),NULL,?2
 FROM json_each(?1) j
 WHERE NOT EXISTS(SELECT 1 FROM price_observations existing WHERE existing.id=json_extract(j.value,'$.id'))`;

const INSERT_CLAIMS_SQL = `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,
 parse_run_id,json_path,created_at)
 SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.rule'),json_extract(j.value,'$.claimKind'),
  json_extract(j.value,'$.observationId'),json_extract(j.value,'$.parseRunId'),json_extract(j.value,'$.jsonPath'),?2
 FROM json_each(?1) j
 WHERE NOT EXISTS(SELECT 1 FROM price_observation_claims existing
   WHERE existing.price_id=json_extract(j.value,'$.id'))`;

const MOVE_CURSOR_SQL = `INSERT INTO price_promotion_cursor(claim_kind,last_observation_id) VALUES(?1,?2)
 ON CONFLICT(claim_kind) DO UPDATE SET
  last_observation_id=max(price_promotion_cursor.last_observation_id,excluded.last_observation_id)`;

interface ValuationCandidate {
  id: number;
  parse_run_id: number;
  source_id: string;
  parser_name: string;
  source_account: string;
  subject: string;
  metric: string;
  currency: string;
  amount_text: string | null;
  as_of: string | null;
  raw_locator: string;
  fetched_at: string;
}

interface PositionCandidate {
  id: number;
  parse_run_id: number;
  source_id: string;
  parser_name: string;
  security_code: string;
  market: string | null;
  quantity_text: string;
  currency: string | null;
  as_of: string | null;
  extra_json: string;
  fetched_at: string;
}

interface RecordRow {
  role: "position" | "market_value";
  parse_run_id: number;
  source_account: string;
  code: string;
  market: string | null;
  amount_text: string | null;
  currency: string | null;
  as_of: string | null;
  raw_locator: string;
}

function parsedExtra(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function valuationVerdicts(
  db: D1Like,
  rows: ValuationCandidate[],
  fxQuoteBasis: FxQuoteBasisTable,
): Promise<PriceVerdict[]> {
  const domestic = rows.filter((row) => row.parser_name === VALUATION_PARSERS[1]);
  const records =
    domestic.length === 0
      ? []
      : ((
          await db
            .prepare(DOMESTIC_RECORD_SQL)
            .bind(JSON.stringify([...new Set(domestic.map((row) => row.parse_run_id))]))
            .all<RecordRow>()
        ).results ?? []);
  return rows.map((row) => {
    if (row.parser_name === VALUATION_PARSERS[1]) {
      // POSITION_VALUATIONS_SQL's pairing: same parse run, account and code,
      // and the valuation's bytes inside the position's MTS record.
      const same = records.filter(
        (record) =>
          record.parse_run_id === row.parse_run_id &&
          record.source_account === row.source_account &&
          record.code === row.subject,
      );
      const positions = same.filter(
        (record) =>
          record.role === "position" && inDomesticRecord(record.raw_locator, row.raw_locator),
      );
      const marketValues = same.filter(
        (record) =>
          record.role === "market_value" &&
          positions.length === 1 &&
          inDomesticRecord(positions[0]!.raw_locator, record.raw_locator),
      );
      return domesticCurrentPrice({
        observationId: row.id,
        parseRunId: row.parse_run_id,
        sourceId: row.source_id,
        parserName: row.parser_name,
        metric: row.metric,
        securityCode: row.subject,
        priceText: row.amount_text,
        priceCurrency: row.currency,
        asOf: row.as_of,
        fetchedAt: row.fetched_at,
        positions: positions.map((record) => ({
          market: record.market,
          quantityText: record.amount_text ?? "",
          asOf: record.as_of,
        })),
        marketValues: marketValues.map((record) => ({
          amountText: record.amount_text,
          currency: record.currency ?? "",
        })),
      });
    }
    return fxBoardPrice(
      {
        observationId: row.id,
        parseRunId: row.parse_run_id,
        sourceId: row.source_id,
        parserName: row.parser_name,
        sourceAccount: row.source_account,
        subject: row.subject,
        metric: row.metric,
        currency: row.currency,
        amountText: row.amount_text,
        asOf: row.as_of,
        fetchedAt: row.fetched_at,
      },
      fxQuoteBasis,
    );
  });
}

function positionVerdicts(rows: PositionCandidate[]): PriceVerdict[] {
  return rows.map((row) =>
    foreignStockPrice({
      observationId: row.id,
      parseRunId: row.parse_run_id,
      sourceId: row.source_id,
      parserName: row.parser_name,
      securityCode: row.security_code,
      market: row.market,
      quantityText: row.quantity_text,
      currency: row.currency,
      asOf: row.as_of,
      fetchedAt: row.fetched_at,
      extra: parsedExtra(row.extra_json),
    }),
  );
}

/** Writes one kind's verdicts and moves its cursor, in one batch. Returns the new price rows. */
async function commit(
  db: D1Like,
  kind: PriceClaimKind,
  verdicts: PriceVerdict[],
  cursor: number,
  now: string,
): Promise<number> {
  const prices: Record<string, unknown>[] = [];
  const claims: Record<string, unknown>[] = [];
  for (const verdict of verdicts) {
    if (verdict.outcome !== "promoted") continue;
    const id = await priceId(verdict.rule, verdict.claim);
    prices.push({
      id,
      base: verdict.price.baseInstrumentRef,
      baseCoefficient: verdict.price.baseQuantity.coefficient,
      baseScale: verdict.price.baseQuantity.scale,
      quote: verdict.price.quoteUnitRef,
      quoteCoefficient: verdict.price.quoteAmount.coefficient,
      quoteScale: verdict.price.quoteAmount.scale,
      kind: verdict.price.priceKind,
      effectiveTime: JSON.stringify(verdict.price.effectiveTime),
      claimRef: verdict.price.sourceClaimRef,
      market: verdict.price.marketRef,
    });
    claims.push({
      id,
      rule: verdict.rule,
      claimKind: verdict.claim.claimKind,
      observationId: verdict.claim.observationId,
      parseRunId: verdict.claim.parseRunId,
      jsonPath: verdict.claim.jsonPath,
    });
  }
  const statements: D1PreparedStatement[] = [];
  if (prices.length > 0)
    statements.push(
      db.prepare(INSERT_PRICES_SQL).bind(JSON.stringify(prices), now),
      db.prepare(INSERT_CLAIMS_SQL).bind(JSON.stringify(claims), now),
    );
  statements.push(db.prepare(MOVE_CURSOR_SQL).bind(kind, cursor));
  const results = await db.batch(statements);
  return prices.length > 0 ? (results[0]?.meta.changes ?? 0) : 0;
}

export async function pricePromotionSweep(
  db: D1Like,
  options: PricePromotionOptions = {},
): Promise<PricePromotionResult> {
  const limit = options.limit ?? PRICE_PROMOTION_BATCH;
  const now = options.now ?? new Date().toISOString();
  const fxQuoteBasis = options.fxQuoteBasis ?? SBI_SHINSEI_FX_QUOTE_BASIS;
  const result: PricePromotionResult = {
    scanned: 0,
    promoted: 0,
    basis_unverified: 0,
    unsupported_currency: 0,
    written: 0,
  };
  const cursors = new Map<string, number>(
    (
      (await db.prepare(CURSOR_SQL).all<{ claim_kind: string; last_observation_id: number }>())
        .results ?? []
    ).map((row) => [row.claim_kind, row.last_observation_id]),
  );
  const kinds: [PriceClaimKind, string, string][] = [
    ["valuation", VALUATION_CANDIDATES_SQL, VALUATION_MAX_SQL],
    ["position", POSITION_CANDIDATES_SQL, POSITION_MAX_SQL],
  ];
  for (const [kind, candidatesSql, maxSql] of kinds) {
    const budget = limit - result.scanned;
    if (budget <= 0) break;
    const from = cursors.get(kind) ?? 0;
    const upper = (await db.prepare(maxSql).first<{ max_id: number }>())?.max_id ?? 0;
    if (upper <= from) continue;
    const rows =
      (await db.prepare(candidatesSql).bind(from, upper, budget).all<Record<string, unknown>>())
        .results ?? [];
    const verdicts =
      kind === "valuation"
        ? await valuationVerdicts(db, rows as unknown as ValuationCandidate[], fxQuoteBasis)
        : positionVerdicts(rows as unknown as PositionCandidate[]);
    for (const verdict of verdicts) result[verdict.outcome] += 1;
    result.scanned += rows.length;
    // A full page stops at its last row; a short page has read everything up
    // to the bound, so the cursor moves past the rows no rule reads as well.
    const last = rows.length === budget ? Number(rows.at(-1)!["id"]) : upper;
    result.written += await commit(db, kind, verdicts, last, now);
  }
  return result;
}
