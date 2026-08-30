import { StopConditionError } from "./types";

export const MYJCB_ORIGIN = "https://my.jcb.co.jp";

export type ReadOperation =
  | "login-page"
  | "login-submit"
  | "mypage"
  | "debit-menu"
  | "debit-detail";

interface RoutePolicy {
  readonly operation: ReadOperation;
  readonly method: "GET" | "POST";
  readonly pathname: string;
  readonly query?: Readonly<Record<string, RegExp>>;
}

const ACTIVE_ALLOWLIST: readonly RoutePolicy[] = [
  { operation: "login-page", method: "GET", pathname: "/Login" },
  {
    operation: "login-submit",
    method: "POST",
    pathname: "/iss-pc/member/user_manage/Login",
  },
  {
    operation: "mypage",
    method: "GET",
    pathname: "/iss-pc/member/mypage/mypage.html",
  },
  {
    operation: "debit-menu",
    method: "GET",
    pathname: "/iss-pc/member/debit/details/debitDetailMenu.html",
    query: { link_id: /^myj_main_debitDetailMenu$/u },
  },
  {
    operation: "debit-detail",
    method: "GET",
    pathname: "/iss-pc/member/debit/details/debitDetail.html",
    query: { seq: /^(?:[0-9]|1[0-4])$/u },
  },
];

export interface DeferredRoute {
  readonly capability:
    | "root-card-switch"
    | "credit-confirmed"
    | "credit-unconfirmed"
    | "credit-csv"
    | "credit-pdf"
    | "credit-ofx";
  readonly enabled: false;
  readonly reason: string;
}

export const DEFERRED_READ_ROUTES: readonly DeferredRoute[] = [
  {
    capability: "root-card-switch",
    enabled: false,
    reason: "The current POST action and state fields have not been observed live.",
  },
  {
    capability: "credit-confirmed",
    enabled: false,
    reason: "The current credit statement path and schema have not been observed live.",
  },
  {
    capability: "credit-unconfirmed",
    enabled: false,
    reason: "Unconfirmed statements are mutable and the current path is unverified.",
  },
  {
    capability: "credit-csv",
    enabled: false,
    reason: "The official CSV form action and CSRF fields have not been observed live.",
  },
  {
    capability: "credit-pdf",
    enabled: false,
    reason: "The official PDF download action has not been observed live.",
  },
  {
    capability: "credit-ofx",
    enabled: false,
    reason: "The official OFX download action has not been observed live.",
  },
];

export function assertAllowedRequest(
  operation: ReadOperation,
  method: string,
  input: string | URL,
): URL {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (url.origin !== MYJCB_ORIGIN) {
    throw new StopConditionError(`Rejected cross-origin MyJCB request: ${url.origin}`);
  }
  const normalizedMethod = method.toUpperCase();
  const policy = ACTIVE_ALLOWLIST.find(
    (entry) =>
      entry.operation === operation &&
      entry.method === normalizedMethod &&
      entry.pathname === url.pathname,
  );
  if (!policy) {
    throw new StopConditionError(
      `Rejected non-allowlisted MyJCB request: ${normalizedMethod} ${url.pathname}`,
    );
  }
  const expectedNames = new Set(Object.keys(policy.query ?? {}));
  for (const name of url.searchParams.keys()) {
    if (!expectedNames.has(name)) {
      throw new StopConditionError(`Rejected unexpected query parameter on ${url.pathname}`);
    }
  }
  for (const [name, pattern] of Object.entries(policy.query ?? {})) {
    const value = url.searchParams.get(name);
    if (value === null || !pattern.test(value)) {
      throw new StopConditionError(`Rejected invalid query parameter on ${url.pathname}`);
    }
  }
  return url;
}

export function allowedUrl(operation: ReadOperation, query?: URLSearchParams): URL {
  const route = ACTIVE_ALLOWLIST.find((entry) => entry.operation === operation);
  if (!route) throw new StopConditionError(`Unknown MyJCB operation: ${operation}`);
  const url = new URL(route.pathname, MYJCB_ORIGIN);
  if (query) url.search = query.toString();
  return assertAllowedRequest(operation, route.method, url);
}
