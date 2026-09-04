import { describe, expect, test } from "bun:test";
import { parseNormalizedSnapshot } from "../src/normalized";

const fixturePath = `${import.meta.dir}/fixtures/normalized-snapshot.json`;

describe("SBI Shinsei normalized fixture", () => {
  test("accepts the strict synthetic schema", async () => {
    const input: unknown = await Bun.file(fixturePath).json();
    const parsed = parseNormalizedSnapshot(input);
    expect(parsed.balances).toHaveLength(3);
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.balances[1]?.product).toBe("hyper-yokin");
  });

  test("rejects unknown fields", async () => {
    const input: unknown = await Bun.file(fixturePath).json();
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("fixture is not an object");
    }
    const changed = { ...input, unrecognized: true };
    expect(() => parseNormalizedSnapshot(changed)).toThrow(
      "Object keys do not match the known schema",
    );
  });

  test("rejects ambiguous debit and credit", async () => {
    const input = await Bun.file(fixturePath).json() as {
      transactions: Array<Record<string, unknown>>;
    };
    const changed = structuredClone(input);
    const first = changed.transactions[0];
    if (!first) throw new Error("fixture has no transaction");
    first.debit = "1";
    expect(() => parseNormalizedSnapshot(changed)).toThrow(
      "exactly one of debit or credit",
    );
  });

  test("rejects an out-of-range date without leaking RangeError", async () => {
    const input = await Bun.file(fixturePath).json() as {
      transactions: Array<Record<string, unknown>>;
    };
    const changed = structuredClone(input);
    changed.transactions[0]!.transactionDate = "9999-99-99";
    expect(() => parseNormalizedSnapshot(changed)).toThrow(
      "transactionDate must be a valid YYYY-MM-DD date",
    );
  });
});
