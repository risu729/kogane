import type { ArtifactMeta, Parser } from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { exactDecimal, exactKeys, exactMoney, normalizedDate, strictObject } from "./sbi-strict.ts";
import { decodeUtf8 } from "./util.ts";

const SOURCE = "smbc-bank";
const SOURCE_ACCOUNT = "smbc-bank:ordinary-foreign-aud";
const EMPTY_CODE = "PC-AIFDDT1-00134-E";

export const smbcForeignOrdinaryBalance: Parser = {
  name: "smbc-foreign-ordinary-balance",
  version: "0.1.1",
  accepts: (artifact) =>
    accepts(artifact, "foreign-ordinary-aud-balance", "foreign-ordinary-aud/balance.json"),
  parse(bytes, artifact) {
    const input = read(bytes, artifact);
    exactKeys(
      input,
      ["currency", "amount", "yenEquivalent", "referenceRate", "observedAt"],
      "foreign balance",
    );
    currency(input);
    const money = exactMoney(input.amount, "AUD", "foreign balance");
    const yenEquivalent = exactMoney(input.yenEquivalent, "JPY", "yen equivalent");
    const referenceRate = exactDecimal(input.referenceRate, "reference rate");
    if (money.minor < 0 || yenEquivalent.minor < 0 || referenceRate.text.startsWith("-"))
      throw new Error("smbc_foreign_decimal_invalid");
    const observedAt = instant(input.observedAt);
    return {
      observations: [
        {
          kind: "balance",
          sourceAccount: SOURCE_ACCOUNT,
          metric: "account_balance",
          amountMinor: money.minor,
          amountText: money.text,
          amountScale: money.scale,
          instrument: "AUD",
          asOf: observedAt,
          observedAt,
          rawLocator: "json:$.amount",
          extra: {
            yenEquivalent: yenEquivalent.text,
            referenceRate: referenceRate.text,
            _kogane: {
              balanceScope: "ordinary_foreign_aud_account",
              rateMeaning: "current_reference_foreign_to_yen",
              canonicalDataset: "foreign-ordinary-aud-balance",
            },
          },
        },
      ],
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: 1,
          expectedCount: 1,
          evidenceRefs: ["json:$.amount"],
        }),
      ],
    };
  },
};

/** Only the explicitly observed empty response is supported. A nonempty
 * transaction shape has not been observed and cannot publish guessed rows. */
export const smbcForeignOrdinaryHistory: Parser = {
  name: "smbc-foreign-ordinary-history",
  version: "0.1.1",
  accepts: (artifact) =>
    artifact.sourceId === SOURCE &&
    artifact.dataset === "foreign-ordinary-aud-history" &&
    artifact.mime === "application/json" &&
    /^foreign-ordinary-aud\/history\/\d{8}-\d{8}\.json$/u.test(artifact.artifactKey ?? ""),
  parse(bytes, artifact) {
    const input = read(bytes, artifact);
    exactKeys(input, ["currency", "range", "emptyCode", "transactions"], "foreign history");
    currency(input);
    const range = strictObject(input.range, "foreign history range");
    exactKeys(range, ["start", "end"], "foreign history range");
    const start = normalizedDate(range.start, "foreign history start");
    const end = normalizedDate(range.end, "foreign history end");
    if (
      start > end ||
      artifact.artifactKey !==
        `foreign-ordinary-aud/history/${start.replaceAll("-", "")}-${end.replaceAll("-", "")}.json`
    )
      throw new Error("smbc_foreign_history_range_invalid");
    if (
      input.emptyCode !== EMPTY_CODE ||
      !Array.isArray(input.transactions) ||
      input.transactions.length !== 0
    )
      throw new Error("smbc_foreign_nonempty_unreviewed");
    return {
      observations: [],
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: 0,
          expectedCount: 0,
          evidenceRefs: ["json:$.emptyCode"],
        }),
      ],
    };
  },
};

function accepts(artifact: ArtifactMeta, dataset: string, key: string): boolean {
  return (
    artifact.sourceId === SOURCE &&
    (artifact.dataset === dataset || artifact.dataset === null) &&
    artifact.fetchUnitKey === "foreign-ordinary-aud" &&
    artifact.artifactKey === key &&
    artifact.mime === "application/json"
  );
}

function read(bytes: Uint8Array, artifact: ArtifactMeta): Record<string, unknown> {
  if (artifact.runStatus !== "success" || artifact.runFailureCount !== 0)
    throw new Error("smbc_foreign_run_incomplete");
  return strictObject(JSON.parse(decodeUtf8(bytes)), "foreign ordinary capture");
}

function currency(input: Record<string, unknown>): void {
  if (input.currency !== "AUD") throw new Error("smbc_foreign_currency_unreviewed");
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("smbc_foreign_observed_at_invalid");
  return value;
}
