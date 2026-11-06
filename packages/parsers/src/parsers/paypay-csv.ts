// Parser for the official PayPay consumer transaction CSV
// (docs/sources/paypay.md documents its 13 columns: transaction date/time,
// outgoing JPY, incoming JPY, overseas outgoing amount, currency, conversion
// rate JPY, country, description/type, counterparty, method, installment
// type, user, transaction number).
//
// Columns are located by matching header labels, because docs/sources/paypay.md
// records that the exact column set of the current export is unverified. A
// purely positional mapping would silently invert an amount if the export ever
// reordered the outgoing and incoming columns. Position is used only as a
// fallback, and every fallback is warned about.
//
// Overseas amount / currency / rate / country stay decomposed in extra and are
// never flattened into the JPY figure — the same rule smcc-meisai-scraper's
// parser follows for foreign card use (docs/tooling.md).

import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { amountToMinorUnits, decimalText, decodeUtf8, parseCsv } from "./util.ts";

const SOURCE_ACCOUNT = "paypay";

/**
 * Field order is the documented column order; `match` identifies the column by
 * a distinguishing substring of its header label. `outgoing` and `incoming`
 * are deliberately matched on 出金/入金 rather than on position, since those
 * two carry the sign of the transaction.
 */
const COLUMNS = [
  { field: "datetime", match: ["取引日"] },
  { field: "outgoingJpy", match: ["出金"] },
  { field: "incomingJpy", match: ["入金"] },
  { field: "overseasAmount", match: ["海外"] },
  { field: "overseasCurrency", match: ["通貨"] },
  { field: "conversionRateJpy", match: ["レート"] },
  { field: "country", match: ["利用国"] },
  { field: "description", match: ["取引内容"] },
  { field: "counterparty", match: ["取引先"] },
  { field: "method", match: ["取引方法"] },
  { field: "installmentType", match: ["支払い区分", "支払区分"] },
  { field: "user", match: ["利用者"] },
  { field: "transactionNumber", match: ["取引番号"] },
] as const;

/**
 * "2026/08/15 12:34:56" -> "2026-08-15T12:34:56+09:00" (PayPay shows JST).
 * A date or clock time that does not exist ("2026/02/30 25:61:61",
 * "2026/13/45 00:00") is refused, never rolled over into another instant.
 */
function toIsoJst(value: string): string | undefined {
  const match = value
    .trim()
    .match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const checked = new Date(
    Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]),
  );
  if (
    checked.getUTCFullYear() !== parts[0] ||
    checked.getUTCMonth() + 1 !== parts[1] ||
    checked.getUTCDate() !== parts[2] ||
    checked.getUTCHours() !== parts[3] ||
    checked.getUTCMinutes() !== parts[4] ||
    checked.getUTCSeconds() !== parts[5]
  ) {
    return undefined;
  }
  const pad = (part: string): string => part.padStart(2, "0");
  return `${year}-${pad(month!)}-${pad(day!)}T${pad(hour!)}:${minute}:${second}+09:00`;
}

/**
 * Whether an amount cell carries a sign of its own: a leading `+`, `-`, `△`
 * or `▲`, or parentheses, the markers `amountToMinorUnits` would read. The
 * column, not the cell, states the direction in this export, and no document
 * or observation records what a signed outgoing or incoming value means (a
 * reversal, a correction, or a display variant), so such a value is left
 * without an amount rather than given a guessed direction (ADR 0004).
 */
