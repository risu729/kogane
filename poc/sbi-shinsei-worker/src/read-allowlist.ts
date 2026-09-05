import { UnsafeReadRequestError, UnverifiedReadRouteError } from "./errors";
import type {
  ReadOperationId,
  ReadExecutionProfile,
  ReadRequestDescriptor,
  ReadRoute,
  ResponseSchemaId,
} from "./types";

const ORIGIN = "https://bk.web.sbishinseibank.co.jp" as const;

/**
 * Route names came from the public login JavaScript. Entries observed in the
 * 2026-08-31 authenticated Kuebiko run are marked liveValidated; bundle-only
 * candidates are not. Captured entries with a strict response schema are
 * production-enabled for the same-page Browser Run collector only.
 */
export const READ_ROUTE_CATALOG = [
  capturedRoute(
    "common.security-connect",
    "/SFC/app/IFCM_CommonAdapter/securityConnect",
    "sbi-shinsei-security-connect-v1",
  ),
  capturedRoute(
    "common.validate-token",
    "/SFC/app/IFCM_CommonAdapter/validateToken",
    "sbi-shinsei-validate-token-v1",
  ),
  capturedRoute(
    "top.accounts-balance-and-activity",
    "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity",
    "sbi-shinsei-top-balances-v1",
  ),
  capturedRoute(
    "top.balance-summary-and-stage",
    "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage",
    "sbi-shinsei-balance-summary-v1",
  ),
  capturedRoute(
    "common.exchange-rate",
    "/SFC/app/IFCM_CommonAdapter/getExchangeRate",
    "sbi-shinsei-exchange-rate-v1",
  ),
  capturedRoute(
    "common.application-information-list",
    "/SFC/app/IFCM_CommonAdapter/getApplicationInformationList",
  ),
  route(
    "common.account-information-list",
    "/SFC/app/IFCM_CommonAdapter/getAccountInformationListDisplay",
  ),
  route("common.product-description", "/SFC/app/IFCM_CommonAdapter/getProductDescription"),
  route(
    "account.information-others",
    "/SFC/app/IFAI_AccountAdapter/getAccountInformationOthersDisplay",
  ),
  route(
    "account.casa-activity-specific-period",
    "/SFC/app/IFAI_AccountAdapter/getCasaAccountActivitySpecificPeriod",
  ),
  route("account.account-list", "/SFC/app/AIAI_AccountInfomationAdapter/getAccountList"),
  capturedRoute("account.inbox-list", "/SFC/app/AIAI_AccountInfomationAdapter/getInboxList"),
  capturedRoute("common.uiux-flag", "/SFC/app/AICM_CommonAdapter/getUiuxFlag"),
  capturedRoute("email.address", "/SFC/app/IFEM_EmailAdapter/getEmailAddress"),
  route("yen-deposit.product-details", "/SFC/app/AIYD_YenDepositAdapter/getYenProductDetails"),
  capturedRoute(
    "yen-deposit.account",
    "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount",
    "sbi-shinsei-yen-deposit-account-v1",
  ),
  route("csv.download", "/SFC/adapters/IFAI_CsvDownloadAdapter/csvDownload/getCsv"),
] as const satisfies readonly ReadRoute[];

const FORBIDDEN_PATH_TERMS = [
  "transfer",
  "furikomi",
  "cancel",
  "update",
  "register",
  "apply",
  "execute",
  "withdraw",
  "purchase",
  "sell",
  "memo",
  "setting",
  "password",
] as const;

export function liveReadsEnabled(): boolean {
  return READ_ROUTE_CATALOG.some(
    (entry) => entry.liveValidated && entry.productionEnabled && entry.responseSchema !== "unknown",
  );
}

export function getReadRoute(operation: ReadOperationId): ReadRoute {
  const entry = READ_ROUTE_CATALOG.find((candidate) => candidate.operation === operation);
  if (!entry) {
    throw new UnsafeReadRequestError("Read operation is not allowlisted");
  }
  return entry;
}

export function assertReadAllowed(
  request: ReadRequestDescriptor,
  executionProfile: ReadExecutionProfile = "worker-production",
): ReadRoute {
  const route = getReadRoute(request.operation);
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    throw new UnsafeReadRequestError("Read request URL is invalid");
  }

  const lowerPath = parsed.pathname.toLowerCase();
  if (FORBIDDEN_PATH_TERMS.some((term) => lowerPath.includes(term))) {
    throw new UnsafeReadRequestError("Read request matched the write denylist");
  }
  if (
    request.method !== route.method ||
    parsed.origin !== route.origin ||
    parsed.pathname !== route.path ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new UnsafeReadRequestError("Read request does not exactly match the allowlist");
  }
  if (!route.liveValidated) {
    throw new UnverifiedReadRouteError(
      `Read operation ${route.operation} has not passed authenticated capture validation`,
    );
  }
  if (route.responseSchema === "unknown") {
    throw new UnverifiedReadRouteError(
      `Read operation ${route.operation} has no approved response schema`,
    );
  }
  if (executionProfile === "direct-http-diagnostic") {
    throw new UnverifiedReadRouteError(
      "Direct HTTP reads are disabled; use the same-page browser collector",
    );
  }
  if (executionProfile === "worker-production" && !route.productionEnabled) {
    throw new UnverifiedReadRouteError(
      `Read operation ${route.operation} is not enabled for production`,
    );
  }
  return route;
}

function route(operation: ReadOperationId, path: string): ReadRoute {
  return {
    operation,
    method: "POST",
    origin: ORIGIN,
    path,
    evidence: "public-login-bundle",
    liveValidated: false,
    productionEnabled: false,
    responseSchema: "unknown",
    maxResponseBytes: 2 * 1024 * 1024,
  };
}

function capturedRoute(
  operation: ReadOperationId,
  path: string,
  responseSchema: ResponseSchemaId = "unknown",
): ReadRoute {
  return {
    operation,
    method: "POST",
    origin: ORIGIN,
    path,
    evidence: "authenticated-capture",
    liveValidated: true,
    productionEnabled: responseSchema !== "unknown",
    responseSchema,
    maxResponseBytes: 2 * 1024 * 1024,
  };
}
