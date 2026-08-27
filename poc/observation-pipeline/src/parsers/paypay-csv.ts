// Parser for the official PayPay consumer transaction CSV
// (docs/sources/paypay.md documents its 13 columns: transaction date/time,
// outgoing JPY, incoming JPY, overseas outgoing amount, currency, conversion
// rate JPY, country, description/type, counterparty, method, installment
// type, user, transaction number).
//
// Header labels are matched loosely by keyword because the exact strings come
// from a real export we have not committed; positional order is the
// documented fallback. Overseas amount / currency / rate / country stay
// decomposed in extra and are never flattened into the JPY figure — the same
// rule smcc-meisai-scraper's parser follows for foreign card use
// (docs/tooling.md).

import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { amountToMinorUnits, decodeUtf8, parseCsv } from "./util.ts";

const SOURCE_ACCOUNT = "paypay";

const COLUMNS = [
  "datetime",
  "outgoingJpy",
  "incomingJpy",
  "overseasAmount",
  "overseasCurrency",
  "conversionRateJpy",
  "country",
  "description",
  "counterparty",
  "method",
  "installmentType",
  "user",
  "transactionNumber",
] as const;

/** "2026/08/15 12:34:56" -> "2026-08-15T12:34:56+09:00" (PayPay shows JST). */
function toIsoJst(value: string): string | undefined {
  const match = value
    .trim()
    .match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
}

export const paypayCsv: Parser = {
  name: "paypay-csv",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "paypay" && artifact.mime === "text/csv";
  },

  parse(bytes: Uint8Array, _artifact: ArtifactMeta): ParseResult {
    const rows = parseCsv(decodeUtf8(bytes));
    const header = rows[0];
    if (!header || header.length < COLUMNS.length) {
      throw new Error("PayPay CSV is missing its 13-column header row");
    }
    if (!header.some((cell) => cell.includes("取引日"))) {
      throw new Error("PayPay CSV header does not mention 取引日");
    }
    const warnings: string[] = [];
    const observations: Observation[] = [];
    rows.slice(1).forEach((cells, index) => {
      const rowNumber = index + 2; // 1-based, counting the header as row 1
      const record: Record<string, string> = {};
      COLUMNS.forEach((name, column) => {
        record[name] = cells[column] ?? "";
      });
      if (cells.length !== COLUMNS.length) {
        warnings.push(
          `row ${rowNumber}: expected ${COLUMNS.length} columns, got ${cells.length}`,
        );
      }

      const outgoing = record["outgoingJpy"]?.trim() ?? "";
      const incoming = record["incomingJpy"]?.trim() ?? "";
      let amountMinor: number | undefined;
      if (outgoing !== "" && incoming !== "") {
        warnings.push(
          `row ${rowNumber}: both outgoing and incoming amounts present; not conflated`,
        );
      } else if (outgoing !== "") {
        const value = amountToMinorUnits(outgoing, "JPY");
        if (value === undefined) {
          warnings.push(`row ${rowNumber}: outgoing ${JSON.stringify(outgoing)} unparseable`);
        } else {
          amountMinor = -value;
        }
      } else if (incoming !== "") {
        const value = amountToMinorUnits(incoming, "JPY");
        if (value === undefined) {
          warnings.push(`row ${rowNumber}: incoming ${JSON.stringify(incoming)} unparseable`);
        } else {
          amountMinor = value;
        }
      }

      const asOf = toIsoJst(record["datetime"] ?? "");
      if (asOf === undefined && (record["datetime"] ?? "") !== "") {
        warnings.push(
          `row ${rowNumber}: datetime ${JSON.stringify(record["datetime"])} not recognized`,
        );
      }
      const transactionNumber = record["transactionNumber"]?.trim() ?? "";
      observations.push({
        kind: "transaction",
        sourceAccount: SOURCE_ACCOUNT,
        ...(transactionNumber !== "" ? { externalId: transactionNumber } : {}),
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        currency: "JPY",
        ...(record["description"] ? { description: record["description"] } : {}),
        ...(record["counterparty"] ? { counterparty: record["counterparty"] } : {}),
        ...(asOf !== undefined ? { asOf } : {}),
        rawLocator: `csv:row=${rowNumber}`,
        extra: {
          // Verbatim row and the decomposed foreign-use fields; the JPY
          // conversion is the provider's own and never replaces the original.
          cells,
          overseas: {
            amount: record["overseasAmount"],
            currency: record["overseasCurrency"],
            conversionRateJpy: record["conversionRateJpy"],
            country: record["country"],
          },
          method: record["method"],
          installmentType: record["installmentType"],
          user: record["user"],
          datetimeVerbatim: record["datetime"],
        },
      });
    });
    return { observations, warnings };
  },
};
