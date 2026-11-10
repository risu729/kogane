// `provider-data-types-v1` (ADR 0087): per CORE source with a collector, the
// data types the provider offers for the account kinds the source collects,
// and whether each is collected. It describes the provider, from the source
// research (docs/sources/*.md) and the per-source issues (#441–#454 under
// #440), not the owner's holdings: a type is listed because the provider
// offers it, whether or not the owner has any.
//
// `collected` names the registered parsers that publish it; `partial` names
// them and the issue that tracks the rest; `not_collected` names the issue.
// `test/provider-data-types.test.ts` checks that every name is a registered
// parser, that every registered parser that publishes something is named, and
// that no parser is named under two sources; which source a parser belongs to
// is this table's word, checked by review. A provider semantic nobody
// has observed is not listed (ADR 0004); a correction is a pull request that
// changes this table and, for a new type or status, the version.
import {
  PROVIDER_DATA_TYPES_VERSION,
  type ProviderDataTypeEntry,
} from "../../../observation-shared/src/collection-quality-contract.ts";

export { PROVIDER_DATA_TYPES_VERSION };

const collected = (
  type: ProviderDataTypeEntry["type"],
  parsers: string[],
): ProviderDataTypeEntry => ({ type, status: "collected", parsers, issue: null });
const partial = (
  type: ProviderDataTypeEntry["type"],
  parsers: string[],
  issue: number,
): ProviderDataTypeEntry => ({ type, status: "partial", parsers, issue });
const missing = (type: ProviderDataTypeEntry["type"], issue: number): ProviderDataTypeEntry => ({
  type,
  status: "not_collected",
  parsers: [],
  issue,
});

/**
 * The backlog issue for a source whose own issue was closed without the work
 * (SBI Shinsei's #447, closed 2026-10-10 with no comment while period
 * history, the electronic reports and product details are still not
 * collected; docs/sources/sbi-shinsei-bank.md and #447's body).
 */
const BACKLOG = 440;

/** CORE source id → its provider-offered data types, in `PROVIDER_DATA_TYPES` order. */
export const PROVIDER_DATA_TYPE_CATALOGUE: Readonly<
  Record<string, readonly ProviderDataTypeEntry[]>
