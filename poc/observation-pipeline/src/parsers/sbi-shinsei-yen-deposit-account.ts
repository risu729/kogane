import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import {
  acceptsSbiShinseiDataset,
  assertSuccessfulRun,
  balanceObservation,
  currency,
  exactArray,
  exactObject,
  nonEmptyString,
  parseJson,
  providerExtra,
  providerTimestamp,
  responseParam,
  scalarFields,
} from "./sbi-shinsei-common.ts";

const DATASET = "yen-deposit-account";
const DEBIT_FIELDS = [
  "accountNo",
  "balance",
  "currency",
  "productCode",
  "accountStatus",
  "moduleCode",
  "unitNo",
  "maturityDate",
  "valueDate",
  "replicateFlag",
  "productDescription",
] as const;

export const sbiShinseiYenDepositAccount: Parser = {
  name: "sbi-shinsei-yen-deposit-account",
  version: "0.1.0",
  accepts: (artifact: ArtifactMeta) => acceptsSbiShinseiDataset(artifact, DATASET),

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    assertSuccessfulRun(artifact);
    const root = parseJson(bytes, DATASET);
    const response = exactObject(
      responseParam(root, DATASET),
      `${DATASET}.responseParam`,
      [
        "postingDate",
        "transactionTime",
        "customerCategory",
        "debitAccountDetails",
        "productDetails",
        "sdBalance",
        "fcyCASABalance",
        "newCustStatus",
        "savingsDetails",
        "tdDetails",
        "sdDetails",
        "debuntureDetails",
        "loanDetails",
        "moduleDetails",
      ],
      ["debitAccountDetails", "productDetails", "savingsDetails", "moduleDetails"],
    );
    scalarFields(
      response,
      [
        "postingDate",
        "transactionTime",
        "customerCategory",
        "sdBalance",
        "fcyCASABalance",
        "newCustStatus",
      ],
      `${DATASET}.responseParam`,
    );
    const observedAt = providerTimestamp(response["transactionTime"]);
    const context = Object.fromEntries(
      Object.entries(response).filter(
        ([key]) =>
          ![
            "debitAccountDetails",
            "savingsDetails",
            "productDetails",
            "moduleDetails",
            "tdDetails",
            "sdDetails",
            "debuntureDetails",
            "loanDetails",
          ].includes(key),
      ),
    );
    const observations: Observation[] = [];
    const identities = new Set<string>();
    const parseDetails = (field: "debitAccountDetails" | "savingsDetails", metric: string) => {
      exactArray(response[field], `${DATASET}.responseParam.${field}`, 100).forEach(
        (value, index) => {
          const locator = `json:$.responseParam.${field}[${index}]`;
          const allowed =
            field === "savingsDetails"
              ? ["accountNo", "balance", "yenEqui", "currency", "productCode"]
              : DEBIT_FIELDS;
          const row = exactObject(value, locator, allowed, [
            "accountNo",
            "balance",
            "currency",
            "productCode",
          ]);
          scalarFields(row, Object.keys(row), locator);
          const accountNo = nonEmptyString(row["accountNo"], `${locator}.accountNo`);
          const identity = `${field}:${accountNo}`;
          if (identities.has(identity))
            throw new Error(`${locator}: duplicate provider account identity`);
          identities.add(identity);
          const nativeCurrency = currency(row["currency"], `${locator}.currency`);
          const productCode = nonEmptyString(row["productCode"], `${locator}.productCode`);
          observations.push(
            balanceObservation({
              value: row["balance"],
              currency: nativeCurrency,
              accountNo,
              metric,
              asOf: artifact.fetchedAt,
              ...(observedAt ? { observedAt } : {}),
              locator: `${locator}.balance`,
              extra: providerExtra(row, context, {
                sourceView: field,
                productCode,
              }),
            }),
          );
        },
      );
    };
    parseDetails("debitAccountDetails", "yen_deposit_account_balance");
    parseDetails("savingsDetails", "yen_deposit_savings_balance");

    exactArray(response["productDetails"], `${DATASET}.responseParam.productDetails`, 100).forEach(
      (value, index) => {
        const locator = `${DATASET}.responseParam.productDetails[${index}]`;
        const row = exactObject(
          value,
          locator,
          ["productCode", "tdProductDetail", "pdProductDetail"],
          ["productCode"],
        );
        nonEmptyString(row["productCode"], `${locator}.productCode`);
        for (const field of ["tdProductDetail", "pdProductDetail"] as const) {
          const detail = row[field];
          if (
            detail !== undefined &&
            detail !== null &&
            typeof detail !== "string" &&
            typeof detail !== "number" &&
            typeof detail !== "boolean" &&
            (typeof detail !== "object" || Array.isArray(detail))
          ) {
            throw new Error(`${locator}.${field}: invalid product detail`);
          }
        }
      },
    );
    exactArray(response["moduleDetails"], `${DATASET}.responseParam.moduleDetails`, 100).forEach(
      (value, index) => {
        const locator = `${DATASET}.responseParam.moduleDetails[${index}]`;
        const row = exactObject(
          value,
          locator,
          ["moduleCode", "moduleDesc", "moduleBalance"],
          ["moduleCode", "moduleDesc", "moduleBalance"],
        );
        scalarFields(row, Object.keys(row), locator);
      },
    );
    for (const field of ["tdDetails", "sdDetails", "debuntureDetails", "loanDetails"] as const) {
      if (response[field] !== undefined)
        exactArray(response[field], `${DATASET}.responseParam.${field}`, 0);
    }
    return { observations, warnings: [] };
  },
};
