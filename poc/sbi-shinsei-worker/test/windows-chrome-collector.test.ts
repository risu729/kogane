import { describe, expect, test } from "bun:test";
import { UnknownResponseShapeError } from "../src/errors";
import { parseCollectionResult } from "../src/local/windows-chrome-collector";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;

describe("SBI Shinsei same-Chrome-context handoff", () => {
  test("accepts only final captured read JSON and builds artifacts", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    const result = parseCollectionResult(JSON.stringify({
      ok: true,
      responses: {
        topBalances: JSON.stringify(fixtures.topBalances),
        balanceSummary: JSON.stringify(fixtures.balanceSummary),
        exchangeRate: JSON.stringify(fixtures.exchangeRate),
        yenDeposit: JSON.stringify(fixtures.yenDeposit),
      },
    }), new Date("2026-08-31T00:00:00.000Z"));
    expect(result.artifacts).toHaveLength(5);
    expect(result.normalized.balances).toHaveLength(2);
    expect(result.normalized.transactions).toHaveLength(1);
  });

  test("rejects session material or unknown fields at the handoff boundary", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    expect(() => parseCollectionResult(JSON.stringify({
      ok: true,
      authorization: "synthetic-session-material",
      responses: {
        topBalances: JSON.stringify(fixtures.topBalances),
        balanceSummary: JSON.stringify(fixtures.balanceSummary),
        exchangeRate: JSON.stringify(fixtures.exchangeRate),
        yenDeposit: JSON.stringify(fixtures.yenDeposit),
      },
    }), new Date())).toThrow(UnknownResponseShapeError);
  });

  test("rejects PowerShell pipeline output wrapped as a top-level array", () => {
    expect(() => parseCollectionResult(
      JSON.stringify([{ unexpectedPipelineValue: true }, { ok: true }]),
      new Date(),
    )).toThrow(UnknownResponseShapeError);
  });

  test("rejects an unknown response before local storage", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    const changed = structuredClone(fixtures.topBalances);
    if (typeof changed !== "object" || changed === null || Array.isArray(changed)) {
      throw new Error("fixture is not an object");
    }
    (changed as Record<string, unknown>).unknown = true;
    expect(() => parseCollectionResult(JSON.stringify({
      ok: true,
      responses: {
        topBalances: JSON.stringify(changed),
        balanceSummary: JSON.stringify(fixtures.balanceSummary),
        exchangeRate: JSON.stringify(fixtures.exchangeRate),
        yenDeposit: JSON.stringify(fixtures.yenDeposit),
      },
    }), new Date())).toThrow(UnknownResponseShapeError);
  });
});
