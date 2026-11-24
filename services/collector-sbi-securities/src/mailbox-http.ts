import {
  mailboxBootstrap,
  MailboxError,
  MAILBOX_APPLICATION,
  MAILBOX_ORIGIN,
} from "./mailbox-bootstrap";
import {
  mailboxForm,
  MAILBOX_ENTRY,
  MAILBOX_CONNECT,
  MAILBOX_SSO,
  MAILBOX_BOOTSTRAP,
} from "./mailbox-form";

export const MAILBOX_MAIN_LINK =
  "https://site4.sbisec.co.jp/ETGate/?_ControlID=WPLETsmR001Control&_DataStoreID=DSWPLETsmR001Control&sw_page=Edeliv&cat1=home&cat2=none&getFlg=on";
const MOBILE_LANDING = "https://m.sbisec.co.jp/switchnaviMain";
const CLASSIC_HOST = /^site\d{1,2}\.sbisec\.co\.jp$/u;
/**
 * The delivered-report link on the signed-in classic host the session landed
 * on (`site<n>`, 2026-11-22). Any other host keeps the observed `site4` link.
 */
export function mailboxMainLink(landing: URL | undefined): string {
  if (
    landing === undefined ||
    landing.protocol !== "https:" ||
    !CLASSIC_HOST.test(landing.hostname)
  )
    return MAILBOX_MAIN_LINK;
  const link = new URL(MAILBOX_MAIN_LINK);
  link.hostname = landing.hostname;
  return link.href;
}
/**
 * The main-site report link redirects through the mobile site's one-time
 * `switchnavi?page=Edeliv&parm=...` hand-off before the landing (2026-11-20,
 * docs/sources/sbi-securities.md). Only that exact path and page are admitted
 * as an intermediate hop; a 200 there is still refused.
 */
function mobileHandoff(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.host === "m.sbisec.co.jp" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname === "/switchnavi" &&
    url.searchParams.getAll("page").length === 1 &&
    url.searchParams.get("page") === "Edeliv"
  );
}
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
export type MailboxApi = "summary" | "list" | "detail" | "pdf";
const API_PATHS: Record<MailboxApi, string> = {
  summary: "/dp-uw/v1/DPAW010501030",
  list: "/dp-uw/v1/DPAW010501010",
  detail: "/dp-uw/v1/DPAW010501080",
  pdf: "/dp-uw/v1/DPAW010501020",
};
export interface MailboxCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
}
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type MailboxStep = "landing" | "entry" | "connect" | "sso" | "application" | "api";
/**
 * Where a refusal happened, in closed values only: the step, the redirect hop,
 * the last HTTP status and a known media type, and for a refused redirect a
 * known host and a known route name. Never provider text: no path, query,
 * cookie, form field or body.
 */
interface MailboxDiagnosis {
  step: MailboxStep;
  api?: MailboxApi;
  hop: number;
  status?: number;
  contentType?: (typeof MEDIA_TYPES)[number] | "other";
  refusedHost?: (typeof KNOWN_HOSTS)[number] | "classic" | "other";
  refusedRoute?: string;
  /** Which transport rule refused, when it was one of the navigation's own. */
  reason?: MailboxRefusal;
  /** For a repeated cookie attribute, its name when it is a standard one. */
  cookieAttribute?: (typeof COOKIE_ATTRIBUTES)[number] | "other";
}
/**
 * The navigation's own refusal rules. Each names a rule, never what the
 * provider sent.
 */
type MailboxRefusal =
  | "status"
  | "unexpected-page"
  | "no-location"
  | "bad-location"
  | "redirect-target"
  | "redirect-loop"
  | "post-redirect"
  | "too-many-hops"
  | "request-url"
  | "request-failed"
  | "response-url"
  | "cookie-pair"
  | "cookie-attribute"
  | "cookie-domain"
  | "cookie-path"
  | "cookie-name"
  | "cookie-header";
