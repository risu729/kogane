import iconv from "iconv-lite";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  MizuhoParseError,
  parseAccountPage,
  parseHistoryPage,
  sanitizeMizuhoPage,
} from "../../../packages/parsers/src/parsers/mizuho-html";

type Node = DefaultTreeAdapterMap["node"];
type Account = ReturnType<typeof parseAccountPage>["accounts"][number];
type History = ReturnType<typeof parseHistoryPage>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
const ACCOUNT_ROUTE = "/servlet/MENSRV0100002B.do";
const HISTORY_ROUTE = "/servlet/BALINQ0301002B.do";
const HISTORY_PERIOD_ROUTE = "/servlet/ACCHST0411009B.do";
const CORE = ["_FRAMEID", "_TARGETID", "_LUID", "_TOKEN", "_FORMID", "_SUBINDEX", "POSTKEY"];
const FIELDS = new Set([
  ...CORE,
  "CLIENT_ENV",
  "lstDateFromDay",
  "lstDateFromMonth",
  "lstDateFromYear",
  "lstDateToDay",
  "lstDateToMonth",
  "lstDateToYear",
  "rdoPopDate",
  "rdoPopDaw",
  "txbSearchWord",
  "txtEndOfLastMonth",
  "txtLast7Days",
  "txtStartOfLastMonth",
  "txtStartOfThisMonth",
  "txtThisDay",
]);
const FORM_NAMES = new Set(["MENTOP_02000B", "BALINQ_03010B", "ACCHST_04110B"]);
const REDIRECT_FIELDS = new Set([
  "REQTYPE",
  "_FRAMEID",
  "_TARGETID",
  "_LUID",
  "_TOKEN",
  "_SUBINDEX",
]);
const MAX_BYTES = 1024 * 1024;

export interface MizuhoFormState {
  name: string;
  fields: Record<string, string>;
}
/** Private session material supplied by its owner; never log or persist unencrypted. */
export interface MizuhoSession {
  origin: string;
  cookies: string;
  userAgent: string;
  referer: string;
  form: MizuhoFormState;
}
export interface MizuhoCollection {
  accounts: Account[];
  histories: History[];
  partial: boolean;
  issues: string[];
  failedUnits: string[];
  /** The closed code that stopped each failed unit, keyed by its unit key. */
  failedUnitCodes: Record<string, string>;
  artifacts: MizuhoArtifact[];
  session: MizuhoSession;
}
export interface MizuhoArtifact {
  artifactKey: string;
  unitKey: string;
  dataset:
    | "mizuho-account-list-html"
    | "mizuho-ordinary-history-html"
    | "mizuho-ordinary-history-unparsed-html";
  body: string;
  mediaType: "text/html";
  partial: boolean;
}
export const MIZUHO_CLIENT_ERROR_CODES = [
  "mizuho-credentials-missing",
  "invalid-login-credentials",
  "login-required",
  "login-challenge-required",
  "login-unrecognized-page",
  "login-redirect-rejected",
  "login-timeout",
  "login-network-error",
  "login-http-error",
  "invalid-session-origin",
  "invalid-session-referer",
  "invalid-form-state",
  "response-too-large",
  "authentication-required",
  "unrecognized-form",
  "unexpected-form-control",
  "duplicate-form-control",
  "unencodable-form-state",
  "invalid-session-cookies",
  "invalid-session-cookie-update",
  "unsupported-session-cookie-path",
  "read-redirect-rejected",
  "invalid-collection-limits",
  "invalid-session",
  "invalid-session-json",
  "collection-timeout",
  "invalid-history-transition",
  "invalid-history-period",
  "read-network-error",
  "read-http-error",
  "unexpected-response-type",
  "empty-response",
  "unexpected-read-page",
  "account-list-changed",
  "invalid-account-read-event",
  "read-parse-error",
  "internal-error",
] as const;
export const MIZUHO_LOGIN_CHECKS = [
  "form-count",
  "field-value",
  "missing-token",
  "credential-controls",
  "entry-base",
  "post-login-form",
] as const;
export const MIZUHO_LOGIN_FORMS = [
  "LOGBNK_00000B",
  "LOGBNK_00005B",
  "LOGCNF_02400B",
  "MENTOP_02000B",
] as const;
export const MIZUHO_HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
export interface MizuhoLoginDiagnostic {
  loginCheck: (typeof MIZUHO_LOGIN_CHECKS)[number];
  httpStatusClass: (typeof MIZUHO_HTTP_STATUS_CLASSES)[number];
  expectedForm: (typeof MIZUHO_LOGIN_FORMS)[number];
}
export class MizuhoClientError extends Error {
  constructor(
    readonly code: string,
    readonly loginDiagnostic?: MizuhoLoginDiagnostic,
  ) {
    super(code);
    this.name = "MizuhoClientError";
  }
}
/**
 * Every code `parseAccountPage`, `parseHistoryPage` and `sanitizeMizuhoPage`
 * throw (packages/parsers/src/parsers/mizuho-html.ts). Kept here, not in the
 * parser, so the parser's code digest and version stay unchanged; a code the
 * parser gains later reads `internal-error` until it is listed.
 */
