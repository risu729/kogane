// Parser for the SBI Shinsei `exchange-rate` dataset: the stored response of
// `IFCM_CommonAdapter/getExchangeRate`, the bank's foreign-currency board
// (collector schema `sbi-shinsei-exchange-rate-v1`,
// services/collector-sbi-shinsei/src/response-schemas.ts).
//
// The accepted shape is exactly the collector's validator: the root with its
// success header, `responseParam.exchangeRateInformation` as a wrapper, an
// optional `transactionTime` and an `exchangeRates` array whose items carry
// `currency`, an optional `customerCategory`, and `buyRate`, `sellRate` and
// `midRate`. An unknown field anywhere fails the artifact, as it fails
// collection.
//
// Each board row becomes three valuation observations of the account
// `sbi-shinsei:fx-board` with subject `<CCY>` and metrics `bank_buy_rate`,
// `bank_sell_rate` and `bank_mid_rate`, in JPY, as exact decimal text. A rate
// is the provider's own quote, not money held, so no minor-unit amount is
// written. `asOf` is the provider's `transactionTime` when it states one;
// otherwise the observation has no provider time and a reader falls back to
// the fetch instant.
//
// The payload names no base quantity for a quote: it does not say whether a
// rate is per 1 unit or per 100 units of the currency. The parser therefore
// records `_kogane.quoteBasis: "not-stated"` and never infers one. Which
// currencies are quoted per 1 unit is decided outside the parser, by the
// closed rule list in packages/domain/src/price-sources.ts (ADR 0020).
//
// The board is a customer rate: `customerCategory` may tier it. The category
// is kept verbatim in `extra`, and a board that lists the same currency twice
// is refused rather than one row being picked.
import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { containerClaim, ParseDiagnostics } from "./coverage.ts";
import {
  acceptsSbiShinseiDataset,
  assertSuccessfulRun,
  currency,
  exactArray,
  exactObject,
  nonEmptyString,
  object,
  providerExtra,
  providerTimestamp,
  scalarFields,
  wrapper,
} from "./sbi-shinsei-common.ts";
import { decodeUtf8 } from "./util.ts";

const DATASET = "exchange-rate";
export const SBI_SHINSEI_FX_BOARD_ACCOUNT = "sbi-shinsei:fx-board";
const CONTAINER = "json:$.responseParam.exchangeRateInformation.responseParam.exchangeRates";
/** An audited bound on the board size; the parser refuses a larger board. */
const MAX_BOARD_ROWS = 100;
const RATE_FIELDS = [
  ["buyRate", "bank_buy_rate"],
  ["sellRate", "bank_sell_rate"],
  ["midRate", "bank_mid_rate"],
] as const;
/** A plain positive decimal: no sign, no grouping, no exponent. */
const RATE_TEXT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

function rootOf(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${DATASET}: invalid JSON`, { cause: error });
    throw error;
  }
  const root = exactObject(
    value,
    DATASET,
    ["responseParam", "header"],
    ["responseParam", "header"],
  );
  const header = exactObject(
    root["header"],
    `${DATASET}.header`,
    ["adapterResultCode", "newToken"],
    ["adapterResultCode"],
  );
  if (header["adapterResultCode"] !== "0")
    throw new Error(`${DATASET}: response was not successful`);
  if (header["newToken"] !== undefined)
    nonEmptyString(header["newToken"], `${DATASET}.header.newToken`);
  return root;
}

/** Exact positive decimal text of a rate, or undefined when the cell is not one. */
function rateText(value: unknown): { text: string; scale: number } | undefined {
  if (typeof value !== "string" || !RATE_TEXT.test(value)) return undefined;
  if (!/[1-9]/u.test(value)) return undefined;
  return { text: value, scale: value.split(".")[1]?.length ?? 0 };
}

export const sbiShinseiExchangeRate: Parser = {
  name: "sbi-shinsei-exchange-rate",
  version: "1.0.0",
  accepts: (artifact: ArtifactMeta) => acceptsSbiShinseiDataset(artifact, DATASET),

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    assertSuccessfulRun(artifact);
    const root = rootOf(bytes);
    const response = exactObject(
      object(root["responseParam"], `${DATASET}.responseParam`),
      `${DATASET}.responseParam`,
      ["exchangeRateInformation"],
      ["exchangeRateInformation"],
    );
    const information = exactObject(
      wrapper(response["exchangeRateInformation"], `${DATASET}.exchangeRateInformation`),
      `${DATASET}.exchangeRateInformation.responseParam`,
      ["transactionTime", "exchangeRates"],
      ["exchangeRates"],
    );
    scalarFields(information, ["transactionTime"], `${DATASET}.exchangeRateInformation`);
    const asOf = providerTimestamp(information["transactionTime"]);
    const rows = exactArray(information["exchangeRates"], CONTAINER, MAX_BOARD_ROWS);
    // A bank board always quotes something. An empty one is a provider state
    // nobody has observed, so it is refused instead of replacing the last
    // board as a complete-empty snapshot.
    if (rows.length === 0) throw new Error(`${DATASET}: the exchange-rate board is empty`);

    const diagnostics = new ParseDiagnostics();
    const observations: Observation[] = [];
    const seen = new Set<string>();
    const context = asOf === undefined ? {} : { transactionTime: information["transactionTime"] };
    rows.forEach((value, index) => {
      const locator = `${CONTAINER}[${index}]`;
      const row = exactObject(
        value,
        locator,
        ["currency", "customerCategory", "buyRate", "sellRate", "midRate"],
        ["currency", "buyRate", "sellRate", "midRate"],
      );
      scalarFields(row, Object.keys(row), locator);
      const code = currency(row["currency"], `${locator}.currency`);
      if (code === "JPY") throw new Error(`${locator}.currency: a JPY row is not a quote`);
      if (seen.has(code)) throw new Error(`${locator}.currency: the board lists ${code} twice`);
      seen.add(code);
      for (const [field, metric] of RATE_FIELDS) {
        const rate = rateText(row[field]);
        if (!rate) {
          // An unreadable cell is recorded and breaks the board's membership;
          // no rate is invented for it and the other cells still stand.
          diagnostics.report({
            code: "row_unreadable",
            locator: `${locator}.${field}`,
            severity: "error",
            impact: "membership",
            message: `${locator}.${field}: not a positive exact decimal rate`,
          });
          continue;
        }
        observations.push({
          kind: "valuation",
          sourceAccount: SBI_SHINSEI_FX_BOARD_ACCOUNT,
          subject: code,
          metric,
          amountText: rate.text,
          amountScale: rate.scale,
          currency: "JPY",
          ...(asOf === undefined ? {} : { asOf }),
          rawLocator: `${locator}.${field}`,
          extra: providerExtra(row, context, {
            quoteBasis: "not-stated",
            quoteCurrency: "JPY",
            rateField: field,
          }),
        });
      }
    });
    return {
      observations,
      warnings: diagnostics.warnings,
      issues: diagnostics.issues,
      coverage: [
        containerClaim({
          artifact,
          issues: diagnostics.issues,
          observedCount: observations.length,
          expectedCount: rows.length * RATE_FIELDS.length,
          evidenceRefs: [CONTAINER],
        }),
      ],
    };
  },
};