type CookieRule = Extract<MailboxRefusal, `cookie-${string}`>;
const COOKIE_ATTRIBUTES = [
  "domain",
  "path",
  "secure",
  "httponly",
  "samesite",
  "expires",
  "max-age",
  "partitioned",
] as const;
/** A refused `Set-Cookie`, with the rule and at most a standard attribute name. */
class CookieRefusal extends MailboxError {
  constructor(
    readonly rule: CookieRule,
    readonly attribute?: (typeof COOKIE_ATTRIBUTES)[number] | "other",
  ) {
    super("sbi_mailbox_transport_failed");
  }
}
const MEDIA_TYPES = ["text/html", "application/json", "application/pdf", "text/plain"] as const;
const KNOWN_HOSTS = [
  "site4.sbisec.co.jp",
  "www.sbisec.co.jp",
  "m.sbisec.co.jp",
  "login.sbisec.co.jp",
  "plus.e-shishobako.ne.jp",
] as const;

/** A separate request-local jar; no authorization header is accepted or forwarded. */
export class MailboxHttp {
  private readonly signals = new WeakMap<Response, AbortSignal>();
  private readonly cookies: MailboxCookie[];
  private csrf = "";
  private riyoCd = "";
  private diagnosis: MailboxDiagnosis = { step: "landing", hop: 0 };
  private readonly fetcher: Fetcher;
  constructor(
    cookies: readonly MailboxCookie[],
    fetcher: Fetcher = fetch,
    private readonly deadline = Number.POSITIVE_INFINITY,
    private readonly leaseSignal = new AbortController().signal,
    private readonly mainLink = MAILBOX_MAIN_LINK,
  ) {
    if (mailboxMainLink(new URL(mainLink)) !== mainLink) fail();
    // Called as `this.fetcher(...)`, the Workers runtime's `fetch` throws
    // "Illegal invocation" before any request leaves, so call it unbound.
    this.fetcher = (input, init) => fetcher(input, init);
    this.cookies = cookies.map((cookie) => {
      if (
        !sbiDomain(cookie.domain) ||
        !cookie.path.startsWith("/") ||
        /[\r\n;]/u.test(cookie.name + cookie.value)
      )
        fail();
      return { ...cookie };
    });
  }

