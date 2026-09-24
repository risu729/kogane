import iconv from "iconv-lite";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  absorbCookies,
  encodeForm,
  extractMizuhoForm,
  MizuhoClientError,
  parseSession,
  type MizuhoSession,
} from "./client";

const ORIGIN = "https://web.ib.mizuhobank.co.jp";
const ENTRY = "/servlet/LOGBNK0000000B.do";
const CUSTOMER = "/servlet/LOGBNK0000001B.do";
const PASSWORD = "/servlet/LOGBNK0000501B.do";
const NOTICE = "/servlet/LOGCNF0240001B.do";
const CORE = ["_FRAMEID", "_TARGETID", "_LUID", "_TOKEN", "_FORMID", "_SUBINDEX", "POSTKEY"];
const REDIRECT_KEYS = new Set(["REQTYPE", "_FRAMEID", "_TARGETID", "_LUID", "_TOKEN", "_SUBINDEX"]);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const MAX_BYTES = 1024 * 1024;
type Node = DefaultTreeAdapterMap["node"];
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Form = { name: string; fields: Record<string, string> };

function fail(code: string): never {
  throw new MizuhoClientError(code);
}
function attr(node: Node, name: string) {
  return "attrs" in node
    ? node.attrs.find((attribute) => attribute.name === name)?.value
    : undefined;
}
function nodes(root: Node): Node[] {
  const result: Node[] = [],
    pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    if ("childNodes" in node) pending.push(...node.childNodes);
  }
  return result;
}
function tag(node: Node) {
  return "tagName" in node ? node.tagName : undefined;
}

/** Extract fresh hidden state only; no password, preferences or agreement is inherited. */
function loginForm(html: string, expected: string): Form {
  const all = nodes(parse(html));
  const forms = all.filter((node) => tag(node) === "form");
  if (forms.length !== 1) fail("login-unrecognized-page");
  const form = forms[0]!;
  const name = attr(form, "name") ?? "";
  if (name !== expected) {
    if (/^LOGBNK_/u.test(name)) fail("login-required");
    fail("login-challenge-required");
  }
  const fields: Record<string, string> = {};
  let credentialControls = 0;
  for (const control of nodes(form)) {
    const type = (attr(control, "type") ?? "text").toLowerCase();
    const key = attr(control, "name");
    if (
      !key ||
      attr(control, "disabled") !== undefined ||
      !["input", "textarea", "select"].includes(tag(control) ?? "")
    )
      continue;
    if (["button", "submit", "reset", "image"].includes(type)) continue;
    const expectedCredential =
      (expected === "LOGBNK_00000B" && key === "txbCustNo" && type === "text") ||
      (expected === "LOGBNK_00005B" && key === "PASSWD_LoginPwdInput" && type === "password");
    if (expectedCredential) {
      credentialControls++;
      continue;
    }
    if (
      expected === "LOGCNF_02400B" &&
      type === "checkbox" &&
      /^(?:checkbox_check1|chkMsgCnf_[A-Za-z0-9_]+)$/u.test(key)
    )
      continue;
    const extra =
      (expected === "LOGBNK_00000B" && key === "CLIENT_ENV") ||
      (expected === "LOGBNK_00005B" && key === "dsdt");
    if (tag(control) !== "input" || type !== "hidden" || (!CORE.includes(key) && !extra))
      fail("login-challenge-required");
    const value = attr(control, "value") ?? "";
    if (
      Object.hasOwn(fields, key) ||
      value.length > 8192 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    )
      fail("login-unrecognized-page");
    fields[key] = value;
  }
  if (
    CORE.some((key) => typeof fields[key] !== "string") ||
    fields._FORMID !== name ||
    !fields._FRAMEID ||
    !fields._TOKEN ||
    !fields.POSTKEY
  )
    fail("login-unrecognized-page");
  if (expected !== "LOGCNF_02400B" && credentialControls !== 1) fail("login-unrecognized-page");
  return { name, fields };
}

function redirect(location: string | null, target: string, origin: string): string {
  if (!location) fail("login-redirect-rejected");
  let url: URL;
  try {
    url = new URL(location, target);
  } catch {
    return fail("login-redirect-rejected");
  }
  const keys = [...url.searchParams.keys()];
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== new URL(target).pathname ||
    keys.length !== REDIRECT_KEYS.size ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !REDIRECT_KEYS.has(key))
  )
    fail("login-redirect-rejected");
  return url.href;
}

