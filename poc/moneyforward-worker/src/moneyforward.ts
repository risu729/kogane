import { MoneyForwardHttpError, MoneyForwardProtocolError, type Stage } from "./diagnostics";
import { CookieJar } from "./cookies";
import type { MoneyForwardCredential, RawArtifact } from "./types";
import { createAssertion } from "./webauthn";

const ID_ORIGIN = "https://id.moneyforward.com";
const ME_ORIGIN = "https://moneyforward.com";
const ALLOWED_HOSTS = new Set(["id.moneyforward.com", "moneyforward.com"]);
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const BROWSER_HEADERS = {
  "accept-language": "ja,en-US;q=0.9,en;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
} as const;

export interface MoneyForwardCollection {
  artifacts: RawArtifact[];
  accountDetailCount: number;
  monthlyFragmentCount: number;
}

export async function collectMoneyForward(options: {
  credential: MoneyForwardCredential;
  fetcher?: Fetcher;
  onStage?: (stage: Stage) => void;
}): Promise<MoneyForwardCollection> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const cookies = new CookieJar();
  const onStage = (stage: Stage) => { try { options.onStage?.(stage); } catch { /* Diagnostics are best effort. */ } };
  onStage("login-entry");
  const signIn = await followGetRedirects(
    new URL("/sign_in", ID_ORIGIN),
    cookies,
    fetcher,
  );
  if (signIn.url.hostname !== "id.moneyforward.com" || signIn.response.status !== 200) {
    throw new MoneyForwardProtocolError("unexpected-redirect", signIn.response.status);
  }
  const signInHtml = await signIn.response.text();
  const csrf = extractCsrfToken(signInHtml);
  onStage("passkey-options");
  const requestOptionsResponse = await fetchWithCookies(
    new URL("/webauthn/assertion/options", ID_ORIGIN),
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        origin: ID_ORIGIN,
        referer: signIn.url.toString(),
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        userIdentifier: {},
        authenticationContext: "sign_in",
      }),
    },
    cookies,
    fetcher,
  );
  if (!requestOptionsResponse.ok) {
    throw new MoneyForwardHttpError(requestOptionsResponse.status);
  }
  const requestOptions = objectValue(
    await requestOptionsResponse.json(),
    "Money Forward passkey options",
  );
  const challenge = requiredString(requestOptions["challenge"], "passkey challenge");
  const rpId = optionalString(requestOptions["rpId"]);
  onStage("passkey-sign");
  const assertion = await createAssertion(options.credential, {
    challenge,
    ...(rpId ? { rpId } : {}),
  });
  onStage("passkey-assert");
  const assertionResponse = await fetchWithCookies(
    new URL("/webauthn/assertion", ID_ORIGIN),
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        origin: ID_ORIGIN,
        referer: signIn.url.toString(),
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        authenticatorResponse: assertion,
        authenticationContext: "sign_in",
        returnUrl: "",
      }),
    },
    cookies,
    fetcher,
  );
  if (!assertionResponse.ok) {
    throw new MoneyForwardHttpError(assertionResponse.status);
  }
  const assertionResult = objectValue(
    await assertionResponse.json(),
    "Money Forward assertion result",
  );
  const redirectPath = requiredString(assertionResult["redirectPath"], "assertion redirect path");
  onStage("auth-redirect");
  const postAssertion = await followGetRedirects(
    checkedUrl(redirectPath, ID_ORIGIN),
    cookies,
    fetcher,
  );
  if (
    postAssertion.url.hostname !== "id.moneyforward.com" ||
    postAssertion.url.pathname !== "/me" ||
    postAssertion.response.status !== 200
  ) {
    throw new MoneyForwardProtocolError("unexpected-redirect", postAssertion.response.status);
  }
  onStage("accounts-index");
  let accounts = await followGetRedirects(new URL("/accounts", ME_ORIGIN), cookies, fetcher);
  onStage("account-selector");
  accounts = await selectActiveAccount(accounts, cookies, fetcher);
  if (
    accounts.url.hostname !== "moneyforward.com" ||
    accounts.url.pathname !== "/accounts" ||
    !accounts.response.ok
  ) {
    throw new MoneyForwardProtocolError("unexpected-redirect", accounts.response.status);
  }
  onStage("accounts-index");
  const accountsHtml = await accounts.response.text();
  if (looksSignedOut(accountsHtml)) throw new MoneyForwardProtocolError("session-not-authenticated");
  const detailPaths = extractAccountDetailPaths(accountsHtml);
  const artifacts: RawArtifact[] = [{
    dataset: "accounts-index",
    filename: "accounts.html",
    mediaType: "text/html; charset=utf-8",
    body: accountsHtml,
  }];
  let monthlyFragmentCount = 0;
  for (const [index, path] of detailPaths.entries()) {
    onStage("account-detail");
    const response = await fetchWithCookies(
      new URL(path, ME_ORIGIN),
      {
        headers: {
          ...BROWSER_HEADERS,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: new URL("/accounts", ME_ORIGIN).toString(),
        },
      },
      cookies,
      fetcher,
    );
    if (!response.ok) {
      throw new MoneyForwardHttpError(response.status);
    }
    const detailHtml = await response.text();
    artifacts.push({
      dataset: "account-detail",
      filename: `account-detail-${String(index + 1).padStart(2, "0")}.html`,
      mediaType: "text/html; charset=utf-8",
      body: detailHtml,
    });
    const context = extractAccountContext(detailHtml);
    for (const month of recentMonths(new Date(), 12)) {
      onStage("monthly-detail");
      const fragment = await fetchWithCookies(
        new URL("/cf/fetch", ME_ORIGIN),
        {
          method: "POST",
          headers: {
            ...BROWSER_HEADERS,
            accept: "text/html, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            origin: ME_ORIGIN,
            referer: new URL(path, ME_ORIGIN).toString(),
            "x-csrf-token": context.csrf,
            "x-requested-with": "XMLHttpRequest",
          },
          body: new URLSearchParams({
            from: `${month.year}/${month.month}/1`,
            account_id_hash: context.accountIdHash,
            service_id: context.serviceId,
          }),
        },
        cookies,
        fetcher,
      );
      if (!fragment.ok) {
        throw new MoneyForwardHttpError(fragment.status);
      }
      artifacts.push({
        dataset: "monthly-transactions",
        filename: `account-${String(index + 1).padStart(2, "0")}-month-${month.label}.html`,
        mediaType: "text/html; charset=utf-8",
        body: await fragment.text(),
      });
      monthlyFragmentCount += 1;
    }
  }
  return { artifacts, accountDetailCount: detailPaths.length, monthlyFragmentCount };
}

