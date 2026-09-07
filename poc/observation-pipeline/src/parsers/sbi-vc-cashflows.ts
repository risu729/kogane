import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  balanceFromDecimal,
  parseSbiVcPage,
  providerExtra,
  providerTimestamp,
  requireString,
  SBI_VC_MAX_PAGES,
  SBI_VC_SOURCE_ACCOUNT,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { decimalText, decimalToMinorUnits, isObject } from "./util.ts";

const DATASET = /^cashflows-historical-page-(\d{4})$/u;
const ITEM_FIELDS = [
  "cashbalance",
  "cashflowAmount",
  "cashflowID",
  "cashflowType",
  "currency",
  "eventDatetime",
  "processStatusType",
  "publicMemo",
  "valueYmdDate",
] as const;

export const sbiVcCashflows: Parser = {
  name: "sbi-vc-cashflows",
  version: "0.1.0",

  accepts(artifact: ArtifactMeta): boolean {
    return acceptsSbiVcDataset(artifact, DATASET);
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const dataset = artifact.dataset;
    if (dataset === null) throw new Error("sbi-vc cashflow artifact omitted its dataset");
    const match = DATASET.exec(dataset);
    const expectedPageNumber = Number(match?.[1] ?? 0) - 1;
    if (
      !Number.isSafeInteger(expectedPageNumber) ||
      expectedPageNumber < 0 ||
      expectedPageNumber >= SBI_VC_MAX_PAGES
    ) {
      throw new Error(`${dataset}: historical page suffix is invalid`);
    }
    const page = parseSbiVcPage(bytes, dataset, expectedPageNumber);
    const warnings: string[] = [];
    const observations: Observation[] = [];
    const observedAt = providerTimestamp(page.meta["timestamp"]);

    page.list.forEach((entry: unknown, index: number) => {
      const locator = `json:$.body.list[${index}]`;
      if (!isObject(entry)) {
        warnings.push(`${locator}: expected a cashflow object; raw element preserved`);
        observations.push({
          kind: "transaction",
          sourceAccount: SBI_VC_SOURCE_ACCOUNT,
          ...(observedAt !== undefined ? { observedAt } : {}),
          rawLocator: locator,
          extra: {
            _kogane: {
              unparsedElement: entry,
              sourceView: "historical",
              providerContext: {
                meta: { ...page.meta },
                pageNumber: page.pageNumber,
                pageSize: page.pageSize,
                totalNumOfPages: page.totalNumOfPages,
                totalSize: page.totalSize,
              },
            },
          },
        });
        return;
      }
      warnUnknownFields(entry, ITEM_FIELDS, locator, warnings);
      warnNonStringFields(
        entry,
        ["cashbalance", "cashflowAmount", "eventDatetime", "publicMemo", "valueYmdDate"],
        locator,
        warnings,
      );
      const cashflowId = requireString(entry, "cashflowID", locator, warnings);
      const currency = requireString(entry, "currency", locator, warnings);
      const cashflowType = requireString(entry, "cashflowType", locator, warnings);
      const status = requireString(entry, "processStatusType", locator, warnings);
      const amount = decimalText(entry["cashflowAmount"]);
      if (!amount) {
        warnings.push(
          `${locator}.cashflowAmount: expected an exact signed decimal; raw value preserved`,
        );
      }
      const amountMinor =
        amount !== undefined && currency !== undefined
          ? decimalToMinorUnits(amount.text, currency)
          : undefined;
      if (amount !== undefined && currency !== undefined && amountMinor === undefined) {
        warnings.push(
          `${locator}.cashflowAmount: exact minor-unit conversion unavailable; signed decimal text preserved`,
        );
      }
      const direction =
        amount === undefined || /^-?0(?:\.0+)?$/u.test(amount.text)
          ? undefined
          : amount.text.startsWith("-")
            ? "outflow"
            : "inflow";
      if (
        (cashflowType === "REMITTANCE_DEPOSIT" && direction === "outflow") ||
        (cashflowType === "REMITTANCE_WITHDRAW" && direction === "inflow")
      ) {
        warnings.push(
          `${locator}: cashflowType disagrees with cashflowAmount sign; amount sign retained`,
        );
      }
      if (
        cashflowType !== undefined &&
        cashflowType !== "REMITTANCE_DEPOSIT" &&
        cashflowType !== "REMITTANCE_WITHDRAW"
      ) {
        warnings.push(
          `${locator}.cashflowType: outside the collector's audited JPY transfer filter`,
        );
      }
      const asOf = providerTimestamp(entry["eventDatetime"]);
      if (asOf === undefined) {
        warnings.push(`${locator}.eventDatetime: timestamp format is not recognized`);
      }
      observations.push({
        kind: "transaction",
        sourceAccount: SBI_VC_SOURCE_ACCOUNT,
        ...(cashflowId !== undefined ? { externalId: cashflowId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        ...(amount !== undefined ? { amountText: amount.text, amountScale: amount.scale } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(cashflowType !== undefined ? { description: cashflowType } : {}),
        ...(asOf !== undefined ? { asOf } : {}),
        ...(observedAt !== undefined ? { observedAt } : {}),
        rawLocator: locator,
        extra: providerExtra(entry, page, ["list"], {
          sourceView: "historical",
          amountSignSource: "cashflowAmount",
          ...(direction !== undefined ? { direction } : {}),
        }),
      });
      if (currency !== undefined) {
        observations.push(
          balanceFromDecimal({
            value: entry["cashbalance"],
            metric: "cash_balance_after_cashflow",
            instrument: currency,
            locator: `${locator}.cashbalance`,
            extra: providerExtra(entry, page, ["list"], {
              sourceView: "historical",
              balanceContext: "after_cashflow",
            }),
            ...(asOf !== undefined ? { asOf } : {}),
            ...(observedAt !== undefined ? { observedAt } : {}),
            warnings,
          }),
        );
      }
    });
    return { observations, warnings };
  },
};