> = {
  // PRESTIA GLOBAL PASS (Visa debit): 15 months of shopping and ATM activity
  // (docs/sources/prestia.md "GLOBAL PASS activity").
  "global-pass": [collected("card_usage", ["global-pass-activity"])],
  // みずほダイレクト: accounts and balances; ordinary-account history beyond the
  // first page, term/foreign/global-account contracts, statement files and
  // みずほポイント are not collected (docs/sources/mizuho-bank.md, #441).
  "mizuho-bank": [
    collected("balance", ["mizuho-account-list"]),
    partial("cash_movement", ["mizuho-ordinary-history"], 1229),
    // 2026-11-09: registered account lists show no held deposit products; see source notes.
    missing("term_deposit", 1241),
    missing("document", 441),
    // 2026-11-09: documented app entry; no browser route observed (source notes).
    missing("reward_balance", 1252),
    missing("reward_activity", 1252),
    missing("reward_expiry", 1252),
  ],
  // Mobile Suica: the SF balance and the one history page of at most 100 rows
  // (docs/sources/mobile-suica.md, #451).
  "mobile-suica": [
    collected("balance", ["mobile-suica-sf-history"]),
    partial("cash_movement", ["mobile-suica-sf-history"], 451),
  ],
  // Money Forward ME (aggregator): monthly transactions of the current and 11
  // past months are parsed; the account pages (balances, holdings) are kept
  // as evidence only (docs/sources/moneyforward.md, #452).
  "moneyforward-me": [
    missing("balance", 452),
    partial("cash_movement", ["moneyforward-monthly-transactions"], 452),
    missing("position", 452),
  ],
  // MyJCB: credit statements and their ledger, J-POINT balance with its
  // nearest expiry, and observed debit ordinary/difference statements; the
  // bonus-payment schedule (stored, not parsed), unsupported debit routes and
  // statuses, PDF/CSV/OFX statement exports, J-POINT history and expiry
  // buckets are not collected (docs/sources/myjcb.md, #444).
  myjcb: [
    partial("card_usage", ["myjcb-credit-ledger", "myjcb-debit-ledger"], 444),
    partial(
      "card_statement",
      [
        "myjcb-credit-statement-total",
        "myjcb-credit-past-month-balances",
        "myjcb-skip-payment-schedule",
        "myjcb-debit-ledger",
        "myjcb-debit-other-statement",
      ],
      444,
    ),
    missing("document", 444),
    collected("reward_balance", ["myjcb-jpoint-balance"]),
    missing("reward_activity", 444),
    partial("reward_expiry", ["myjcb-jpoint-balance"], 444),
  ],
  // PRESTIA bank: account summary (native balances, term principal); deposit
  // activity, product details and the statement PDFs are not collected
  // (docs/sources/prestia.md, #454).
  prestia: [
    collected("balance", ["prestia-bank-balances"]),
    missing("cash_movement", 454),
    partial("term_deposit", ["prestia-bank-balances"], 454),
    missing("document", 454),
  ],
  // SBI証券: domestic and US positions and trades, cash (the yen history's
  // first page only) and the My資産 current valuation; dividends, asset
  // history, fund/bond detail and delivered documents are not collected
  // (docs/sources/sbi-securities.md, #446).
  "sbi-securities": [
    partial("position", ["sbi-domestic-cash-positions", "sbi-foreign-cash-positions"], 1237),
    collected("execution", ["sbi-domestic-trade-records", "sbi-foreign-trade-records"]),
    // USD continuation and scheduled retained-coverage proof remain outstanding (#1226).
    partial(
      "settlement_cash",
      ["sbi-foreign-cash-balances", "sbi-yen-detail-history", "sbi-foreign-cash-history"],
      1226,
    ),
    missing("income", 446),
    partial(
      "valuation_history",
      ["sbi-account-assets-current", "sbi-account-assets-history"],
      1238,
    ),
    missing("document", 446),
  ],
  // SBI新生銀行: top accounts with recent activity, balance summary and the yen
  // deposit account, exchange rates; dated history and CSV, term and foreign
  // contracts are not collected; monthly PDFs have metadata-only coverage
  // (docs/sources/sbi-shinsei-bank.md; #447 was closed without them).
  // On 2026-11-09 the inspected account held no time or structured-deposit
  // contracts in the yen/FX holdings views (#1242). This catalogue describes
  // offered types, not live holdings, so term_deposit stays not_collected.
  "sbi-shinsei-bank": [
    collected("balance", [
      "sbi-shinsei-top-balances-and-activity",
      "sbi-shinsei-balance-summary-and-stage",
      "sbi-shinsei-yen-deposit-account",
    ]),
    partial("cash_movement", ["sbi-shinsei-top-balances-and-activity"], BACKLOG),
    missing("term_deposit", 1242),
    collected("document", ["sbi-shinsei-monthly-report-metadata"]),
    collected("fx_rate", ["sbi-shinsei-exchange-rate"]),
  ],
  // SBI VCトレード (a broker): crypto holdings and leverage positions,
  // executions under one filter, and the yen account (balances, margin,
  // deposits and withdrawals); crypto transfers, staking or lending rewards,
  // the balance history and annual P&L report, and the PDF reports are not
  // collected (docs/sources/sbi-vc-trade.md, #448).
  "sbi-vc-trade": [
    collected("position", ["sbi-vc-cash-balances", "sbi-vc-position-summary"]),
    partial("execution", ["sbi-vc-executions"], 448),
    collected("settlement_cash", [
      "sbi-vc-cash-balances",
      "sbi-vc-account-margin",
      "sbi-vc-cashflows",
    ]),
    missing("asset_transfer", 448),
    missing("income", 448),
    missing("valuation_history", 448),
    missing("document", 448),
  ],
  // SMBC Direct: the yen ordinary account; foreign-currency deposits and term
  // or installment deposits are not collected (docs/sources/smbc-bank.md,
  // #442).
  "smbc-bank": [
    partial("balance", ["smbc-direct-balance"], 442),
    partial("cash_movement", ["smbc-direct-transactions"], 442),
    missing("term_deposit", 442),
  ],
  // ソニー銀行: total balance, yen and ten foreign-currency histories and WALLET
  // statements; the realized FX P&L, term deposit contracts, the delivered
  // documents and backfill beyond the daily window are not collected
  // (docs/sources/sony-bank.md, #449).
  "sony-bank": [
    collected("balance", ["sony-bank-gross-balance"]),
    partial("cash_movement", ["sony-bank-history-json", "sony-bank-history-csv"], 449),
    collected("card_usage", ["sony-bank-wallet-history"]),
    missing("valuation_history", 449),
    missing("term_deposit", 1243),
    missing("document", 449),
  ],
  // St.George: account balances and the first page of each account's history;
  // dated history, term deposits, eStatements and other account kinds are not
  // collected (docs/sources/st-george.md, #450).
  "st-george": [
    collected("balance", ["st-george-balances"]),
    partial("cash_movement", ["st-george-transactions"], 450),
    missing("term_deposit", 450),
    missing("document", 450),
  ],
  // V Point: balances by kind with expiry, and history pages
  // (docs/sources/v-point.md §4).
  "v-point": [
    collected("reward_balance", ["v-point-balance-info", "v-point-smfg-point"]),
    collected("reward_activity", ["v-point-history-page"]),
    collected("reward_expiry", ["v-point-balance-info"]),
  ],
  // V Point Pay: usage notification e-mails only, with the balance after an
  // event when the e-mail states one; the wallet balance page, charges and the
  // full history are not collected (docs/sources/v-point-pay.md, #453).
  "v-point-pay": [
    partial("balance", ["v-point-pay-notification-event"], 453),
    partial("cash_movement", ["v-point-pay-notification-event"], 453),
  ],
  // Vpass: card statement pages (purchases and statement amounts)
  // (docs/collection.md "Vpass", #445).
  vpass: [
    partial("balance", ["vpass-credit-snapshot"], 1256),
    collected("card_usage", ["vpass-statement-page"]),
    collected("card_statement", ["vpass-statement-page"]),
  ],
};

/** A source's catalogued data types, or null when the catalogue does not describe it. */
export function providerDataTypes(sourceId: string): ProviderDataTypeEntry[] | null {
  if (!Object.hasOwn(PROVIDER_DATA_TYPE_CATALOGUE, sourceId)) return null;
  return PROVIDER_DATA_TYPE_CATALOGUE[sourceId]!.map((entry) => ({
    ...entry,
    parsers: [...entry.parsers],
  }));
}
