import { expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import {
  ECONOMIC_READINESS_PATH,
  economicReadinessMatches,
  validEconomicReadinessResult,
} from "../src/economic-readiness-contract.ts";
import { economicReadinessFixture } from "./economic-readiness-fixture.ts";

test("economic readiness preserves closed diagnostics, unknown coverage and disabled adoption", () => {
  for (const family of ["bank-movement", "securities-execution"] as const) {
    const answer = economicReadinessFixture(1, 7, family);
    expect(validApiResponse(ECONOMIC_READINESS_PATH, answer)).toBe(true);
    for (const change of [
      { writerEnabled: true },
      { proposalEnabled: true },
      { historyCoverage: "complete" },
      { contextId: "private text" },
      { unexpected: "private text" },
      { counts: { admitted: 1, blocked: 0, unavailable: 0 } },
      { generationGates: [] },
      { generationGates: ["private text"] },
      { manifest: { ...answer.manifest, knowledge: "past" } },
      { manifest: { ...answer.manifest, rows: [] } },
      {
        manifest: { ...answer.manifest, rows: [answer.manifest.rows[0], answer.manifest.rows[0]] },
      },
      {
        manifest: {
          ...answer.manifest,
          rows: [{ ...answer.manifest.rows[0], reasons: ["private text"] }],
        },
      },
      {
        manifest: {
          ...answer.manifest,
          rows: [
            { ...answer.manifest.rows[0], ref: { observationId: 1, parseRunId: 7, extra: true } },
          ],
        },
      },
    ])
      expect(validEconomicReadinessResult({ ...answer, ...change })).toBe(false);
  }
  expect(
    validEconomicReadinessResult({ status: "unavailable", reason: "readiness_store_unavailable" }),
  ).toBe(false);
});

test("a safe diagnostic is correlated to exact family, observation and parse", () => {
  const request = {
    schema: "economic-row-readiness-v1",
    family: "bank-movement",
    knowledge: "current",
    rows: [{ observationId: 1, parseRunId: 7 }],
  } as const;
  const input = { ...request, rows: [...request.rows] };
  expect(economicReadinessMatches(economicReadinessFixture(), input)).toBe(true);
  expect(economicReadinessMatches(economicReadinessFixture(2), input)).toBe(false);
  expect(economicReadinessMatches(economicReadinessFixture(1, 8), input)).toBe(false);
  expect(
    economicReadinessMatches(economicReadinessFixture(1, 7, "securities-execution"), input),
  ).toBe(false);
});
