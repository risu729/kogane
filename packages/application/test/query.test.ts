import { describe, expect, test } from "bun:test";
import { validFinancialResult } from "../../domain/src/result.ts";
import { contextIdOf, openContext } from "../src/context/open.ts";
import { executeQuery, type QueryData } from "../src/query/execute.ts";
import { encodeCursor } from "../src/query/cursor.ts";
import { parseQueryRequest, querySpecDigest, type QueryRequest } from "../src/query/spec.ts";
import { CONTEXT_INPUTS, grant, HOSTILE_DESCRIPTION, OVERVIEW, reader } from "./fixture.ts";
import type { Grant } from "../src/grants.ts";

const anyData = (value: unknown): value is QueryData => value !== null && typeof value === "object";

function request(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return { intent: "coverage", filters: {}, cursor: null, limit: null, ...overrides };
}

async function run(grantValue: Grant, body: QueryRequest, rows = reader()) {
  const opened = await openContext(grantValue, CONTEXT_INPUTS, { query: body });
  return executeQuery({
    grant: grantValue,
    opened,
    request: body,
    reader: rows,
    overview: OVERVIEW,
  });
}

describe("query spec validation", () => {
  test("an unknown key is unsupported semantics, not a silently dropped filter", () => {
    const outcome = parseQueryRequest({ intent: "coverage", sql: "SELECT 1" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unsupported_semantics");
  });

  test("a filter the intent does not accept is refused by name", () => {
    const outcome = parseQueryRequest({ intent: "coverage", filters: { q: "x" } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("unsupported_semantics");
      expect(outcome.refs).toEqual(["filter:q"]);
    }
  });

  test("an intent with no adopted semantics is refused rather than approximated", () => {
    for (const intent of ["net-worth", "performance", "income"]) {
      const outcome = parseQueryRequest({ intent });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("unsupported_semantics");
    }
  });

  test("no request can carry a URL, SQL or an ordering", () => {
    for (const body of [
      { intent: "activity", url: "https://provider.invalid" },
      { intent: "activity", orderBy: "id" },
      { intent: "activity", filters: { table: "parse_runs" } },
    ])
      expect(parseQueryRequest(body).ok).toBe(false);
  });
});

describe("contexts are re-derivable digests", () => {
  test("the id is the digest of its own manifest", async () => {
    const opened = await openContext(grant(), CONTEXT_INPUTS);
    expect(opened.context.contextId).toBe(await contextIdOf(opened.context));
    expect(opened.context.contextId).toMatch(/^ctx_[0-9a-f]{64}$/u);
  });

  test("a changed input yields a different context id", async () => {
    const a = await openContext(grant(), CONTEXT_INPUTS);
    const b = await openContext(grant(), {
      ...CONTEXT_INPUTS,
      publicationHighWater: "published-parse-runs@43",
    });
    expect(a.context.contextId).not.toBe(b.context.contextId);
  });

  test("defaults the server chose are reported, not applied silently", async () => {
    const opened = await openContext(grant(), CONTEXT_INPUTS);
    const keys = opened.unresolvedInputs.map((entry) => entry.key).sort();
    expect(keys).toEqual([
      "effectiveTime",
      "identityRead",
      "intent",
      "knowledgeCutoff",
      "valuation",
    ]);
    expect(opened.unresolvedInputs.find((entry) => entry.key === "valuation")?.reasonCode).toBe(
      "no_valuation_policy_adopted",
    );
  });
});

describe("coverage inside the granted scope", () => {
  test("the shared summary is a valid FinancialResult", async () => {
    const outcome = await run(grant(), request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(validFinancialResult(outcome.result, anyData)).toBe(true);
    const data = outcome.result.data as {
      sourceCount: number;
      artifactCount: number;
      collectionRunCount: number;
    };
    expect(data).toMatchObject({ sourceCount: 3, artifactCount: 3, collectionRunCount: 2 });
    expect(outcome.result.coverage.gaps).toEqual([
      { reasonCode: "no_artifacts_collected", scopeRef: "source:fixture-empty" },
    ]);
    expect(outcome.result.completeness).toBe("partial");
  });

  test("a narrower grant recomputes and never mentions a hidden source", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const outcome = await run(narrow, request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.result.data as { sourceCount: number; artifactCount: number };
    expect(data).toMatchObject({ sourceCount: 1, artifactCount: 2 });
    expect(outcome.result.coverage.gaps).toEqual([]);
    const serialized = JSON.stringify(outcome.result);
    for (const hidden of ["fixture-b", "fixture-empty"]) expect(serialized).not.toContain(hidden);
  });
});

describe("row intents", () => {
  test("provider text is returned as data and never as an instruction field", async () => {
    const outcome = await run(grant(), request({ intent: "activity" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.result.data as { rows: { description: string | null }[] };
    expect(data.rows.some((row) => row.description === HOSTILE_DESCRIPTION)).toBe(true);
    const { data: _data, ...withoutData } = outcome.result;
    expect(JSON.stringify(withoutData)).not.toContain("auth token");
  });

  test("records.read is required; summary.read alone cannot read rows", async () => {
    const summaryOnly = grant({ capabilities: ["summary.read"] });
    const outcome = await run(summaryOnly, request({ intent: "activity" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unauthorized");
  });

  test("a narrower grant reads one source at a time and reports the rest as no gap", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const rows = reader();
    const outcome = await run(narrow, request({ intent: "activity" }), rows);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.result.data as { rows: { sourceRef: string }[] };
    expect(data.rows.every((row) => row.sourceRef === "fixture-a")).toBe(true);
    expect(rows.calls).toEqual(["transactions:fixture-a/*"]);
    expect(JSON.stringify(outcome.result)).not.toContain("fixture-b");
  });

  test("a filter naming a source outside the grant is restricted, not answered", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const outcome = await run(
      narrow,
      request({ intent: "activity", filters: { source: "fixture-b" } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("evidence_restricted");
  });

  test("a partial page carries a cursor instead of being silently cut", async () => {
    const outcome = await run(grant(), request({ intent: "activity", limit: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.nextCursor).not.toBeNull();
    expect(outcome.result.completeness).toBe("partial");
    expect(outcome.result.warnings).toEqual([{ code: "more_rows_available", severity: "info" }]);
    const next = await run(
      grant(),
      request({ intent: "activity", limit: 2, cursor: outcome.result.nextCursor }),
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect((next.result.data as { rows: unknown[] }).rows).toHaveLength(1);
    expect(next.result.nextCursor).toBeNull();
  });

  test("numeric quality follows the stored decimal state", async () => {
    const outcome = await run(grant(), request({ intent: "reported-state" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.quality.numeric.state).toBe("partial");
    expect(outcome.result.quality.numeric.reasonCodes).toEqual(["amount_text_only"]);
    expect(outcome.result.quality.freshness.state).toBe("partial");
  });
});

describe("holdings without the adopted projection", () => {
  test("is unavailable with a reason, never a total computed from raw rows", async () => {
    const outcome = await run(grant(), request({ intent: "holdings" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.completeness).toBe("unavailable");
    expect(outcome.result.coverage.gaps).toEqual([
      { reasonCode: "projection_not_built", scopeRef: outcome.result.resolvedQuery.perimeterRef },
    ]);
    expect(outcome.result.warnings).toEqual([
      { code: "projection_not_built", severity: "blocking" },
    ]);
  });
});

describe("cursors and budgets", () => {
  test("a cursor from another context is stale, never answered from the newest rows", async () => {
    const body = request({ intent: "activity", limit: 1 });
    const opened = await openContext(grant(), CONTEXT_INPUTS, { query: body });
    const other = await openContext(grant(), {
      ...CONTEXT_INPUTS,
      publicationHighWater: "published-parse-runs@99",
    });
    const foreign = encodeCursor({
      contextId: other.context.contextId,
      queryDigest: await querySpecDigest(opened.resolvedQuery),
      offset: 1,
    });
    const outcome = await run(grant(), { ...body, cursor: foreign });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale_context");
  });

  test("a cursor from another query on the same context is stale too", async () => {
    const body = request({ intent: "activity", limit: 1 });
    const first = await run(grant(), body);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const outcome = await run(
      grant(),
      request({ intent: "reported-state", limit: 1, cursor: first.result.nextCursor }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale_context");
  });

  test("a page past the budget is refused, not truncated", async () => {
    const tight = grant({ budget: { maxRows: 2, maxProposalTargets: 2, maxExplainDepth: 2 } });
    const outcome = await run(tight, request({ intent: "activity", limit: 2 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("budget_exceeded");
      expect(outcome.error.message).not.toContain("SELECT");
    }
  });

  test("an invented cursor value is refused", async () => {
    const outcome = await run(grant(), request({ intent: "activity", cursor: "not-a-cursor" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale_context");
  });
});
