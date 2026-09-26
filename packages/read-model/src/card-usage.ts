// Current card usage: every Vpass and MyJCB usage row a card purchase can be
// recognised from, pending and posted, with the recognition key, the resolved
// account, the provider display state and the exact decimal amount. One
// definition of "current" for the purchase-recognition writer and its readers
// (card purchase plan §1.2):
//
//   1. the parse run is published (`activeStateProjection`, the same predicate
//      as every current list);
//   2. the row is in the latest complete container snapshot, by the very CTEs
//      the Transactions page composes (`sql.ts`: a Vpass card unit + statement
//      month, a MyJCB connection + statement state + `myjcbStatementSlot`);
//   3. the newest representation per (resolved account, source, snapshot
//      slot) wins, so a card ordinal or MyJCB connection that changed under one
//      resolved account does not keep an older capture current. The slot is
//      the part of the step-2 partition that is not the unit: the statement
//      month for Vpass (a month's capture flips from the customized family to
//      the web family as one snapshot), the statement state and statement for
//      MyJCB (every unconfirmed capture shares one slot, and each confirmed
//      statement is one slot whatever position it was captured at, exactly as
//      in step 2).
//      A representation is a fetch run: the newest run by (snapshot
//      fetched_at, fetch run id), the step-2 Vpass order, keeps every one of
//      its units, so two cards that one account resolves in the same run never
//      shadow each other. A row without a resolved account keeps its raw unit,
//      i.e. step 2 alone;
//   4. the latest observation of each recognition key.
//
// Step 4 keeps one row per key, and each provider row of one capture has a key
// of its own. The Vpass parser numbers repeated identical rows per page
// artifact (`rowIdentity` in packages/parsers/src/parsers/vpass.ts), and since
// vpass-statement-page@1.2.0 every page after the first names itself in the
// external id, so two identical rows on different pages of one capture are two
// keys and two rows, as on the Transactions page. A later page whose published
// parse is still 1.1.0 (its re-parse has not run yet) keeps the old id and can
// still share a key with the first page. The MyJCB ledger is one artifact per
// snapshot, so its occurrence count is complete. Both deployed parsers always
// emit an external id; a row without one has no recognition key, is never
// merged with another row, and cannot be recognised.
//
// Amounts are the decimal-v1 projection of migration 0024, never a cast
// integer. Provider extras are read at the exact `extra_json` paths the
// deployed parsers emit; each is cited below. Nothing is classified here:
// what counts as a purchase is the domain's decision.
import { activeStateProjection, successfulFetchRuns } from "./concepts";
import { DECIMAL_POLICY_RELEASE } from "./identity";
import type { PageSql } from "./scope";
import {
  MYJCB_LEDGER_MEMBER,
  MYJCB_LEDGER_SNAPSHOT_CTES,
  VPASS_SNAPSHOT_MEMBER,
  VPASS_STATEMENT_SNAPSHOT_CTES,
} from "./sql";

/** Largest page one call may request; the caller pages on with `afterId`. */
export const CARD_USAGE_PAGE_LIMIT = 1000;
/** Longest provider text an extra column returns; longer text reads as absent. */
export const CARD_USAGE_TEXT_BOUND = 256;

export type CardUsageSource = "vpass" | "myjcb";
/** Pending and posted per source, as `RECONCILIATION_SLICES` in services/processor/src/reconciliation-job.ts. */
export type CardUsageDisplayState = "pending" | "posted";

/** One current card usage row. Column names are the SQL result's. */
export interface CurrentCardUsageRow {
  /** `transaction_observations.id`; the paging cursor. */
  observation_id: number;
  parse_run_id: number;
  fetch_artifact_id: number;
  fetch_run_id: number;
  raw_locator: string;

  // The recognition key: json_array(source_id, producer_id,
  // external_id_namespace, source_account, external_id), the shape of
  // `bank_key` in migration 0044.
  source_id: CardUsageSource;
  producer_id: string;
  external_id_namespace: string | null;
  source_account: string;
  external_id: string | null;
  /** SQLite's `json_array` text of the five components; null without an external id (never recognised). */
  recognition_key: string | null;

