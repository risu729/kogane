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

export const sbiForeignCashBalances: Parser = {
  name: "sbi-foreign-cash-balances",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === "sbi-securities" &&
      artifact.dataset === "foreign-cash-balances"
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body: unknown = JSON.parse(decodeUtf8(bytes));
    const list = isObject(body) ? body["listForeignScheduleCashBalances"] : undefined;
    const accounts = isObject(list) ? list["foreignCashBalances"] : undefined;
    if (!Array.isArray(accounts)) {
      throw new Error(
        `artifact ${artifact.sha256} is not a GetForeignCashBalance data object`,
      );
    }
    const warnings: string[] = [];
    const observations: Observation[] = [];
    accounts.forEach((account: unknown, accountIndex: number) => {
      if (!isObject(account)) return;
      const currencies = Array.isArray(account["currencyCashBalances"])
        ? account["currencyCashBalances"]
        : [];
      currencies.forEach((currencyEntry: unknown, currencyIndex: number) => {
        if (!isObject(currencyEntry)) return;
        const currencyCode =
          typeof currencyEntry["currencyCode"] === "string"
            ? currencyEntry["currencyCode"]
            : undefined;
        if (currencyCode === undefined) {
          warnings.push(
            `foreignCashBalances[${accountIndex}].currencyCashBalances[${currencyIndex}] omitted currencyCode; skipped`,
          );
          return;
        }
        const schedule = Array.isArray(currencyEntry["foreignScheduleCashBalances"])
          ? currencyEntry["foreignScheduleCashBalances"]
          : [];
        schedule.forEach((row: unknown, rowIndex: number) => {
          if (!isObject(row)) return;
          const locator =
            `json:$.listForeignScheduleCashBalances.foreignCashBalances[${accountIndex}]` +
            `.currencyCashBalances[${currencyIndex}].foreignScheduleCashBalances[${rowIndex}]`;
          const asOf =
            typeof row["businessDate"] === "string" ? row["businessDate"] : undefined;
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
            observations.push({
              kind: "balance",
              sourceAccount: SOURCE_ACCOUNT,
              metric,
              ...(minor !== undefined ? { amountMinor: minor } : {}),
              amountText: decimal.text,
              amountScale: decimal.scale,
              instrument: currencyCode,
              ...(asOf !== undefined ? { asOf } : {}),
              observedAt: artifact.fetchedAt,
              rawLocator: `${locator}.${field}`,
              extra: {
                accountKind: account["accountKind"],
                daysLater: row["daysLater"],
                row: { ...row },
              },
            });
          }
        });
      });
    });
    return { observations, warnings };
  },
};
