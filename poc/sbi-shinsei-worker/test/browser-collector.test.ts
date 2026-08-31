import { describe, expect, test } from "bun:test";
import { collectSbiShinsei } from "../src/collector";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;
const credentialJson = JSON.stringify({
  branchNumber: "012",
  accountNumber: "0345678",
  powerDirectPassword: "synthetic-password",
});

describe("SBI Shinsei Container handoff", () => {
  test("passes the isolated credential once and returns only validated artifacts", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    let calls = 0;
    const result = await collectSbiShinsei({
      credentialJson,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      collectHandoff: async (value) => {
        calls += 1;
        expect(JSON.parse(value)).toEqual(JSON.parse(credentialJson));
        return JSON.stringify({
          ok: true,
          responses: {
            topBalances: JSON.stringify(fixtures.topBalances),
            balanceSummary: JSON.stringify(fixtures.balanceSummary),
            exchangeRate: JSON.stringify(fixtures.exchangeRate),
            yenDeposit: JSON.stringify(fixtures.yenDeposit),
          },
        });
      },
    });
    expect(calls).toBe(1);
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual([
      "raw-top-accounts-balance-and-activity.json",
      "raw-balance-summary-and-stage.json",
      "raw-exchange-rate.json",
      "raw-yen-deposit-account.json",
      "normalized.json",
    ]);
  });

  test("does not retry a rejected login", async () => {
    let calls = 0;
    await expect(collectSbiShinsei({
      credentialJson,
      collectHandoff: async () => {
        calls += 1;
        return JSON.stringify({
          ok: false,
          stage: "login-rejected",
          authenticationAttempted: true,
        });
      },
    })).rejects.toThrow("stopped at login-rejected");
    expect(calls).toBe(1);
  });

  test("rejects a non-object or unknown handoff before storage", async () => {
    await expect(collectSbiShinsei({
      credentialJson,
      collectHandoff: async () => "[]",
    })).rejects.toThrow("handoff was not an object");
  });

  test("bounds the handoff before parsing", async () => {
    await expect(collectSbiShinsei({
      credentialJson,
      collectHandoff: async () => "x".repeat(10 * 1024 * 1024 + 1),
    })).rejects.toThrow("handoff was not bounded JSON text");
  });
});
