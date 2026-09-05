// Parser for the `foreign-cash-balances` dataset stored by
// poc/sbi-securities-worker: the GraphQL `data` object of
// GetForeignCashBalance, i.e.
// `{ listForeignScheduleCashBalances: { foreignCashBalances: [
//      { accountKind, currencyCashBalances: [
//          { currencyCode, foreignScheduleCashBalances: [
//              { businessDate daysLater buyPossibleAmount keepCash
//                transferPossibleAmount remainingBuyPossibleAmount
//                amountPayValue } ] } ] } ] } }`.
//
// Balances are measurements, not columns (docs/design.md): each schedule row
// yields one balance observation per provider metric, keyed by
// (source_account, metric, instrument, as_of), append-only.
//
// Structures this parser does not recognize are never skipped quietly — each
// one produces a warning naming its locator, because a silently dropped
// container could be an entire account.

import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decimalText, decimalToMinorUnits, decodeUtf8, isObject } from "./util.ts";

const SOURCE_ACCOUNT = "sbi-securities:foreign";

const METRIC_FIELDS: readonly { field: string; metric: string }[] = [
  { field: "buyPossibleAmount", metric: "buy_possible_amount" },
  { field: "keepCash", metric: "keep_cash" },
  { field: "transferPossibleAmount", metric: "transfer_possible_amount" },
  { field: "remainingBuyPossibleAmount", metric: "remaining_buy_possible_amount" },
  { field: "amountPayValue", metric: "amount_pay_value" },
];

/** Copy an object without the child collection the caller walks separately. */
function withoutChild(value: Record<string, unknown>, child: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== child) copy[key] = entry;
  }
  return copy;
}

export const sbiForeignCashBalances: Parser = {
  name: "sbi-foreign-cash-balances",
  version: "0.2.0",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "foreign-cash-balances";
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body: unknown = JSON.parse(decodeUtf8(bytes));
    const list = isObject(body) ? body["listForeignScheduleCashBalances"] : undefined;
    const accounts = isObject(list) ? list["foreignCashBalances"] : undefined;
    if (!Array.isArray(accounts)) {
      throw new Error(`artifact ${artifact.sha256} is not a GetForeignCashBalance data object`);
    }
    const warnings: string[] = [];
    const observations: Observation[] = [];
    accounts.forEach((account: unknown, accountIndex: number) => {
      const accountLocator = `json:$.listForeignScheduleCashBalances.foreignCashBalances[${accountIndex}]`;
      if (!isObject(account)) {
        warnings.push(
          `${accountLocator}: expected an object, got ${typeof account}; nothing could be read from it`,
        );
        return;
      }
      const currencies = account["currencyCashBalances"];
      if (!Array.isArray(currencies)) {
        warnings.push(
          `${accountLocator}.currencyCashBalances: expected an array, got ${typeof currencies}; the whole account was skipped`,
        );
        return;
      }
      currencies.forEach((currencyEntry: unknown, currencyIndex: number) => {
        const currencyLocator = `${accountLocator}.currencyCashBalances[${currencyIndex}]`;
        if (!isObject(currencyEntry)) {
          warnings.push(
            `${currencyLocator}: expected an object, got ${typeof currencyEntry}; skipped`,
          );
          return;
        }
        const currencyCode =
          typeof currencyEntry["currencyCode"] === "string"
            ? currencyEntry["currencyCode"]
            : undefined;
        if (currencyCode === undefined) {
          warnings.push(`${currencyLocator} omitted currencyCode; skipped`);
          return;
        }
        const schedule = currencyEntry["foreignScheduleCashBalances"];
        if (!Array.isArray(schedule)) {
          warnings.push(
            `${currencyLocator}.foreignScheduleCashBalances: expected an array, got ${typeof schedule}; skipped`,
          );
          return;
        }
        schedule.forEach((row: unknown, rowIndex: number) => {
          const locator = `${currencyLocator}.foreignScheduleCashBalances[${rowIndex}]`;
          if (!isObject(row)) {
            warnings.push(`${locator}: expected an object, got ${typeof row}; skipped`);
            return;
          }
          const asOf = typeof row["businessDate"] === "string" ? row["businessDate"] : undefined;
          // Fields of the enclosing account and currency entry are carried on
          // every observation, so an unmodelled sibling (a balance the schema
          // does not know about yet) is never lost.
          const context = {
            account: withoutChild(account, "currencyCashBalances"),
            currencyEntry: withoutChild(currencyEntry, "foreignScheduleCashBalances"),
            row: { ...row },
          };
          const unmodelled = Object.keys(row).filter(
            (key) =>
              key !== "businessDate" &&
              key !== "daysLater" &&
              !METRIC_FIELDS.some((entry) => entry.field === key),
          );
          if (unmodelled.length > 0) {
            warnings.push(
              `${locator}: fields not modelled as metrics were kept only in extra: ${unmodelled.join(", ")}`,
            );
          }
          for (const { field, metric } of METRIC_FIELDS) {
            const value = row[field];
            if (value === undefined || value === null) continue;
            const decimal = decimalText(value);
            if (!decimal) {
              warnings.push(
                `${locator}.${field}: ${JSON.stringify(value)} is not an exact decimal`,
              );
              continue;
            }
            const minor = decimalToMinorUnits(decimal.text, currencyCode);
            if (minor === undefined) {
              warnings.push(
                `${locator}.${field}: ${decimal.text} has no exact ${currencyCode} minor-unit form; kept as text`,
              );
            }
            observations.push({
              kind: "balance",
              sourceAccount: SOURCE_ACCOUNT,
              metric,
              ...(minor !== undefined ? { amountMinor: minor } : {}),
              amountText: decimal.text,
              amountScale: decimal.scale,
              instrument: currencyCode,
              ...(asOf !== undefined ? { asOf } : {}),
              rawLocator: `${locator}.${field}`,
              extra: context,
            });
          }
        });
      });
    });
    return { observations, warnings };
  },
};
