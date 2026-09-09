import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { containerClaim } from "./coverage.ts";
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
  version: "0.1.1",
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
        ([key]) => !["debitAccountDetails", "savingsDetails"].includes(key),
      ),
    );
    const preservedContextSections = [
      "productDetails",
      "moduleDetails",
      "tdDetails",
      "sdDetails",
      "debuntureDetails",
      "loanDetails",
    ].filter((field) => Object.hasOwn(context, field));
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
                preservedContextSections,
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
        if (row["tdProductDetail"] !== undefined)
          validateTermDepositProduct(row["tdProductDetail"], `${locator}.tdProductDetail`);
        if (row["pdProductDetail"] !== undefined)
          validateScalarOrEmptyObject(row["pdProductDetail"], `${locator}.pdProductDetail`);
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
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: observations.length,
          evidenceRefs: [
            "json:$.responseParam.debitAccountDetails",
            "json:$.responseParam.savingsDetails",
          ],
        }),
      ],
    };
  },
};

function validateTermDepositProduct(value: unknown, label: string): void {
  if (!isRecord(value)) {
    validateScalar(value, label);
    return;
  }
  const detail = exactObject(
    value,
    label,
    [
      "bookingMaturityCode",
      "bookingMaturityDesc",
      "changeMaturityCode",
      "changeMaturityDesc",
      "currency",
      "customerCategoryDetails",
      "maxDepositAmount",
      "maxDepositTerm",
      "minDepositAmount",
      "minDepositTerm",
      "moduleCode",
      "otameshiAmount",
      "otameshiDepositTerm",
      "otameshiInitialInterestRate",
      "productCode",
      "productName",
      "productRiskLevel",
      "productType",
      "redemptionFlag",
    ],
    [],
  );
  scalarFields(
    detail,
    Object.keys(detail).filter((key) => key !== "customerCategoryDetails"),
    label,
  );
  if (detail["customerCategoryDetails"] === undefined) return;
  exactArray(detail["customerCategoryDetails"], `${label}.customerCategoryDetails`, 100).forEach(
    (categoryValue, categoryIndex) => {
      const categoryLabel = `${label}.customerCategoryDetails[${categoryIndex}]`;
      const category = exactObject(
        categoryValue,
        categoryLabel,
        ["customerCategory", "term"],
        ["customerCategory", "term"],
      );
      validateScalar(category["customerCategory"], `${categoryLabel}.customerCategory`);
      exactArray(category["term"], `${categoryLabel}.term`, 100).forEach((termValue, termIndex) => {
        const termLabel = `${categoryLabel}.term[${termIndex}]`;
        const term = exactObject(
          termValue,
          termLabel,
          ["months", "days", "interest"],
          ["months", "days", "interest"],
        );
        scalarFields(term, Object.keys(term), termLabel);
      });
    },
  );
}

function validateScalarOrEmptyObject(value: unknown, label: string): void {
  if (isRecord(value)) {
    exactObject(value, label, [], []);
    return;
  }
  validateScalar(value, label);
}

function validateScalar(value: unknown, label: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(`${label}: expected a scalar`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
