// `kogane.evidence.read` (ADR 0081): the evidence browser's catalogue over MCP
// answers what `GET /api/evidence/v1/*` answers, through the route's own
// reader, and never the raw bytes. Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { validEvidenceResponse } from "../../../packages/observation-shared/src/evidence-validation";
import { PAGE_READ_ROUTES, pageReadMcpTools, pageReadStore } from "../src/page-read-tools";
import { seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";

const TOOL = "kogane.evidence.read";
const EVIDENCE_GRANT = { ...RECORDS_GRANT, capabilities: ["evidence.read"] };
const PREFIX = "/api/evidence/v1";
const page = pageReadHarness("evidence-read");
// The browser with no configured source, as `EVIDENCE_SOURCE_ID` unset or another value.
const unconfigured = pageReadHarness("evidence-read-unconfigured", {
  EVIDENCE_SOURCE_ID: "other-test",
});

let run: Awaited<ReturnType<typeof seedRun>>;
let hidden: Awaited<ReturnType<typeof seedRun>>;
let artifact = "";

beforeAll(async () => {
  await seedRegistry();
  // 51 artifacts, so the run's artifact list has a second page.
  run = await seedRun({ count: 51 });
  hidden = await seedRun({ source: "other-test", count: 1 });
  artifact = `a_${run.artifacts[0]!.id}`;
});

describe("kogane.evidence.read", () => {
  it("answers the evidence browser's JSON routes, never /raw", () => {
    expect(PAGE_READ_ROUTES[TOOL]).toEqual([
      "/api/evidence/v1/meta",
      "/api/evidence/v1/sources/:source/runs",
      "/api/evidence/v1/runs/:run/artifacts",
      "/api/evidence/v1/runs/:run/artifacts/:artifact",
    ]);
  });

  it("is listed only to evidence.read over the whole store", async () => {
    const names = async (grant: unknown) =>
      (await pageReadMcpTools(grant as never, pageReadStore(env as Env))).map((tool) => tool.name);
    expect(await names(EVIDENCE_GRANT)).toContain(TOOL);
    expect(await names(RECORDS_GRANT)).not.toContain(TOOL);
    expect(
      await names({ ...EVIDENCE_GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } }),
    ).not.toContain(TOOL);
    expect(await page.listed()).toContain(TOOL);
  });

  it("answers each page exactly as its route, and writes nothing", async () => {
    const before = await tableCounts();
    const firstPage = (await page.route(`${PREFIX}/runs/r_${run.id}/artifacts`)).body as {
      nextCursor: string;
    };
    expect(firstPage.nextCursor).toMatch(/^c_/);
    for (const [query, args] of [
      [`${PREFIX}/meta`, { page: "meta" }],
      [`${PREFIX}/sources/sony-bank/runs`, { page: "runs", source: "sony-bank" }],
      [`${PREFIX}/runs/r_${run.id}/artifacts`, { page: "artifacts", runId: `r_${run.id}` }],
      [
        `${PREFIX}/runs/r_${run.id}/artifacts?cursor=${firstPage.nextCursor}`,
        { page: "artifacts", runId: `r_${run.id}`, cursor: firstPage.nextCursor },
      ],
      [
        `${PREFIX}/runs/r_${run.id}/artifacts/${artifact}`,
        { page: "artifact", runId: `r_${run.id}`, artifactId: artifact },
      ],
    ] as const) {
      const served = await page.expectSameAnswer(query, TOOL, args);
      expect(served.status, query).toBe(200);
      expect(validEvidenceResponse(query.split("?")[0]!, served.body), query).toBe(true);
    }
    expect(await tableCounts()).toEqual(before);
  });

  it("refuses what the route refuses, with the route's code", async () => {
    for (const [query, args, status] of [
      // Another source's run and its artifact are not in the browser.
      [`${PREFIX}/sources/other-test/runs`, { page: "runs", source: "other-test" }, 404],
      [
        `${PREFIX}/runs/r_${hidden.id}/artifacts`,
        { page: "artifacts", runId: `r_${hidden.id}` },
        404,
      ],
      [
        `${PREFIX}/runs/r_${run.id}/artifacts/a_999999999`,
        { page: "artifact", runId: `r_${run.id}`, artifactId: "a_999999999" },
        404,
      ],
      // The route's own query rules: meta and a detail take no query; an
      // unsafe cursor is not an identifier.
      [`${PREFIX}/meta?cursor=c_1`, { page: "meta", cursor: "c_1" }, 400],
      [
        `${PREFIX}/runs/r_${run.id}/artifacts/${artifact}?cursor=c_1`,
        { page: "artifact", runId: `r_${run.id}`, artifactId: artifact, cursor: "c_1" },
        400,
      ],
      [
        `${PREFIX}/sources/sony-bank/runs?cursor=c_9007199254740992`,
        { page: "runs", source: "sony-bank", cursor: "c_9007199254740992" },
        400,
      ],
    ] as [string, Record<string, unknown>, number][]) {
      const refused = await page.expectSameAnswer(query, TOOL, args);
      expect(refused.status, query).toBe(status);
    }
  });

  it("answers 503 source_not_configured on every page while no source is configured", async () => {
    for (const [query, args] of [
      [`${PREFIX}/meta`, { page: "meta" }],
      [`${PREFIX}/sources/sony-bank/runs`, { page: "runs", source: "sony-bank" }],
      [`${PREFIX}/runs/r_${run.id}/artifacts`, { page: "artifacts", runId: `r_${run.id}` }],
      [
        `${PREFIX}/runs/r_${run.id}/artifacts/${artifact}`,
        { page: "artifact", runId: `r_${run.id}`, artifactId: artifact },
      ],
    ] as const) {
      const refused = await unconfigured.expectSameAnswer(query, TOOL, args, EVIDENCE_GRANT);
      expect(refused.status, query).toBe(503);
      expect(refused.body, query).toMatchObject({ error: "source_not_configured" });
    }
  });

  it("refuses an argument outside the closed schema, or a segment the page does not have", async () => {
    for (const [args, refs] of [
      [{}, undefined],
      [{ page: "raw" }, undefined],
      [{ page: "meta", path: "/raw" }, undefined],
      [{ page: "artifact", runId: `r_${run.id}`, artifactId: `${artifact}/raw` }, undefined],
      [{ page: "runs", source: "../meta" }, undefined],
      [{ page: "artifacts", runId: "1" }, undefined],
      [{ page: "runs", source: "sony-bank", cursor: "c_0" }, undefined],
      [{ page: "runs" }, ["source"]],
      [{ page: "artifacts" }, ["runId"]],
      [{ page: "artifact", runId: `r_${run.id}` }, ["artifactId"]],
      [{ page: "meta", source: "sony-bank" }, ["source"]],
      [{ page: "runs", source: "sony-bank", runId: `r_${run.id}` }, ["runId"]],
    ] as [Record<string, unknown>, string[] | undefined][]) {
      const overHttp = await page.http(TOOL, args);
      expect(overHttp.status, JSON.stringify(args)).toBe(400);
      expect(overHttp.body).toMatchObject({ error: "invalid_request", ...(refs ? { refs } : {}) });
      const overMcp = await page.mcp(TOOL, args);
      expect(overMcp).toEqual({ isError: true, body: overHttp.body });
    }
  });

  it("refuses a grant without evidence.read or narrower than the whole store", async () => {
    for (const [grant, expected] of [
      [RECORDS_GRANT, { code: "unauthorized", refs: ["capability:evidence.read"] }],
      [
        { ...EVIDENCE_GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } },
        { code: "evidence_restricted", refs: ["scope:source"] },
      ],
    ] as const) {
      // No deployment configures such a grant (ADR 0084), so it is given to
      // the shared service both transports call.
      const answer = await page.direct(TOOL, { page: "meta" }, grant);
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject(expected);
    }
  });

  it("records each agent call as an R0 read under evidence.read, a cursor marking more", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const args = { page: "artifacts", runId: `r_${run.id}` };
    expect((await page.http(TOOL, args)).status).toBe(200);
    expect((await page.mcp(TOOL, args)).isError).toBe(false);
    const rows = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='evidence.read' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    const diff = JSON.stringify({ kind: "read", rows: 50, truncated: true });
    expect(rows).toEqual([
      { path: "agent-http", risk_class: "R0", result: "read", diff_json: diff },
      { path: "mcp", risk_class: "R0", result: "read", diff_json: diff },
    ]);
  });
});
