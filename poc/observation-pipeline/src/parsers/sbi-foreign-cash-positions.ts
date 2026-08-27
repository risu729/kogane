// Parser for the `foreign-cash-positions` dataset stored by
// poc/sbi-securities-worker: the GraphQL `data` object of
// GetSecuritiesBalanceList, i.e.
// `{ listSecuritiesBalances: { securitiesBalances: [...], page: {...} } }`.
//
// Each balance element yields one position observation (quantity of a
// security) and up to four valuation observations (provider-reported
// evaluation amount / profit-loss, in JPY and in the trading currency).
// Provider-reported valuations are observations; Kogane's own valuations are
// a later derived layer and never mix with these (docs/design.md).
//
// Working assumption, to be confirmed against real R2 payloads on first
// re-parse: `evaluationAmount` / `evaluationProfitLoss` are JPY figures and
// the `frn*` variants are denominated in `currencyCode`. If this turns out to
// be wrong, bumping the parser version and re-parsing corrects every
// observation; that operation is exactly what the pipeline exists to prove.

import type {
  ArtifactMeta,
  Observation,
  Parser,
  ParseResult,
  ValuationObservation,
} from "../types.ts";
import { decimalText, decimalToMinorUnits, decodeUtf8, isObject } from "./util.ts";

const SOURCE_ACCOUNT = "sbi-securities:foreign";

function valuationFor(options: {
  value: unknown;
  metric: string;
  currency: string;
  subject: string;
  locator: string;
  observedAt: string;
  extra: Record<string, unknown>;
  warnings: string[];
}): ValuationObservation | undefined {
  if (options.value === undefined || options.value === null) return undefined;
  const decimal = decimalText(options.value);
  if (!decimal) {
    options.warnings.push(
      `${options.locator}: ${options.metric} ${JSON.stringify(options.value)} is not an exact decimal`,
    );
    return undefined;
  }
  const minor = decimalToMinorUnits(decimal.text, options.currency);
  return {
    kind: "valuation",
    sourceAccount: SOURCE_ACCOUNT,
    subject: options.subject,
    metric: options.metric,
    ...(minor !== undefined ? { amountMinor: minor } : {}),
    amountText: decimal.text,
    amountScale: decimal.scale,
    currency: options.currency,
    observedAt: options.observedAt,
    rawLocator: options.locator,
    extra: options.extra,
  };
}

export const sbiForeignCashPositions: Parser = {
  name: "sbi-foreign-cash-positions",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === "sbi-securities" &&
      artifact.dataset === "foreign-cash-positions"
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body: unknown = JSON.parse(decodeUtf8(bytes));
    const list = isObject(body) ? body["listSecuritiesBalances"] : undefined;
    const balances = isObject(list) ? list["securitiesBalances"] : undefined;
    if (!Array.isArray(balances)) {
      throw new Error(
        `artifact ${artifact.sha256} is not a GetSecuritiesBalanceList data object`,
      );
    }
    const warnings: string[] = [];
    const observations: Observation[] = [];
    balances.forEach((element: unknown, index: number) => {
      if (!isObject(element)) {
        throw new Error(`securitiesBalances[${index}] is not an object`);
      }
      const locator = `json:$.listSecuritiesBalances.securitiesBalances[${index}]`;
      const securities = isObject(element["securities"]) ? element["securities"] : {};
      const market = isObject(element["market"]) ? element["market"] : {};
      const securityCode = String(securities["securitiesCode"] ?? "");
      const currency =
        typeof element["currencyCode"] === "string" ? element["currencyCode"] : undefined;

      const quantity = decimalText(element["securitiesQuantity"]);
      if (!quantity) {
        warnings.push(
          `${locator}: securitiesQuantity ${JSON.stringify(element["securitiesQuantity"])} is not an exact decimal; position skipped, kept in valuation extras`,
        );
      } else {
        observations.push({
          kind: "position",
          sourceAccount: SOURCE_ACCOUNT,
          securityCode,
          ...(typeof securities["securitiesName"] === "string"
            ? { securityName: securities["securitiesName"] }
            : {}),
          ...(typeof market["marketCode"] === "string"
            ? { market: market["marketCode"] }
            : {}),
          quantityText: quantity.text,
          quantityScale: quantity.scale,
          ...(currency !== undefined ? { currency } : {}),
          observedAt: artifact.fetchedAt,
          rawLocator: locator,
          extra: { ...element },
        });
      }

      const profitLoss = isObject(element["evaluationProfitLoss"])
        ? element["evaluationProfitLoss"]
        : {};
      const valuationExtra = {
        securities,
        stockPrice: element["stockPrice"],
        evaluationProfitLoss: profitLoss,
        specificAccountCode: element["specificAccountCode"],
      };
      const cases: { value: unknown; metric: string; currency: string }[] = [
        { value: profitLoss["evaluationAmount"], metric: "evaluation_amount", currency: "JPY" },
        {
          value: profitLoss["evaluationProfitLoss"],
          metric: "evaluation_profit_loss",
          currency: "JPY",
        },
        ...(currency !== undefined
          ? [
              {
                value: profitLoss["frnEvaluationAmount"],
                metric: "frn_evaluation_amount",
                currency,
              },
              {
                value: profitLoss["frnEvaluationProfitLoss"],
                metric: "frn_evaluation_profit_loss",
                currency,
              },
            ]
          : []),
      ];
      for (const item of cases) {
        const observation = valuationFor({
          value: item.value,
          metric: item.metric,
          currency: item.currency,
          subject: securityCode,
          locator: `${locator}.evaluationProfitLoss`,
          observedAt: artifact.fetchedAt,
          extra: valuationExtra,
          warnings,
        });
        if (observation) observations.push(observation);
      }
    });
    return { observations, warnings };
  },
};
