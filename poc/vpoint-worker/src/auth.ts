import { load as loadHtml } from "cheerio";
import iconv from "iconv-lite";
import setCookieParser from "set-cookie-parser";

const SITE_ORIGIN = "https://tsite.jp";
const MY_PAGE_ORIGIN = "https://mypage.tsite.jp";
const LOGIN_ENTRY = "/tm/pc/login/STKIp0018001.do";
const NUMBER_ENTRY = "/tm/pc/login/STKIp0002010.do";
const AUTH_METHOD = "/tm/pc/login/STKIp0002011.do";
const EMAIL_CONFIRM = "/tm/pc/login/STKIp0002040.do";
const EMAIL_CODE = "/tm/pc/login/STKIp0002042.do";
const EMAIL_COMPLETE = "/tm/pc/login/STKIp0002045.do";
const MAX_REDIRECTS = 8;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expiresAt: number | null;
}

interface PageResponse {
  url: string;
  status: number;
  location: string | null;
  html: string;
}

export interface VPointEmailChallenge {
  requestedAt: string;
  state: VPointEmailChallengeState;
  complete(code: string): Promise<VPointLoginResult>;
}

export interface VPointEmailChallengeState {
  version: 1;
  requestedAt: string;
  codePageUrl: string;
  codeForm: Array<[string, string]>;
  cookies: StoredCookie[];
}

export interface VPointLoginResult {
  sessionCookie: string;
  applicationStatus: "0000";
}

export interface VPointLoginTrace {
  method: string;
  origin: string;
  pathname: string;
  status: number;
  redirect: { origin: string; pathname: string } | null;
  sentCookieNames: string[];
  receivedCookies: Array<{
    name: string;
    domain: string | null;
    path: string | null;
  }>;
}

export async function beginVPointEmailLogin(options: {
  memberNumber: string;
  fetcher?: Fetcher;
  now?: () => Date;
  onTrace?: (trace: VPointLoginTrace) => void;
}): Promise<VPointEmailChallenge> {
  const memberNumber = normalizeMemberNumber(options.memberNumber);
  const client = new VPointLoginClient(options.fetcher ?? defaultFetch, options.onTrace);
  const entry = await client.get(`${SITE_ORIGIN}${LOGIN_ENTRY}`);
  const numberPage = await client.postForm(entry, NUMBER_ENTRY);
  assertFormField(numberPage.html, "TID", NUMBER_ENTRY);
  const authPage = await client.postForm(numberPage, AUTH_METHOD, {
    TID: memberNumber,
  });
  const confirmPage = await client.postForm(authPage, EMAIL_CONFIRM);
  const codePage = await client.postForm(confirmPage, EMAIL_CODE);
  assertFormField(codePage.html, "NINSYO_CD", EMAIL_CODE);
  const requestedAt = (options.now ?? (() => new Date()))().toISOString();
  const state: VPointEmailChallengeState = {
    version: 1,
    requestedAt,
    codePageUrl: codePage.url,
    codeForm: [...parseForm(codePage.html).entries()],
    cookies: client.exportCookies(),
  };

  return {
    requestedAt,
    state,
    async complete(value: string): Promise<VPointLoginResult> {
      return completeVPointEmailLogin({
        state,
        code: value,
        fetcher: options.fetcher,
        onTrace: options.onTrace,
      });
    },
  };
}

