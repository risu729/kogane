import { describe, expect, test } from "bun:test";
import { UnknownResponseShapeError } from "../src/errors";
import { parseCollectionResult } from "../src/local/windows-chrome-collector";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;

describe("SBI Shinsei same-Chrome-context handoff", () => {
  test("accepts only final captured read JSON and builds artifacts", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(fixtures.topBalances),
          balanceSummary: JSON.stringify(fixtures.balanceSummary),
          exchangeRate: JSON.stringify(fixtures.exchangeRate),
          yenDeposit: JSON.stringify(fixtures.yenDeposit),
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.artifacts).toHaveLength(5);
    expect(result.normalized?.balances).toHaveLength(2);
    expect(result.normalized?.transactions).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });

  test("preserves a validated prefix when a later provider read fails", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(fixtures.topBalances),
        },
        failure: {
          dataset: "balance-summary-and-stage",
          stage: "balance-summary-http-503",
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.artifacts.map((artifact) => artifact.dataset)).toEqual([
      "top-accounts-balance-and-activity",
      "normalized",
    ]);
    expect(result.failures).toEqual([
      {
        operation: "read:balance-summary-and-stage",
        errorType: "ProviderReadError",
        message: "provider_read_failed",
        diagnostics: { stage: "balance-summary-http-503", httpStatus: 503 },
      },
      {
        operation: "read:exchange-rate",
        errorType: "NotAttempted",
        message: "provider_read_not_attempted",
      },
      {
        operation: "read:yen-deposit-account",
        errorType: "NotAttempted",
        message: "provider_read_not_attempted",
      },
    ]);
  });

  test("rejects a partial envelope whose failure is not the next dataset", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    expect(() =>
      parseCollectionResult(
        JSON.stringify({
          ok: true,
          responses: { topBalances: JSON.stringify(fixtures.topBalances) },
          failure: { dataset: "exchange-rate", stage: "exchange-rate-http-503" },
        }),
        new Date("2026-08-31T00:00:00.000Z"),
      ),
    ).toThrow("collector failure did not match the next dataset");
  });

  test("drops one drifted later response but retains other validated evidence", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const balanceSummary = structuredClone(fixtures.balanceSummary) as Record<string, unknown>;
    balanceSummary.unexpected = true;
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(fixtures.topBalances),
          balanceSummary: JSON.stringify(balanceSummary),
          exchangeRate: JSON.stringify(fixtures.exchangeRate),
          yenDeposit: JSON.stringify(fixtures.yenDeposit),
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.artifacts.map((artifact) => artifact.dataset)).toEqual([
      "top-accounts-balance-and-activity",
      "exchange-rate",
      "yen-deposit-account",
      "normalized",
    ]);
    expect(result.failures).toEqual([
      {
        operation: "read:balance-summary-and-stage",
        errorType: "ResponseSchemaError",
        message: "provider_response_invalid",
      },
    ]);
  });

  test("rejects session material or unknown fields at the handoff boundary", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    expect(() =>
      parseCollectionResult(
        JSON.stringify({
          ok: true,
          authorization: "synthetic-session-material",
          responses: {
            topBalances: JSON.stringify(fixtures.topBalances),
            balanceSummary: JSON.stringify(fixtures.balanceSummary),
            exchangeRate: JSON.stringify(fixtures.exchangeRate),
            yenDeposit: JSON.stringify(fixtures.yenDeposit),
          },
        }),
        new Date(),
      ),
    ).toThrow(UnknownResponseShapeError);
  });

  test("rejects PowerShell pipeline output wrapped as a top-level array", () => {
    expect(() =>
      parseCollectionResult(
        JSON.stringify([{ unexpectedPipelineValue: true }, { ok: true }]),
        new Date(),
      ),
    ).toThrow(UnknownResponseShapeError);
  });

  test("drops a drifted top response but retains independently valid raw evidence", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const changed = structuredClone(fixtures.topBalances);
    if (typeof changed !== "object" || changed === null || Array.isArray(changed)) {
      throw new Error("fixture is not an object");
    }
    (changed as Record<string, unknown>).unknown = true;
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(changed),
          balanceSummary: JSON.stringify(fixtures.balanceSummary),
          exchangeRate: JSON.stringify(fixtures.exchangeRate),
          yenDeposit: JSON.stringify(fixtures.yenDeposit),
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.normalized).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.dataset)).toEqual([
      "balance-summary-and-stage",
      "exchange-rate",
      "yen-deposit-account",
    ]);
    expect(result.failures).toEqual([
      {
        operation: "read:top-accounts-balance-and-activity",
        errorType: "ResponseSchemaError",
        message: "provider_response_invalid",
      },
      {
        operation: "derive:normalized",
        errorType: "DependencyInvalid",
        message: "normalized_source_invalid",
      },
    ]);
  });

  test("retains all strict raw responses when normalization fails", async () => {
    const fixtures = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const top = structuredClone(fixtures.topBalances) as {
      responseParam: {
        activity: { responseParam: { activityDetails: Array<Record<string, unknown>> } };
      };
    };
    top.responseParam.activity.responseParam.activityDetails[0]!.postingDate = "9999-99-99";
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(top),
          balanceSummary: JSON.stringify(fixtures.balanceSummary),
          exchangeRate: JSON.stringify(fixtures.exchangeRate),
          yenDeposit: JSON.stringify(fixtures.yenDeposit),
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.normalized).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.dataset)).toEqual([
      "top-accounts-balance-and-activity",
      "balance-summary-and-stage",
      "exchange-rate",
      "yen-deposit-account",
    ]);
    expect(result.failures).toEqual([
      {
        operation: "derive:normalized",
        errorType: "DerivationError",
        message: "normalized_derivation_failed",
      },
    ]);
  });
});