export const MIZUHO_HTML_ERROR_CODES = [
  "account-mismatch",
  "authentication-required",
  "conflicting-responsive-balances",
  "duplicate-account",
  "duplicate-row-index",
  "inconsistent-row-count",
  "invalid-account-context",
  "invalid-account-identifier",
  "invalid-amount-column",
  "invalid-count",
  "invalid-displayed-range",
  "invalid-html-size",
  "invalid-row-index",
  "invalid-text",
  "invalid-transaction-currency",
  "invalid-transaction-date",
  "invalid-yen-amount",
  "missing-or-duplicate-balance",
  "missing-or-duplicate-field",
  "unrecognized-empty-state",
  "unrecognized-page",
  "unsupported-account-kind",
  "unsupported-transaction-currency",
] as const;
/**
 * A page check the shared Mizuho HTML parser refused, as `parse-<its code>`:
 * the parser's own closed code, so a refused page names the check instead of
 * one `read-parse-error` for all of them.
 */
export const MIZUHO_PARSE_ERROR_CODES = MIZUHO_HTML_ERROR_CODES.map(
  (code) => `parse-${code}` as const,
);
export function safeMizuhoErrorCode(error: unknown): string {
  if (
    error instanceof MizuhoClientError &&
    (MIZUHO_CLIENT_ERROR_CODES as readonly string[]).includes(error.code)
  )
    return error.code;
  if (
    error instanceof MizuhoParseError &&
    (MIZUHO_HTML_ERROR_CODES as readonly string[]).includes(error.code)
  )
    return `parse-${error.code}`;
  return "internal-error";
}
function fail(code: string): never {
  throw new MizuhoClientError(code);
}
function attr(node: Node, name: string): string | undefined {
  return "attrs" in node ? node.attrs.find((a) => a.name === name)?.value : undefined;
}
function descendants(node: Node): Node[] {
  const pending = [node],
    result: Node[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    result.push(current);
    if ("childNodes" in current) pending.push(...[...current.childNodes].reverse());
  }
  return result;
}
function tag(node: Node): string | undefined {
  return "tagName" in node ? node.tagName : undefined;
}
function officialOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("invalid-session-origin");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !/^web\d*\.ib\.mizuhobank\.co\.jp$/u.test(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail("invalid-session-origin");
  return url.origin;
}
function privateUrl(input: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("invalid-session-referer");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/servlet\/[A-Z]{6}\d{7}[A-Z](?:AJAX)?\.do$/u.test(url.pathname)
  )
    fail("invalid-session-referer");
  return url.href;
}
function validateForm(form: MizuhoFormState): void {
  if (!form || !FORM_NAMES.has(form.name) || !form.fields || typeof form.fields !== "object")
    fail("invalid-form-state");
  if (
    CORE.some((key) => typeof form.fields[key] !== "string") ||
    form.fields._FORMID !== form.name ||
    !form.fields._FRAMEID ||
    !form.fields._TOKEN ||
    !form.fields.POSTKEY
  )
    fail("invalid-form-state");
  if (
    Object.entries(form.fields).some(
      ([key, value]) =>
        !FIELDS.has(key) ||
        typeof value !== "string" ||
        value.length > 8192 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    )
  )
    fail("invalid-form-state");
  if (JSON.stringify(form.fields).length > 64 * 1024) fail("invalid-form-state");
}
/** Extract only successful controls needed to reproduce an already observed read event. */
export function extractMizuhoForm(html: string): MizuhoFormState {
  if (html.length > MAX_BYTES) fail("response-too-large");
  const all = descendants(parse(html));
  const forms = all.filter((node) => tag(node) === "form");
  if (forms.some((node) => /^LOG/u.test(attr(node, "name") ?? ""))) fail("authentication-required");
  if (forms.length !== 1) fail("unrecognized-form");
  const node = forms[0]!;
  const name = attr(node, "name") ?? "";
  const fields: Record<string, string> = {};
  for (const field of descendants(node)) {
    const fieldTag = tag(field);
    if (
      !["input", "select", "textarea", "button"].includes(fieldTag ?? "") ||
      attr(field, "disabled") !== undefined
    )
      continue;
    const key = attr(field, "name");
    if (!key) continue;
    const type = (attr(field, "type") ?? (fieldTag === "button" ? "submit" : "text")).toLowerCase();
    if (["submit", "reset", "button", "image"].includes(type)) continue;
    if (!FIELDS.has(key) || type === "password" || type === "file" || fieldTag === "textarea")
      fail("unexpected-form-control");
    if ((type === "radio" || type === "checkbox") && attr(field, "checked") === undefined) continue;
    let value = attr(field, "value") ?? (type === "radio" || type === "checkbox" ? "on" : "");
    if (fieldTag === "select") {
      if (attr(field, "multiple") !== undefined) fail("unexpected-form-control");
      const options = descendants(field).filter(
        (n) => tag(n) === "option" && attr(n, "disabled") === undefined,
      );
      const selected = options.filter((n) => attr(n, "selected") !== undefined);
      if (selected.length > 1) fail("unexpected-form-control");
      const option = selected[0] ?? options[0];
      if (!option || attr(option, "value") === undefined) fail("unexpected-form-control");
      value = attr(option, "value")!;
    }
    if (Object.hasOwn(fields, key)) fail("duplicate-form-control");
    fields[key] = value;
  }
  const result = { name, fields };
  validateForm(result);
  return result;
}
export function encodeForm(fields: Record<string, string>): string {
  const encode = (value: string) => {
    const bytes = iconv.encode(value, "shift_jis");
    if (iconv.decode(bytes, "shift_jis") !== value) fail("unencodable-form-state");
    return [...bytes]
      .map((b) =>
        /[A-Za-z0-9*._-]/u.test(String.fromCharCode(b))
          ? String.fromCharCode(b)
          : b === 32
            ? "+"
            : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join("");
  };
  return Object.entries(fields)
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}
function accountReadIndexes(html: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const card of descendants(parse(html)).filter((node) =>
    (attr(node, "class") ?? "").split(/\s+/u).includes("btn-account"),
  )) {
    const identifiers = descendants(card)
      .map((node) => attr(node, "id") ?? "")
      .filter((id) => /^txtAccType_\d{3}$/u.test(id));
    const event = /doTransaction\(\s*['"]\/BALINQ0301002B['"]\s*,\s*['"](0|[1-9]\d{0,2})['"]/u.exec(
      attr(card, "onclick") ?? "",
    );
    const index = identifiers[0]?.slice("txtAccType_".length);
    if (
      identifiers.length !== 1 ||
      !index ||
      !event ||
      Number(index) !== Number(event[1]) ||
      result.has(index)
    )
      fail("invalid-account-read-event");
    result.set(index, event[1]!);
  }
  return result;
}
function cookieMap(header: string): Map<string, string> {
  if (
    typeof header !== "string" ||
    !header ||
    header.length > 32 * 1024 ||
    /[^\x20-\x7e]/u.test(header)
  )
    fail("invalid-session-cookies");
  const result = new Map<string, string>();
  for (const part of header.split(";")) {
    const match = /^\s*([!#$%&'*+.^_`|~A-Za-z0-9-]+)=([^;]*)$/u.exec(part);
    if (!match || result.has(match[1]!)) fail("invalid-session-cookies");
    result.set(match[1]!, match[2]!);
  }
  return result;
}
/** Strict secret JSON validation, without accepting passwords or captured HTML artifacts. */
export function parseSession(value: string): MizuhoSession {
  let input: MizuhoSession;
  try {
    if (typeof value !== "string" || value.length > 128 * 1024) fail("invalid-session-json");
    input = JSON.parse(value) as MizuhoSession;
  } catch {
    return fail("invalid-session-json");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["origin", "cookies", "userAgent", "referer", "form"].includes(key),
    ) ||
    !input.form ||
    typeof input.form !== "object" ||
    Array.isArray(input.form) ||
    Object.keys(input.form).some((key) => !["name", "fields"].includes(key)) ||
    typeof input.userAgent !== "string" ||
    !input.userAgent ||
    input.userAgent.length > 1024 ||
    /[^\x20-\x7e]/u.test(input.userAgent)
  )
    fail("invalid-session-json");
  const origin = officialOrigin(input.origin);
  const referer = privateUrl(input.referer, origin);
  validateForm(input.form);
  cookieMap(input.cookies);
  return {
    origin,
    cookies: input.cookies,
    userAgent: input.userAgent,
    referer,
    form: { name: input.form.name, fields: { ...input.form.fields } },
  };
}
export function absorbCookies(
  cookies: Map<string, string>,
  response: Response,
  origin: string,
): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const combined = response.headers.get("set-cookie");
  const values =
    headers.getSetCookie?.() ?? (combined ? combined.split(/,(?=\s*[^;,=\s]+=)/u) : []);
  const host = new URL(origin).hostname;
  for (const value of values) {
    const [pair, ...parts] = value.split(";");
    const match = /^\s*([!#$%&'*+.^_`|~A-Za-z0-9-]+)=([^;\r\n]*)$/u.exec(pair ?? "");
    if (!match) fail("invalid-session-cookie-update");
    const attrs = new Map(
      parts.map((part) => {
        const [key, ...rest] = part.trim().split("=");
        return [key!.toLowerCase(), rest.join("=")] as const;
      }),
    );
    const domain = (attrs.get("domain") ?? host).replace(/^\./u, "").toLowerCase();
    if (
      !(host === domain || host.endsWith(`.${domain}`)) ||
      ![host, "ib.mizuhobank.co.jp", "mizuhobank.co.jp"].includes(domain)
    )
      fail("invalid-session-cookie-update");
    if (attrs.has("path") && !["/", "/servlet", "/servlet/"].includes(attrs.get("path")!))
      fail("unsupported-session-cookie-path");
    const age = attrs.get("max-age");
    if (
      match[2] === "" ||
      (age !== undefined && /^-?\d+$/u.test(age) && Number(age) <= 0) ||
      (age === undefined && attrs.has("expires") && Date.parse(attrs.get("expires")!) <= Date.now())
    )
      cookies.delete(match[1]!);
    else cookies.set(match[1]!, match[2]!);
  }
}
function redirectUrl(location: string | null, target: string, origin: string): string {
  if (!location) fail("read-redirect-rejected");
  let next: URL;
  try {
    next = new URL(location, target);
  } catch {
    return fail("read-redirect-rejected");
  }
  const names = [...next.searchParams.keys()];
  if (
    next.origin !== origin ||
    next.username ||
    next.password ||
    next.hash ||
    next.pathname !== new URL(target).pathname ||
    names.length !== REDIRECT_FIELDS.size ||
    names.some((key) => !REDIRECT_FIELDS.has(key)) ||
    new Set(names).size !== names.length
  )
    fail("read-redirect-rejected");
  return next.href;
}

/** Use the bank's query-day control, never a transaction date or caller-supplied window. */
function retainedHistoryFields(form: MizuhoFormState): Record<string, string> {
  const value = form.fields.txtThisDay;
  if (form.name !== "ACCHST_04110B" || !value || !/^\d{8}$/u.test(value))
    fail("invalid-history-period");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const end = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 ||
    end.getUTCFullYear() !== year ||
    end.getUTCMonth() + 1 !== month ||
    end.getUTCDate() !== day
  )
    fail("invalid-history-period");
  // The observed selector exposes this month and the preceding two calendar months.
  const start = new Date(Date.UTC(year, month - 3, 1));
  return {
    rdoPopDate: "4",
    rdoPopDaw: "0",
    txbSearchWord: "",
    lstDateFromYear: String(start.getUTCFullYear()),
    lstDateFromMonth: String(start.getUTCMonth() + 1),
    lstDateFromDay: "1",
    lstDateToYear: String(year),
    lstDateToMonth: String(month),
    lstDateToDay: String(day),
  };
}
function matchesHistoryPeriod(form: MizuhoFormState, fields: Record<string, string>): boolean {
  return Object.entries(fields).every(([key, value]) => form.fields[key] === value);
}

/** No login, retries, export/download, guessed pagination, or bank-write endpoints. */
export async function collectMizuho(options: {
  session: MizuhoSession;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxAccounts?: number;
  onPhase?: (phase: "account-list" | "history") => void;
}): Promise<MizuhoCollection> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxAccounts = options.maxAccounts ?? 10;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !Number.isInteger(maxAccounts) ||
    maxAccounts < 1 ||
    maxAccounts > 25
  )
    fail("invalid-collection-limits");
  const input = options.session;
  if (
    !input ||
    typeof input.userAgent !== "string" ||
    !input.userAgent ||
    input.userAgent.length > 1024 ||
    /[\r\n]/u.test(input.userAgent)
  )
    fail("invalid-session");
  const origin = officialOrigin(input.origin);
  let referer = privateUrl(input.referer, origin);
  validateForm(input.form);
  let state: MizuhoFormState = { name: input.form.name, fields: { ...input.form.fields } };
  const cookies = cookieMap(input.cookies);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new MizuhoClientError("collection-timeout"));
    }, timeoutMs);
  });
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  async function request(
    route: typeof ACCOUNT_ROUTE | typeof HISTORY_ROUTE | typeof HISTORY_PERIOD_ROUTE,
    index = "",
    periodFields?: Record<string, string>,
  ): Promise<string> {
    if (controller.signal.aborted) fail("collection-timeout");
    if (
      route === HISTORY_ROUTE &&
      (state.name !== "BALINQ_03010B" || !/^(0|[1-9]\d{0,2})$/u.test(index))
    )
      fail("invalid-history-transition");
    if (
      route === HISTORY_PERIOD_ROUTE &&
      (state.name !== "ACCHST_04110B" || index !== "" || !periodFields)
    )
      fail("invalid-history-transition");
    const fields = {
      ...state.fields,
      ...(route === HISTORY_PERIOD_ROUTE ? periodFields : {}),
      _SUBINDEX: index,
      _TARGETID: state.fields._FRAMEID!,
    };
    const target = origin + route;
    let url = target;
    let body: string | undefined = encodeForm(fields);
    for (let step = 0; step < 2; step++) {
      const headers: Record<string, string> = {
        accept: "text/html",
        "accept-language": "ja,en;q=0.8",
        "user-agent": input.userAgent,
        cookie: cookieHeader(),
        referer,
      };
      if (body !== undefined) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        headers.origin = origin;
      }
      let response: Response;
      try {
        response = await fetcher(url, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch {
        return fail(controller.signal.aborted ? "collection-timeout" : "read-network-error");
      }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        fail("collection-timeout");
      }
      absorbCookies(cookies, response, origin);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (step !== 0 || ![302, 303].includes(response.status)) fail("read-redirect-rejected");
        url = redirectUrl(response.headers.get("location"), target, origin);
        body = undefined;
        continue;
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        fail([401, 403].includes(response.status) ? "authentication-required" : "read-http-error");
      }
      if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
        void response.body?.cancel().catch(() => {});
        fail("unexpected-response-type");
      }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        void response.body?.cancel().catch(() => {});
        fail("response-too-large");
      }
      reader = response.body?.getReader();
      if (!reader) fail("empty-response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const item = await reader.read();
        if (controller.signal.aborted) fail("collection-timeout");
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_BYTES) {
          void reader.cancel().catch(() => {});
          fail("response-too-large");
        }
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const html = iconv.decode(bytes, "shift_jis");
      state = extractMizuhoForm(html);
      if (state.name !== (route === ACCOUNT_ROUTE ? "BALINQ_03010B" : "ACCHST_04110B"))
        fail("unexpected-read-page");
      referer = url;
      return html;
    }
    return fail("read-redirect-rejected");
  }
  const snapshot = (): MizuhoSession => ({
    origin,
    cookies: cookieHeader(),
    userAgent: input.userAgent,
    referer,
    form: { name: state.name, fields: { ...state.fields } },
  });
  const artifacts: MizuhoArtifact[] = [];
  const accounts: Account[] = [];
  const histories: History[] = [];
  const issues: string[] = [];
  const failedUnits: string[] = [];
  const failedUnitCodes: Record<string, string> = {};
  const unit = (account: Account) => `ordinary:${account.branchCode}:${account.accountNumber}`;
  const failUnits = (units: string[], code: string) => {
    for (const key of units) {
      failedUnits.push(key);
      failedUnitCodes[key] ??= code;
    }
  };
  const result = (): MizuhoCollection => ({
    accounts,
    histories,
    artifacts,
    partial: issues.length > 0,
    issues: [...new Set(issues)],
    failedUnits: [...new Set(failedUnits)],
    failedUnitCodes: { ...failedUnitCodes },
    session: snapshot(),
  });
  async function run(): Promise<MizuhoCollection> {
    options.onPhase?.("account-list");
    const accountRawHtml = await request(ACCOUNT_ROUTE);
    const accountHtml = sanitizeMizuhoPage(accountRawHtml);
    accounts.push(...parseAccountPage(accountHtml).accounts);
    artifacts.push({
      artifactKey: "account-list.html",
      unitKey: "account-list",
      dataset: "mizuho-account-list-html",
      body: accountHtml,
      mediaType: "text/html",
      partial: false,
    });
    let readIndexes = accountReadIndexes(accountRawHtml);
    if (accounts.length > maxAccounts) {
      issues.push("account-limit");
      failUnits(accounts.slice(maxAccounts).map(unit), "account-limit");
    }
    for (const account of accounts.slice(0, maxAccounts)) {
      if (histories.length) {
        options.onPhase?.("account-list");
        const currentHtml = await request(ACCOUNT_ROUTE);
        const current = parseAccountPage(currentHtml).accounts;
        readIndexes = accountReadIndexes(currentHtml);
        const rediscovered = current.find(
          (a) => a.branchCode === account.branchCode && a.accountNumber === account.accountNumber,
        );
        if (!rediscovered || rediscovered.branchName !== account.branchName)
          fail("account-list-changed");
        account.sourceIndex = rediscovered.sourceIndex;
      }
      const readIndex = readIndexes.get(account.sourceIndex);
      if (readIndex === undefined) fail("invalid-account-read-event");
      options.onPhase?.("history");
      let rawHistory = await request(HISTORY_ROUTE, readIndex);
      const periodFields = retainedHistoryFields(state);
      // Reuse a page only when its echoed controls already cover the entire observed window.
      if (!matchesHistoryPeriod(state, periodFields))
        rawHistory = await request(HISTORY_PERIOD_ROUTE, "", periodFields);
      if (
        !matchesHistoryPeriod(state, periodFields) ||
        !Object.entries(retainedHistoryFields(state)).every(
          ([key, value]) => periodFields[key] === value,
        )
      )
        fail("invalid-history-period");
      const html = sanitizeMizuhoPage(rawHistory);
      const prefix = `ordinary/${account.branchCode}-${account.accountNumber}`;
      let history: History;
      try {
        history = parseHistoryPage(html, account);
      } catch (error) {
        // Keep the sanitized page the collector could not read (raw first):
        // no parser accepts this key, so nothing is published from it; it is
        // kept for inspection and as a fixture for a parser fix. The account's history unit
        // still fails below. A page that does not sanitize to itself again
        // (misnested forms) is not kept: the run plan refuses such an
        // artifact, which would lose the whole partial run.
        if (sanitizeMizuhoPage(html) === html)
          artifacts.push({
            artifactKey: `${prefix}/history/unparsed.html`,
            unitKey: `${unit(account)}:page:unparsed`,
            dataset: "mizuho-ordinary-history-unparsed-html",
            body: html,
            mediaType: "text/html",
            partial: true,
          });
        throw error;
      }
      histories.push(history);
      // The observed empty page (no transaction block) is one complete page
      // with no rows; it is stored under `page:empty`, which only the empty
      // state parses from, never under an invented range.
      const partialPage =
        history.state === "listed" && (history.hasMore || history.displayedRange.from !== 1);
      if (partialPage) issues.push("history-pagination-unverified");
      const page =
        history.state === "empty"
          ? { key: "empty", unit: "empty" }
          : {
              key: `${history.displayedRange.from}-${history.displayedRange.to}`,
              unit: `${history.displayedRange.from}:${history.displayedRange.to}`,
            };
      artifacts.push({
        artifactKey: `${prefix}/history/${page.key}.html`,
        unitKey: `${unit(account)}:page:${page.unit}`,
        dataset: "mizuho-ordinary-history-html",
        body: html,
        mediaType: "text/html",
        partial: partialPage,
      });
    }
    return result();
  }
  try {
    return await Promise.race([run(), deadline]);
  } catch (error) {
    const code = controller.signal.aborted ? "collection-timeout" : safeMizuhoErrorCode(error);
    if (accounts.length) {
      issues.push(code);
      failUnits(
        accounts
          .filter(
            (a) =>
              !histories.some(
                (h) => h.branchCode === a.branchCode && h.accountNumber === a.accountNumber,
              ),
          )
          .map(unit),
        code,
      );
      return result();
    }
    return fail(code);
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