  // Identity: the `current_identity_observations` row (read per parse) and its
  // `current_account_mappings` revision, as the card settlement ownership
  // view (0044) and the Transactions page's `latest` organization resolve it.
  /** `source_accounts.id` the sealed identity run assigned; null before identity ran. */
  source_account_id: string | null;
  account_id: string | null;
  /** `account_mappings.status` of the current mapping. */
  account_status: "identified" | "provider-local" | "aggregate" | "unresolved" | null;
  /** `identity_runs.policy_version`: orders runs of one parse; not a family (an override may record 3). */
  policy_version: number | null;
  /**
   * `identity_run_contexts.policy_family`: `vpass-card-binding` when a trusted
   * importer card binding resolved the row, else `identity-default`.
   */
  policy_family: string | null;

  // Provider display.
  /** `transaction_observations.status` verbatim: `unconfirmed`, `posted` or `confirmed`. */
  provider_status: string | null;
  /** Vpass `_kogane.statementFamily` (`web`/`customized`); MyJCB `_kogane.statementState`. */
  provider_family: string | null;
  display_state: CardUsageDisplayState | null;
  /** Provider usage date, `YYYY-MM-DD` as both parsers write it. */
  as_of: string | null;
  /**
   * Vpass `_kogane.statementMonth` (`YYYYMM`); MyJCB `_kogane.period` (the
   * provider label, verbatim, possibly the collector's relative
   * `detailMonth-N`). Never resolved here: the domain reads it together with
   * `snapshot_fetched_at` (packages/domain/src/relative-period.ts).
   */
  statement_period: string | null;
  /** The snapshot unit: the Vpass card ordinal (`card-NNN`) or the MyJCB connection id. */
  snapshot_unit: string | null;
  /**
   * The snapshot's time: the newest artifact of the Vpass card-month, the
   * MyJCB artifact's own. A MyJCB snapshot is one ledger artifact, so this is
   * the capture a relative `statement_period` is resolved from.
   */
  snapshot_fetched_at: string;

  // decimal-v1 (migration 0024); the unit is the observation's currency.
  /** Null only when no decimal-v1 row was projected for the observation. */
  value_status: "exact" | "missing" | "unparsed" | "conflict" | null;
  coefficient: string | null;
  scale: number | null;
  value_basis: "minor_units" | "decimal_text" | "agreement" | "none" | null;
  unit_ref: string | null;

  // Provider extras; null when absent, not text, empty or over the bound.
  /**
   * Where each source's payment type (支払区分) is: Vpass web `data[6]` and
   * customized `bunkatsuYaku` (one-digit codes of two different fields),
   * MyJCB `summaryCells[1]`, the
   * combined `ご利用先など／支払区分` cell (merchant and `1回払` together). Only
   * the domain's single-payment rule reads it.
   */
  payment_type: string | null;
  /** Vpass customized `_kogane.providerSaleCode` (`5` sale, `6` refund). */
  provider_sale_code: string | null;
  /** MyJCB `_kogane.usageAmountText` (ご利用金額). */
  usage_amount_text: string | null;
  /** MyJCB `_kogane.paymentAmountText` (今回のお支払い金額). */
  payment_amount_text: string | null;
  /** MyJCB `expanded.今回回数`. */
  installment_count_text: string | null;
}

/** A bounded text at a fixed `extra_json` path of `t`, or NULL; malformed JSON is NULL, never an error. */
const extraText = (path: string): string =>
  `CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '${path}') = 'text'
              AND length(json_extract(t.extra_json, '${path}')) BETWEEN 1 AND ${CARD_USAGE_TEXT_BOUND}
            THEN json_extract(t.extra_json, '${path}') END`;

const VPASS = "fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page'";
const MYJCB = "fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger'";

