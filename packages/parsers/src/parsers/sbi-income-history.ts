import type { Observation, Parser, ValuationObservation } from "../types.ts";
import { containerClaim, ParseDiagnostics } from "./coverage.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import { stableFingerprint, exactDecimal } from "./sbi-strict.ts";
import {
  incomeDecimal,
  incomeMoney,
  readIncomeJson,
  validateIncomeHistory,
  type IncomeHistoryKind,
} from "./sbi-income-history-schema.ts";

export const incomeDataset = (kind: IncomeHistoryKind) =>
  kind === "income" ? "income-payments" : "realised-gains";
const iso = (text: unknown) =>
  `${String(text).slice(0, 4)}-${String(text).slice(4, 6)}-${String(text).slice(6)}`;

function parser(kind: IncomeHistoryKind): Parser {
  return {
    name: kind === "income" ? "sbi-income-payments" : "sbi-realised-gains",
    version: "0.1.1",
    accepts: (artifact) =>
      artifact.sourceId === "sbi-securities" && artifact.dataset === incomeDataset(kind),
    parse(bytes, artifact) {
      if (artifact.mime !== "application/json") throw new Error("sbi_income_history_schema");
      if (
        (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
        !unitScopeAdmitted(artifact)
      )
        throw new Error("sbi_income_history_run_incomplete");
      // Outer fields are text/metadata; the shared reader rejects duplicate keys
      // and original source texts are validated again inside the bundle.
      const body = readIncomeJson(decodeUtf8(bytes)).exact;
      const { records } = validateIncomeHistory(body, kind);
      const observations: Observation[] = [];
      const diagnostics = new ParseDiagnostics();
      const occurrences = new Map<string, number>();
      for (const [index, row] of records.entries()) {
        const foreign = row["category"] === "FOREIGN_STOCK_US";
        const currency = foreign ? "USD" : "JPY";
        const suffix = foreign ? "Lc" : "";
        const asOf = iso(row[kind === "income" ? "dispositionDate" : "contractDate"]);
        // A USD payment's changing yen equivalent is not another payment.
        // No provider id was observed: normalized net/proceeds plus occurrence
        // identifies repeated rows, without claiming to reconcile corrections
        // to that identifying amount or quantity.
        const fingerprint = stableFingerprint([
          kind,
          row["category"],
          row["accountType"],
          row["productCode"],
          asOf,
          kind === "gains" ? row["dispositionDate"] : null,
          incomeDecimal(row["quantity"]),
          incomeDecimal(row[kind === "income" ? `receivedAmount${suffix}` : "amount"]),
        ]);
        const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
        occurrences.set(fingerprint, occurrence);
        const externalId = `sbi-${kind}:${fingerprint}:${occurrence}`;
        const metrics: [string, string, boolean][] =
          kind === "income"
            ? [
                [`dividendTotal${suffix}`, "income_gross", true],
                [`taxTotal${suffix}`, "income_tax", true],
                [`incomeTax${suffix}`, "income_income_tax", true],
                [`residentTax${suffix}`, "income_resident_tax", true],
                [`receivedAmount${suffix}`, "income_net", true],
              ]
            : [
                ["amount", "sale_proceeds", true],
                ["profitLoss", "realised_gain_before_tax", true],
                ["price", "sale_unit_price", false],
                ["acquisitionCost", "average_acquisition_unit_cost", false],
              ];
        for (const [field, metric, isMoney] of metrics) {
          const locator = `json:$.rowsText.${kind === "income" ? "dividends" : "profitLosses"}[${index}].${field}`;
          if (row[field] === null) {
            diagnostics.note({
              code: "row_unreadable",
              locator,
              severity: "info",
              impact: "field",
              message: "sbi_income_history_metric_unavailable",
            });
            continue;
          }
          const amount = isMoney
            ? incomeMoney(row[field], currency)
            : exactDecimal(incomeDecimal(row[field]), "income unit price");
          const observation: ValuationObservation = {
            kind: "valuation",
            sourceAccount: `sbi-securities:${kind}:${row["accountType"]}`,
            subject: `sbi:${kind}:${externalId}`,
            metric,
            amountText: amount.text,
            amountScale: amount.scale,
            ...(isMoney ? { amountMinor: (amount as ReturnType<typeof incomeMoney>).minor } : {}),
            currency,
            asOf,
            rawLocator: locator,
            extra: {
              ...row,
              _kogane: {
                externalId,
                identityOrigin: "row-occurrence",
                sourceView: kind === "income" ? "official-payment-detail" : "official-sale-detail",
                securityCode: row["productCode"],
                accountType: row["accountType"],
                category: row["category"],
                sourceCurrency: currency,
                incomeRecognition: "evidence-only",
                quantityText: incomeDecimal(row["quantity"]),
                ...(foreign ? { yenEquivalent: "metadata-only" } : {}),
              },
            },
          };
          observations.push(observation);
        }
      }
      return {
        observations,
        warnings: [],
        issues: diagnostics.issues,
        coverage: [
          containerClaim({
            artifact,
            issues: diagnostics.issues,
            observedCount: observations.length,
            expectedCount: observations.length,
            evidenceRefs: ["json:$.summaryText", "json:$.rowsText"],
          }),
        ],
      };
    },
  };
}

export const sbiIncomePayments = parser("income");
export const sbiRealisedGains = parser("gains");
