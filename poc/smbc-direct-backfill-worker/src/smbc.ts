import iconv from "iconv-lite";
import { renderSVG } from "uqr";
import { compactDate } from "./dates";
import type {
  AuthenticatedSession,
  ChallengeState,
  CookieRecord,
  Credentials,
  DateRange,
} from "./types";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const ACCOUNT_ITEM_CODE = "2206";
const APP_SCHEME = "smbcdirectapp:";

const browserHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "ja,en-US;q=0.9,en;q=0.8",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
};

export interface DirectOrigins {
  baseURL: string;
  loginURL: string;
}

export interface FetchTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface NormalizedTransaction {
  id: string;
  date: string;
  amount: number;
  balanceAfter: number;
  description: string;
  direction: "credit" | "debit";
}

export interface TransactionResult {
  range: DateRange;
  depositsTotal: number;
  withdrawalsTotal: number;
  transactions: NormalizedTransaction[];
  rawBytes: Uint8Array;
  rawContentType: string;
}

export interface BalanceResult {
  amount: number;
  currency: "JPY";
  displayValue: string;
  rawBytes: Uint8Array;
  rawContentType: string;
}

export class ApprovalNotCompletedError extends Error {
  override name = "ApprovalNotCompletedError";
}

export class CookieJar {
  readonly #cookies = new Map<string, CookieRecord>();

  constructor(initial: CookieRecord[] = []) {
    for (const cookie of initial) this.#cookies.set(cookieKey(cookie), cookie);
  }

  apply(url: URL, response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? splitSetCookie(response.headers.get("set-cookie"));
    for (const value of values) {
      const parsed = parseSetCookie(url, value);
      if (!parsed) continue;
      const key = cookieKey(parsed);
      if (parsed.value === "") this.#cookies.delete(key);
      else this.#cookies.set(key, parsed);
    }
  }