export async function completeVPointEmailLogin(options: {
  state: VPointEmailChallengeState;
  code: string;
  fetcher?: Fetcher;
  onTrace?: (trace: VPointLoginTrace) => void;
}): Promise<VPointLoginResult> {
  if (options.state.version !== 1) {
    throw new Error("Unsupported V Point email challenge state");
  }
  const code = normalizeEmailCode(options.code);
  const client = new VPointLoginClient(
    options.fetcher ?? defaultFetch,
    options.onTrace,
    options.state.cookies,
  );
  const result = await client.postFormEntries(
    options.state.codePageUrl,
    options.state.codeForm,
    EMAIL_COMPLETE,
    { NINSYO_CD: code },
  );
  if (result.status !== 302 && result.status !== 303) {
    throw new Error("V Point email code was rejected or expired");
  }
  await client.followRedirect(result);
  await client.get(`${MY_PAGE_ORIGIN}/?hid=1`);
  await client.request(`${MY_PAGE_ORIGIN}/api/user_info`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      origin: MY_PAGE_ORIGIN,
      referer: `${MY_PAGE_ORIGIN}/?hid=1`,
      "x-requested-with": "XMLHttpRequest",
    },
  });
  const probe = await client.request(`${MY_PAGE_ORIGIN}/api/balance_info`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      origin: MY_PAGE_ORIGIN,
      referer: `${MY_PAGE_ORIGIN}/?hid=1`,
      "x-requested-with": "XMLHttpRequest",
    },
  });
  let json: unknown;
  try {
    json = JSON.parse(probe.html);
  } catch {
    throw new Error("V Point session probe returned non-JSON");
  }
  const status = isObject(json) && isObject(json.status) ? json.status.code : null;
  if (status !== "0000") {
    throw new Error(
      `V Point email login did not create an authenticated session (${String(status)})`,
    );
  }
  return {
    sessionCookie: client.cookieHeader(`${MY_PAGE_ORIGIN}/api/balance_info`),
    applicationStatus: "0000",
  };
}

export function normalizeMemberNumber(value: string): string {
  const normalized = value.replace(/[\s-]+/gu, "");
  if (!/^(?:\d{9}|[09]\d{15})$/u.test(normalized)) {
    throw new Error("V Point member number must be 9 or 16 digits");
  }
  return normalized;
}

export function normalizeEmailCode(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4,6}$/u.test(normalized)) {
    throw new Error("V Point email code must be 4 to 6 digits");
  }
  return normalized;
}

