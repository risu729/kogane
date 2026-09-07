import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decimalToMinorUnits, minorUnitExponent } from "./util.ts";
import {
  acceptsSbiShinseiDataset,
  assertSuccessfulRun,
  balanceObservation,
  compactDate,
  currency,
  decimal,
  exactArray,
  exactObject,
  nonEmptyString,
  parseJson,
  providerExtra,
  providerTimestamp,
  responseParam,
  scalarFields,
  wrapper,
} from "./sbi-shinsei-common.ts";

const DATASET = "top-accounts-balance-and-activity";

export const sbiShinseiTopBalancesAndActivity: Parser = {
  name: "sbi-shinsei-top-balances-and-activity",
  version: "0.1.0",
  accepts: (artifact: ArtifactMeta) => acceptsSbiShinseiDataset(artifact, DATASET),

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    assertSuccessfulRun(artifact);
    const root = parseJson(bytes, DATASET);
    const response = exactObject(
      responseParam(root, DATASET),
      `${DATASET}.responseParam`,
      ["overview", "activity", "systemResponseTime", "sbiHyperYokinFlg"],
      ["overview", "activity"],
    );
    scalarFields(response, ["systemResponseTime", "sbiHyperYokinFlg"], `${DATASET}.responseParam`);
    const observedAt = providerTimestamp(response["systemResponseTime"]);
    const overview = exactObject(
      wrapper(response["overview"], `${DATASET}.overview`),
      `${DATASET}.overview.responseParam`,
      [
        "totalCreditBalance",
        "totalDebitBalance",
        "savingsBalance",
        "tdBalance",
        "sdBalance",
        "debuntureBalance",
        "loanBalance",
        "savingsDetails",
        "hyperYokinStatus",
      ],
      ["savingsDetails"],
    );
    scalarFields(
      overview,
      Object.keys(overview).filter((key) => key !== "savingsDetails"),
      `${DATASET}.overview.responseParam`,
    );
    const observations: Observation[] = [];
    const accountIds = new Set<string>();
    const overviewContext = Object.fromEntries(
      Object.entries(overview).filter(([key]) => key !== "savingsDetails"),
    );
    exactArray(
      overview["savingsDetails"],
      `${DATASET}.overview.responseParam.savingsDetails`,
      100,
    ).forEach((value, index) => {
      const locator = `json:$.responseParam.overview.responseParam.savingsDetails[${index}]`;
      const row = exactObject(
        value,
        locator,
        ["accountNo", "balance", "yenEqui", "currency", "productCode"],
        ["accountNo", "balance", "currency", "productCode"],
      );
      scalarFields(row, Object.keys(row), locator);
      const accountNo = nonEmptyString(row["accountNo"], `${locator}.accountNo`);
      if (accountIds.has(accountNo))
        throw new Error(`${locator}: duplicate provider account identity`);
      accountIds.add(accountNo);
      const nativeCurrency = currency(row["currency"], `${locator}.currency`);
      const productCode = nonEmptyString(row["productCode"], `${locator}.productCode`);
      observations.push(
        balanceObservation({
          value: row["balance"],
          currency: nativeCurrency,
          accountNo,
          metric: "account_balance",
          asOf: artifact.fetchedAt,
          ...(observedAt ? { observedAt } : {}),
          locator: `${locator}.balance`,
          extra: providerExtra(row, overviewContext, {
            sourceView: "top_overview",
            productCode,
          }),
        }),
      );
      if (row["yenEqui"] !== undefined && row["yenEqui"] !== null && row["yenEqui"] !== "") {
        const yen = balanceObservation({
          value: row["yenEqui"],
          currency: "JPY",
          accountNo,
          metric: "provider_yen_equivalent",
          asOf: artifact.fetchedAt,
          ...(observedAt ? { observedAt } : {}),
          locator: `${locator}.yenEqui`,
          extra: providerExtra(row, overviewContext, {
            sourceView: "top_overview",
            productCode,
            subjectCurrency: nativeCurrency,
          }),
        });
        observations.push({
          ...yen,
          kind: "valuation",
          subject: nativeCurrency,
          currency: "JPY",
        });
      }
    });

    const activity = exactObject(
      wrapper(response["activity"], `${DATASET}.activity`),
      `${DATASET}.activity.responseParam`,
      [
        "type",
        "fromDate",
        "toDate",
        "purgeflag",
        "currentBalance",
        "accountNo",
        "currency",
        "activityDetails",
      ],
      ["activityDetails"],
    );
    scalarFields(
      activity,
      Object.keys(activity).filter((key) => key !== "activityDetails"),
      `${DATASET}.activity.responseParam`,
    );
    const details = exactArray(
      activity["activityDetails"],
      `${DATASET}.activity.responseParam.activityDetails`,
      1_000,
    );
    const fromPresent =
      activity["fromDate"] !== undefined &&
      activity["fromDate"] !== null &&
      activity["fromDate"] !== "";
    const toPresent =
      activity["toDate"] !== undefined && activity["toDate"] !== null && activity["toDate"] !== "";
    if (fromPresent !== toPresent || (details.length > 0 && !fromPresent)) {
      throw new Error(`${DATASET}.activity.responseParam: incomplete activity window`);
    }
    const fromDate = fromPresent
      ? compactDate(activity["fromDate"], `${DATASET}.activity.responseParam.fromDate`)
      : undefined;
    const toDate = toPresent
      ? compactDate(activity["toDate"], `${DATASET}.activity.responseParam.toDate`)
      : undefined;
    if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
      throw new Error(`${DATASET}.activity.responseParam: activity window is reversed`);
    }
    if (
      details.length > 0 ||
      (activity["currentBalance"] !== undefined &&
        activity["currentBalance"] !== null &&
        activity["currentBalance"] !== "")
    ) {
      const accountNo = nonEmptyString(
        activity["accountNo"],
        `${DATASET}.activity.responseParam.accountNo`,
      );
      const nativeCurrency = currency(
        activity["currency"],
        `${DATASET}.activity.responseParam.currency`,
      );
      const context = Object.fromEntries(
        Object.entries(activity).filter(([key]) => key !== "activityDetails"),
      );
      if (
        activity["currentBalance"] !== undefined &&
        activity["currentBalance"] !== null &&
        activity["currentBalance"] !== ""
      ) {
        observations.push(
          balanceObservation({
            value: activity["currentBalance"],
            currency: nativeCurrency,
            accountNo,
            metric: "activity_current_balance",
            asOf: artifact.fetchedAt,
            ...(observedAt ? { observedAt } : {}),
            locator: "json:$.responseParam.activity.responseParam.currentBalance",
            extra: providerExtra({}, context, {
              sourceView: "top_activity",
              balanceContext: "current",
            }),
          }),
        );
      }
      const transactionIds = new Set<string>();
      details.forEach((value, index) => {
        const locator = `json:$.responseParam.activity.responseParam.activityDetails[${index}]`;
        const row = exactObject(
          value,
          locator,
          [
            "txnReferenceNo",
            "description",
            "credit",
            "debit",
            "postingDate",
            "balance",
            "tradeTypeCode",
          ],
          ["txnReferenceNo", "description", "postingDate", "balance"],
        );
        scalarFields(row, Object.keys(row), locator);
        const externalId = nonEmptyString(row["txnReferenceNo"], `${locator}.txnReferenceNo`);
        if (transactionIds.has(externalId))
          throw new Error(`${locator}: duplicate transaction identity`);
        transactionIds.add(externalId);
        const description = nonEmptyString(row["description"], `${locator}.description`);
        const debitPresent =
          row["debit"] !== undefined && row["debit"] !== null && row["debit"] !== "";
        const creditPresent =
          row["credit"] !== undefined && row["credit"] !== null && row["credit"] !== "";
        if (debitPresent === creditPresent)
          throw new Error(`${locator}: expected exactly one debit or credit`);
        const sourceField = debitPresent ? "debit" : "credit";
        const unsigned = decimal(row[sourceField], `${locator}.${sourceField}`);
        if (unsigned.text.startsWith("-"))
          throw new Error(`${locator}.${sourceField}: expected an unsigned side amount`);
        const amountText =
          debitPresent && !/^0(?:\.0+)?$/u.test(unsigned.text)
            ? `-${unsigned.text}`
            : unsigned.text;
        const amountMinor = decimalToMinorUnits(amountText, nativeCurrency);
        if (minorUnitExponent(nativeCurrency) !== undefined && amountMinor === undefined)
          throw new Error(
            `${locator}.${sourceField}: not exactly representable in ${nativeCurrency}`,
          );
        decimal(row["balance"], `${locator}.balance`);
        const postingDate = compactDate(row["postingDate"], `${locator}.postingDate`);
        if (
          fromDate !== undefined &&
          toDate !== undefined &&
          (postingDate < fromDate || postingDate > toDate)
        ) {
          throw new Error(`${locator}.postingDate: outside declared activity window`);
        }
        observations.push({
          kind: "transaction",
          sourceAccount: `sbi-shinsei:${accountNo}`,
          externalId,
          ...(amountMinor === undefined ? {} : { amountMinor }),
          amountText,
          amountScale: unsigned.scale,
          currency: nativeCurrency,
          description,
          asOf: postingDate,
          ...(observedAt ? { observedAt } : {}),
          rawLocator: locator,
          extra: providerExtra(row, context, {
            sourceView: "top_activity",
            amountSignSource: sourceField,
            rowBalanceDisposition: "preserved_provider_value_semantics_unverified",
          }),
        });
      });
    }
    return { observations, warnings: [] };
  },
};
