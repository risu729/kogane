const ENTRY = "https://web.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do";
const ENTRY_PATH = "/servlet/LOGBNK0000000B.do";
const OBSERVED_PATHS = new Set(["/", "/servlet/", ENTRY_PATH, "/servlet/LOGBNK0000001B.do"]);
const FIELD_NAMES = new Set([
  "_FRAMEID",
  "_TARGETID",
  "_LUID",
  "_TOKEN",
  "_FORMID",
  "_SUBINDEX",
  "POSTKEY",
  "CLIENT_ENV",
  "txbCustNo",
]);
const MEDIA_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
]);

function bankUrl(value, base = ENTRY) {
  try {
    const url = new URL(value, base);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !/^web\d*\.ib\.mizuhobank\.co\.jp$/u.test(url.hostname)
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function safeLocation(url) {
  return { origin: url.origin, path: url.pathname };
}

function observedLocation(value, base) {
  const url = bankUrl(value, base);
  if (!url || !OBSERVED_PATHS.has(url.pathname)) return undefined;
  return safeLocation(url);
}

// Only public login form structure is retained. Input values and arbitrary
// names, script contents, text, headers and URL queries never enter the report.
function attributes(tag) {
  const result = new Map();
  const pattern = /\s([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu;
  for (const match of tag.matchAll(pattern)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function inspectHtml(html, url, status) {
  const markup = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "");
  const visibleText = markup.replace(/<[^>]*>/gu, " ");
  const baseTag = markup.match(/<base\b[^>]*>/iu)?.[0];
  const baseValue = baseTag ? attributes(baseTag).get("href") : undefined;
  const base = baseValue ? bankUrl(baseValue, url) : url;
  const formTags = [...markup.matchAll(/<form\b[^>]*>/giu)];
  const forms = formTags.slice(0, 8).map(([tag]) => {
    const attrs = attributes(tag);
    const action = attrs.get("action");
    return {
      name: attrs.get("name") === "LOGBNK_00000B" ? "LOGBNK_00000B" : "unrecognized",
      method: /^(get|post)$/iu.test(attrs.get("method") ?? "get")
        ? (attrs.get("method") ?? "get").toUpperCase()
        : "unrecognized",
      ...(action && base ? { action: observedLocation(action, base) } : {}),
    };
  });
  const fieldNames = new Set();
  let unrecognizedFieldCount = 0;
  for (const [tag] of markup.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/giu)) {
    const name = attributes(tag).get("name");
    if (!name) continue;
    if (FIELD_NAMES.has(name)) fieldNames.add(name);
    else unrecognizedFieldCount++;
  }
  let outcome = "unknown";
  if (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    /access denied|captcha|認証が必要/iu.test(visibleText)
  )
    outcome = "challenge";
  else if (/\b50010\b/u.test(visibleText)) outcome = "maintenance-50010";
  else if (/\b50020\b/u.test(visibleText)) outcome = "unsupported-environment-50020";
  else if (
    status >= 200 &&
    status < 300 &&
    fieldNames.has("txbCustNo") &&
    forms.some(
      (form) =>
        form.name === "LOGBNK_00000B" &&
        form.method === "POST" &&
        form.action?.path === "/servlet/LOGBNK0000001B.do",
    )
  )
    outcome = "login-ready";
  return {
    outcome,
    ...(baseValue ? { base: observedLocation(baseValue, url) } : {}),
    forms,
    formCount: formTags.length,
    fieldNames: [...fieldNames].sort(),
    unrecognizedFieldCount,
  };
}

class ProbeFailure extends Error {
  constructor(outcome) {
    super(outcome);
    this.outcome = outcome;
  }
}

/** Public entry GET only. No auth input, session import, retries or POST API. */
export async function probePublicLogin({
  fetchImpl = fetch,
  timeoutMs = 15_000,
  maxBytes = 512 * 1024,
  maxRedirects = 3,
} = {}) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1024 * 1024 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 5
  ) {
    throw new Error("Invalid probe limits");
  }
  const started = performance.now();
  const controller = new AbortController();
  let reader;
  let timer;
  const report = {
    schemaVersion: "mizuho-public-probe-v1",
    scope: "unauthenticated-public-entry",
    outcome: "unknown",
    requests: 0,
    redirects: 0,
    bodyBytes: 0,
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new ProbeFailure("timeout"));
    }, timeoutMs);
  });
  async function collect() {
    let url = new URL(ENTRY);
    while (true) {
      if (controller.signal.aborted) throw new ProbeFailure("timeout");
      report.requests++;
      report.location = safeLocation(url);
      const response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new ProbeFailure("timeout");
      }
      report.httpStatus = response.status;
      const rawContentType = response.headers.get("content-type") ?? "";
      const mediaType = rawContentType.split(";", 1)[0].trim().toLowerCase();
      report.contentType = MEDIA_TYPES.has(mediaType) ? mediaType : "unknown";
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (report.redirects >= maxRedirects) throw new ProbeFailure("redirect-limit");
        const location = response.headers.get("location");
        const next = location ? bankUrl(location, url) : undefined;
        if (!next || next.pathname !== ENTRY_PATH || next.search || next.hash) {
          throw new ProbeFailure("redirect-rejected");
        }
        url = next;
        report.redirects++;
        continue;
      }
      const length = response.headers.get("content-length");
      if (length && /^\d+$/u.test(length) && Number(length) > maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new ProbeFailure("body-too-large");
      }
      reader = response.body?.getReader();
      const chunks = [];
      if (reader)
        while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) throw new ProbeFailure("timeout");
          if (done) break;
          report.bodyBytes += value.byteLength;
          if (report.bodyBytes > maxBytes) throw new ProbeFailure("body-too-large");
          chunks.push(value);
        }
      const bytes = new Uint8Array(report.bodyBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (report.contentType === "text/html" || report.contentType === "application/xhtml+xml") {
        const encoding = /charset\s*=\s*["']?(?:shift[_-]jis|sjis|windows-31j)/iu.test(
          rawContentType,
        )
          ? "shift_jis"
          : "utf-8";
        Object.assign(
          report,
          inspectHtml(new TextDecoder(encoding).decode(bytes), url, response.status),
        );
      } else if ([401, 403, 429].includes(response.status)) report.outcome = "challenge";
      return report;
    }
  }
  try {
    await Promise.race([collect(), deadline]);
  } catch (error) {
    report.outcome = error instanceof ProbeFailure ? error.outcome : "network-error";
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
  return { ...report, elapsedMs: Math.round(performance.now() - started) };
}
