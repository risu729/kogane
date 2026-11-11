import type { ArtifactMeta, Observation, ParseResult } from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { exactMoney, normalizedDate, stableFingerprint } from "./sbi-strict.ts";
import {
  parseCashHistoryJson,
  validateCashHistory,
  type CashHistoryKind,
} from "./sbi-cash-history-schema.ts";

export function parseRetainedCashHistory(
  bytes: Uint8Array,
  artifact: ArtifactMeta,
  kind: CashHistoryKind,
): ParseResult {
  const bundle = validateCashHistory(parseCashHistoryJson(new TextDecoder().decode(bytes)), kind);
  const observations: Observation[] = [];
  const occurrences = new Map<string, number>();
  for (const [pageIndex, page] of bundle.pages.entries()) {
    const rows = page[kind === "yen" ? "depositRecordList" : "items"] as Record<string, unknown>[];
    for (const [rowIndex, row] of rows.entries()) {
      const currency = kind === "yen" ? "JPY" : "USD";
      const amount = exactMoney(
        row[kind === "yen" ? "payAmount" : "amount"],
        currency,
        "cash history amount",
      );
      const asOf = normalizedDate(
        row[kind === "yen" ? "payDepDate" : "valueDate"],
        "cash history date",
      );
      const credit = row[kind === "yen" ? "payDepKbn" : "tradeType"] === "入金";
      const description = String(row[kind === "yen" ? "dispAbstract" : "description"]);
      const fingerprint =
        kind === "yen"
          ? ""
          : stableFingerprint([asOf, credit, row["cashType"], currency, amount.minor, description]);
      const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, occurrence);
      observations.push({
        kind: "transaction",
        sourceAccount: kind === "yen" ? "sbi-securities:yen-cash" : "sbi-securities:foreign",
        externalId:
          kind === "yen"
            ? `sbi-yen-detail:${row["did"]}`
            : `sbi-foreign-cash:${fingerprint}:${occurrence}`,
        status: "posted",
        amountMinor: amount.minor,
        amountText: amount.text,
        amountScale: amount.scale,
        currency,
        description: description || String(row[kind === "yen" ? "detailKbn" : "cashType"] ?? ""),
        asOf,
        rawLocator: `json:$.pages[${pageIndex}].${kind === "yen" ? "depositRecordList" : "items"}[${rowIndex}]`,
        extra: {
          ...row,
          _kogane: {
            direction: credit ? "credit" : "debit",
            transactionType: credit ? "deposit" : "withdrawal",
            bundlePageIndex: pageIndex,
            providerPageNumber: pageIndex + 1,
            ...(kind === "foreign" ? { identityOrigin: "row-occurrence" } : {}),
          },
        },
      });
    }
  }
  return {
    observations,
    warnings: [],
    issues: [],
    coverage: [
      containerClaim({
        artifact,
        issues: [],
        observedCount: observations.length,
        expectedCount: bundle.totalCount,
        evidenceRefs: ["json:$.requestedRange", "json:$.pages"],
      }),
    ],
  };
}
