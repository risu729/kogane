import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiVcDataset,
  balanceFromDecimal,
  parseSbiVcPage,
  providerExtra,
  providerTimestamp,
  requireNonEmptyString,
  SBI_VC_MAX_PAGES,
  SBI_VC_SOURCE_ACCOUNT,
  warnNonStringFields,
  warnUnknownFields,
} from "./sbi-vc-common.ts";
import { ParseDiagnostics } from "./coverage.ts";
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
  version: "0.2.0",

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
    const diagnostics = new ParseDiagnostics();
    const observations: Observation[] = [];
    const observedAt = providerTimestamp(page.meta["timestamp"]);
    const cashflowIds = new Set<string>();

    page.list.forEach((entry: unknown, index: number) => {
      const locator = `json:$.body.list[${index}]`;
      if (!isObject(entry)) {
        throw new Error(`${locator}: expected a cashflow object`);
      }
      warnUnknownFields(entry, ITEM_FIELDS, locator, diagnostics);
      warnNonStringFields(
        entry,
        ["cashbalance", "cashflowAmount", "eventDatetime", "publicMemo", "valueYmdDate"],
        locator,
        diagnostics,
      );
      const cashflowId = requireNonEmptyString(entry, "cashflowID", locator);
      if (cashflowIds.has(cashflowId)) {
        throw new Error(`${locator}: duplicate cashflow identity`);
      }
      cashflowIds.add(cashflowId);
      const currency = requireNonEmptyString(entry, "currency", locator);
      if (currency !== "JPY") {
        throw new Error(`${locator}.currency: outside the audited JPY collector filter`);
      }
      const cashflowType = requireNonEmptyString(entry, "cashflowType", locator);
      if (cashflowType !== "REMITTANCE_DEPOSIT" && cashflowType !== "REMITTANCE_WITHDRAW") {
        throw new Error(`${locator}.cashflowType: outside the audited transfer filter`);
      }
      const status = requireNonEmptyString(entry, "processStatusType", locator);
      const amount = decimalText(entry["cashflowAmount"]);
      if (!amount) {
        throw new Error(`${locator}.cashflowAmount: expected an exact signed decimal`);
      }
      const amountMinor = decimalToMinorUnits(amount.text, currency);
      if (amountMinor === undefined) {
        throw new Error(`${locator}.cashflowAmount: not exactly representable in JPY`);
      }
      const cashbalance = decimalText(entry["cashbalance"]);
      if (!cashbalance || decimalToMinorUnits(cashbalance.text, currency) === undefined) {
        throw new Error(`${locator}.cashbalance: expected an exact JPY balance`);
      }
      const direction = /^-?0(?:\.0+)?$/u.test(amount.text)
        ? undefined
        : amount.text.startsWith("-")
          ? "outflow"
          : "inflow";
      if (
        (cashflowType === "REMITTANCE_DEPOSIT" && direction === "outflow") ||
        (cashflowType === "REMITTANCE_WITHDRAW" && direction === "inflow")
      ) {
        diagnostics.warnings.push(
          `${locator}: cashflowType disagrees with cashflowAmount sign; amount sign retained`,
        );
      }
      const asOf = providerTimestamp(entry["eventDatetime"]);
      if (asOf === undefined) {
        throw new Error(`${locator}.eventDatetime: timestamp format is not recognized`);
      }
      observations.push({
        kind: "transaction",
        sourceAccount: SBI_VC_SOURCE_ACCOUNT,
        externalId: cashflowId,
        status,
        amountMinor,
        amountText: amount.text,
        amountScale: amount.scale,
        currency,
        description: cashflowType,
        asOf,
        ...(observedAt !== undefined ? { observedAt } : {}),
        rawLocator: locator,
        extra: providerExtra(entry, page, ["list"], {
          sourceView: "historical",
          amountSignSource: "cashflowAmount",
          ...(direction !== undefined ? { direction } : {}),
        }),
      });
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
          asOf,
          ...(observedAt !== undefined ? { observedAt } : {}),
          diagnostics,
        }),
      );
    });
    return { observations, warnings: diagnostics.warnings };
  },
};