// Field sources (packages/parsers/src/parsers/*.ts, as deployed):
// - vpass.ts parseWeb: status 'posted'; `extra` is the provider row (`data`,
//   positional: data[6] is the payment type, the same text as `description`;
//   production rows carry a one-digit full-width code there, `１`) plus
//   `_kogane.statementFamily` = 'web' and `_kogane.statementMonth`.
// - vpass.ts parseCustomized: status 'unconfirmed'; `extra` is the provider
//   row (`bunkatsuYaku` is the payment-type field, the same text as
//   `description`; every production row carries `0`, which the domain
//   accepts as a single payment on the owner's confirmation) plus
//   `_kogane.statementFamily` = 'customized', `_kogane.statementMonth`
//   and `_kogane.providerSaleCode` (the row's `uriageKbn`: '5' sale, '6' refund).
// - myjcb.ts myJcbCreditLedger: status 'confirmed'/'unconfirmed'; `extra` is
//   `summaryCells`, `expanded` (provider cells such as 今回回数) and
//   `_kogane.statementState`, `_kogane.period`, `_kogane.usageAmountText`,
//   `_kogane.paymentAmountText`. The last two are the fields
//   services/processor/src/reconciliation-job.ts `comparablePayment` already
//   reads (usage == payment > 0). The payment type is read from
//   `summaryCells[1]`, the combined `ご利用先など／支払区分` cell, which holds
//   it (`1回払`) in every production row. The cell the parser names
//   `_kogane.paymentTypeCellIndex` (and copies to `description`) holds a
//   two-character on-screen label in production, not the payment type, so it
//   is not read; the evidence already holds the value, so no parser release is
//   needed to read it here.
const PROVIDER_FAMILY = `CASE WHEN ${VPASS} THEN ${extraText("$._kogane.statementFamily")}
            WHEN ${MYJCB} THEN ${extraText("$._kogane.statementState")} END`;
const STATEMENT_PERIOD = `CASE WHEN ${VPASS} THEN ${extraText("$._kogane.statementMonth")}
            WHEN ${MYJCB} THEN ${extraText("$._kogane.period")} END`;
const PAYMENT_TYPE = `CASE WHEN ${VPASS} THEN
              CASE ${extraText("$._kogane.statementFamily")}
                WHEN 'web' THEN ${extraText("$.data[6]")}
                WHEN 'customized' THEN ${extraText("$.bunkatsuYaku")}
              END
            WHEN ${MYJCB} THEN ${extraText("$.summaryCells[1]")}
            END`;
const DISPLAY_STATE = `CASE
              WHEN ${VPASS} AND t.status = 'unconfirmed' THEN 'pending'
              WHEN ${VPASS} AND t.status = 'posted' THEN 'posted'
              WHEN ${MYJCB} AND t.status = 'unconfirmed' THEN 'pending'
              WHEN ${MYJCB} AND t.status = 'confirmed' THEN 'posted'
            END`;

/**
 * The sealed identity run of each current parse: `current_identity_observations`
 * (0026) restated per parse, the way `organizationSql` reads it for the
 * Transactions page. For a published parse on a successful fetch run, the
 * sealed eligible identity run with the highest policy version (unique per
 * parse, 0018). The view itself would materialize every source's identity
 * catalogue on each call, and a per-row lookup would re-check the Vpass binding
 * provenance behind `eligible_identity_runs` for every observation rather than
 * once per parse; card-usage.test.ts proves the result equals the view.
 */
const PARSE_IDENTITY = `parse_identity AS MATERIALIZED (
         SELECT parses.parse_run_id,
                (SELECT run.id
                   FROM eligible_identity_runs run
                   JOIN identity_run_seals seal ON seal.identity_run_id = run.id
                  WHERE run.parse_run_id = parses.parse_run_id
                  ORDER BY run.policy_version DESC
                  LIMIT 1) AS identity_run_id
         FROM (SELECT DISTINCT parse_run_id FROM current_rows WHERE run_succeeded) parses
       )`;

/**
 * The artifacts step 2 can keep: the members of each current Vpass snapshot
 * (`VPASS_SNAPSHOT_MEMBER`, looked up through the snapshot's fetch run) and
 * the current MyJCB captures. `current_rows` still applies every predicate of
 * steps 1 and 2 itself, so this set decides only where its scan starts, never
 * which rows it keeps. D1 is never analyzed, and without statistics the
 * planner otherwise walks every terminal run report, artifact, parse and
 * observation of every source before the snapshot filter: a cost that grows
 * with the whole store instead of with the current captures.
 */
