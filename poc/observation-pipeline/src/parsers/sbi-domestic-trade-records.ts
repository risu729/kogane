// Parser for the `domestic-trade-records` dataset stored by
// poc/sbi-securities-worker. The stored artifact body is
// `{ records: DomesticTradeRecord[], hasMore: boolean }`, where each record
// keeps the source table row verbatim in `rawCells` (the collector already
// follows the "never drop fields" rule at capture time).
//
// Every record becomes one transaction observation. Amounts are recorded as
// the provider displayed them (△ handled as a negative marker); no sign is
// invented from the trade type — that is interpretation, which belongs to
// layer C, not to a parser.

import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { amountToMinorUnits, decodeUtf8, isObject } from "./util.ts";

const SOURCE_ACCOUNT = "sbi-securities:domestic";

export const sbiDomesticTradeRecords: Parser = {
  name: "sbi-domestic-trade-records",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === "sbi-securities" &&
      artifact.dataset === "domestic-trade-records"
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body: unknown = JSON.parse(decodeUtf8(bytes));
    if (!isObject(body) || !Array.isArray(body["records"])) {
      throw new Error(
        `artifact ${artifact.sha256} is not a domestic-trade-records body`,
      );
    }
    const warnings: string[] = [];
    const observations: Observation[] = body["records"].map(
      (record: unknown, index: number): Observation => {
        if (!isObject(record)) {
          throw new Error(`records[${index}] is not an object`);
        }
        const amount = typeof record["amount"] === "string" ? record["amount"] : "";
        const amountMinor = amountToMinorUnits(amount, "JPY");
        if (amountMinor === undefined) {
          warnings.push(
            `records[${index}]: amount ${JSON.stringify(amount)} did not resolve to JPY minor units`,
          );
        }
        const rawCells = Array.isArray(record["rawCells"])
          ? (record["rawCells"] as unknown[])
          : undefined;
        const description =
          typeof rawCells?.[1] === "string"
            ? rawCells[1]
            : String(record["issueName"] ?? "");
        const tradeDate =
          typeof record["tradeDate"] === "string" ? record["tradeDate"] : undefined;
        const externalId = typeof record["id"] === "string" ? record["id"] : undefined;
        return {
          kind: "transaction",
          sourceAccount: SOURCE_ACCOUNT,
          ...(externalId !== undefined ? { externalId } : {}),
          ...(amountMinor !== undefined ? { amountMinor } : {}),
          currency: "JPY",
          description,
          ...(tradeDate !== undefined ? { asOf: tradeDate } : {}),
          observedAt: artifact.fetchedAt,
          rawLocator: `json:$.records[${index}]`,
          // The whole record is carried forward; nothing the collector saw is
          // dropped, including fields this parser does not model.
          extra: { ...record, externalIdOrigin: "collector-fingerprint" },
        };
      },
    );
    if (body["hasMore"] === true) {
      warnings.push(
        "hasMore=true: the source truncated this window; artifact covers a partial page",
      );
    }
    return { observations, warnings };
  },
};
