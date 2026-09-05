import { ImportError } from "./error";

type JsonObject = Record<string, unknown>;
type ResponseSchemaId =
  | "sbi-shinsei-top-balances-v1"
  | "sbi-shinsei-balance-summary-v1"
  | "sbi-shinsei-exchange-rate-v1"
  | "sbi-shinsei-yen-deposit-account-v1";

export function validateSbiShinseiResponse(schema: ResponseSchemaId, value: unknown): JsonObject {
  switch (schema) {
    case "sbi-shinsei-top-balances-v1":
      return validateTopBalances(value);
    case "sbi-shinsei-balance-summary-v1":
      return validateBalanceSummary(value);
    case "sbi-shinsei-exchange-rate-v1":
      return validateExchangeRate(value);
    case "sbi-shinsei-yen-deposit-account-v1":
      return validateYenDeposit(value);
  }
}

function validateTopBalances(value: unknown): JsonObject {
  const root = responseRoot(value, "topBalances");
  const response = exactObject(
    root.responseParam,
    "topBalances.responseParam",
    ["overview", "activity", "systemResponseTime", "sbiHyperYokinFlg"],
    ["overview", "activity"],
  );
  const overview = wrapper(response.overview, "topBalances.overview");
  const overviewResponse = exactObject(
    overview.responseParam,
    "topBalances.overview.responseParam",
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
  optionalScalars(
    overviewResponse,
    [
      "totalCreditBalance",
      "totalDebitBalance",
      "savingsBalance",
      "tdBalance",
      "sdBalance",
      "debuntureBalance",
      "loanBalance",
      "hyperYokinStatus",
    ],
    "topBalances.overview.responseParam",
  );
  objectArray(
    overviewResponse.savingsDetails,
    "topBalances.overview.responseParam.savingsDetails",
    validateSavings,
  );

  const activity = wrapper(response.activity, "topBalances.activity");
  const activityResponse = exactObject(
    activity.responseParam,
    "topBalances.activity.responseParam",
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
  optionalScalars(
    activityResponse,
    ["type", "fromDate", "toDate", "purgeflag", "currentBalance", "accountNo", "currency"],
    "topBalances.activity.responseParam",
  );
  objectArray(
    activityResponse.activityDetails,
    "topBalances.activity.responseParam.activityDetails",
    validateActivity,
  );
  optionalScalars(
    response,
    ["systemResponseTime", "sbiHyperYokinFlg"],
    "topBalances.responseParam",
  );
  return root;
}

function validateBalanceSummary(value: unknown): JsonObject {
  const root = responseRoot(value, "balanceSummary");
  const response = exactObject(
    root.responseParam,
    "balanceSummary.responseParam",
    ["summary", "mutualFundBalance", "category", "branchFetch"],
    ["summary", "category", "branchFetch"],
  );
  const summary = wrapper(response.summary, "balanceSummary.summary");
  const summaryResponse = exactObject(
    summary.responseParam,
    "balanceSummary.summary.responseParam",
    [
      "customerName",
      "customerNameKanji",
      "customerNameKana",
      "mfAccountStatus",
      "savingsBalance",
      "odLimit",
      "totalCredit",
      "totalDebit",
      "fxCasaBalance",
      "yenTDBalance",
    ],
    [],
  );
  optionalScalars(
    summaryResponse,
    Object.keys(summaryResponse),
    "balanceSummary.summary.responseParam",
  );

  const category = wrapper(response.category, "balanceSummary.category");
  const categoryResponse = exactObject(
    category.responseParam,
    "balanceSummary.category.responseParam",
    [
      "freeTransferCount",
      "customerCategory",
      "atmFee",
      "allowedAtmWithFreeCnt",
      "balanceAtmWithFreeCnt",
    ],
    [],
  );
  optionalScalars(
    categoryResponse,
    Object.keys(categoryResponse),
    "balanceSummary.category.responseParam",
  );

  const branch = wrapper(response.branchFetch, "balanceSummary.branchFetch");
  const branchResponse = exactObject(
    branch.responseParam,
    "balanceSummary.branchFetch.responseParam",
    ["branchCode", "branchName"],
    [],
  );
  optionalScalars(
    branchResponse,
    Object.keys(branchResponse),
    "balanceSummary.branchFetch.responseParam",
  );
  if (response.mutualFundBalance !== undefined) {
    if (
      typeof response.mutualFundBalance === "object" &&
      response.mutualFundBalance !== null &&
      !Array.isArray(response.mutualFundBalance)
    ) {
      optionalWrapper(response.mutualFundBalance, "balanceSummary.mutualFundBalance");
    } else {
      scalar(response.mutualFundBalance, "balanceSummary.mutualFundBalance");
    }
  }
  return root;
}

function validateExchangeRate(value: unknown): JsonObject {
  const root = responseRoot(value, "exchangeRate");
  const response = exactObject(
    root.responseParam,
    "exchangeRate.responseParam",
    ["exchangeRateInformation"],
    ["exchangeRateInformation"],
  );
  const information = wrapper(
    response.exchangeRateInformation,
    "exchangeRate.exchangeRateInformation",
  );
  const informationResponse = exactObject(
    information.responseParam,
    "exchangeRate.exchangeRateInformation.responseParam",
    ["transactionTime", "exchangeRates"],
    ["exchangeRates"],
  );
  if (informationResponse.transactionTime !== undefined) {
    scalar(informationResponse.transactionTime, "exchangeRate.transactionTime");
  }
  objectArray(informationResponse.exchangeRates, "exchangeRate.exchangeRates", (item, label) => {
    const rate = exactObject(
      item,
      label,
      ["currency", "customerCategory", "buyRate", "sellRate", "midRate"],
      ["currency", "buyRate", "sellRate", "midRate"],
    );
    optionalScalars(rate, Object.keys(rate), label);
  });
  return root;
}

function validateYenDeposit(value: unknown): JsonObject {
  const root = responseRoot(value, "yenDeposit");
  const response = exactObject(
    root.responseParam,
    "yenDeposit.responseParam",
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
  optionalScalars(
    response,
    [
      "postingDate",
      "transactionTime",
      "customerCategory",
      "sdBalance",
      "fcyCASABalance",
      "newCustStatus",
    ],
    "yenDeposit.responseParam",
  );
  objectArray(response.savingsDetails, "yenDeposit.savingsDetails", validateSavings);
  objectArray(response.debitAccountDetails, "yenDeposit.debitAccountDetails", (item, label) => {
    const debit = exactObject(
      item,
      label,
      [
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
      ],
      ["accountNo", "balance", "currency", "productCode"],
    );
    optionalScalars(debit, Object.keys(debit), label);
  });
  objectArray(response.productDetails, "yenDeposit.productDetails", (item, label) => {
    const product = exactObject(
      item,
      label,
      ["productCode", "tdProductDetail", "pdProductDetail"],
      ["productCode"],
    );
    scalar(product.productCode, `${label}.productCode`);
    if (product.tdProductDetail !== undefined) {
      validateTermDepositProduct(product.tdProductDetail, `${label}.tdProductDetail`);
    }
    if (product.pdProductDetail !== undefined) {
      scalarOrEmptyObject(product.pdProductDetail, `${label}.pdProductDetail`);
    }
  });
  objectArray(response.moduleDetails, "yenDeposit.moduleDetails", (item, label) => {
    const module = exactObject(
      item,
      label,
      ["moduleCode", "moduleDesc", "moduleBalance"],
      ["moduleCode", "moduleDesc", "moduleBalance"],
    );
    optionalScalars(module, Object.keys(module), label);
  });
  for (const key of ["tdDetails", "sdDetails", "debuntureDetails", "loanDetails"] as const) {
    if (response[key] !== undefined) {
      if (!Array.isArray(response[key])) {
        throw unknown(`${labelOf("yenDeposit.responseParam", key)} must be an array`);
      }
      if (response[key].length !== 0) {
        throw unknown(`${labelOf("yenDeposit.responseParam", key)} item schema is not known`);
      }
    }
  }
  return root;
}

function optionalWrapper(value: unknown, label: string): void {
  const result = exactObject(
    value,
    label,
    ["requestParam", "responseParam", "header", "errorInfo"],
    [],
  );
  if (result.requestParam !== undefined) object(result.requestParam, `${label}.requestParam`);
  if (result.responseParam !== undefined) {
    const response = object(result.responseParam, `${label}.responseParam`);
    if (Object.keys(response).length !== 0) {
      throw unknown(`${label}.responseParam schema is not known`);
    }
  }
  if (result.header !== undefined) {
    const header = exactObject(
      result.header,
      `${label}.header`,
      ["referenceNo", "systemCode", "langCode"],
      [],
    );
    optionalScalars(header, Object.keys(header), `${label}.header`);
  }
  if (result.errorInfo !== undefined) {
    const error = exactObject(
      result.errorInfo,
      `${label}.errorInfo`,
      ["statusID", "statusMessage"],
      [],
    );
    optionalScalars(error, Object.keys(error), `${label}.errorInfo`);
  }
}

function validateTermDepositProduct(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    scalar(value, label);
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
  for (const key of Object.keys(detail)) {
    if (key === "customerCategoryDetails") continue;
    scalar(detail[key], `${label}.${key}`);
  }
  if (detail.customerCategoryDetails !== undefined) {
    objectArray(
      detail.customerCategoryDetails,
      `${label}.customerCategoryDetails`,
      (categoryValue, categoryLabel) => {
        const category = exactObject(
          categoryValue,
          categoryLabel,
          ["customerCategory", "term"],
          ["customerCategory", "term"],
        );
        scalar(category.customerCategory, `${categoryLabel}.customerCategory`);
        objectArray(category.term, `${categoryLabel}.term`, (termValue, termLabel) => {
          const term = exactObject(
            termValue,
            termLabel,
            ["months", "days", "interest"],
            ["months", "days", "interest"],
          );
          optionalScalars(term, Object.keys(term), termLabel);
        });
      },
    );
  }
}

function responseRoot(value: unknown, label: string): JsonObject {
  const root = exactObject(value, label, ["responseParam", "header"], ["responseParam", "header"]);
  const header = exactObject(
    root.header,
    `${label}.header`,
    ["adapterResultCode", "newToken"],
    ["adapterResultCode"],
  );
  successCode(header.adapterResultCode, `${label}.header.adapterResultCode`);
  if (header.newToken !== undefined) {
    nonEmptyString(header.newToken, `${label}.header.newToken`);
  }
  return root;
}

function wrapper(value: unknown, label: string): JsonObject {
  const result = exactObject(
    value,
    label,
    ["requestParam", "responseParam", "header", "errorInfo"],
    ["responseParam"],
  );
  if (result.requestParam !== undefined) object(result.requestParam, `${label}.requestParam`);
  if (result.header !== undefined) {
    const header = exactObject(
      result.header,
      `${label}.header`,
      ["referenceNo", "systemCode", "langCode"],
      [],
    );
    optionalScalars(header, Object.keys(header), `${label}.header`);
  }
  if (result.errorInfo !== undefined) {
    const error = exactObject(
      result.errorInfo,
      `${label}.errorInfo`,
      ["statusID", "statusMessage"],
      [],
    );
    optionalScalars(error, Object.keys(error), `${label}.errorInfo`);
  }
  return result;
}

function validateSavings(value: unknown, label: string): void {
  const savings = exactObject(
    value,
    label,
    ["accountNo", "balance", "yenEqui", "currency", "productCode"],
    ["accountNo", "balance", "currency", "productCode"],
  );
  optionalScalars(savings, Object.keys(savings), label);
}

function validateActivity(value: unknown, label: string): void {
  const activity = exactObject(
    value,
    label,
    ["txnReferenceNo", "description", "credit", "debit", "postingDate", "balance", "tradeTypeCode"],
    ["txnReferenceNo", "description", "postingDate", "balance"],
  );
  optionalScalars(activity, Object.keys(activity), label);
}

function exactObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
): JsonObject {
  const result = object(value, label);
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) throw unknown(`${label} has unknown field ${key}`);
  }
  for (const key of required) {
    if (!(key in result)) throw unknown(`${label} is missing field ${key}`);
  }
  return result;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unknown(`${label} must be an object`);
  }
  return value as JsonObject;
}

function objectArray(
  value: unknown,
  label: string,
  validator: (item: unknown, label: string) => void,
): void {
  if (!Array.isArray(value)) throw unknown(`${label} must be an array`);
  value.forEach((item, index) => validator(item, `${label}[${index}]`));
}

function optionalScalars(value: JsonObject, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (value[key] !== undefined) scalar(value[key], `${label}.${key}`);
  }
}

function scalar(value: unknown, label: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw unknown(`${label} must be a scalar`);
  }
}

function successCode(value: unknown, label: string): void {
  if (value !== "0") {
    throw unknown(`${label} is not the captured success code`);
  }
}

function scalarOrEmptyObject(value: unknown, label: string): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Object.keys(value).length !== 0) {
      throw unknown(`${label} object schema is not known`);
    }
    return;
  }
  scalar(value, label);
}

function nonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw unknown(`${label} must be a non-empty string`);
  }
}

function labelOf(parent: string, key: string): string {
  return `${parent}.${key}`;
}

function unknown(_message: string): ImportError {
  return new ImportError(409, "artifact_schema_invalid");
}