const CARD_ARTIFACTS = `card_artifacts AS MATERIALIZED (
         SELECT fa.id, NULL AS myjcb_slot
         FROM current_vpass_snapshots snapshot
         CROSS JOIN observation_fetch_artifacts fa ON ${VPASS_SNAPSHOT_MEMBER}
         UNION
         SELECT fetch_artifact_id, statement_slot FROM current_myjcb_snapshots
       )`;

/** The row's columns, in the order the result returns them. */
const COLUMNS = [
  "observation_id",
  "parse_run_id",
  "fetch_artifact_id",
  "fetch_run_id",
  "raw_locator",
  "source_id",
  "producer_id",
  "external_id_namespace",
  "source_account",
  "external_id",
  "recognition_key",
  "source_account_id",
  "account_id",
  "account_status",
  "policy_version",
  "policy_family",
  "provider_status",
  "provider_family",
  "display_state",
  "as_of",
  "statement_period",
  "snapshot_unit",
  "snapshot_fetched_at",
  "value_status",
  "coefficient",
  "scale",
  "value_basis",
  "unit_ref",
  "payment_type",
  "provider_sale_code",
  "usage_amount_text",
  "payment_amount_text",
  "installment_count_text",
] as const satisfies readonly (keyof CurrentCardUsageRow)[];

/**
 * The whole query; `?1` is the exclusive observation id cursor and `?2` the
 * page size. Ranking runs over the complete current set before the cursor
 * applies, so a page boundary never changes which row is current.
 *
 * Steps 1 and 2 are materialized first (`current_rows`), so the identity
 * lookup and the provider extras are evaluated for current rows only, never
 * for the older captures every Vpass and MyJCB artifact keeps. `current_rows`
 * starts from `card_artifacts` and reaches every other relation by key; the
 * `CROSS JOIN`s fix that order, because D1's planner has no statistics and
 * would otherwise start from every fetch run's terminal report (the cost is
 * measured in docs/read-model.md, "Cost").
 */
