// `classifyError` is the only path from a thrown error to the codes this
// collector stores (manifest failures and units, so the terminal's
// `safeErrorCode`; the health record's `lastErrorCode` and
// `lastReauthErrorCode`) and logs (`sbi_vc_keepalive`, `sbi_vc_reauth`).
// A message is kept only when it is one of the collector's own closed codes;
// a code-shaped message is still free text that a provider response or a
// library may have chosen. Every error here is synthetic.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCryptoError, classifyError, SBI_VC_ERROR_CODES } from "../src/error-code";

const SRC = join(import.meta.dir, "..", "src");

/** A message whose accessor throws: nothing of it may escape. */
function errorWithThrowingMessage(): Error {
  const error = new Error("unused");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("synthetic accessor failure");
    },
  });
  return error;
}

describe("classifyError keeps only the collector's own closed codes", () => {
  test.each([
    "synthetic_provider_status",
    "econnreset",
    "synthetic-library-code",
    "collector_http_999",
    "passkey_http_99",
    "collector_http_503_extra",
    "executions_historical_synthetic_reason",
    "cashflows_all_future_invalid_pagination",
    "",
  ])("a plain Error with the code-shaped message %p is unexpected_error", (message) => {
    expect(classifyError(new Error(message))).toBe("unexpected_error");
  });

  test("an error class keeps its class code, never a code-shaped message", () => {
    expect(classifyError(new TypeError("synthetic_provider_status"))).toBe("type_error");
    expect(classifyError(new SyntaxError("synthetic_provider_status"))).toBe("json_parse_failed");
    expect(classifyError(new DOMException("synthetic_provider_status", "OperationError"))).toBe(
      "crypto_operation_error",
    );
    expect(classifyError(new DOMException("synthetic", "SyntheticError"))).toBe("crypto_error");
  });

  test("a non-Error value and a throwing message accessor are unexpected_error", () => {
    expect(classifyError("missing_session_seed")).toBe("unexpected_error");
    expect(classifyError({ message: "missing_session_seed" })).toBe("unexpected_error");
    expect(classifyError(undefined)).toBe("unexpected_error");
    expect(classifyError(errorWithThrowingMessage())).toBe("unexpected_error");
  });

  test("a throwing prototype read or name getter is never thrown on", () => {
    const leak = () => {
      throw new Error("synthetic private text");
    };
    const prototypeThrows = new Proxy(new Error("missing_session_seed"), { getPrototypeOf: leak });
    expect(classifyError(prototypeThrows)).toBe("unexpected_error");
    expect(classifyCryptoError(prototypeThrows)).toBe("session_encrypt_failed");
    // The built-in `name` getter refuses a Proxy receiver.
    const proxiedCrypto = new Proxy(new DOMException("synthetic", "OperationError"), {});
    expect(classifyError(proxiedCrypto)).toBe("crypto_error");
    expect(classifyCryptoError(proxiedCrypto)).toBe("crypto_error");
    class NameThrows extends DOMException {
      override get name(): string {
        return leak();
      }
    }
    expect(classifyError(new NameThrows("synthetic"))).toBe("crypto_error");
    expect(classifyCryptoError(new NameThrows("synthetic"))).toBe("crypto_error");
  });

  test.each([
    "missing_session_seed",
    "missing_passkey_credential",
    "manual_agreement_required",
    "passkey_login_rejected",
    "invalid_gateway_envelope",
    "collector_gateway_rejected",
    "crypto_operation_error",
    "executions_recent_page_limit_exceeded",
    "report_list_invalid",
  ])("the collector's own code %p is kept", (code) => {
    expect(classifyError(new Error(code))).toBe(code);
  });

  test("bounded HTTP statuses of the gateway and the passkey login are kept", () => {
    expect(classifyError(new Error("collector_http_503"))).toBe("collector_http_503");
    expect(classifyError(new Error("collector_http_302"))).toBe("collector_http_302");
    expect(classifyError(new Error("passkey_http_401"))).toBe("passkey_http_401");
  });

  test.each([
    ["executions-historical", "executions_historical"],
    ["cashflows-historical", "cashflows_historical"],
    ["cashflows-all-recent", "cashflows_all_recent"],
    ["cashflows-all-historical", "cashflows_all_historical"],
  ])("pagination refusals of %p keep their underscore code", (prefix, code) => {
    for (const reason of [
      "invalid_pagination",
      "pagination_total_changed",
      "pagination_length_mismatch",
      "invalid_identity",
      "duplicate_identity",
      "page_limit_exceeded",
    ]) {
      expect(classifyError(new Error(`${prefix}_${reason}`))).toBe(`${code}_${reason}`);
    }
  });
});

describe("the closed set covers every code the collector throws", () => {
  const sources = readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

  test("every error the sources construct takes a whole literal, a template or a classified code", () => {
    // Anything else (a variable, a concatenation, no argument) would pass the
    // two scans below unseen, so each construction must be one of them.
    const unreviewed = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/new [A-Za-z]*Error\(\s*([^\n]*)/gu)]
        .map((match) => match[1]!)
        .filter(
          (argument) =>
            !/^"[^"]*"\s*[),]/u.test(argument) &&
            !/^`[^`]*`\s*[),]/u.test(argument) &&
            !(name === "worker.ts" && argument.startsWith("classifyCryptoError(error))")),
        )
        .map((argument) => `${name}: ${argument}`),
    );
    expect(unreviewed).toEqual([]);
  });

  test("every literal thrown message is a closed code that classifyError keeps", () => {
    const literals = sources.flatMap(({ text }) =>
      [...text.matchAll(/new [A-Za-z]*Error\(\s*"([^"]*)"/gu)].map((match) => match[1]!),
    );
    expect(literals.length).toBeGreaterThan(80);
    for (const literal of literals) {
      expect(SBI_VC_ERROR_CODES.has(literal)).toBe(true);
      expect(classifyError(new Error(literal))).toBe(literal);
    }
  });

  test("every templated thrown message is one of the reviewed templates", () => {
    const templates = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/new [A-Za-z]*Error\(\s*`([^`]*)`/gu)].map(
        (match) => `${name}: ${match[1]!}`,
      ),
    );
    expect(new Set(templates)).toEqual(
      new Set([
        "collector.ts: ${options.prefix}_invalid_pagination",
        "collector.ts: ${options.prefix}_pagination_total_changed",
        "collector.ts: ${options.prefix}_pagination_length_mismatch",
        "collector.ts: ${options.prefix}_invalid_identity",
        "collector.ts: ${options.prefix}_duplicate_identity",
        "collector.ts: ${options.prefix}_page_limit_exceeded",
        "collector.ts: collector_http_${response.status}",
        "passkey.ts: passkey_http_${response.status}",
      ]),
    );
    // The pagination prefixes the closed set enumerates.
    const prefixes = [
      ...sources
        .find(({ name }) => name === "collector.ts")!
        .text.matchAll(/prefix: (?:"([^"]+)"|`([^`]+)`)/gu),
    ].map((match) => match[1] ?? match[2]);
    expect(prefixes).toEqual([
      "executions-historical",
      "cashflows-historical",
      'cashflows-all-${historical ? "historical" : "recent"}',
    ]);
  });
});
