// The paging basis of `kogane.financial.query` over the real read model and
// the real CORE migrations (INV09, ADR 0091). A cursor resumes only while
// every input its rows were read from holds. Two changes move the rows a page
// reads without recording a newer parse run: an activation of an artifact's
// already parsed candidate run, and a run excluded from financial views. Each
// case changes only that input and checks that both the first page and the
// basis its cursor carries change, and that the earlier cursor is refused.
// Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { callTool, toolContext } from "../src/agent-service";
import { decodeCursor } from "../../../packages/application/src/query/cursor";
import type { Grant } from "../../../packages/application/src/index";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const GRANT: Grant = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 500, maxProposalTargets: 5, maxExplainDepth: 3 },
};
const NOW = "2026-09-09T00:00:00Z";
let runA = 0;
let artifactA = 0;
let candidate = 0;
let published = 0;

async function parse(artifact: number, version: string): Promise<number> {
  const row = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'paging-fixture',?,'2026-09-07','ok','[]') RETURNING id`)
    .bind(artifact, version)
    .first<{ id: number }>();
  return row!.id;
}

async function line(parseRun: number, account: string, asOf: string, id: string) {
  await env.DB.prepare(`INSERT INTO transaction_observations
    (parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json,description)
    VALUES (?,?,?,?,1,'JPY','$','{}','synthetic line')`)
    .bind(parseRun, account, id, asOf)
    .run();
}

interface Page {
  contextId: string;
  result: { nextCursor: string | null; data: { rows: { observationRef: string }[] } };
}

async function query(cursor?: string): Promise<{ status: number; body: Page }> {
  const result = await callTool(
    "kogane.financial.query",
    { intent: "activity", limit: 1, ...(cursor === undefined ? {} : { cursor }) },
    toolContext(env as Env, GRANT, NOW),
  );
  return { status: result.status, body: result.body as Page };
}

function basisOf(page: Page): string {
  const cursor = decodeCursor(page.result.nextCursor!);
  expect(cursor).not.toBeNull();
  return cursor!.basisRef;
}

beforeAll(async () => {
  await seedRegistry();
  // Source A: one artifact with its published run and a candidate run of a
  // later parser build that no reader sees until it is activated.
  const a = await seedRun({ count: 1, source: "sony-bank" });
  runA = a.id;
  artifactA = a.artifacts[0]!.id;
  published = await parse(artifactA, "1");
  await publishParse(published);
  await line(published, "paging-a", "2026-09-05", "a-1");
  candidate = await parse(artifactA, "2");
  await line(candidate, "paging-a", "2026-09-06", "a-2");
  // Source B: later artifacts parsed by both builds, so the set of visible
  // parser builds is the same before and after either change, and its last
  // run is the highest visible parse run throughout.
  const b = await seedRun({ count: 2, source: "other-test" });
  for (const [index, version] of [
    [0, "1"],
    [1, "2"],
  ] as const) {
    const other = await parse(b.artifacts[index]!.id, version);
    await publishParse(other);
    await line(other, "paging-b", `2026-09-0${String(2 - index)}`, `b-${String(index)}`);
  }
});

describe("the paging basis moves with every input the rows are read from (INV09)", () => {
  it("keeps the basis while nothing it reads changes", async () => {
    const first = await query();
    const again = await query();
    expect(again.body.result.data.rows).toEqual(first.body.result.data.rows);
    expect(again.body.contextId).toBe(first.body.contextId);
    expect(basisOf(again.body)).toBe(basisOf(first.body));
    const next = await query(first.body.result.nextCursor!);
    expect(next.status).toBe(200);
  });

  it("moves the basis when an older candidate run is activated", async () => {
    const before = await query();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO publication_events
        (fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
        VALUES (?,'paging-fixture',?,?,'activation','fixture-operator','fixture','2026-09-08T00:00:00Z')`).bind(
        artifactA,
        published,
        candidate,
      ),
      env.DB.prepare(`UPDATE published_parse_runs SET parse_run_id=?,parser_version='2',
        publication_kind='activation' WHERE fetch_artifact_id=? AND parser_name='paging-fixture'`).bind(
        candidate,
        artifactA,
      ),
    ]);
    const after = await query();
    // The answer moved: the activated run's line is the newest one now.
    expect(after.body.result.data.rows).not.toEqual(before.body.result.data.rows);
    // At one evaluation clock the context id moves too, not only the basis.
    expect(after.body.contextId).not.toBe(before.body.contextId);
    expect(basisOf(after.body)).not.toBe(basisOf(before.body));
    const resumed = await query(before.body.result.nextCursor!);
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ code: "stale_context" });
  });

  it("moves the basis when a run is excluded from financial views", async () => {
    const before = await query();
    await env.DB.prepare(`INSERT INTO fetch_run_annotations
      (fetch_run_id,annotation_kind,reason_code,recorded_at_ms)
      VALUES (?,'exclude_from_financial_views','fixture-exclusion',0)`)
      .bind(runA)
      .run();
    const after = await query();
    // Source A's line is gone; source B's newest line leads the list now.
    expect(after.body.result.data.rows).not.toEqual(before.body.result.data.rows);
    // At one evaluation clock the context id moves too, not only the basis.
    expect(after.body.contextId).not.toBe(before.body.contextId);
    expect(basisOf(after.body)).not.toBe(basisOf(before.body));
    const resumed = await query(before.body.result.nextCursor!);
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ code: "stale_context" });
  });
});
