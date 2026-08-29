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
//
// `observed_at` and the position's `as_of` are left unset: this payload states
// no time for the values it reports. See the note in
// sbi-domestic-trade-records.ts.

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
  if (minor === undefined) {
    options.warnings.push(
      `${options.locator}: ${options.metric} ${decimal.text} has no exact ${options.currency} minor-unit form; kept as text`,
    );
  }
  return {
    kind: "valuation",
    sourceAccount: SOURCE_ACCOUNT,
    subject: options.subject,
    metric: options.metric,
    ...(minor !== undefined ? { amountMinor: minor } : {}),
    amountText: decimal.text,
    amountScale: decimal.scale,
    currency: options.currency,
    rawLocator: options.locator,
    extra: options.extra,
  };
}

export const sbiForeignCashPositions: Parser = {
  name: "sbi-foreign-cash-positions",
  version: "0.2.0",

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
      const locator = `json:$.listSecuritiesBalances.securitiesBalances[${index}]`;
      if (!isObject(element)) {
        // Recorded rather than dropped, and rather than failing the artifact.
        warnings.push(
          `securitiesBalances[${index}]: expected an object, got ${typeof element}; recorded verbatim`,
        );
        observations.push({
          kind: "position",
          sourceAccount: SOURCE_ACCOUNT,
          securityCode: "",
          quantityText: "",
          quantityScale: 0,
          rawLocator: locator,
          extra: { _kogane: { unparsedElement: element } },
        });
        return;
      }
      const securities = isObject(element["securities"]) ? element["securities"] : {};
      const market = isObject(element["market"]) ? element["market"] : {};
      const securityCode = String(securities["securitiesCode"] ?? "");
      if (securityCode === "") {
        warnings.push(
          `${locator}: securities.securitiesCode is missing; the observation cannot be joined by security`,
        );
      }
      const currency =
        typeof element["currencyCode"] === "string" ? element["currencyCode"] : undefined;

      const quantity = decimalText(element["securitiesQuantity"]);
      if (!quantity) {
        warnings.push(
          `${locator}: securitiesQuantity ${JSON.stringify(element["securitiesQuantity"])} is not an exact decimal; the position is recorded without a quantity`,
        );
      }
      // The position is emitted whether or not the quantity parsed, so that a
      // holding never disappears because one field was unreadable.
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
        quantityText: quantity?.text ?? "",
        quantityScale: quantity?.scale ?? 0,
        ...(currency !== undefined ? { currency } : {}),
        rawLocator: locator,
        extra: { ...element },
      });

      const profitLoss = isObject(element["evaluationProfitLoss"])
        ? element["evaluationProfitLoss"]
        : {};
      // The full element is carried on every valuation too, so a valuation row
      // is self-contained evidence of what the source said around it.
      const valuationExtra = { ...element };
      const cases: { value: unknown; metric: string; currency: string }[] = [
        { value: profitLoss["evaluationAmount"], metric: "evaluation_amount", currency: "JPY" },
        {
          value: profitLoss["evaluationProfitLoss"],
          metric: "evaluation_profit_loss",
          currency: "JPY",
        },
      ];
      if (currency !== undefined) {
        cases.push(
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
        );
      } else if (
        profitLoss["frnEvaluationAmount"] !== undefined ||
        profitLoss["frnEvaluationProfitLoss"] !== undefined
      ) {
        warnings.push(
          `${locator}: currencyCode is missing, so the frn* valuations cannot be denominated; they remain only in extra`,
        );
      }
      for (const item of cases) {
        const observation = valuationFor({
          value: item.value,
          metric: item.metric,
          currency: item.currency,
          subject: securityCode,
          locator: `${locator}.evaluationProfitLoss`,
          extra: valuationExtra,
          warnings,
        });
        if (observation) observations.push(observation);
      }
    });
    return { observations, warnings };
  },
};
