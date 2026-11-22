// The interpretation context of a positions page names the identity releases
// of the rows the page returns, and of no other row: the reader fetches one
// position past the page to report truncation, and that row is not shown.
// `kogane.observations.list` reads the same reader and answers the same.
// Every row here is synthetic.
import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { observationApi } from "../src/observation-api";
import { NO_RECORDED_IDENTITY_RELEASE } from "../../../packages/read-model/src/index";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness } from "./page-read-harness";

beforeAll(seedRegistry);
/** `kogane.observations.list`, which reads the route's own reader (ADR 0081). */
const tools = pageReadHarness("positions-context");

async function page(path: string) {
  const request = new Request(`https://fixture.test${path}`);
  const response = await observationApi(request, env, new URL(request.url));
  expect(response!.status, path).toBe(200);
  const body = (await response!.json()) as {
    positions: { position: { id: number; source_account: string } }[];
    interpretationContext: { identityRelease: string };
    coverage: { truncated: boolean; nextOffset: number | null };
  };
  expect(validApiResponse("/api/positions", body)).toBe(true);
  return body;
}

/** One published parse run of `source` holding `count` positions of `account`. */
async function seedPositions(source: string, account: string, count: number) {
  const run = await seedRun({ count: 1, source });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,'1','2026-09-07','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id, `positions-context-${source}`)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(
    `INSERT INTO position_observations
      (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?2)
     SELECT ?1,?3,printf('%04d',x),'1',0,CAST(x AS TEXT),'{}' FROM n`,
  )
    .bind(parse!.id, count, account)
    .run();
  return parse!.id;
}

it("names only the identity releases of the positions the page returns", async () => {
  // 500 positions no identity run organized, then one more, which sorts last
  // (its source after theirs) and is the only organized row: its parse's
  // sealed identity run, of policy 1, recorded it.
  await seedPositions("other-test", "plain-account", 500);
  const organizedParse = await seedPositions("sony-bank", "organized-account", 1);
  const last = await env.DB.prepare("SELECT id FROM position_observations WHERE parse_run_id=?")
    .bind(organizedParse)
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO source_accounts VALUES ('pc-ref','sony-bank','evidence-test',?)`,
    ).bind(JSON.stringify(["organized-account"])),
    env.DB.prepare(
      `INSERT INTO accounts VALUES ('pc-account','口座','securities','provider-local')`,
    ),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES ('pc-am1','pc-ref',1,'pc-account','rule','provider-scope',1,'2099','口座','provider-local')`,
    ),
    env.DB.prepare(`INSERT INTO identity_runs VALUES ('pc-run',?,1,'2099')`).bind(organizedParse),
    env.DB.prepare(
      `INSERT INTO identity_observations VALUES ('pc-io','pc-run','position',?,'pc-ref','pc-am1','[]')`,
    ).bind(last!.id),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES ('pc-run',1,'2099')`),
  ]);

  const first = await page("/api/positions?identityRead=as-recorded");
  expect(first.positions).toHaveLength(500);
  expect(first.coverage).toMatchObject({ truncated: true, nextOffset: 500 });
  expect(first.positions.every((row) => row.position.source_account === "plain-account")).toBe(
    true,
  );
  // No returned row was organized by an identity run, so the page names none.
  expect(first.interpretationContext.identityRelease).toBe(NO_RECORDED_IDENTITY_RELEASE);

  const second = await page("/api/positions?identityRead=as-recorded&offset=500");
  expect(second.positions.map((row) => row.position.id)).toEqual([last!.id]);
  expect(second.interpretationContext.identityRelease).toBe("identity-default-v1");

  // The MCP list answers both pages as the route does, the same context included.
  for (const [path, offset, release] of [
    ["/api/positions?identityRead=as-recorded", 0, NO_RECORDED_IDENTITY_RELEASE],
    ["/api/positions?identityRead=as-recorded&offset=500", 500, "identity-default-v1"],
  ] as const) {
    const answer = await tools.expectSameAnswer(path, "kogane.observations.list", {
      kind: "positions",
      identityRead: "as-recorded",
      offset,
    });
    expect(answer.status, path).toBe(200);
    expect(
      (answer.body as { interpretationContext: { identityRelease: string } }).interpretationContext
        .identityRelease,
      path,
    ).toBe(release);
  }
});