export const CURRENT_CARD_USAGE_SQL = `WITH ${MYJCB_LEDGER_SNAPSHOT_CTES}, ${VPASS_STATEMENT_SNAPSHOT_CTES}, ${CARD_ARTIFACTS}, current_rows AS MATERIALIZED (
         SELECT t.id AS observation_id, t.parse_run_id, fa.id AS fetch_artifact_id,
                fa.fetch_run_id, t.raw_locator,
                fa.source_id, fr.producer_id, ses.external_id_namespace,
                t.source_account, t.external_id,
                (${successfulFetchRuns.predicate("f")}) AS run_succeeded,
                t.status AS provider_status,
                ${PROVIDER_FAMILY} AS provider_family,
                ${DISPLAY_STATE} AS display_state,
                t.as_of,
                ${STATEMENT_PERIOD} AS statement_period,
                CASE WHEN snapshot.fetch_run_id IS NOT NULL THEN fa.fetch_unit_key
                  ELSE substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1)
                END AS snapshot_unit,
                coalesce(snapshot.fetched_at, fa.fetched_at) AS snapshot_fetched_at,
                CASE WHEN snapshot.fetch_run_id IS NOT NULL THEN json_array(snapshot.statement_month)
                  ELSE json_array(fa.statement_state, candidate.myjcb_slot)
                END AS snapshot_slot,
                dv.status AS value_status, dv.coefficient, dv.scale, dv.basis AS value_basis,
                t.currency AS unit_ref,
                ${PAYMENT_TYPE} AS payment_type,
                CASE WHEN ${VPASS} THEN ${extraText("$._kogane.providerSaleCode")} END
                  AS provider_sale_code,
                CASE WHEN ${MYJCB} THEN ${extraText("$._kogane.usageAmountText")} END
                  AS usage_amount_text,
                CASE WHEN ${MYJCB} THEN ${extraText("$._kogane.paymentAmountText")} END
                  AS payment_amount_text,
                CASE WHEN ${MYJCB} THEN ${extraText('$.expanded."今回回数"')} END
                  AS installment_count_text
         FROM card_artifacts candidate
         CROSS JOIN observation_fetch_artifacts fa ON fa.id = candidate.id
         CROSS JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         CROSS JOIN financial_fetch_runs fr ON fr.id = f.id
         CROSS JOIN acquisition_sessions ses ON ses.id = fr.acquisition_session_id
         CROSS JOIN parse_runs p ON p.fetch_artifact_id = fa.id
         CROSS JOIN transaction_observations t ON t.parse_run_id = p.id
         LEFT JOIN current_vpass_snapshots snapshot
           ON p.parser_name = 'vpass-statement-page'
          AND ${VPASS_SNAPSHOT_MEMBER}
         LEFT JOIN observation_decimal_values dv
           ON dv.kind = 'transaction' AND dv.observation_id = t.id
          AND dv.policy_version = '${DECIMAL_POLICY_RELEASE}'
         WHERE ${activeStateProjection.predicate}
           AND (
             (${VPASS} AND snapshot.fetch_run_id IS NOT NULL)
             OR (${MYJCB} AND ${MYJCB_LEDGER_MEMBER})
           )
       ), ${PARSE_IDENTITY}, card_usage AS (
         SELECT current_rows.*,
                CASE WHEN current_rows.external_id IS NOT NULL THEN json_array(
                  current_rows.source_id, current_rows.producer_id,
                  current_rows.external_id_namespace, current_rows.source_account,
                  current_rows.external_id
                ) END AS recognition_key,
                io.source_account_id, mapping.account_id, mapping.status AS account_status,
                -- Scalar lookups keep the view keyed; as a LEFT JOIN operand it is materialized whole.
                (SELECT ctx.policy_version FROM identity_run_contexts ctx
                  WHERE ctx.identity_run_id = io.identity_run_id) AS policy_version,
                (SELECT ctx.policy_family FROM identity_run_contexts ctx
                  WHERE ctx.identity_run_id = io.identity_run_id) AS policy_family
         FROM current_rows
         LEFT JOIN parse_identity ON parse_identity.parse_run_id = current_rows.parse_run_id
         LEFT JOIN identity_observations io
           ON io.identity_run_id = parse_identity.identity_run_id
          AND io.kind = 'transaction' AND io.observation_id = current_rows.observation_id
         LEFT JOIN current_account_mappings mapping
           ON mapping.source_account_id = io.source_account_id
       ), representations AS (
         SELECT card_usage.*,
                FIRST_VALUE(fetch_run_id) OVER (
                  PARTITION BY source_id, snapshot_slot,
                    CASE WHEN account_id IS NULL THEN json_array('unit', snapshot_unit)
                      ELSE json_array('account', account_id)
                    END
                  ORDER BY snapshot_fetched_at DESC, fetch_run_id DESC
                ) AS newest_run
         FROM card_usage
       ), keyed AS (
         SELECT representations.*,
                ROW_NUMBER() OVER (
                  PARTITION BY coalesce(recognition_key, json_array('observation-row', observation_id))
                  ORDER BY snapshot_fetched_at DESC, observation_id DESC
                ) AS key_rank
         FROM representations
         WHERE fetch_run_id = newest_run
       )
       SELECT ${COLUMNS.join(", ")}
       FROM keyed
       WHERE key_rank = 1 AND observation_id > ?1
       ORDER BY observation_id
       LIMIT ?2`;

/**
 * One page of current card usage after the observation id `afterId`, in
 * ascending id order. Start at 0; pass the last row's `observation_id` for
 * the next page; a page shorter than `limit` is the end.
 */
export function currentCardUsageSql({
  afterId,
  limit,
}: {
  afterId: number;
  limit: number;
}): PageSql {
  if (!Number.isSafeInteger(afterId) || afterId < 0)
    throw new Error("read-model: afterId must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CARD_USAGE_PAGE_LIMIT)
    throw new Error(`read-model: limit must be an integer from 1 to ${CARD_USAGE_PAGE_LIMIT}`);
  return { sql: CURRENT_CARD_USAGE_SQL, args: [afterId, limit] };
}
