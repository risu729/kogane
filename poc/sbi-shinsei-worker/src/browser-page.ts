import type { SbiShinseiCredential } from "./types";

export interface BrowserCollectionSuccess {
  ok: true;
  responses: {
    topBalances: string;
    balanceSummary: string;
    exchangeRate: string;
    yenDeposit: string;
  };
}

export interface BrowserCollectionFailure {
  ok: false;
  stage: string;
  authenticationAttempted: boolean;
}

export type BrowserCollectionHandoff = BrowserCollectionSuccess | BrowserCollectionFailure;

/** Runs wholly in the bank page. Session and risk material are never returned. */
export async function collectInBankPage(
  credential: SbiShinseiCredential,
): Promise<string> {
  type PageInput = { value: string };
  type CafisResult = { deviceTokenInfo?: unknown } | null | undefined;
  type PageGlobal = {
    location: { origin: string };
    navigator: { userAgent: string };
    document: { getElementById(id: string): unknown };
    CAFISBrainRiskCollector?: {
      getDeviceTokenInfoV3(callback: (result: CafisResult) => void): void;
    };
  };
  type PageFailure = { stage?: string; authenticationAttempted?: boolean };

  const pageGlobal = globalThis as unknown as PageGlobal;
  const maximumBytes = 2 * 1024 * 1024;
  const exactKeys = (value: unknown, keys: readonly string[]): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]);
  };
  const fail = (stage: string, authenticationAttempted = false): string =>
    JSON.stringify({ ok: false, stage, authenticationAttempted });

  if (pageGlobal.location.origin !== "https://bk.web.sbishinseibank.co.jp") {
    return fail("unexpected-origin");
  }
  const inputCandidate = pageGlobal.document.getElementById("dtokeninfo");
  if (!inputCandidate || typeof inputCandidate !== "object" || !("value" in inputCandidate)) {
    return fail("missing-input");
  }
  const input = inputCandidate as PageInput;
  const collector = pageGlobal.CAFISBrainRiskCollector;
  if (!collector || typeof collector.getDeviceTokenInfoV3 !== "function") {
    return fail("collector-unavailable");
  }

  input.value = "";
  let jsc = "";
  try {
    jsc = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("cafis-timeout")), 30_000);
      collector.getDeviceTokenInfoV3((result) => {
        clearTimeout(timeout);
        const value = result?.deviceTokenInfo;
        if (typeof value !== "string" || value.length < 64) {
          reject(new Error("cafis-result"));
          return;
        }
        input.value = value;
        resolve(value);
      });
    });
  } catch {
    input.value = "";
    return fail("cafis-generation");
  }

  if (
    !/^\d{3}$/.test(credential.branchNumber) ||
    !/^\d{7}$/.test(credential.accountNumber) ||
    typeof credential.powerDirectPassword !== "string" ||
    credential.powerDirectPassword.length === 0
  ) {
    jsc = "";
    input.value = "";
    return fail("credential-shape");
  }

  const fetchJson = async (
    path: string,
    init: RequestInit,
    stage: string,
    authenticationAttempted: boolean,
  ): Promise<{ response: Response; raw: string; data: Record<string, unknown> }> => {
    let response: Response;
    try {
      response = await fetch(path, {
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        ...init,
      });
    } catch {
      throw { stage: `${stage}-network`, authenticationAttempted } satisfies PageFailure;
    }
    if (!response.ok || response.redirected || response.type === "opaqueredirect") {
      throw { stage: `${stage}-http-${response.status}`, authenticationAttempted } satisfies PageFailure;
    }
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const accepted = stage === "login"
      ? ["application/octet-stream", "application/json", "text/json"].includes(mediaType)
      : mediaType === "application/json";
    if (!accepted) {
      throw { stage: `${stage}-content-type`, authenticationAttempted } satisfies PageFailure;
    }
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      throw { stage: `${stage}-oversize`, authenticationAttempted } satisfies PageFailure;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw { stage: `${stage}-json`, authenticationAttempted } satisfies PageFailure;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw { stage: `${stage}-shape`, authenticationAttempted } satisfies PageFailure;
    }
    return { response, raw, data: data as Record<string, unknown> };
  };

  const form = new URLSearchParams();
  form.set("fldUserID", `${credential.branchNumber}${credential.accountNumber}`);
  form.set("password", credential.powerDirectPassword);
  form.set("langCode", "JAP");
  form.set("mode", "1");
  form.set("postubFlag", "0");
  form.set("jsc", jsc);
  form.set("forward", "");
  form.set("userAgentInfo", pageGlobal.navigator.userAgent);

  let login: Awaited<ReturnType<typeof fetchJson>>;
  try {
    login = await fetchJson(
      "/SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url",
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: form.toString(),
      },
      "login",
      true,
    );
  } catch (error) {
    return fail((error as PageFailure).stage ?? "login-failed", true);
  } finally {
    credential.powerDirectPassword = "";
    form.set("password", "");
    form.set("jsc", "");
    jsc = "";
    input.value = "";
  }

  const loginBody = login.data.responseJSON;
  const authorization = login.response.headers.get("authorization");
  if (
    !exactKeys(login.data, ["responseJSON"]) ||
    !exactKeys(loginBody, ["authStatus", "token"]) ||
    !loginBody ||
    typeof loginBody !== "object" ||
    Array.isArray(loginBody)
  ) {
    return fail("login-shape", true);
  }
  const typedLoginBody = loginBody as Record<string, unknown>;
  if (
    typedLoginBody.authStatus !== "success" ||
    typeof typedLoginBody.token !== "string" ||
    typedLoginBody.token.length === 0 ||
    !authorization
  ) {
    return fail("login-rejected", true);
  }
  let csrfToken = typedLoginBody.token;

  const read = async (
    path: string,
    body: Record<string, unknown> | undefined,
    stage: string,
  ): Promise<Awaited<ReturnType<typeof fetchJson>>> => {
    const result = await fetchJson(
      path,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: authorization,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      stage,
      true,
    );
    const header = result.data.header;
    if (header && typeof header === "object" && !Array.isArray(header)) {
      const nextToken = (header as Record<string, unknown>).newToken;
      if (nextToken !== undefined) {
        if (typeof nextToken !== "string" || nextToken.length === 0) {
          throw { stage: `${stage}-invalid-token`, authenticationAttempted: true } satisfies PageFailure;
        }
        csrfToken = nextToken;
      }
    }
    return result;
  };

  try {
    const security = await read(
      "/SFC/app/IFCM_CommonAdapter/securityConnect", undefined, "security-connect",
    );
    if (
      !exactKeys(security.data, ["userId", "attributes"]) ||
      !exactKeys(security.data.attributes, [
        "lastLoginTime", "createtime", "nationalId", "systemCode",
        "langCode", "AILG04_Login", "sessionId",
      ])
    ) {
      return fail("security-connect-shape", true);
    }
    const validation = await read(
      "/SFC/app/IFCM_CommonAdapter/validateToken", undefined, "validate-token",
    );
    if (
      !exactKeys(validation.data, ["header"]) ||
      !exactKeys(validation.data.header, ["adapterResultCode", "newToken"]) ||
      !validation.data.header ||
      typeof validation.data.header !== "object" ||
      Array.isArray(validation.data.header)
    ) {
      return fail("validate-token-shape", true);
    }
    const validationHeader = validation.data.header as Record<string, unknown>;
    if (
      validationHeader.adapterResultCode !== "0" ||
      typeof validationHeader.newToken !== "string" ||
      validationHeader.newToken.length === 0
    ) {
      return fail("validate-token-result", true);
    }
    csrfToken = validationHeader.newToken;

    const topBalances = await read(
      "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity", undefined, "top-balances",
    );
    const balanceSummary = await read(
      "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage", undefined, "balance-summary",
    );
    const exchangeRate = await read(
      "/SFC/app/IFCM_CommonAdapter/getExchangeRate", undefined, "exchange-rate",
    );
    const yenDeposit = await read(
      "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount",
      { requestParam: { screenGroupID: "CTYD0004" } },
      "yen-deposit",
    );
    for (const result of [topBalances, balanceSummary, exchangeRate, yenDeposit]) {
      const header = result.data.header;
      if (
        !header || typeof header !== "object" || Array.isArray(header) ||
        (header as Record<string, unknown>).adapterResultCode !== "0"
      ) {
        return fail("core-read-result-code", true);
      }
    }
    return JSON.stringify({
      ok: true,
      responses: {
        topBalances: topBalances.raw,
        balanceSummary: balanceSummary.raw,
        exchangeRate: exchangeRate.raw,
        yenDeposit: yenDeposit.raw,
      },
    });
  } catch (error) {
    return fail((error as PageFailure).stage ?? "read-failed", true);
  } finally {
    csrfToken = "";
  }
}
