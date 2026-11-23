// The paging conformance walk (ADR 0128 slice S6) over the two candidate
// reviews: `kogane.accounts.candidates` (the unreviewed aggregator accounts of
// a synthetic MoneyForward source) and `kogane.instruments.candidates` (open
// candidates of a synthetic SBI Securities capture, identified by the
// production identity writer). Each is walked over `/mcp` by merging
// `next.arguments` into the last call until `next` is null, with every page
// the same answer on its route, on the agent HTTP path and on `/mcp`, and
// with `next` and `paging` that agree with the deprecated `nextOffset`. A
// page whose next page the grant's `maxRows` refuses says so
// (`stoppedBy: "budget"`, `next` null), where it was silent before S6.
// Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { walkPages } from "../../../packages/observation-shared/test-support/paging-walk";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { ACCOUNT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/account-candidates-contract";
import { INSTRUMENT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/instrument-candidates-contract";
import { identifyParse } from "../../processor/src/identity-store";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness } from "./page-read-harness";

const page = pageReadHarness("paging-conformance-candidates");

/** Unreviewed aggregator source accounts: a page of 50 and a short one. */
const ACCOUNTS = 57;
/** Codes held on a mapped venue and traded on one the rule does not map: one open candidate each. */
const CODES = 53;
const accountIds: string[] = [];

const GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 1 },
};
const withMaxRows = (maxRows: number) => ({ ...GRANT, budget: { ...GRANT.budget, maxRows } });

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    ...["moneyforward-me", "sbi-securities"].flatMap((source) => [
      env.DB.prepare(
        "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test',?)",
      ).bind(source),
    ]),
    ...Array.from({ length: ACCOUNTS }, (_, n) => {
      const id = `sa-walk-${String(n).padStart(3, "0")}`;
      accountIds.push(id);
      const key = `moneyforward-account-v2-${n.toString(16).padStart(64, "0")}`;
      return env.DB.prepare(
        "INSERT INTO source_accounts(id,source_id,producer_id,reference_json) VALUES(?,'moneyforward-me','evidence-test',?)",
      ).bind(id, JSON.stringify([`moneyforward-me:${key}`]));
    }),
  ]);

  const artifactId = (await seedRun({ count: 1, source: "sbi-securities" })).artifacts[0]!.id;
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'candidate-walk','1','2099-01-01','ok','[]') RETURNING id`)
    .bind(artifactId)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch(
    Array.from({ length: CODES }, (_, n) => {
      const code = `SYN${String(7100 + n)}`;
      return [
        env.DB.prepare(`INSERT INTO position_observations
          (parse_run_id,source_account,security_code,security_name,market,currency,quantity_text,quantity_scale,raw_locator,extra_json)
          VALUES (?,'sbi-securities:domestic',?,?,'TKY','JPY','1',0,'synthetic','{}')`).bind(
          parse!.id,
          code,
          `Synthetic ${code}`,
        ),
        env.DB.prepare(`INSERT INTO transaction_observations
          (parse_run_id,source_account,currency,raw_locator,extra_json)
          VALUES (?,'sbi-securities:domestic','JPY','synthetic',?)`).bind(
          parse!.id,
          JSON.stringify({
            issueCode: code,
            issueName: `Synthetic ${code}`,
            marketLabel: "SYNTHETIC-VENUE",
            accountLabel: "synthetic",
          }),
        ),
      ];
    }).flat(),
  );
  const verified =
    await env.DB.prepare(`SELECT p.id,a.id artifact_id,a.source_id,r.producer_id,a.fetch_run_id
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN financial_fetch_runs r ON r.id=a.fetch_run_id WHERE p.id=?`)
      .bind(parse!.id)
      .first<{
        id: number;
        artifact_id: number;
        source_id: string;
        producer_id: string;
        fetch_run_id: number;
      }>();
  while (await identifyParse(env.DB, verified!, resolveIdentity)) {
    // Resume the production writer's bounded pages until the run is sealed.
  }
}, 120_000);

/**
 * One page on all three transports: the route under the signed-in reader,
 * the agent HTTP path and `/mcp`. They must give one answer, which the
 * browser's validator accepts; the walk continues from `/mcp`'s.
 */
async function threeWays(tool: string, path: string, args: Record<string, unknown>) {
  const query = new URLSearchParams(
    Object.entries(args).map(([key, value]) => [key, String(value)]),
  ).toString();
  const route = await page.route(`${path}${query === "" ? "" : `?${query}`}`);
  const overHttp = await page.http(tool, args);
  const overMcp = await page.mcp(tool, args);
  const label = `${tool} ${JSON.stringify(args)}`;
  expect(route.status, label).toBe(200);
  expect(overHttp.status, label).toBe(200);
  expect(overMcp.isError, label).toBe(false);
  expect(overHttp.body, label).toEqual(route.body);
  expect(overMcp.body, label).toEqual(route.body);
  const body = overMcp.body as Record<string, any>;
  expect(validApiResponse(path, body), label).toBe(true);
  expect(Object.keys(body).slice(-2), label).toEqual(["next", "paging"]);
  return body;
}

describe("the candidate reviews, walked by next.arguments alone", () => {
  it("kogane.accounts.candidates: every unreviewed aggregator account once across the 50-item page", async () => {
    const walk = await walkPages({
      first: { view: "unreviewed" },
      call: (args) => threeWays("kogane.accounts.candidates", ACCOUNT_CANDIDATES_PATH, args),
      items: (answer) => answer["items"] as { sourceAccountId: string }[],
      id: (item) => item.sourceAccountId,
    });
    expect(walk.calls).toEqual([{ view: "unreviewed" }, { view: "unreviewed", offset: 50 }]);
    expect(walk.withheld).toBe(false);
    expect(walk.items.map((item) => item.sourceAccountId).sort()).toEqual([...accountIds].sort());
  });

  it("kogane.instruments.candidates: every open candidate once across the 50-item page", async () => {
    const walk = await walkPages({
      first: {},
      call: (args) => threeWays("kogane.instruments.candidates", INSTRUMENT_CANDIDATES_PATH, args),
      items: (answer) => answer["items"] as { candidateId: string }[],
      id: (item) => item.candidateId,
    });
    expect(walk.calls).toEqual([{}, { offset: 50 }]);
    expect(walk.withheld).toBe(false);
    expect(walk.items).toHaveLength(CODES);
  });

  it("withholds a next page past the grant's maxRows and says so, where nextOffset alone was silent", async () => {
    for (const [tool, args] of [
      ["kogane.accounts.candidates", { view: "unreviewed" }],
      ["kogane.instruments.candidates", {}],
    ] as const) {
      // 99 rows reach the first page only: the next one would be refused.
      const tight = await page.direct(tool, args, withMaxRows(99));
      expect(tight.status, tool).toBe(200);
      expect(tight.body, tool).toMatchObject({
        nextOffset: null,
        next: null,
        paging: { limit: 50, returned: 50, hasMore: true, stoppedBy: "budget" },
      });
      // The rows beyond are still counted, so the page is not the end.
      expect(tight.body.total, tool).toBeGreaterThan(50);
      const tightWalk = await walkPages({
        first: args,
        call: async (next) => (await page.direct(tool, next, withMaxRows(99))).body,
        items: (answer) => answer["items"] as unknown[],
        id: (item) => JSON.stringify(item),
      });
      expect(tightWalk.withheld, tool).toBe(true);
      expect(tightWalk.calls, tool).toHaveLength(1);
      // 100 rows reach the second page: it is offered, and it is the last.
      const enough = await page.direct(tool, args, withMaxRows(100));
      expect(enough.body, tool).toMatchObject({
        nextOffset: 50,
        next: { arguments: { offset: 50 } },
        paging: { limit: 50, returned: 50, hasMore: true, stoppedBy: "limit" },
      });
      const last = await page.direct(tool, { ...args, offset: 50 }, withMaxRows(100));
      expect(last.body.next, tool).toBeNull();
      expect(last.body.paging, tool).toMatchObject({ limit: 50, hasMore: false, stoppedBy: null });
    }
  });

  it("an offset past the list is an empty last page, not a withheld one", async () => {
    const past = await page.direct(
      "kogane.accounts.candidates",
      { view: "unreviewed", offset: 200 },
      GRANT,
    );
    expect(past.body).toMatchObject({
      items: [],
      nextOffset: null,
      next: null,
      paging: { limit: 50, returned: 0, hasMore: false, stoppedBy: null },
    });
  });
});
