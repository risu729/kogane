import { expect, test } from "bun:test";
import { readEconomicRowReadinessForGrant } from "../src/query/economic-row-readiness-read.ts";
import type { Grant } from "../src/grants.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";

const GRANT: Grant = {
  principal: "synthetic-readiness-reader",
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows: 64, maxProposalTargets: 1, maxExplainDepth: 1 },
};
const request = (count = 1) => ({
  schema: "economic-row-readiness-v1",
  family: "bank-movement",
  knowledge: "current",
  rows: Array.from({ length: count }, (_, n) => ({ observationId: n + 1, parseRunId: 1 })),
});
function forbiddenStore() {
  let reads = 0;
  const deny = async (): Promise<never> => {
    reads++;
    throw new Error("private database shape must not escape");
  };
  return { sql: { all: deny, first: deny } satisfies SqlExecutor, reads: () => reads };
}
test("capability and both whole-store axes precede validation and every schema/data read", async () => {
  for (const [grant, code] of [
    [{ ...GRANT, capabilities: [] }, "unauthorized"],
    [{ ...GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } }, "evidence_restricted"],
    [
      { ...GRANT, scopes: { sources: "*", accounts: ["synthetic-account"] } },
      "evidence_restricted",
    ],
    [{ ...GRANT, scopes: { sources: [], accounts: [] } }, "evidence_restricted"],
  ] as const) {
    const store = forbiddenStore();
    for (const body of [request(), { ...request(), schema: "private schema probe" }]) {
      const result = await readEconomicRowReadinessForGrant({
        grant,
        sql: store.sql,
        request: body,
      });
      expect(result).toMatchObject({ status: "refused", error: { code } });
      expect(JSON.stringify(result)).not.toContain("private");
    }
    expect(store.reads()).toBe(0);
  }
});
test("closed request, distinct observations and safe positive ids are required before reading", async () => {
  for (const body of [
    null,
    {},
    { ...request(), extra: "override" },
    { ...request(), rows: [{ observationId: 1, parseRunId: 1, account: "override" }] },
    { ...request(), schema: "other" },
    { ...request(), family: "card-purchase" },
    { ...request(), knowledge: { instant: "2030-01-01" } },
    { ...request(), rows: [] },
    { ...request(), rows: [{ observationId: 0, parseRunId: 1 }] },
    { ...request(), rows: [{ observationId: Number.MAX_SAFE_INTEGER + 1, parseRunId: 1 }] },
    { ...request(), rows: [{ observationId: 1, parseRunId: 0.5 }] },
    {
      ...request(),
      rows: [
        { observationId: 1, parseRunId: 1 },
        { observationId: 1, parseRunId: 2 },
      ],
    },
    request(65),
  ]) {
    const store = forbiddenStore();
    expect(
      await readEconomicRowReadinessForGrant({ grant: GRANT, sql: store.sql, request: body }),
    ).toMatchObject({ status: "refused", error: { code: "invalid_query", refs: ["request"] } });
    expect(store.reads()).toBe(0);
  }
});
test("grant row budget refuses the entire batch before reading; the hard bound remains 64", async () => {
  const store = forbiddenStore();
  expect(
    await readEconomicRowReadinessForGrant({
      grant: { ...GRANT, budget: { ...GRANT.budget, maxRows: 1 } },
      sql: store.sql,
      request: request(2),
    }),
  ).toMatchObject({ status: "refused", error: { code: "budget_exceeded" } });
  expect(store.reads()).toBe(0);
  // A valid boundary request reaches exactly the existing single read; failures stay closed.
  expect(
    await readEconomicRowReadinessForGrant({ grant: GRANT, sql: store.sql, request: request(64) }),
  ).toEqual({ status: "unavailable", reason: "readiness_store_unavailable" });
  expect(store.reads()).toBe(1);
});
