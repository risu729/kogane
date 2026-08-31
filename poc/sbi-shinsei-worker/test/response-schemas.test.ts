import { describe, expect, test } from "bun:test";
import { UnknownResponseShapeError } from "../src/errors";
import { validateKnownResponse } from "../src/response-schemas";
import { rotateCsrfTokenIfPresent } from "../src/transport";
import type { ResponseSchemaId } from "../src/types";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;

const CASES = [
  ["securityConnect", "sbi-shinsei-security-connect-v1"],
  ["validateToken", "sbi-shinsei-validate-token-v1"],
  ["topBalances", "sbi-shinsei-top-balances-v1"],
  ["balanceSummary", "sbi-shinsei-balance-summary-v1"],
  ["exchangeRate", "sbi-shinsei-exchange-rate-v1"],
  ["yenDeposit", "sbi-shinsei-yen-deposit-account-v1"],
] as const satisfies readonly (readonly [string, ResponseSchemaId])[];

describe("SBI Shinsei captured response schemas", () => {
  for (const [fixtureName, schema] of CASES) {
    test(`accepts sanitized ${fixtureName}`, async () => {
      const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
      expect(validateKnownResponse(schema, fixtures[fixtureName])).toBeDefined();
    });
  }

  test("rejects an unknown field before data is stored", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    const source = fixtures.topBalances;
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new Error("fixture is not an object");
    }
    const changed = { ...source, unexpected: true };
    expect(() => validateKnownResponse(
      "sbi-shinsei-top-balances-v1",
      changed,
    )).toThrow(UnknownResponseShapeError);
  });

  test("unknown schemas are always rejected", () => {
    expect(() => validateKnownResponse("unknown", {})).toThrow(
      UnknownResponseShapeError,
    );
  });

  test("rotates an optional newToken from any known root header", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    const source = structuredClone(fixtures.topBalances);
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new Error("fixture is not an object");
    }
    const header = (source as Record<string, unknown>).header;
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      throw new Error("fixture header is not an object");
    }
    (header as Record<string, unknown>).newToken = "synthetic-rotated-token";
    const validated = validateKnownResponse(
      "sbi-shinsei-top-balances-v1",
      source,
    );
    const rotations: string[] = [];
    rotateCsrfTokenIfPresent({
      getAuthorization: () => "synthetic-authorization",
      getCsrfToken: () => "synthetic-old-token",
      rotateCsrfToken: (token) => rotations.push(token),
    }, validated);
    expect(rotations).toEqual(["synthetic-rotated-token"]);
  });
});