/** One bounded login attempt. Unknown authentication or consent screens stop the run. */
export async function loginMizuho(options: {
  customerNumber: string;
  password: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}): Promise<MizuhoSession> {
  if (
    typeof options.customerNumber !== "string" ||
    !/^[1-9](?:\d{7}|\d{9})$/u.test(options.customerNumber) ||
    typeof options.password !== "string" ||
    !/^[\x21-\x7e]{4,32}$/u.test(options.password) ||
    options.password.length === 5
  )
    fail("invalid-login-credentials");
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    fail("invalid-login-credentials");
  const fetcher = options.fetcher ?? fetch;
  let origin = ORIGIN;
  const cookies = new Map<string, string>();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let referer = ORIGIN + ENTRY;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new MizuhoClientError("login-timeout"));
    }, timeoutMs);
  });
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  async function request(route: string, fields?: Record<string, string>): Promise<string> {
    const target = origin + route;
    let url = target;
    let body = fields ? encodeForm(fields) : undefined;
    for (let step = 0; step < 2; step++) {
      if (controller.signal.aborted) fail("login-timeout");
      const headers: Record<string, string> = {
        accept: "text/html",
        "accept-language": "ja,en;q=0.8",
        "user-agent": USER_AGENT,
        ...(cookies.size ? { cookie: cookieHeader() } : {}),
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
        return fail(controller.signal.aborted ? "login-timeout" : "login-network-error");
      }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        fail("login-timeout");
      }
      try {
        absorbCookies(cookies, response, origin);
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        if (step !== 0 || body === undefined || ![302, 303].includes(response.status))
          fail("login-redirect-rejected");
        url = redirect(response.headers.get("location"), target, origin);
        body = undefined;
        referer = target;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        fail("login-http-error");
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
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const item = await reader.read();
          if (controller.signal.aborted) fail("login-timeout");
          if (item.done) break;
          size += item.value.byteLength;
          if (size > MAX_BYTES) fail("response-too-large");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        reader = undefined;
      }
      if (!size) fail("empty-response");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      referer = url;
      return iconv.decode(bytes, "shift_jis");
    }
    return fail("login-redirect-rejected");
  }
  function submit(form: Form, extra: Record<string, string> = {}) {
    return { ...form.fields, _TARGETID: form.fields._FRAMEID!, _SUBINDEX: "", ...extra };
  }
  async function authenticate() {
    const entryHtml = await request(ENTRY);
    const customer = loginForm(entryHtml, "LOGBNK_00000B");
    const bases = nodes(parse(entryHtml)).filter((node) => tag(node) === "base");
    if (bases.length !== 1) fail("login-unrecognized-page");
    let base: URL;
    try {
      base = new URL(attr(bases[0]!, "href") ?? "");
    } catch {
      return fail("login-redirect-rejected");
    }
    if (
      base.protocol !== "https:" ||
      base.port ||
      base.username ||
      base.password ||
      !/^web\d*\.ib\.mizuhobank\.co\.jp$/u.test(base.hostname) ||
      base.pathname !== "/servlet/" ||
      base.search ||
      base.hash
    )
      fail("login-redirect-rejected");
    origin = base.origin;
    const password = loginForm(
      await request(
        CUSTOMER,
        submit(customer, {
          CLIENT_ENV: "ja;undefined;undefined",
          txbCustNo: options.customerNumber,
        }),
      ),
      "LOGBNK_00005B",
    );
    // The bank's observed chkInvalidScript sets dsdt to 1 before the password submission.
    let html = await request(
      PASSWORD,
      submit(password, { dsdt: "1", PASSWD_LoginPwdInput: options.password }),
    );
    const forms = nodes(parse(html)).filter((node) => tag(node) === "form");
    if (forms.length === 1 && attr(forms[0]!, "name") === "LOGCNF_02400B") {
      const notice = loginForm(html, "LOGCNF_02400B");
      html = await request(NOTICE, submit(notice));
    }
    let form;
    try {
      form = extractMizuhoForm(html);
    } catch {
      return fail("login-challenge-required");
    }
    if (form.name !== "MENTOP_02000B") fail("login-unrecognized-page");
    return parseSession(
      JSON.stringify({ origin, cookies: cookieHeader(), userAgent: USER_AGENT, referer, form }),
    );
  }
  try {
    return await Promise.race([authenticate(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
