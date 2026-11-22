// An unknown key is the caller's own text: every parser that names unknown
// keys in an `unsupported_semantics` refusal names at most ten of them, each
// cut to its first 64 code units without splitting a surrogate pair, so a body
// of long keys is never repeated back whole. Synthetic keys only.
import { describe, expect, test } from "bun:test";
import {
  refPrefix,
  UNKNOWN_KEY_REF_LENGTH,
  UNKNOWN_KEY_REFS_MAX,
  unknownKeyRefs,
} from "../src/errors.ts";
import { parseExplainRequest } from "../src/explain.ts";
import { parseProposalRequest } from "../src/propose.ts";
import { parseAccountCandidatesRequest } from "../src/query/account-candidates.ts";
import { parseInstrumentCandidatesRequest } from "../src/query/instrument-candidates-review.ts";
import { parsePurchasesExplainRequest } from "../src/query/purchases-explain.ts";
import { parseQueryRequest } from "../src/query/spec.ts";

const LONG_KEYS = Array.from({ length: 12 }, (_, index) =>
  String.fromCharCode(97 + index).repeat(4_000),
);
const EXPECTED = LONG_KEYS.slice(0, 10).map((key) => key.slice(0, 64));
const withLongKeys = (known: Record<string, unknown>) => ({
  ...known,
  ...Object.fromEntries(LONG_KEYS.map((key) => [key, 1])),
});
/** Whether text holds no lone surrogate (`encodeURIComponent` throws on one). */
const wellFormed = (text: string): boolean => {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
};

describe("unknown keys are named by a bounded prefix", () => {
  test("the helper keeps ten keys of 64 code units, and a short key whole", () => {
    expect(UNKNOWN_KEY_REFS_MAX).toBe(10);
    expect(UNKNOWN_KEY_REF_LENGTH).toBe(64);
    expect(unknownKeyRefs(LONG_KEYS)).toEqual(EXPECTED);
    expect(unknownKeyRefs(["sql", "url"])).toEqual(["sql", "url"]);
    expect(unknownKeyRefs([])).toEqual([]);
  });

  test("a cut never splits a surrogate pair, so the refs serialise as well-formed text", () => {
    // U+1F600 is two code units: at units 64 and 65 it would be split.
    const split = `${"x".repeat(63)}\u{1F600}tail`;
    const [cut] = unknownKeyRefs([split]);
    expect(cut).toBe("x".repeat(63));
    expect(wellFormed(cut!)).toBe(true);
    expect(JSON.stringify(cut)).not.toContain("\\ud");
    // A pair that ends at unit 64 is kept whole, as is a pair-only key.
    const whole = `${"x".repeat(62)}\u{1F600}tail`;
    expect(unknownKeyRefs([whole])).toEqual([`${"x".repeat(62)}\u{1F600}`]);
    const emoji = "\u{1F600}".repeat(40);
    expect(unknownKeyRefs([emoji])).toEqual(["\u{1F600}".repeat(32)]);
    for (let pad = 0; pad < 70; pad += 1) {
      const [ref] = unknownKeyRefs([`${"x".repeat(pad)}${"\u{1F600}".repeat(40)}`]);
      expect({ pad, wellFormed: wellFormed(ref!) }).toEqual({ pad, wellFormed: true });
      expect(ref!.length).toBeLessThanOrEqual(UNKNOWN_KEY_REF_LENGTH);
    }
  });

  test("a lone surrogate the caller sent is cut by the same rule, never repaired", () => {
    // A high surrogate at unit 64 is dropped whether or not a low one follows.
    expect(refPrefix(`${"x".repeat(63)}\uD800tail`)).toBe("x".repeat(63));
    expect(refPrefix(`${"x".repeat(63)}\uD800`)).toBe("x".repeat(63));
    // A lone low surrogate at unit 64 splits nothing, so it is kept.
    expect(refPrefix(`${"x".repeat(63)}\uDC00tail`)).toBe(`${"x".repeat(63)}\uDC00`);
    // Inside the kept prefix the caller's own text is repeated as sent.
    expect(refPrefix("a\uD800b")).toBe("a\uD800b");
    expect(refPrefix("")).toBe("");
    expect(unknownKeyRefs([""])).toEqual([""]);
  });

  test("an unsupported intent is cut the same way", () => {
    const outcome = parseQueryRequest({ intent: `${"y".repeat(63)}\u{1F600}` });
    expect(outcome).toEqual({
      ok: false,
      code: "unsupported_semantics",
      refs: [`intent:${"y".repeat(63)}`],
    });
  });

  test("instruments.candidates, accounts.candidates and purchases.explain share the bound", () => {
    const keys = { [`${"z".repeat(63)}\u{1F600}`]: 1 };
    const expected = {
      ok: false as const,
      code: "unsupported_semantics" as const,
      refs: ["z".repeat(63)],
    };
    expect(parseInstrumentCandidatesRequest(keys)).toEqual(expected);
    expect(parseAccountCandidatesRequest(keys)).toEqual(expected);
    expect(parsePurchasesExplainRequest(keys)).toEqual(expected);
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
