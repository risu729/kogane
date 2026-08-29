import { CookieJar } from "tough-cookie";
import { decodeHtml, findForm, summarizeHtml, type FormState, type SafeHtmlSummary } from "./html";

const APP_VERSION = "1.4.0";
const BOOTSTRAP_URL =
  "https://mlogin.smbctb.co.jp/ib/portal/POSNIN1prestiatop.prst?LOCALE=ja_JP";
const LOGIN_URL = "https://mobile.smbctb.co.jp/ib/portal/POSNIN1next.prst";
const HOME_URL = "https://mobile.smbctb.co.jp/ib/portal/POSNIN1prestiatop.prst";
const BALANCE_URL =
  "https://mobile.smbctb.co.jp/ib/top/TOMETOPaccountinfokozazandaka.prst";
const SIGNOFF_URL = "https://mobile.smbctb.co.jp/ib/top/TOMETOPportalsignoff.prst";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241105.008; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 " +
  "Mobile Safari/537.36";
// Static analysis confirms this header/cookie pair but has not yet recovered
// the app's exact separator. Keep the approximation explicit and do not claim
// byte-for-byte parity with the official app.
const FORWARDED_USER_AGENT = `${USER_AGENT} PRESTIA/${APP_VERSION}`;

export type Credentials = { userId: string; password: string };

export type StepResult = {
  urlHost: string;
  status: number;
  redirected: boolean;
  redirectLocationPresent: boolean;
  setCookieCount: number;
  summary: SafeHtmlSummary;
};

export type RawStep = StepResult & {
  bytes: Uint8Array;
  finalUrl: string;
  location: string | null;
};
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (extended.getSetCookie) return extended.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function safeStep(raw: RawStep): StepResult {
  const { bytes: _bytes, finalUrl: _finalUrl, location: _location, ...safe } = raw;
  return safe;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function formBody(form: FormState, overrides: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams();
  const replaced = new Set(Object.keys(overrides));
  for (const [name, value] of form.fields) {
    if (!replaced.has(name)) params.append(name, value);
  }
  for (const [name, value] of Object.entries(overrides)) params.append(name, value);
  return params;
}

export class PrestiaMobileClient {
  readonly #jar = new CookieJar();
  readonly #fetch: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.#fetch = fetcher;
  }

  async #request(url: string, init: RequestInit = {}, redirected = false): Promise<RawStep> {
    const cookie = await this.#jar.getCookieString(url);
    const requestHeaders = new Headers(init.headers);
    const headers = new Headers({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
      "cache-control": "no-cache",
      "user-agent": USER_AGENT,
      "x-forwarded-ua": FORWARDED_USER_AGENT,
      cookie: cookie
        ? `${cookie}; X-FORWARDED-UA=${encodeURIComponent(FORWARDED_USER_AGENT)}`
        : `X-FORWARDED-UA=${encodeURIComponent(FORWARDED_USER_AGENT)}`,
    });
    requestHeaders.forEach((value, name) => headers.set(name, value));
    const response = await this.#fetch(url, { ...init, redirect: "manual", headers });
    const cookies = setCookieHeaders(response.headers);
    for (const source of cookies) await this.#jar.setCookie(source, url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const location = response.headers.get("location");
    return {
      urlHost: new URL(url).host,
      status: response.status,
      redirected,
      redirectLocationPresent: Boolean(location),
      setCookieCount: cookies.length,
      summary: summarizeHtml(bytes),
      bytes,
      finalUrl: url,
      location,
    };
  }

  async #getFollowingSameHostRedirects(startUrl: string): Promise<RawStep> {
    let current = startUrl;
    for (let hop = 0; hop <= 5; hop += 1) {
      const result = await this.#request(current, { method: "GET" }, hop > 0);
      if (!isRedirect(result.status)) return result;
      if (!result.location) throw new Error("Redirect has no Location header");
      const next = new URL(result.location, current);
      if (next.host !== new URL(current).host) {
        throw new Error("Cross-host bootstrap redirect refused");
      }
      if (next.protocol !== "https:") {
        throw new Error("Insecure bootstrap redirect refused");
      }
      current = next.toString();
    }
    throw new Error("Too many bootstrap redirects");
  }

  async bootstrap(): Promise<RawStep> {
    return this.#getFollowingSameHostRedirects(BOOTSTRAP_URL);
  }

  async login(bootstrap: RawStep, credentials: Credentials): Promise<RawStep> {
    const html = decodeHtml(bootstrap.bytes);
    const form = findForm(html, "POSNIN1");
    if (!form) throw new Error("Bootstrap response has no POSNIN1 form");
    const frameId = form.fields.find(([name]) => name === "_FRAMEID")?.[1]?.trim();
    if (!frameId) {
      throw new Error("Bootstrap POSNIN1 form has no non-empty _FRAMEID");
    }
    const body = formBody(form, {
      _TARGETID: frameId,
      userId: credentials.userId,
      password: credentials.password,
      // The public login page's submitProc() copies the visible fields into
      // the hidden pair immediately before doTransaction().
      dispuserId: credentials.userId,
      disppassword: credentials.password,
    });
    return this.#request(LOGIN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://mlogin.smbctb.co.jp",
        referer: bootstrap.finalUrl,
      },
      body,
    });
  }

  async home(login: RawStep): Promise<RawStep> {
    return this.#request(HOME_URL, {
      method: "GET",
      headers: { referer: login.finalUrl },
    });
  }

  async balance(home: RawStep): Promise<RawStep> {
    const html = decodeHtml(home.bytes);
    const form = findForm(html, "POMHTOP");
    if (!form) throw new Error("Home response has no POMHTOP form");
    return this.#request(BALANCE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://mobile.smbctb.co.jp",
        referer: home.finalUrl,
      },
      body: formBody(form),
    });
  }

  async signoff(home: RawStep): Promise<StepResult | null> {
    const html = decodeHtml(home.bytes);
    const form = findForm(html, "POMHTOP");
    if (!form) return null;
    const result = await this.#request(SIGNOFF_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://mobile.smbctb.co.jp",
        referer: home.finalUrl,
      },
      body: formBody(form),
    });
    return safeStep(result);
  }

  async withBestEffortSignoff<T>(home: RawStep, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      try {
        await this.signoff(home);
      } catch {
        // Preserve the read error. A scheduled collector should expose
        // signoff failure as a separate sanitized health signal.
      }
    }
  }

  safe(step: RawStep): StepResult {
    return safeStep(step);
  }
}
