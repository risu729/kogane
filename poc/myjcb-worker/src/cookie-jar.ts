import type { CookieParam } from "@cloudflare/puppeteer";
import { StopConditionError } from "./types";

interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expiresAt?: number;
}

const MAX_COOKIES = 100;
const MAX_COOKIE_BYTES = 4096;

export class CookieJar {
  readonly #cookies = new Map<string, StoredCookie>();

  importBrowserCookies(cookies: readonly CookieParam[], baseUrl: URL): void {
    for (const cookie of cookies) {
      if (!cookie.name || cookie.value === undefined) continue;
      const domain = normalizeDomain(cookie.domain ?? baseUrl.hostname);
      this.#set({
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path || "/",
        secure: cookie.secure ?? true,
        ...(typeof cookie.expires === "number" && cookie.expires > 0
          ? { expiresAt: cookie.expires * 1000 }
          : {}),
      }, baseUrl);
    }
  }

  updateFromResponse(response: Response, requestUrl: URL): void {
    for (const value of responseSetCookies(response.headers)) {
      const parsed = parseSetCookie(value, requestUrl);
      if (parsed) this.#set(parsed, requestUrl);
    }
  }

  header(url: URL, now = Date.now()): string {
    const values = [...this.#cookies.values()]
      .filter((cookie) =>
        (cookie.expiresAt === undefined || cookie.expiresAt > now) &&
        domainMatches(url.hostname, cookie.domain) &&
        pathMatches(url.pathname, cookie.path) &&
        (!cookie.secure || url.protocol === "https:")
      )
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    return values.join("; ");
  }

  count(): number {
    return this.#cookies.size;
  }

  #set(cookie: StoredCookie, requestUrl: URL): void {
    if (!domainMatches(requestUrl.hostname, cookie.domain)) {
      throw new StopConditionError("Rejected cookie for an unrelated domain");
    }
    if (`${cookie.name}=${cookie.value}`.length > MAX_COOKIE_BYTES) {
      throw new StopConditionError("Rejected oversized MyJCB cookie");
    }
    const key = `${cookie.domain}\0${cookie.path}\0${cookie.name}`;
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
      this.#cookies.delete(key);
      return;
    }
    this.#cookies.set(key, cookie);
    if (this.#cookies.size > MAX_COOKIES) {
      throw new StopConditionError("Rejected excessive MyJCB cookie count");
    }
  }
}

function responseSetCookies(headers: Headers): string[] {
  const candidate = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof candidate.getSetCookie === "function") return candidate.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

function splitCombinedSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/u).map((part) => part.trim());
}

function parseSetCookie(value: string, requestUrl: URL): StoredCookie | undefined {
  const segments = value.split(";").map((part) => part.trim());
  const first = segments.shift();
  if (!first) return undefined;
  const separator = first.indexOf("=");
  if (separator <= 0) return undefined;
  const name = first.slice(0, separator);
  const cookieValue = first.slice(separator + 1);
  let domain = requestUrl.hostname.toLowerCase();
  let path = defaultPath(requestUrl.pathname);
  let secure = false;
  let maxAgeAt: number | undefined;
  let expiresAt: number | undefined;
  for (const segment of segments) {
    const [rawName, ...rest] = segment.split("=");
    const attribute = rawName?.toLowerCase();
    const attributeValue = rest.join("=");
    if (attribute === "domain" && attributeValue) domain = normalizeDomain(attributeValue);
    if (attribute === "path" && attributeValue.startsWith("/")) path = attributeValue;
    if (attribute === "secure") secure = true;
    if (attribute === "max-age" && /^-?\d+$/u.test(attributeValue)) {
      maxAgeAt = Date.now() + Number(attributeValue) * 1000;
    } else if (attribute === "expires") {
      const parsed = Date.parse(attributeValue);
      if (!Number.isNaN(parsed)) expiresAt = parsed;
    }
  }
  const effectiveExpiry = maxAgeAt ?? expiresAt;
  return {
    name,
    value: cookieValue,
    domain,
    path,
    secure,
    ...(effectiveExpiry === undefined ? {} : { expiresAt: effectiveExpiry }),
  };
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\./u, "");
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  return pathname === cookiePath ||
    pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function defaultPath(pathname: string): string {
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}