  async open(): Promise<void> {
    try {
      await this.opening();
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  /** The closed diagnosis of the latest step, for logs and tests. */
  get lastDiagnosis(): Readonly<MailboxDiagnosis> {
    return { ...this.diagnosis };
  }

  private at(step: MailboxStep, api?: MailboxApi): void {
    this.diagnosis = { step, hop: 0, ...(api === undefined ? {} : { api }) };
  }

  private report(error: unknown): void {
    if (!(error instanceof MailboxError)) return;
    try {
      console.log(
        JSON.stringify({ event: "sbi-mailbox-refused", code: error.code, ...this.diagnosis }),
      );
    } catch {
      /* Logging is best effort. */
    }
  }

  private async opening(): Promise<void> {
    this.at("landing");
    const landing = await this.navigation(
      this.mainLink,
      "GET",
      undefined,
      this.mainLink,
      new Set([MOBILE_LANDING]),
      mobileHandoff,
    );
    await requireHtml(landing);
    await this.read(landing, 256 * 1024);
    this.at("entry");
    const entry = await this.request(MAILBOX_ENTRY, { method: "GET" }, MOBILE_LANDING);
    await requireHtml(entry);
    const entryFields = mailboxForm(await html(entry, this.signals.get(entry)), MAILBOX_ENTRY);
    this.at("connect");
    const connecting = await this.request(
      MAILBOX_CONNECT,
      { method: "POST", body: entryFields },
      MAILBOX_ENTRY,
    );
    await requireHtml(connecting);
    const ssoFields = mailboxForm(
      await html(connecting, this.signals.get(connecting)),
      MAILBOX_CONNECT,
    );
    this.at("sso");
    const bootstrap = await this.navigation(
      MAILBOX_SSO,
      "POST",
      ssoFields,
      MAILBOX_CONNECT,
      new Set([MAILBOX_BOOTSTRAP]),
    );
    await requireHtml(bootstrap);
    const material = mailboxBootstrap(await html(bootstrap, this.signals.get(bootstrap)));
    this.csrf = material.csrf;
    this.riyoCd = material.riyoCd;
    this.at("application");
    const application = await this.request(
      MAILBOX_APPLICATION,
      { method: "GET" },
      MAILBOX_BOOTSTRAP,
    );
    await requireHtml(application);
    // The application is static; it is never executed or stored.
    await this.read(application, 256 * 1024);
  }

  async api(kind: MailboxApi, fields: Readonly<Record<string, string>> = {}): Promise<Uint8Array> {
    this.at("api", kind);
    try {
      return await this.calling(kind, fields);
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  private async calling(
    kind: MailboxApi,
    fields: Readonly<Record<string, string>>,
  ): Promise<Uint8Array> {
    if (!this.csrf || !this.riyoCd) fail();
    const expected =
      kind === "summary" || kind === "list"
        ? []
        : kind === "detail"
          ? ["userTokuteiId", "sCd", "sBaseDate", "sCdSeq"]
          : [
              "userTokuteiId",
              "sCd",
              "sBaseDate",
              "sCdSeq",
              "sTypeCd",
              "sIntFileIds",
              "xmlPreviewFlg",
            ];
    if (
      Object.keys(fields).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(fields, key))
    )
      fail();
    if (kind === "pdf" && fields.xmlPreviewFlg !== "0") fail();
    const body = new URLSearchParams({ _csrf: this.csrf, riyoCd: this.riyoCd, ...fields });
    const response = await this.request(
      new URL(API_PATHS[kind], MAILBOX_ORIGIN).href,
      { method: "POST", body },
      MAILBOX_APPLICATION,
    );
    // The application rotates the header token even on an unsuccessful response.
    const rotated = response.headers.get("x-csrf-token");
    if (rotated !== null) {
      if (!rotated || rotated.length > 8192 || /[\u0000-\u001f\u007f]/u.test(rotated)) {
        await cancel(response);
        fail();
      }
      this.csrf = rotated;
    }
    if (response.status !== 200) {
      await cancel(response);
      fail();
    }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime !== (kind === "pdf" ? "application/pdf" : "application/json")) {
      await cancel(response);
      fail();
    }
    return this.read(response, kind === "pdf" ? 4 * 1024 * 1024 : 2 * 1024 * 1024);
  }

  private async read(response: Response, limit: number): Promise<Uint8Array> {
    try {
      return await readMailboxResponse(response, limit, this.signals.get(response));
    } catch (error) {
      if (this.leaseSignal.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
      if (Date.now() >= this.deadline) bound();
      throw error;
    }
  }

  private async navigation(
    initial: string,
    method: "GET" | "POST",
    body: URLSearchParams | undefined,
    referer: string,
    destinations: ReadonlySet<string>,
    via: (url: URL) => boolean = () => false,
  ): Promise<Response> {
    let current = initial;
    const visited = new Set<string>();
    for (let hop = 0; hop < 5; hop++) {
      // A hop that never answers must not carry the previous hop's answer.
      this.diagnosis.hop = hop;
      delete this.diagnosis.status;
      delete this.diagnosis.contentType;
      if (visited.has(current)) this.refuse("redirect-loop");
      visited.add(current);
      const response = await this.request(
        current,
        { method, ...(body === undefined ? {} : { body }) },
        referer,
      );
      if (response.status === 200) {
        if (!destinations.has(current)) {
          await cancel(response);
          this.refuse("unexpected-page");
        }
        return response;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        await cancel(response);
        this.refuse("status");
      }
      const location = response.headers.get("location");
      if (location === null) {
        await cancel(response);
        this.refuse("no-location");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        await cancel(response);
        this.refuse("bad-location");
      }
      if (!destinations.has(next.href) && !via(next)) {
        this.diagnosis.refusedHost = knownHost(next);
        this.diagnosis.refusedRoute = knownRoute(next);
        await cancel(response);
        this.refuse("redirect-target");
      }
      // Never repeat a secret-bearing POST at a redirect destination.
      if (method === "POST" && (response.status === 307 || response.status === 308)) {
        await cancel(response);
        this.refuse("post-redirect");
      }
      await cancel(response);
      // A one-time hand-off URL is never sent onward as a referer.
      if (!via(new URL(current))) referer = current;
      current = next.href;
      method = "GET";
      body = undefined;
    }
    this.refuse("too-many-hops");
  }

  /** Records which navigation rule refused, then refuses with the one closed code. */
  private refuse(reason: MailboxRefusal): never {
    this.diagnosis.reason = reason;
    fail();
  }

  private async request(
    url: string,
    init: { method: "GET" | "POST"; body?: URLSearchParams },
    referer: string,
  ): Promise<Response> {
    try {
      if (this.leaseSignal.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) bound();
      const target = new URL(url);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.port ||
        target.hash
      )
        this.refuse("request-url");
      const cookie = this.cookies
        .filter((entry) => matches(entry, target))
        .sort((a, b) => b.path.length - a.path.length)
        .map((entry) => `${entry.name}=${entry.value}`)
        .join("; ");
      const signal = AbortSignal.any([
        AbortSignal.timeout(Math.min(30_000, remaining)),
        this.leaseSignal,
      ]);
      const response = await this.fetcher(target, {
        ...init,
        redirect: "manual",
        signal,
        headers: {
          accept: "text/html,application/json,application/pdf",
          "user-agent": USER_AGENT,
          referer,
          ...(cookie ? { cookie } : {}),
          ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
      });
      this.signals.set(response, signal);
      this.diagnosis.status = response.status;
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (mime) this.diagnosis.contentType = MEDIA_TYPES.find((type) => type === mime) ?? "other";
      else delete this.diagnosis.contentType;
      if (this.leaseSignal.aborted) {
        await cancel(response);
        throw new MailboxError("sbi_mailbox_lease_lost");
      }
      if (response.redirected || (response.url && response.url !== target.href)) {
        await cancel(response);
        this.refuse("response-url");
      }
      try {
        updateMailboxCookies(this.cookies, response.headers, target);
      } catch (error) {
        await cancel(response);
        if (error instanceof CookieRefusal && error.attribute !== undefined)
          this.diagnosis.cookieAttribute = error.attribute;
        this.refuse(error instanceof CookieRefusal ? error.rule : "cookie-header");
      }
      return response;
    } catch (error) {
      if (this.leaseSignal.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
      if (error instanceof MailboxError) throw error;
      if (Date.now() >= this.deadline) bound();
      this.refuse("request-failed");
    }
  }
}

/** Check the actual stream as well as Content-Length before buffering. */
export async function readMailboxResponse(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null || Number(response.headers.get("content-length")) > limit) {
    await cancel(response);
    bound();
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal?.aborted) fail();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        try {
          await reader.cancel();
        } catch {
          /* Retain the closed bound code. */
        }
        bound();
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    fail();
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function updateMailboxCookies(jar: MailboxCookie[], headers: Headers, origin: URL): void {
  for (const header of headers.getSetCookie()) {
    const pieces = header.split(";").map((piece) => piece.trim());
    const pair = pieces.shift()!;
    const equal = pair.indexOf("=");
    if (equal <= 0 || /[\r\n]/u.test(pair)) throw new CookieRefusal("cookie-pair");
    const attrs = new Map<string, string>();
    for (const piece of pieces) {
      const split = piece.indexOf("=");
      const name = (split < 0 ? piece : piece.slice(0, split)).toLowerCase();
      const value = split < 0 ? "" : piece.slice(split + 1);
      // A repeat that says the same thing is not ambiguous: the mobile hand-off
      // repeats `HttpOnly` (2026-11-24). A repeat with another value is refused.
      if (attrs.get(name) === value) continue;
      if (attrs.has(name))
        throw new CookieRefusal(
          "cookie-attribute",
          COOKIE_ATTRIBUTES.find((known) => known === name) ?? "other",
        );
      attrs.set(name, value);
    }
    const requestedDomain = attrs.get("domain")?.replace(/^\./u, "").toLowerCase();
    const domain = requestedDomain ?? origin.hostname;
    if (
      (!sbiDomain(domain) &&
        domain !== "e-shishobako.ne.jp" &&
        domain !== "plus.e-shishobako.ne.jp") ||
      (origin.hostname !== domain && !origin.hostname.endsWith(`.${domain}`))
    )
      throw new CookieRefusal("cookie-domain");
    const lastSlash = origin.pathname.lastIndexOf("/");
    const path = attrs.get("path") ?? (lastSlash <= 0 ? "/" : origin.pathname.slice(0, lastSlash));
    if (!path.startsWith("/")) throw new CookieRefusal("cookie-path");
    const name = pair.slice(0, equal);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) throw new CookieRefusal("cookie-name");
    const value = pair.slice(equal + 1);
    const existing = jar.findIndex(
      (cookie) => cookie.name === name && cookie.domain === domain && cookie.path === path,
    );
    if (existing >= 0) jar.splice(existing, 1);
    const age = attrs.get("max-age");
    const expires = attrs.get("expires");
    if (
      (age !== undefined && (!/^-?\d+$/u.test(age) || Number(age) <= 0)) ||
      (age === undefined && expires !== undefined && Date.parse(expires) <= Date.now()) ||
      !value
    )
      continue;
    jar.push({
      name,
      value,
      domain,
      path,
      hostOnly: requestedDomain === undefined,
      secure: attrs.has("secure"),
    });
  }
}

function matches(cookie: MailboxCookie, url: URL): boolean {
  return (
    (cookie.hostOnly
      ? url.hostname === cookie.domain
      : url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`)) &&
    (url.pathname === cookie.path ||
      url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)) &&
    (!cookie.secure || url.protocol === "https:")
  );
}
function knownHost(url: URL): (typeof KNOWN_HOSTS)[number] | "classic" | "other" {
  return (
    KNOWN_HOSTS.find((host) => host === url.hostname) ??
    (CLASSIC_HOST.test(url.hostname) ? "classic" : "other")
  );
}
/** The flow's own routes by name; any other origin and path is `other`. */
const KNOWN_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["main-link", MAILBOX_MAIN_LINK],
  ["handoff", "https://m.sbisec.co.jp/switchnavi"],
  ["landing", MOBILE_LANDING],
  ["entry", MAILBOX_ENTRY],
  ["connect", MAILBOX_CONNECT],
  ["sso", MAILBOX_SSO],
  ["bootstrap", MAILBOX_BOOTSTRAP],
  ["application", MAILBOX_APPLICATION],
  ...Object.entries(API_PATHS).map(
    ([kind, path]) => [`api-${kind}`, new URL(path, MAILBOX_ORIGIN).href] as const,
  ),
].map(([name, href]) => {
  const url = new URL(href);
  return [name, `${url.origin}${url.pathname}`] as const;
});
function knownRoute(url: URL): string {
  if (url.protocol === "https:" && CLASSIC_HOST.test(url.hostname) && url.pathname === "/ETGate/")
    return "main-link";
  const route = `${url.origin}${url.pathname}`;
  return KNOWN_ROUTES.find(([, known]) => known === route)?.[0] ?? "other";
}
function sbiDomain(domain: string): boolean {
  return domain === "sbisec.co.jp" || domain.endsWith(".sbisec.co.jp");
}
async function requireHtml(response: Response): Promise<void> {
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/html"
  ) {
    await cancel(response);
    fail();
  }
}
async function html(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    const bytes = await readMailboxResponse(response, 256 * 1024, signal);
    const header = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(
      response.headers.get("content-type") ?? "",
    )?.[1];
    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 4096));
    const declared = /<meta\b[^>]*\bcharset\s*=\s*["']?([^;\s"'/>]+)/iu.exec(head)?.[1];
    const encoding = (header ?? declared ?? "utf-8").toLowerCase();
    if (!["utf-8", "utf8", "shift_jis", "shift-jis", "windows-31j"].includes(encoding)) fail();
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}
function fail(): never {
  throw new MailboxError("sbi_mailbox_transport_failed");
}
function bound(): never {
  throw new MailboxError("sbi_mailbox_response_bound");
}
async function cancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Refusal must not expose transport exceptions. */
  }
}
