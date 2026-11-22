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
//
// `observed_at` is deliberately left unset: this payload carries no timestamp
// stating when the source displayed the value. When the value was retrieved is
// `fetch_artifacts.fetched_at`, reachable through the observation's parse run,
// and copying it into `observed_at` would collapse two of the three distinct
// timestamps docs/design.md separates.

import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import { amountToMinorUnits, decimalText, decodeUtf8, isObject } from "./util.ts";

const SOURCE_ACCOUNT = "sbi-securities:domestic";

export const sbiDomesticTradeRecords: Parser = {
  name: "sbi-domestic-trade-records",
  // 0.2.2: a stated `tradeDate` that is not a calendar `YYYY-MM-DD` date gives
  // no as_of and a warning; every valid date reads as in 0.2.1.
  version: "0.2.2",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "domestic-trade-records";
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body: unknown = JSON.parse(decodeUtf8(bytes));
    if (!isObject(body) || !Array.isArray(body["records"])) {
      throw new Error(`artifact ${artifact.sha256} is not a domestic-trade-records body`);
    }
    const warnings: string[] = [];
    const observations: Observation[] = body["records"].map(
      (record: unknown, index: number): Observation => {
        const locator = `json:$.records[${index}]`;
        // A record that is not an object is still evidence: it is recorded
        // with the raw element in `extra` rather than discarded, and rather
        // than failing the whole artifact and losing its good records too.
        if (!isObject(record)) {
          warnings.push(
            `records[${index}]: expected an object, got ${typeof record}; recorded verbatim`,
          );
          return {
            kind: "transaction",
            sourceAccount: SOURCE_ACCOUNT,
            currency: "JPY",
            rawLocator: locator,
            extra: { _kogane: { unparsedElement: record } },
          };
        }

        const rawAmount = record["amount"];
        // The collector emits amounts as display strings, but a JSON number is
        // just as parseable and must not be thrown away.
        const amountText =
          typeof rawAmount === "string"
            ? rawAmount
            : typeof rawAmount === "number"
              ? (decimalText(rawAmount)?.text ?? "")
              : "";
        const amountMinor = amountText === "" ? undefined : amountToMinorUnits(amountText, "JPY");
        if (amountMinor === undefined) {
          warnings.push(
            `records[${index}]: amount ${JSON.stringify(rawAmount)} did not resolve to JPY minor units`,
          );
        }
        const normalized = amountText === "" ? undefined : decimalText(amountText);

        const rawCells = Array.isArray(record["rawCells"])
          ? (record["rawCells"] as unknown[])
          : undefined;
        const description =
          typeof rawCells?.[1] === "string" ? rawCells[1] : String(record["issueName"] ?? "");
        // The collector writes `20YY-MM-DD` from the page's `YY/MM/DD` cell
        // without a calendar check, and as_of orders transactions by text.
        // Only a calendar `YYYY-MM-DD` date is one; any other stated value
        // stays in `extra` and is never stored as if it were a date.
        const statedDate = record["tradeDate"];
        const tradeDate =
          typeof statedDate === "string" && parseLocalDate(statedDate) !== null
            ? statedDate
            : undefined;
        if (statedDate !== undefined && tradeDate === undefined) {
          warnings.push(
            `records[${index}]: tradeDate is not a calendar YYYY-MM-DD date; recorded without as_of`,
          );
        }
        const externalId = typeof record["id"] === "string" ? record["id"] : undefined;
        return {
          kind: "transaction",
          sourceAccount: SOURCE_ACCOUNT,
          ...(externalId !== undefined ? { externalId } : {}),
          ...(amountMinor !== undefined ? { amountMinor } : {}),
          // The verbatim amount is kept even when it does not resolve to minor
          // units, so no stated figure is lost to a parsing limitation.
          ...(normalized !== undefined
            ? { amountText: normalized.text, amountScale: normalized.scale }
            : amountText !== ""
              ? { amountText }
              : {}),
          currency: "JPY",
          description,
          ...(tradeDate !== undefined ? { asOf: tradeDate } : {}),
          rawLocator: locator,
          // The whole record is carried forward; nothing the collector saw is
          // dropped. Parser-added fields are namespaced so they can never
          // overwrite a provider field of the same name.
          extra: {
            ...record,
            _kogane: { externalIdOrigin: "collector-fingerprint" },
          },
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