  header(url: URL): string {
    if (url.hostname === "direct.smbc.co.jp" || url.hostname === "direct3.smbc.co.jp") {
      const compatible = new Map<string, string>();
      for (const cookie of this.#cookies.values()) {
        if (!isSmbcDirectCookie(cookie) || (cookie.secure && url.protocol !== "https:")) continue;
        compatible.set(cookie.name, cookie.value);
      }
      return [...compatible].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    return [...this.#cookies.values()]
      .filter((cookie) => cookieMatches(cookie, url))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  get(name: string, url?: URL): string | undefined {
    return [...this.#cookies.values()]
      .filter((cookie) => cookie.name === name && (!url || cookieMatches(cookie, url)))
      .sort((left, right) => right.path.length - left.path.length)[0]?.value;
  }

  export(): CookieRecord[] {
    return [...this.#cookies.values()].map((cookie) => ({ ...cookie }));
  }
}

function isSmbcDirectCookie(cookie: CookieRecord): boolean {
  return (
    cookie.domain === "smbc.co.jp" ||
    cookie.domain === "direct.smbc.co.jp" ||
    cookie.domain === "direct3.smbc.co.jp"
  );
}

function cookieKey(cookie: CookieRecord): string {
  return `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
}

function parseSetCookie(requestUrl: URL, value: string): CookieRecord | null {
  const parts = value.split(";");
  const pair = parts.shift()?.trim();
  if (!pair) return null;
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const attributes = new Map<string, string>();
  let secure = false;
  for (const part of parts) {
    const [rawName, ...rawValue] = part.trim().split("=");
    const name = rawName?.toLowerCase();
    if (!name) continue;
    if (name === "secure") secure = true;
    attributes.set(name, rawValue.join("="));
  }
  const domain = (attributes.get("domain") || requestUrl.hostname)
    .replace(/^\./u, "")
    .toLowerCase();
  const path = attributes.get("path") || defaultCookiePath(requestUrl.pathname);
  return {
    domain,
    path: path.startsWith("/") ? path : "/",
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    secure,
  };
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookieMatches(cookie: CookieRecord, url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const domainMatches = hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
  const pathMatches =
    url.pathname === cookie.path ||
    url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`);
  return domainMatches && pathMatches && (!cookie.secure || url.protocol === "https:");
}

function splitSetCookie(header: string | null): string[] {
  return header ? header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/gu).map((value) => value.trim()) : [];
}

async function fetchWithCookies(
  url: URL,
  init: RequestInit,
  jar: CookieJar,
  transport: FetchTransport,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header(url);
  if (cookie) headers.set("cookie", cookie);
  const response = await transport.fetch(url, { ...init, headers, redirect: "manual" });
  jar.apply(url, response);
  return response;
}

async function readBoundedBytes(
  response: Response,
  limit: number,
  name: string,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${name}_http_${response.status}`);
  if (!response.body) throw new Error(`${name}_body_missing`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`${name}_body_too_large`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function responseShiftJis(
  response: Response,
  name: string,
): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = await readBoundedBytes(response, MAX_HTML_BYTES, name);
  return { bytes, text: iconv.decode(Buffer.from(bytes), "Shift_JIS") };
}

type LoginResponseKind =
  | "confirmation"
  | "access_denied"
  | "service_unavailable"
  | "login_form_returned"
  | "error_form"
  | "unexpected";

function classifyLoginResponse(html: string): LoginResponseKind {
  if (/<form\b[^>]*\bname=["']BCATBCA["']/iu.test(html)) return "confirmation";
  if (/\bAccess Denied\b|\bReference\s*#/iu.test(html)) return "access_denied";
  if (
    /サービス(?:時間外|休止中)|ただいま[^<]{0,80}ご利用いただけません|メンテナンス/iu.test(html)
  ) {
    return "service_unavailable";
  }
  if (/<form\b[^>]*\bname=["']LLDLDIL["']/iu.test(html)) return "login_form_returned";
  if (/<form\b[^>]*\bname=["']ERRINFO["']/iu.test(html)) return "error_form";
  return "unexpected";
}

async function loginResponseDigest(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formFields(html: string, formName: string): Record<string, string> {
  const escapedName = formName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const form = new RegExp(
    `<form\\b[^>]*\\bname=["']${escapedName}["'][^>]*>([\\s\\S]*?)</form>`,
    "iu",
  ).exec(html)?.[1];
  if (!form) throw new Error(`${formName}_form_missing`);
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/giu)) {
    const name = /\bname=["']([^"']+)["']/iu.exec(input[0])?.[1];
    const value = /\bvalue=["']([^"']*)["']/iu.exec(input[0])?.[1];
    if (name && value !== undefined) fields[name] = value;
  }
  return fields;
}

function required(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (value === undefined) throw new Error(`${name}_field_missing`);
  return value;
}

function inlineVariable(html: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(
    `(?:const|let|var)\\s+${escapedName}\\s*=\\s*['"]([^'"]+)['"]`,
    "u",
  ).exec(html)?.[1];
  if (!value) throw new Error(`${name}_variable_missing`);
  return value;
}

function parseYen(value: unknown, name: string): number {
  if (typeof value !== "string") throw new Error(`${name}_invalid`);
  const normalized = value.replace(/[￥円,\s]/gu, "");
  if (!/^-?\d+$/u.test(normalized)) throw new Error(`${name}_invalid`);
  return Number(normalized);
}

function transactionDate(value: unknown, referenceDate: string): string {
  if (typeof value !== "string") throw new Error("transaction_date_invalid");
  const match = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/u.exec(value.trim());
  if (!match?.[2] || !match[3]) throw new Error("transaction_date_invalid");
  const month = Number(match[2]);
  const day = Number(match[3]);
  let year = match[1] ? Number(match[1]) : Number(referenceDate.slice(0, 4));
  let instant = Date.UTC(year, month - 1, day);
  const referenceInstant = Date.UTC(
    Number(referenceDate.slice(0, 4)),
    Number(referenceDate.slice(4, 6)) - 1,
    Number(referenceDate.slice(6, 8)),
  );
  if (!match[1] && instant > referenceInstant) {
    year -= 1;
    instant = Date.UTC(year, month - 1, day);
  }
  const date = new Date(instant);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("transaction_date_invalid");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+09:00`;
}

function normalizeOrigins(origins: DirectOrigins): DirectOrigins {
  const normalized = {
    baseURL: normalizeOrigin(origins.baseURL),
    loginURL: normalizeOrigin(origins.loginURL),
  };
  if (
    normalized.baseURL !== "https://direct3.smbc.co.jp" ||
    normalized.loginURL !== "https://direct.smbc.co.jp"
  ) {
    throw new Error("smbc_origin_not_allowlisted");
  }
  return normalized;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("smbc_origin_invalid");
  return url.origin;
}

export function qrDataUrl(value: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(value, { border: 4 }))}`;
}

export async function startLogin(
  originsInput: DirectOrigins,
  credentials: Credentials,
  transport: FetchTransport,
): Promise<{ state: ChallengeState; qrSvgDataUrl: string }> {
  const origins = normalizeOrigins(originsInput);
  const jar = new CookieJar();
  const loginPage = await fetchWithCookies(
    new URL("/aib/aibgsjsw5001.jsp", origins.loginURL),
    { headers: browserHeaders },
    jar,
    transport,
  );
  const loginHtml = (await responseShiftJis(loginPage, "login_page")).text;
  const loginForm = formFields(loginHtml, "LLDLDIL");
  const confirmation = await fetchWithCookies(
    new URL("/ib/web/loginlogout/LLDLDILnextPreTS.smbc", origins.baseURL),
    {
      method: "POST",
      headers: {
        ...browserHeaders,
        "content-type": "application/x-www-form-urlencoded",
        origin: origins.baseURL,
        referer: loginPage.url,
      },
      body: new URLSearchParams({
        _FRAMEID: required(loginForm, "_FRAMEID"),
        _TARGETID: required(loginForm, "_TARGETID"),
        _LUID: required(loginForm, "_LUID"),
        _TOKEN: required(loginForm, "_TOKEN"),
        _FORMID: "LLDLDIL",
        _SUBINDEX: "",
        switchLoginDomainReqFlag: "",
        swKeyboardUseFlagSw2: "0",
        branchNo: credentials.branchNo,
        accountNo: credentials.accountNo,
        userId1: "",
        userId2: "",
        password: credentials.password,
      }),
    },
    jar,
    transport,
  );
  const confirmationBody = await responseShiftJis(confirmation, "login_request");
  const confirmationHtml = confirmationBody.text;
  const responseKind = classifyLoginResponse(confirmationHtml);
  if (responseKind !== "confirmation") {
    console.warn(
      JSON.stringify({
        message: "smbc_login_response_rejected",
        responseKind,
        status: confirmation.status,
        responseBytes: confirmationBody.bytes.byteLength,
        responseDigest: await loginResponseDigest(confirmationBody.bytes),
      }),
    );
    throw new Error(`login_response_${responseKind}`);
  }
  const confirmationForm = formFields(confirmationHtml, "BCATBCA");
  const pageDlink = new URL("smbcdirectapp:///biometrics/ADBA");
  pageDlink.searchParams.set("userId", inlineVariable(confirmationHtml, "userId"));
  pageDlink.searchParams.set(
    "confirmationNumber",
    inlineVariable(confirmationHtml, "confirmationNumber"),
  );
  pageDlink.searchParams.set("createdTime", inlineVariable(confirmationHtml, "createdTime"));
  if (pageDlink.protocol !== APP_SCHEME) throw new Error("smbc_app_url_invalid");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const state: ChallengeState = {
    createdAt,
    expiresAt,
    appUrl: pageDlink.toString(),
    cookies: jar.export(),
    confirmationForm,
    confirmationUrl: confirmation.url,
  };
  return { state, qrSvgDataUrl: qrDataUrl(state.appUrl) };
}

export async function finishLogin(
  originsInput: DirectOrigins,
  credentials: Credentials,
  challenge: ChallengeState,
  transport: FetchTransport,
): Promise<DirectProfile> {
  const origins = normalizeOrigins(originsInput);
  if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("challenge_expired");
  const jar = new CookieJar(challenge.cookies);
  const completionUrl = new URL("/ib/web/loginlogout/LLDLDILnextPostTS.smbc", origins.baseURL);
  const sessionBefore = jar.get("JSESSIONID", completionUrl);
  const response = await fetchWithCookies(
    completionUrl,
    {
      method: "POST",
      headers: {
        ...browserHeaders,
        "content-type": "application/x-www-form-urlencoded",
        origin: origins.baseURL,
        referer: challenge.confirmationUrl,
      },
      body: new URLSearchParams({
        _FRAMEID: required(challenge.confirmationForm, "_FRAMEID"),
        _TARGETID: required(challenge.confirmationForm, "_TARGETID"),
        _LUID: required(challenge.confirmationForm, "_LUID"),
        _TOKEN: required(challenge.confirmationForm, "_TOKEN"),
        _FORMID: "BCATBCA",
        _SUBINDEX: "",
        takeOverTransitionType: required(challenge.confirmationForm, "takeOverTransitionType"),
        validMillisecond: required(challenge.confirmationForm, "validMillisecond"),
      }),
    },
    jar,
    transport,
  );
  const completion = await responseShiftJis(response, "login_completion");
  const sessionAfter = jar.get("JSESSIONID", completionUrl);
  if (!sessionAfter || sessionAfter === sessionBefore) throw new ApprovalNotCompletedError();
  const topPage = await requestTopPage(
    origins.baseURL,
    jar,
    completion.text,
    response.url,
    transport,
  );
  return new DirectProfile(origins, credentials, jar, topPage, transport);
}

async function requestTopPage(
  baseURL: string,
  jar: CookieJar,
  completionHtml: string,
  completionUrl: string,
  transport: FetchTransport,
): Promise<{ html: string; url: string }> {
  if (/\bname=["']TPALTOP["']/iu.test(completionHtml)) {
    return { html: completionHtml, url: completionUrl };
  }
  const header = formFields(completionHtml, "DIRECTHEADERFORM");
  const response = await fetchWithCookies(
    new URL("/ib/web/top/TPALTOPacctList.smbc", baseURL),
    {
      method: "POST",
      headers: {
        ...browserHeaders,
        "content-type": "application/x-www-form-urlencoded",
        origin: baseURL,
        referer: completionUrl,
      },
      body: new URLSearchParams(header),
    },
    jar,
    transport,
  );
  return { html: (await responseShiftJis(response, "top_page")).text, url: response.url };
}

export class DirectProfile {
  #topPage: { html: string; url: string };

  constructor(
    readonly origins: DirectOrigins,
    readonly credentials: Credentials,
    readonly jar: CookieJar,
    topPage: { html: string; url: string },
    readonly transport: FetchTransport,
  ) {
    this.#topPage = topPage;
  }

  static import(
    originsInput: DirectOrigins,
    credentials: Credentials,
    session: AuthenticatedSession,
    transport: FetchTransport,
  ): DirectProfile {
    const origins = normalizeOrigins(originsInput);
    const topPageUrl = new URL(session.topPage.url);
    if (topPageUrl.origin !== origins.baseURL) throw new Error("session_origin_invalid");
    return new DirectProfile(
      origins,
      credentials,
      new CookieJar(session.cookies),
      { html: session.topPage.html, url: topPageUrl.toString() },
      transport,
    );
  }

  export(): AuthenticatedSession {
    return { cookies: this.jar.export(), topPage: { ...this.#topPage } };
  }

  #topForms(): { topForm: Record<string, string>; headerForm: Record<string, string> } {
    return {
      topForm: formFields(this.#topPage.html, "TPALTOP"),
      headerForm: formFields(this.#topPage.html, "DIRECTHEADERFORM"),
    };
  }

  async continueSession(): Promise<void> {
    const { headerForm } = this.#topForms();
    const response = await fetchWithCookies(
      new URL("/ib/web/top/TPALTOPacctList.smbc", this.origins.baseURL),
      {
        method: "POST",
        headers: {
          ...browserHeaders,
          "content-type": "application/x-www-form-urlencoded",
          origin: this.origins.baseURL,
          referer: this.#topPage.url,
        },
        body: new URLSearchParams(headerForm),
      },
      this.jar,
      this.transport,
    );
    this.#topPage = {
      html: (await responseShiftJis(response, "continue_session")).text,
      url: response.url,
    };
    this.#topForms();
  }

  async getBalance(): Promise<BalanceResult> {
    const { topForm } = this.#topForms();
    const url = new URL("/ib/ajax/top/TPALTOPAjaxSavingBalance.smbc", this.origins.baseURL);
    url.searchParams.set("_TOKEN", required(topForm, "_TOKEN"));
    url.searchParams.set("_FORMID", required(topForm, "_FORMID"));
    const response = await fetchWithCookies(
      url,
      {
        method: "POST",
        headers: {
          ...browserHeaders,
          "content-type": "application/json; charset=UTF-8",
          origin: this.origins.baseURL,
          referer: this.#topPage.url,
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({
          accountBranchCode: this.credentials.branchNo.padStart(4, "0"),
          accountItemCode: ACCOUNT_ITEM_CODE,
          accountNo: this.credentials.accountNo,
        }),
      },
      this.jar,
      this.transport,
    );
    const rawBytes = await readBoundedBytes(response, MAX_JSON_BYTES, "balance");
    const text = iconv.decode(Buffer.from(rawBytes), "Shift_JIS");
    const body = JSON.parse(text) as { response?: { ajaxSavingAccountBalance?: unknown } };
    const displayValue = body.response?.ajaxSavingAccountBalance;
    if (typeof displayValue !== "string") throw new Error("balance_value_missing");
    return {
      amount: parseYen(displayValue, "balance"),
      currency: "JPY",
      displayValue,
      rawBytes,
      rawContentType: response.headers.get("content-type") ?? "application/json; charset=Shift_JIS",
    };
  }

  async getTransactions(range: DateRange): Promise<TransactionResult> {
    const startDate = compactDate(range.start);
    const endDate = compactDate(range.end);
    await this.continueSession();
    const { topForm } = this.#topForms();
    const detailResponse = await fetchWithCookies(
      new URL("/ib/web/top/TPALTOPaccountFutsuDetail.smbc", this.origins.baseURL),
      {
        method: "POST",
        headers: {
          ...browserHeaders,
          "content-type": "application/x-www-form-urlencoded",
          origin: this.origins.baseURL,
          referer: this.#topPage.url,
        },
        body: new URLSearchParams({
          ...topForm,
          moudaiBrNo: this.credentials.branchNo.padStart(4, "0"),
          moudaiAcNo: this.credentials.accountNo,
          accountBranchCode: this.credentials.branchNo.padStart(4, "0"),
          accountItemCode: ACCOUNT_ITEM_CODE,
          accountNo: this.credentials.accountNo,
        }),
      },
      this.jar,
      this.transport,
    );
    const detailHtml = (await responseShiftJis(detailResponse, "account_detail")).text;
    const detailFormName = /\bname=["']AIFCDTL["']/iu.test(detailHtml) ? "AIFCDTL" : "AIFCDT3";
    const detailForm = formFields(detailHtml, detailFormName);
    const url = new URL(
      "/ib/ajax/accountinquiry/AIFCDT3Ajaxkikannshokai.smbc",
      this.origins.baseURL,
    );
    url.searchParams.set("_TOKEN", required(detailForm, "_TOKEN"));
    url.searchParams.set("_FORMID", required(detailForm, "_FORMID"));
    const response = await fetchWithCookies(
      url,
      {
        method: "POST",
        headers: {
          ...browserHeaders,
          "content-type": "application/json; charset=UTF-8",
          origin: this.origins.baseURL,
          referer: detailResponse.url,
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({ mStartYmd: startDate, mEndYmd: endDate }),
      },
      this.jar,
      this.transport,
    );
    const rawBytes = await readBoundedBytes(response, MAX_JSON_BYTES, "transactions");
    const text = iconv.decode(Buffer.from(rawBytes), "Shift_JIS");
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error("transactions_json_invalid");
    }
    const result = body as {
      success?: unknown;
      response?: {
        nyukinGoukei?: unknown;
        syukkinGoukei?: unknown;
        meisai?: Array<Record<string, unknown>>;
      };
      cause?: unknown;
    };
    if (result.success !== true || !result.response || !Array.isArray(result.response.meisai)) {
      if (String(result.cause).endsWith(".ServiceTimeCheckException")) {
        throw new Error("transactions_service_time_unavailable");
      }
      throw new Error("transactions_rejected");
    }
    const transactions = result.response.meisai.map((entry) => ({
      id: String(entry.meisaiId ?? ""),
      date: transactionDate(entry.dispDate, endDate),
      amount: Math.abs(parseYen(entry.amount, "transaction_amount")),
      balanceAfter: parseYen(entry.torihikigobalance, "transaction_balance"),
      description: String(entry.comment ?? ""),
      direction: entry.depositWithdrawTypeFlag === "1" ? ("debit" as const) : ("credit" as const),
    }));
    await this.continueSession();
    return {
      range,
      depositsTotal: parseYen(result.response.nyukinGoukei, "deposits_total"),
      withdrawalsTotal: parseYen(result.response.syukkinGoukei, "withdrawals_total"),
      transactions,
      rawBytes,
      rawContentType: response.headers.get("content-type") ?? "application/json; charset=Shift_JIS",
    };
  }

  async logout(): Promise<void> {
    const { headerForm } = this.#topForms();
    const response = await fetchWithCookies(
      new URL("/ib/web/loginlogout/TPALTOPlogout1.smbc", this.origins.baseURL),
      {
        method: "POST",
        headers: {
          ...browserHeaders,
          "content-type": "application/x-www-form-urlencoded",
          origin: this.origins.baseURL,
          referer: this.#topPage.url,
        },
        body: new URLSearchParams(headerForm),
      },
      this.jar,
      this.transport,
    );
    await responseShiftJis(response, "logout");
  }
}