async function selectActiveAccount(
  current: { url: URL; response: Response },
  cookies: CookieJar,
  fetcher: Fetcher,
): Promise<{ url: URL; response: Response }> {
  if (
    current.url.hostname !== "id.moneyforward.com" ||
    current.url.pathname !== "/account_selector" ||
    current.response.status !== 200
  ) {
    return current;
  }
  const html = await current.response.text();
  const match = html.match(/(?:window\.)?gon\.accounts=(\[[\s\S]*?\]);gon\./u);
  if (!match?.[1]) throw new MoneyForwardProtocolError("invalid-response");
  const value: unknown = JSON.parse(match[1]);
  if (!Array.isArray(value)) throw new MoneyForwardProtocolError("invalid-response");
  const active = value
    .map((entry) => objectValue(entry, "Money Forward account selector entry"))
    .find((entry) => entry["active"] === true);
  if (!active) throw new MoneyForwardProtocolError("invalid-response");
  const formAction = requiredString(active["formAction"], "account selector form action");
  return followGetRedirects(checkedUrl(formAction, ID_ORIGIN), cookies, fetcher);
}

export function extractAccountDetailPaths(html: string): string[] {
  const paths = new Set<string>();
  for (const match of html.matchAll(/href=["'](\/accounts\/show\/[A-Za-z0-9_-]+)(?:[?"'#])/giu)) {
    const path = match[1];
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

export function extractAccountContext(html: string): {
  accountIdHash: string;
  serviceId: string;
  csrf: string;
} {
  return {
    accountIdHash: extractInputValue(html, "account[id_hash]"),
    serviceId: extractInputValue(html, "service[id]"),
    csrf: extractCsrfToken(html),
  };
}

export function recentMonths(now: Date, count: number): Array<{
  year: number;
  month: number;
  label: string;
}> {
  const tokyoNow = new Date(now.getTime() + 9 * 60 * 60 * 1_000);
  const result = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(Date.UTC(
      tokyoNow.getUTCFullYear(),
      tokyoNow.getUTCMonth() - offset,
      1,
    ));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    result.push({ year, month, label: `${year}-${String(month).padStart(2, "0")}` });
  }
  return result;
}

async function followGetRedirects(
  initialUrl: URL,
  cookies: CookieJar,
  fetcher: Fetcher,
): Promise<{ url: URL; response: Response }> {
  let url = checkedUrl(initialUrl.toString(), initialUrl.origin);
  for (let index = 0; index < 12; index += 1) {
    const response = await fetchWithCookies(
      url,
      {
        headers: {
          ...BROWSER_HEADERS,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "upgrade-insecure-requests": "1",
        },
      },
      cookies,
      fetcher,
    );
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { url, response };
    }
    const location = response.headers.get("location");
    if (!location) throw new MoneyForwardProtocolError("missing-location");
    const next = checkedUrl(location, url.toString());
    url = next;
  }
  throw new MoneyForwardProtocolError("redirect-limit");
}

async function fetchWithCookies(
  url: URL,
  init: RequestInit,
  cookies: CookieJar,
  fetcher: Fetcher,
): Promise<Response> {
  if (!ALLOWED_HOSTS.has(url.hostname) || url.protocol !== "https:") {
    throw new MoneyForwardProtocolError("unexpected-redirect");
  }
  const headers = new Headers(init.headers);
  const cookie = cookies.header(url);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetcher(url, { ...init, headers, redirect: "manual" });
  cookies.absorb(url, response);
  return response;
}

function checkedUrl(value: string, base: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new MoneyForwardProtocolError("unexpected-redirect");
  }
  return url;
}

function extractCsrfToken(html: string): string {
  const match =
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/iu) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/iu);
  if (!match?.[1]) throw new MoneyForwardProtocolError("missing-csrf");
  return htmlDecode(match[1]);
}

function extractInputValue(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(`<input[^>]+name=["']${escaped}["'][^>]+value=["']([^"']+)["']`, "iu"),
    new RegExp(`<input[^>]+value=["']([^"']+)["'][^>]+name=["']${escaped}["']`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return htmlDecode(match[1]);
  }
  throw new MoneyForwardProtocolError("missing-account-context");
}

function looksSignedOut(html: string): boolean {
  return /id\.moneyforward\.com\/sign_in/iu.test(html) && !/\/sign_out/iu.test(html);
}

function htmlDecode(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyForwardProtocolError("invalid-response");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MoneyForwardProtocolError("invalid-response");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
