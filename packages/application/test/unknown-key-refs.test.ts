// An unknown key is the caller's own text: every parser that names unknown
// keys in an `unsupported_semantics` refusal names at most ten of them, each
// cut to its first 64 code units, so a body of long keys is never repeated
// back whole. Synthetic keys only.
import { describe, expect, test } from "bun:test";
import { UNKNOWN_KEY_REF_LENGTH, UNKNOWN_KEY_REFS_MAX, unknownKeyRefs } from "../src/errors.ts";
import { parseExplainRequest } from "../src/explain.ts";
import { parseProposalRequest } from "../src/propose.ts";
import { parseQueryRequest } from "../src/query/spec.ts";

const LONG_KEYS = Array.from({ length: 12 }, (_, index) =>
  String.fromCharCode(97 + index).repeat(4_000),
);
const EXPECTED = LONG_KEYS.slice(0, 10).map((key) => key.slice(0, 64));
const withLongKeys = (known: Record<string, unknown>) => ({
  ...known,
  ...Object.fromEntries(LONG_KEYS.map((key) => [key, 1])),
});

describe("unknown keys are named by a bounded prefix", () => {
  test("the helper keeps ten keys of 64 code units, and a short key whole", () => {
    expect(UNKNOWN_KEY_REFS_MAX).toBe(10);
    expect(UNKNOWN_KEY_REF_LENGTH).toBe(64);
    expect(unknownKeyRefs(LONG_KEYS)).toEqual(EXPECTED);
    expect(unknownKeyRefs(["sql", "url"])).toEqual(["sql", "url"]);
    expect(unknownKeyRefs([])).toEqual([]);
  });

  test("financial.query: top-level and filter keys", () => {
    const top = parseQueryRequest(withLongKeys({ intent: "coverage" }));
    expect(top).toEqual({ ok: false, code: "unsupported_semantics", refs: EXPECTED });
    const filters = parseQueryRequest({ intent: "coverage", filters: withLongKeys({}) });
    expect(filters).toEqual({
      ok: false,
      code: "unsupported_semantics",
      refs: EXPECTED.map((key) => `filter:${key}`),
    });
  });

  test("explain", () => {
    expect(parseExplainRequest(withLongKeys({ ref: "observation:transaction:1" }))).toEqual({
      ok: false,
      code: "unsupported_semantics",
      refs: EXPECTED,
    });
  });

  test("reconcile.propose", () => {
    expect(parseProposalRequest(withLongKeys({ kind: "same_account" }), 1)).toEqual({
      ok: false,
      code: "unsupported_semantics",
      refs: EXPECTED,
    });
  });
});