class VPointLoginClient {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly onTrace?: (trace: VPointLoginTrace) => void,
    cookies: StoredCookie[] = [],
  ) {
    for (const cookie of cookies) {
      this.cookies.set(cookieKey(cookie), { ...cookie });
    }
  }

  async get(url: string): Promise<PageResponse> {
    return this.request(url, { method: "GET" });
  }

  async postForm(
    page: PageResponse,
    path: string,
    overrides: Record<string, string> = {},
  ): Promise<PageResponse> {
    return this.postFormEntries(page.url, [...parseForm(page.html).entries()], path, overrides);
  }

  async postFormEntries(
    referer: string,
    entries: Array<[string, string]>,
    path: string,
    overrides: Record<string, string> = {},
  ): Promise<PageResponse> {
    const form = new URLSearchParams(entries);
    for (const [name, value] of Object.entries(overrides)) form.set(name, value);
    return this.request(`${SITE_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: SITE_ORIGIN,
        referer,
      },
      body: form.toString(),
    });
  }

  async followRedirect(response: PageResponse): Promise<PageResponse> {
    let current = response;
    for (let count = 0; count < MAX_REDIRECTS; count += 1) {
      if (![301, 302, 303, 307, 308].includes(current.status)) return current;
      if (!current.location) throw new Error("V Point redirect had no Location header");
      const next = new URL(current.location, current.url).toString();
      current = await this.get(next);
    }
    throw new Error("V Point login exceeded the redirect limit");
  }

  async request(url: string, init: RequestInit): Promise<PageResponse> {
    const headers = new Headers(init.headers);
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
    headers.set("accept-language", "ja-JP,ja;q=0.9,en;q=0.8");
    const cookie = this.cookieHeader(url);
    if (cookie) headers.set("cookie", cookie);
    const response = await this.fetcher(url, {
      ...init,
      headers,
      redirect: "manual",
    });
    const setCookies = getSetCookieValues(response.headers);
    this.captureCookies(url, response.headers);
    const responseUrl = new URL(url);
    const location = response.headers.get("location");
    const redirectUrl = location ? new URL(location, url) : null;
    this.onTrace?.({
      method: init.method ?? "GET",
      origin: responseUrl.origin,
      pathname: responseUrl.pathname,
      status: response.status,
      redirect: redirectUrl ? { origin: redirectUrl.origin, pathname: redirectUrl.pathname } : null,
      sentCookieNames: cookie ? cookie.split("; ").map((pair) => pair.split("=", 1)[0] ?? "") : [],
      receivedCookies: setCookies.flatMap((value) =>
        setCookieParser.parse(value).map((received) => ({
          name: received.name,
          domain: received.domain ?? null,
          path: received.path ?? null,
        })),
      ),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      url,
      status: response.status,
      location,
      html: decodeBody(bytes, response.headers.get("content-type")),
    };
  }

  cookieHeader(urlValue: string): string {
    const url = new URL(urlValue);
    const now = Date.now();
    return [...this.cookies.values()]
      .filter((cookie) => {
        if (cookie.expiresAt !== null && cookie.expiresAt <= now) return false;
        if (cookie.secure && url.protocol !== "https:") return false;
        const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
        if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) {
          return false;
        }
        return url.pathname.startsWith(cookie.path);
      })
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  exportCookies(): StoredCookie[] {
    return [...this.cookies.values()].map((cookie) => ({ ...cookie }));
  }

  private captureCookies(urlValue: string, headers: Headers): void {
    const url = new URL(urlValue);
    const values = getSetCookieValues(headers);
    for (const value of values) {
      for (const parsed of setCookieParser.parse(value)) {
        const domain = parsed.domain?.replace(/^\./u, "") ?? url.hostname;
        const path = parsed.path ?? defaultCookiePath(url.pathname);
        const key = cookieKey({ name: parsed.name, domain, path });
        if (parsed.maxAge === 0 || parsed.value.length === 0) {
          this.cookies.delete(key);
          continue;
        }
        this.cookies.set(key, {
          name: parsed.name,
          value: parsed.value,
          domain,
          path,
          secure: parsed.secure ?? false,
          expiresAt: parsed.expires instanceof Date ? parsed.expires.getTime() : null,
        });
      }
    }
  }
}

function cookieKey(cookie: Pick<StoredCookie, "name" | "domain" | "path">): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}

function getSetCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  return (
    extended.getSetCookie?.() ?? setCookieParser.splitCookiesString(headers.get("set-cookie") ?? "")
  );
}

function parseForm(html: string): URLSearchParams {
  const $ = loadHtml(html);
  const form = $("form#form").first().length > 0 ? $("form#form").first() : $("form").first();
  if (form.length === 0) throw new Error("V Point response contained no form");
  const values = new URLSearchParams();
  form.find("input[name], select[name], textarea[name]").each((_index, element) => {
    const field = $(element);
    const name = field.attr("name");
    if (!name) return;
    const type = (field.attr("type") ?? "").toLowerCase();
    if (["button", "file", "image", "reset", "submit"].includes(type)) return;
    if (["checkbox", "radio"].includes(type) && !field.is(":checked")) return;
    values.set(name, field.val()?.toString() ?? field.attr("value") ?? "");
  });
  return values;
}

function assertFormField(html: string, name: string, operation: string): void {
  const $ = loadHtml(html);
  if ($(`[name="${name}"]`).length === 0) {
    throw new Error(`V Point ${operation} response did not contain ${name}`);
  }
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  if (/charset=(?:windows-31j|shift_jis|shift-jis|sjis)/iu.test(contentType ?? "")) {
    return iconv.decode(Buffer.from(bytes), "shift_jis");
  }
  return new TextDecoder().decode(bytes);
}

function defaultCookiePath(pathname: string): string {
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
