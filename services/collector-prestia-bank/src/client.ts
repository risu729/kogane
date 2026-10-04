import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  parsePrestiaBankBalancePage,
  sanitizePrestiaBankPage,
} from "../../../packages/parsers/src/parsers/prestia-bank-html";

type Node = DefaultTreeAdapterMap["node"];
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
const LOGIN_ORIGIN = "https://mlogin.smbctb.co.jp";
const READ_ORIGIN = "https://mobile.smbctb.co.jp";
const BOOTSTRAP = "/ib/portal/POSNIN1prestiatop.prst?LOCALE=ja_JP";
const LOGIN = "/ib/portal/POSNIN1next.prst";
const BALANCE = "/ib/top/TOMETOPaccountinfokozazandaka.prst";
const SIGNOFF = "/ib/top/TOMETOPportalsignoff.prst";
const MAX_BYTES = 1024 * 1024;
const CORE = ["_FRAMEID", "_TARGETID", "_LUID", "_TOKEN", "_FORMID", "_SUBINDEX", "LOCALE"];
// Derived Android WebView profile used by the successful local HTTP trial;
// this is not a claim that a Worker's TLS stack equals Android's.
export const PRESTIA_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; XIG03 Build/AQ3A.240912.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.36 Mobile Safari/537.36";
export const PRESTIA_ERROR_CODES = [
  "credentials-missing",
  "invalid-credentials",
  "invalid-user-agent",
  "login-http-error",
  "login-rejected",
  "login-challenge-required",
  "login-page-unknown",
  "response-too-large",
  "response-type-unknown",
  "response-encoding-unknown",
  "network-error",
  "request-timeout",
  "redirect-rejected",
  "invalid-form-state",
  "invalid-cookie-update",
  "balance-http-error",
  "balance-page-unknown",
  "balance-parse-error",
] as const;
export class PrestiaBankError extends Error {
  constructor(readonly code: (typeof PRESTIA_ERROR_CODES)[number]) {
    super(code);
    this.name = "PrestiaBankError";
  }
}
export function safePrestiaBankError(error: unknown): string {
  return error instanceof PrestiaBankError &&
    (PRESTIA_ERROR_CODES as readonly string[]).includes(error.code)
    ? error.code
    : "balance-parse-error";
}
function fail(code: (typeof PRESTIA_ERROR_CODES)[number]): never {
  throw new PrestiaBankError(code);
}
function nodes(node: Node): Node[] {
  return [node, ...("childNodes" in node ? node.childNodes.flatMap(nodes) : [])];
}
function attr(node: Node, key: string): string | undefined {
  return "attrs" in node ? node.attrs.find((a) => a.name === key)?.value : undefined;
}
function tag(node: Node): string | undefined {
  return "tagName" in node ? node.tagName : undefined;
}
export function extractPrestiaForm(
  html: string,
  name: "POSNIN1" | "POMHTOP" | "ACKZDSP",
): Record<string, string> {
  if (html.length > MAX_BYTES) return fail("response-too-large");
  const forms = nodes(parse(html)).filter((n) => tag(n) === "form" && attr(n, "name") === name);
  if (forms.length !== 1) return fail("invalid-form-state");
  const fields: Record<string, string> = {};
  for (const input of nodes(forms[0]!).filter(
    (n) => tag(n) === "input" && attr(n, "type") === "hidden",
  )) {
    const key = attr(input, "name"),
      value = attr(input, "value") ?? "";
    if (
      !key ||
      (!CORE.includes(key) && key !== "hashedCIF") ||
      Object.hasOwn(fields, key) ||
      value.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      return fail("invalid-form-state");
    fields[key] = value;
  }
  if (
    CORE.some((k) => !Object.hasOwn(fields, k)) ||
    fields._FORMID !== name ||
    !fields._TOKEN ||
    fields.LOCALE !== "ja_JP"
  )
    return fail("invalid-form-state");
  return fields;
}
function formPresent(html: string, name: string): boolean {
  return nodes(parse(html)).some((n) => tag(n) === "form" && attr(n, "name") === name);
}
function hasProviderError(html: string): boolean {
  return nodes(parse(html)).some(
    (n) =>
      ["errorMsgArea", "dispErrorMsgArea"].includes(attr(n, "id") ?? "") &&
      nodes(n).some((t) => "value" in t && t.value.trim() !== ""),
  );
}
async function boundedHtml(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) return fail("response-too-large");
  if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? ""))
    return fail("response-type-unknown");
  if (!response.body) return fail("response-type-unknown");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let aborted: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      let part: Awaited<ReturnType<typeof reader.read>>;
      try {
        part = await Promise.race([reader.read(), deadline]);
      } finally {
        if (aborted) signal.removeEventListener("abort", aborted);
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) return fail("response-too-large");
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof PrestiaBankError) throw error;
    return fail(signal.aborted ? "request-timeout" : "network-error");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("response-encoding-unknown");
  }
}
export interface PrestiaBankCollection {
  body: string;
  accountCount: number;
  foreignCurrencyCount: number;
  aggregateCount: number;
  monthlyAverageCount: number;
  signoffFailed: boolean;
}
/** One password POST; fixed read-only routes; private session exists only in this invocation. */
export async function collectPrestiaBank(
  input: { userId: string; password: string; userAgent?: string },
  fetcher: Fetcher = fetch,
): Promise<PrestiaBankCollection> {
  if (!input.userId || !input.password) return fail("credentials-missing");
  if (
    input.userId.length > 50 ||
    input.password.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input.userId + input.password)
  )
    return fail("invalid-credentials");
  const userAgent = input.userAgent ?? PRESTIA_USER_AGENT;
  if (!userAgent || userAgent.length > 1024 || /[\u0000-\u001f\u007f]/u.test(userAgent))
    return fail("invalid-user-agent");
  const forwarded = `${userAgent} PrestiaApp/1.4.1`,
    cookies = new Map<string, string>();
  const runSignal = AbortSignal.timeout(90_000);
  async function request(origin: string, path: string, fields?: Record<string, string>) {
    const cookie = `JSESSIONID=${cookies.get("JSESSIONID") ?? ""}; X-FORWARDED-UA=${encodeURIComponent(forwarded)};${cookies.has("co02") ? ` co02=${cookies.get("co02")};` : ""}`;
    let response: Response;
    const requestSignal = AbortSignal.any([runSignal, AbortSignal.timeout(30_000)]);
    try {
      response = await fetcher(origin + path, {
        method: fields ? "POST" : "GET",
        redirect: "manual",
        headers: {
          "User-Agent": userAgent,
          "X-FORWARDED-UA": forwarded,
          via: "appli",
          Cookie: cookie,
          "Content-Type": fields ? "application/x-www-form-urlencoded" : "text/html",
        },
        ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
        signal: requestSignal,
      });
    } catch (error) {
      return fail(
        error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
          ? "request-timeout"
          : "network-error",
      );
    }
    if (response.status >= 300 && response.status < 400) return fail("redirect-rejected");
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0]!,
        cut = pair.indexOf("="),
        key = pair.slice(0, cut),
        value = pair.slice(cut + 1);
      if (!["JSESSIONID", "co02"].includes(key)) continue;
      if (cut < 1 || value.length > 8192 || /[\u0000-\u0020\u007f;,]/u.test(value))
        return fail("invalid-cookie-update");
      if (!value) cookies.delete(key);
      else cookies.set(key, value);
    }
    if (response.status !== 200)
      return fail(path === BALANCE ? "balance-http-error" : "login-http-error");
    return boundedHtml(response, requestSignal);
  }
  const bootstrap = await request(LOGIN_ORIGIN, BOOTSTRAP);
  const hidden = extractPrestiaForm(bootstrap, "POSNIN1");
  if (!cookies.has("JSESSIONID")) return fail("invalid-cookie-update");
  const home = await request(LOGIN_ORIGIN, LOGIN, {
    userId: input.userId,
    password: input.password,
    dispuserId: input.userId,
    disppassword: input.password,
    ...hidden,
  });
  if (formPresent(home, "AUOTIN1") || /name=["']AUOTIN/iu.test(home))
    return fail("login-challenge-required");
  if (hasProviderError(home) || formPresent(home, "POSNIN1")) return fail("login-rejected");
  if (!formPresent(home, "POMHTOP")) return fail("login-page-unknown");
  let signoffForm = extractPrestiaForm(home, "POMHTOP"),
    signoffFailed = false;
  let result: Omit<PrestiaBankCollection, "signoffFailed">;
  try {
    const html = await request(READ_ORIGIN, BALANCE, signoffForm);
    if (!formPresent(html, "ACKZDSP") || hasProviderError(html))
      return fail("balance-page-unknown");
    signoffForm = extractPrestiaForm(html, "ACKZDSP");
    const body = sanitizePrestiaBankPage(html),
      parsed = parsePrestiaBankBalancePage(body);
    result = {
      body,
      accountCount: parsed.accounts.length,
      foreignCurrencyCount: new Set(
        parsed.accounts.filter((a) => a.currency !== "JPY").map((a) => a.currency),
      ).size,
      aggregateCount: parsed.aggregates.length,
      monthlyAverageCount: parsed.monthlyAverages.length,
    };
  } catch (error) {
    if (error instanceof PrestiaBankError) throw error;
    return fail("balance-parse-error");
  } finally {
    try {
      await request(READ_ORIGIN, SIGNOFF, signoffForm);
    } catch {
      signoffFailed = true;
    }
  }
  return { ...result, signoffFailed };
}
