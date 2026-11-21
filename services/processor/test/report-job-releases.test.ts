// The report id is a digest of the input manifest, and the job reuses a stored
// report by that id. So the manifest names the release of every piece of code
// that turns the stored inputs into the body: the snapshot price selection,
// ADR 0020's closed rule list, the holding valuation and the body build. A
// later build with any of them changed gets a new report, never the body the
// earlier code computed (INV09; ADR 0072, amendment of 2026-11-19). Every row
// is synthetic: a made-up account, security code, quantity and price.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { sha256Hex } from "../../../packages/domain/src/context.ts";
import { HOLDING_VALUATION_RELEASE } from "../../../packages/domain/src/calculation.ts";
import { PRICE_RULE_IDS } from "../../../packages/domain/src/price-sources.ts";
import { REPORT_BODY_SCHEMA_VERSION } from "../../../packages/domain/src/reports.ts";
import { validReportExplanationNode } from "../../../packages/observation-shared/src/report-artifact-contract.ts";
import {
  REPORT_BUILD_RELEASE,
  reportBuildReleases,
  runReportJob,
  SNAPSHOT_PRICE_RELEASE,
  SNAPSHOT_PRICE_SQL,
  type ReportBuildReleases,
  type ReportJobEnv,
} from "../src/report-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
let jobEnv: ReportJobEnv;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  jobEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" };
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const options = {
  actor: "report-job",
  now: "2026-09-08T00:00:00.000Z",
  unitRef: "JPY",
  perimeterRef: "perimeter:test",
  knowledgeCutoff: "2026-12-31T00:00:00.000Z",
  decimalPolicyRelease: "decimal-v1",
};

/** One published synthetic position and a price claimed from its own snapshot. */
async function seedValuedPosition(id: number, code: string): Promise<void> {
  await seedArtifact(env, id, "other-test", "positions", `positions-${id}.json`, { synthetic: id });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'synthetic-positions','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(id)
    .first<{ id: number }>();
  await publishParse(env.DB, parse!.id);
  const position = await env.DB.prepare(
    `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     VALUES (?,'synthetic-account',?,'3',0,'$','{}') RETURNING id`,
  )
    .bind(parse!.id, code)
    .first<{ id: number }>();
  const priceId = `price:${code}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO price_observations
          (id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,
           quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,
           market_ref,adjustment_policy_ref,recorded_at)
         VALUES (?,?,'1',0,'JPY','500',0,'nav',?,?,NULL,NULL,'2026-09-01T00:00:00.000Z')`,
    ).bind(
      priceId,
      `instrument:other-test:-:${code}`,
      JSON.stringify({
        kind: "instant",
        value: "2026-09-01T00:00:00.000Z",
        zone: "UTC",
        basis: "collector",
      }),
      `claim:${priceId}`,
    ),
    env.DB.prepare(
      `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
       VALUES (?,'sbi-foreign-stock-price-last-v1','position',?,?,?,'2026-09-01T00:00:00.000Z')`,
    ).bind(priceId, position!.id, parse!.id, `$.synthetic.${code}`),
  ]);
}

async function artifactCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  return row!.n;
}

test("the shipped releases are the ones the manifest names", () => {
  expect(reportBuildReleases()).toEqual({
    priceSelectionRelease: SNAPSHOT_PRICE_RELEASE,
    priceRuleIds: [...PRICE_RULE_IDS].sort(),
    valuationRelease: HOLDING_VALUATION_RELEASE,
    reportBuildRelease: REPORT_BUILD_RELEASE,
  });
  // A body schema bump changes the build release with it.
  expect(REPORT_BUILD_RELEASE.startsWith(`${REPORT_BODY_SCHEMA_VERSION}:`)).toBe(true);
});

test("the snapshot price text is pinned to its release", async () => {
  // Changing SNAPSHOT_PRICE_SQL can choose another price for the same rows.
  // Bump SNAPSHOT_PRICE_RELEASE with it, then update both values here.
  expect(SNAPSHOT_PRICE_RELEASE).toBe("report-snapshot-price-v1");
  expect(await sha256Hex(SNAPSHOT_PRICE_SQL)).toBe(
    "0518e57c53280ab69c6f8075e03d53f9ee6454a703f42ff84bf0ddb876f6855e",
  );
});

test("a later build with any release changed writes a new report and never reuses the old body", async () => {
  await seedValuedPosition(8101, "SYN-REL");

  const first = await runReportJob(jobEnv, options);
  expect(first).toMatchObject({ generated: 1, reused: 0, partition: "complete" });
  const firstArtifact = await env.DB.prepare(
    "SELECT report_id,context_id,content_digest FROM report_artifacts WHERE report_id=?",
  )
    .bind(first.reportId)
    .first();

  // The same inputs under the same code reuse the stored report.
  const again = await runReportJob(jobEnv, { ...options, now: "2026-09-08T00:05:00.000Z" });
  expect(again).toMatchObject({ generated: 0, reused: 1, reportId: first.reportId });

  // The explanation names the releases this build ships.
  const node: unknown = JSON.parse(
    await (await env.EVIDENCE.get(`reports/${first.contentDigest}.explanation`))!.text(),
  );
  expect(validReportExplanationNode(node)).toBe(true);
  expect((node as { inputManifest: unknown }).inputManifest).toMatchObject({
    schemaVersion: "report-inputs-v2",
    ...reportBuildReleases(),
  });

  const shipped = reportBuildReleases();
  const later: [string, ReportBuildReleases][] = [
    ["price selection", { ...shipped, priceSelectionRelease: "report-snapshot-price-v2" }],
    // A rule added to the closed list that matches no stored claim: the same
    // price is chosen, and only the list tells the builds apart.
    ["price rules", { ...shipped, priceRuleIds: [...shipped.priceRuleIds, "synthetic-rule-v1"] }],
    ["valuation", { ...shipped, valuationRelease: "holding-valuation-v2" }],
    ["body build", { ...shipped, reportBuildRelease: `${REPORT_BODY_SCHEMA_VERSION}:build-v2` }],
  ];
  const seen = new Set([first.reportId]);
  for (const [name, releases] of later) {
    const before = await artifactCount();
    const result = await runReportJob(jobEnv, options, releases);
    expect({ name, ...result }).toMatchObject({ name, generated: 1, reused: 0 });
    expect(seen.has(result.reportId)).toBe(false);
    expect(result.contextId).not.toBe(first.contextId);
    expect(await artifactCount()).toBe(before + 1);
    seen.add(result.reportId);
    // The later build reuses its own report on the next sweep.
    const repeat = await runReportJob(
      jobEnv,
      { ...options, now: "2026-09-08T00:10:00.000Z" },
      releases,
    );
    expect(repeat).toMatchObject({ generated: 0, reused: 1, reportId: result.reportId });
  }

  // The report the earlier build stored keeps its id, context and body.
  const after = await env.DB.prepare(
    "SELECT report_id,context_id,content_digest FROM report_artifacts WHERE report_id=?",
  )
    .bind(first.reportId)
    .first();
  expect(after).toEqual(firstArtifact);
  expect(await env.EVIDENCE.get(`reports/${first.contentDigest}`)).not.toBeNull();
}, 120_000);
