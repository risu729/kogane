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
// written. `asOf` is the provider's `transactionTime` when it states one in a
// recognised form; otherwise the observation has no provider time and a
// reader falls back to the fetch instant.
//
// The stored boards carry a 22-character `transactionTime`
// (`NNNN/NN/NN NN:NN:NN NN`: a timestamp, a space and two more characters whose
// meaning nobody has observed; ADR 0028, observed 2026-09-27). From 1.0.1
// exactly that shape no longer fails the board: the observations carry no
// provider time (so the fetch instant stands in, marked as the collector's),
// record `_kogane.providerTimeBasis: "unrecognized"`, and one `info` issue says
// so without the value. The text is kept verbatim in the provider context and
// no part of it is interpreted. Any other unrecognised form, a recognised form
// with an impossible calendar value, or a non-string, still fails the board.
//
// The payload names no base quantity for a quote: it does not say whether a
// rate is per 1 unit or per 100 units of the currency. The parser therefore
// records `_kogane.quoteBasis: "not-stated"` and never infers one. Which
// currencies are quoted per 1 unit is decided outside the parser, by the
// closed rule list in packages/domain/src/price-sources.ts (ADR 0020).
//
// The board is a customer rate tiered by `customerCategory`: the stored boards
// list most currencies once per tier (observed 2026-09-27). A row's identity
// is therefore the pair (currency, customerCategory): every tier's row gives
// its own observations, with the category verbatim in `extra`, and a pair
// listed twice is refused rather than one row being picked. Which tier applies
// to the owner is not stated, so the parser chooses none; the price rule reads
// a tier only once an admission names it (price-sources.ts, ADR 0020).
//
// A JPY row is not a quote of JPY against itself. From 1.0.1 it is skipped
// with one `info` `row_unreadable` issue of impact `none` and is not counted
// in the board's expected cells, so the board stays complete; before, it
// failed the board. A board with no quote row left is refused like an empty
// one.
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
const TRANSACTION_TIME =
  "json:$.responseParam.exchangeRateInformation.responseParam.transactionTime";
/**
 * The one unrecognised `transactionTime` shape the stored boards carry
 * (ADR 0028): a slash timestamp, a space and two more digits. It is matched as
 * a shape only; no part of it is read. Every other unrecognised form still
 * fails in `providerTimestamp` (ADR 0004).
 */
const OBSERVED_UNRECOGNIZED_TIME = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \d{2}$/u;
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
  version: "1.0.1",
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
    const diagnostics = new ParseDiagnostics();
    const time = information["transactionTime"];
    const timeUnrecognized = typeof time === "string" && OBSERVED_UNRECOGNIZED_TIME.test(time);
    const asOf = timeUnrecognized ? undefined : providerTimestamp(time);
    if (timeUnrecognized) {
      // The provider stated a time in a form nobody has verified. It is kept
      // verbatim below and never read; the observations carry no provider time.
      diagnostics.report({
        code: "unknown_fields_preserved",
        locator: TRANSACTION_TIME,
        severity: "info",
        impact: "field",
        message: `${TRANSACTION_TIME}: provider timestamp format is not recognized; kept verbatim, the fetch instant stands in`,
      });
    }
    const rows = exactArray(information["exchangeRates"], CONTAINER, MAX_BOARD_ROWS);
    // A bank board always quotes something. An empty one is a provider state
    // nobody has observed, so it is refused instead of replacing the last
    // board as a complete-empty snapshot.
    if (rows.length === 0) throw new Error(`${DATASET}: the exchange-rate board is empty`);

    const observations: Observation[] = [];
    const seen = new Set<string>();
    let quoteRows = 0;
    const context =
      asOf === undefined && !timeUnrecognized
        ? {}
        : { transactionTime: information["transactionTime"] };
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
      if (code === "JPY") {
        // Not a quote, so nothing is lost by skipping it and membership holds.
        diagnostics.note({
          code: "row_unreadable",
          locator: `${locator}.currency`,
          severity: "info",
          impact: "none",
          message: `${locator}.currency: a JPY row is not a quote; skipped`,
        });
        return;
      }
      // The tier is compared as the provider sent it: an absent category is
      // its own tier, and a number never matches the same digits as text.
      const identity = JSON.stringify([code, row["customerCategory"] ?? null]);
      if (seen.has(identity))
        throw new Error(
          `${locator}.currency: the board lists ${code} twice in one customerCategory`,
        );
      seen.add(identity);
      quoteRows++;
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
            ...(timeUnrecognized ? { providerTimeBasis: "unrecognized" } : {}),
          }),
        });
      }
    });
    if (quoteRows === 0) throw new Error(`${DATASET}: the exchange-rate board has no quote row`);
    return {
      observations,
      warnings: diagnostics.warnings,
      issues: diagnostics.issues,
      coverage: [
        containerClaim({
          artifact,
          issues: diagnostics.issues,
          observedCount: observations.length,
          expectedCount: quoteRows * RATE_FIELDS.length,
          evidenceRefs: [CONTAINER],
        }),
      ],
    };
  },
};
