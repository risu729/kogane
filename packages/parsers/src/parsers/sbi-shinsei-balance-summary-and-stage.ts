// Parser for the SBI Shinsei `balance-summary-and-stage` dataset: the stored
// response of `IFTP_TopAdapter/getBalanceSummaryAndStage` (collector schema
// `sbi-shinsei-balance-summary-v1`,
// services/collector-sbi-shinsei/src/response-schemas.ts). ADR 0031.
//
// It reads one thing: the customer's stage category,
// `responseParam.category.responseParam.customerCategory`, the provider's own
// statement of which Step-Up stage the customer is in. The FX board lists each
// currency once per `customerCategory` (ADR 0028), and the price rule admits
// the board rows whose category is strictly equal to this one, from the same
// collection run (packages/domain/src/price-sources.ts, ADR 0031).
//
// The category becomes one valuation-kind observation that carries no amount:
// account `sbi-shinsei:customer`, subject `customerCategory`, metric
// `provider_customer_category`, currency `XXX` (ISO 4217's code for "no
// currency is involved"). The value is kept exactly as the provider sent it,
// string or number, in `extra.customerCategory`; nothing parses it, trims it
// or maps it to a stage name. Valuation is the kind that already holds
// provider statements that are not holdings (the FX board's rates, account
// `sbi-shinsei:fx-board`); a kind of its own would need a table and every
// observation reader to learn it, for one value per run (ADR 0031, options).
//
// A category that is absent, null, empty, a boolean or anything but a
// non-empty string or a finite number fails the artifact: no such shape has
// been observed, and a stage nobody has seen is not guessed (ADR 0004). The
// price rule then finds no stage for the run and admits no board row.
//
// Every other block is validated exactly as the collector validates it, so an
// unknown field still fails the artifact, but nothing else is emitted: the
// summary block carries the customer's names (class d in ADR 0029: avoided in
// CORE) and balances the top page already reports (INV06), and the branch
// block is read by the account-connection review from the artifact itself.
// The category block's other fields (transfer and ATM allowances) are kept
// verbatim in the observation's provider context.
import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { containerClaim } from "./coverage.ts";
import {
  acceptsSbiShinseiDataset,
  assertSuccessfulRun,
  exactObject,
  object,
  parseJson,
  providerExtra,
  responseParam,
  scalarFields,
  wrapper,
} from "./sbi-shinsei-common.ts";

const DATASET = "balance-summary-and-stage";
/** The customer relationship the page describes; it names no account number. */
export const SBI_SHINSEI_CUSTOMER_ACCOUNT = "sbi-shinsei:customer";
/** The closed metric of the stage category observation. */
export const SBI_SHINSEI_STAGE_METRIC = "provider_customer_category";
export const SBI_SHINSEI_STAGE_SUBJECT = "customerCategory";
/** ISO 4217 "no currency": the observation states an attribute, not an amount. */
export const SBI_SHINSEI_STAGE_CURRENCY = "XXX";
const LOCATOR = "json:$.responseParam.category.responseParam.customerCategory";

const SUMMARY_FIELDS = [
  "customerName",
  "customerNameKanji",
  "customerNameKana",
  "mfAccountStatus",
  "savingsBalance",
  "odLimit",
  "totalCredit",
  "totalDebit",
  "fxCasaBalance",
  "yenTDBalance",
];
const CATEGORY_FIELDS = [
  "freeTransferCount",
  "customerCategory",
  "atmFee",
  "allowedAtmWithFreeCnt",
  "balanceAtmWithFreeCnt",
];

/** The collector's `optionalWrapper`: a wrapper whose response, when present, is empty. */
function emptyWrapper(value: unknown, label: string): void {
  const result = exactObject(
    value,
    label,
    ["requestParam", "responseParam", "header", "errorInfo"],
    [],
  );
  if (result["requestParam"] !== undefined) object(result["requestParam"], `${label}.requestParam`);
  if (result["responseParam"] !== undefined) {
    const response = object(result["responseParam"], `${label}.responseParam`);
    if (Object.keys(response).length !== 0)
      throw new Error(`${label}.responseParam: schema is not known`);
  }
  for (const [field, allowed] of [
    ["header", ["referenceNo", "systemCode", "langCode"]],
    ["errorInfo", ["statusID", "statusMessage"]],
  ] as const) {
    if (result[field] === undefined) continue;
    const block = exactObject(result[field], `${label}.${field}`, allowed, []);
    scalarFields(block, Object.keys(block), `${label}.${field}`);
  }
}

/** The category exactly as sent, when it is a non-empty string or a finite number. */
function stageCategory(value: unknown): string | number {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${LOCATOR}: expected a non-empty string or a finite number`);
}

export const sbiShinseiBalanceSummaryAndStage: Parser = {
  name: "sbi-shinsei-balance-summary-and-stage",
  version: "0.1.0",
  accepts: (artifact: ArtifactMeta) => acceptsSbiShinseiDataset(artifact, DATASET),

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    assertSuccessfulRun(artifact);
    const root = parseJson(bytes, DATASET);
    const response = exactObject(
      responseParam(root, DATASET),
      `${DATASET}.responseParam`,
      ["summary", "mutualFundBalance", "category", "branchFetch"],
      ["summary", "category", "branchFetch"],
    );
    const summary = exactObject(
      wrapper(response["summary"], `${DATASET}.summary`),
      `${DATASET}.summary.responseParam`,
      SUMMARY_FIELDS,
      [],
    );
    scalarFields(summary, Object.keys(summary), `${DATASET}.summary.responseParam`);
    const category = exactObject(
      wrapper(response["category"], `${DATASET}.category`),
      `${DATASET}.category.responseParam`,
      CATEGORY_FIELDS,
      [],
    );
    scalarFields(category, Object.keys(category), `${DATASET}.category.responseParam`);
    const branch = exactObject(
      wrapper(response["branchFetch"], `${DATASET}.branchFetch`),
      `${DATASET}.branchFetch.responseParam`,
      ["branchCode", "branchName"],
      [],
    );
    scalarFields(branch, Object.keys(branch), `${DATASET}.branchFetch.responseParam`);
    const fund = response["mutualFundBalance"];
    if (fund !== undefined) {
      if (typeof fund === "object" && fund !== null && !Array.isArray(fund))
        emptyWrapper(fund, `${DATASET}.mutualFundBalance`);
      else scalarFields(response, ["mutualFundBalance"], `${DATASET}.responseParam`);
    }

    const value = stageCategory(category["customerCategory"]);
    const context = Object.fromEntries(
      Object.entries(category).filter(([key]) => key !== "customerCategory"),
    );
    const observations: Observation[] = [
      {
        kind: "valuation",
        sourceAccount: SBI_SHINSEI_CUSTOMER_ACCOUNT,
        subject: SBI_SHINSEI_STAGE_SUBJECT,
        metric: SBI_SHINSEI_STAGE_METRIC,
        currency: SBI_SHINSEI_STAGE_CURRENCY,
        rawLocator: LOCATOR,
        extra: providerExtra({ customerCategory: value }, context, {
          attribute: "stage-category",
          valueType: typeof value,
          amountDisposition: "not-an-amount",
        }),
      },
    ];
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: observations.length,
          expectedCount: 1,
          evidenceRefs: [LOCATOR],
        }),
      ],
    };
  },
};