function carriesSign(cell: string): boolean {
  return /^[+\-△▲(]/u.test(cell) || cell.endsWith(")");
}

/** Locate each documented field in the header row. */
function mapColumns(header: string[]): {
  index: Record<string, number>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const index: Record<string, number> = {};
  const taken = new Set<number>();
  COLUMNS.forEach((column, position) => {
    const found = header.findIndex(
      (label, at) => !taken.has(at) && column.match.some((needle) => label.includes(needle)),
    );
    if (found >= 0) {
      index[column.field] = found;
      taken.add(found);
      if (found !== position) {
        warnings.push(
          `header: ${column.field} was found at column ${found + 1}, not the documented column ${position + 1}`,
        );
      }
      return;
    }
    if (position < header.length && !taken.has(position)) {
      index[column.field] = position;
      taken.add(position);
      warnings.push(
        `header: no label matched ${column.field}; fell back to documented column ${position + 1} (${JSON.stringify(header[position])})`,
      );
    } else {
      warnings.push(`header: no column found for ${column.field}`);
    }
  });
  const unmatched = header
    .map((label, at) => (taken.has(at) ? undefined : `${at + 1}:${label}`))
    .filter((entry): entry is string => entry !== undefined);
  if (unmatched.length > 0) {
    warnings.push(
      `header: columns not documented by docs/sources/paypay.md: ${unmatched.join(", ")}`,
    );
  }
  return { index, warnings };
}

export const paypayCsv: Parser = {
  name: "paypay-csv",
  // 0.2.2: an outgoing or incoming amount that carries its own sign (-, +,
  // △, ▲ or parentheses) is left without an amount, with a closed warning,
  // instead of being negated (outgoing) or transcribed (incoming); every
  // unsigned amount reads as in 0.2.1.
  // 0.2.1: a transaction date or time that does not exist gives no asOf and
  // the "not recognized" warning instead of an impossible instant; every
  // existing date and time reads as in 0.2.0.
  version: "0.2.2",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "paypay" && artifact.mime === "text/csv";
  },

  parse(bytes: Uint8Array, _artifact: ArtifactMeta): ParseResult {
    const rows = parseCsv(decodeUtf8(bytes));
    const header = rows[0];
    if (!header) throw new Error("PayPay CSV is empty");
    if (!header.some((cell) => cell.includes("取引日"))) {
      throw new Error("PayPay CSV header does not mention 取引日");
    }
    const { index, warnings } = mapColumns(header);
    const cellFor = (cells: string[], field: string): string => {
      const at = index[field];
      return at === undefined ? "" : (cells[at] ?? "");
    };

    const observations: Observation[] = [];
    rows.slice(1).forEach((cells, offset) => {
      const rowNumber = offset + 2; // 1-based, counting the header as row 1
      if (cells.length !== header.length) {
        warnings.push(`row ${rowNumber}: expected ${header.length} columns, got ${cells.length}`);
      }

      const outgoing = cellFor(cells, "outgoingJpy").trim();
      const incoming = cellFor(cells, "incomingJpy").trim();
      let amountMinor: number | undefined;
      let amountVerbatim: string | undefined;
      if (outgoing !== "" && incoming !== "") {
        warnings.push(
          `row ${rowNumber}: both outgoing and incoming amounts present; not conflated`,
        );
      } else if (outgoing !== "" && carriesSign(outgoing)) {
        warnings.push(
          `row ${rowNumber}: outgoing amount carries a sign; provider-signed amounts are unsupported, amount left empty`,
        );
      } else if (incoming !== "" && carriesSign(incoming)) {
        warnings.push(
          `row ${rowNumber}: incoming amount carries a sign; provider-signed amounts are unsupported, amount left empty`,
        );
      } else if (outgoing !== "") {
        amountVerbatim = outgoing;
        const value = amountToMinorUnits(outgoing, "JPY");
        if (value === undefined) {
          warnings.push(`row ${rowNumber}: outgoing ${JSON.stringify(outgoing)} unparseable`);
        } else {
          amountMinor = value === 0 ? 0 : -value;
        }
      } else if (incoming !== "") {
        amountVerbatim = incoming;
        const value = amountToMinorUnits(incoming, "JPY");
        if (value === undefined) {
          warnings.push(`row ${rowNumber}: incoming ${JSON.stringify(incoming)} unparseable`);
        } else {
          amountMinor = value;
        }
      } else {
        warnings.push(`row ${rowNumber}: neither an outgoing nor an incoming amount was stated`);
      }
      const normalized = amountVerbatim !== undefined ? decimalText(amountVerbatim) : undefined;

      const datetime = cellFor(cells, "datetime");
      const asOf = toIsoJst(datetime);
      if (asOf === undefined && datetime !== "") {
        warnings.push(`row ${rowNumber}: datetime ${JSON.stringify(datetime)} not recognized`);
      }
      const transactionNumber = cellFor(cells, "transactionNumber").trim();
      const description = cellFor(cells, "description");
      const counterparty = cellFor(cells, "counterparty");
      observations.push({
        kind: "transaction",
        sourceAccount: SOURCE_ACCOUNT,
        ...(transactionNumber !== "" ? { externalId: transactionNumber } : {}),
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        ...(normalized !== undefined
          ? { amountText: normalized.text, amountScale: normalized.scale }
          : amountVerbatim !== undefined
            ? { amountText: amountVerbatim }
            : {}),
        currency: "JPY",
        ...(description !== "" ? { description } : {}),
        ...(counterparty !== "" ? { counterparty } : {}),
        ...(asOf !== undefined ? { asOf } : {}),
        rawLocator: `csv:row=${rowNumber}`,
        extra: {
          // The verbatim row and its header, so a column the export adds later
          // is preserved by name as well as by value.
          header,
          cells,
          overseas: {
            amount: cellFor(cells, "overseasAmount"),
            currency: cellFor(cells, "overseasCurrency"),
            conversionRateJpy: cellFor(cells, "conversionRateJpy"),
            country: cellFor(cells, "country"),
          },
          method: cellFor(cells, "method"),
          installmentType: cellFor(cells, "installmentType"),
          user: cellFor(cells, "user"),
          datetimeVerbatim: datetime,
        },
      });
    });
    return { observations, warnings };
  },
};
