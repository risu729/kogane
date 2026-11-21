// A report whose positions run past the row bound is never `complete`, even
// when every position it does hold is valued: the positions it never read are
// missing from its subtotal (INV05). Every row is synthetic: made-up accounts,
// security codes, quantities and prices.
import { afterAll, expect } from "bun:test";
import { validReportBody, type ReportBody } from "../../../packages/domain/src/reports.ts";
import { runReportJob, type ReportJobEnv } from "../src/report-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { settledTest } from "./support/settle.ts";

// The runtime starts while the module loads, so a case that times out fails
// alone (docs/ci.md, Miniflare under Bun; test/support/settle.ts).
const { mf, env } = await startPipeline();
const jobEnv: ReportJobEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" };
const test = settledTest();
afterAll(async () => {
  await mf.dispose();
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

async function storedBody(contentDigest: string | null): Promise<ReportBody> {
  const object = await env.EVIDENCE.get(`reports/${contentDigest ?? ""}`);
  const body: unknown = JSON.parse(await object!.text());
  expect(validReportBody(body)).toBe(true);
  return body as ReportBody;
}

test("a report cut at its row bound is a partial subtotal even when every row it holds is valued", async () => {
  await seedValuedPosition(8001, "SYN-A");
  await seedValuedPosition(8002, "SYN-B");

  // Both positions fit: every holding is valued and the figure is the whole.
  const whole = await runReportJob(jobEnv, options);
  expect(whole).toMatchObject({ generated: 1, truncated: false, partition: "complete" });
  const wholeBody = await storedBody(whole.contentDigest);
  expect(wholeBody.partition).toBe("complete");
  expect(wholeBody.subtotal).toEqual({ coefficient: "3000", scale: 0 });

  // One position past the bound is never read. The one row held is valued,
  // but its value is not the report's whole figure.
  const cut = await runReportJob(jobEnv, { ...options, maxRows: 1 });
  expect(cut).toMatchObject({ generated: 1, truncated: true });
  expect(cut.partition).toBe("partial-verified-scope");
  const cutBody = await storedBody(cut.contentDigest);
  expect(cutBody.rows).toHaveLength(1);
  expect(cutBody.rows.every((row) => row.valued)).toBe(true);
  expect(cutBody.coverage.truncated).toBe(true);
  expect(cutBody.partition).toBe("partial-verified-scope");
  expect(cutBody.subtotal).toEqual({ coefficient: "1500", scale: 0 });
}, 120_000);

test("the same kept positions with and without positions past the bound are two reports", async () => {
  // Positions page in source, account and security code order, so a position
  // whose code sorts last falls past a bound that kept every earlier one. The
  // kept ids are the same; only the cut differs, and the manifest names it
  // (INV05, INV09; ADR 0072, amendment of 2026-11-19).
  const whole = await runReportJob(jobEnv, options);
  const wholeBody = await storedBody(whole.contentDigest);
  expect(wholeBody.coverage.truncated).toBe(false);
  expect(wholeBody.partition).toBe("complete");
  const kept = wholeBody.rows.length;

  await seedValuedPosition(8009, "SYN-Z");
  const cut = await runReportJob(jobEnv, {
    ...options,
    now: "2026-09-08T00:05:00.000Z",
    maxRows: kept,
  });
  expect(cut).toMatchObject({ generated: 1, reused: 0, truncated: true });
  expect(cut.reportId).not.toBe(whole.reportId);
  expect(cut.partition).toBe("partial-verified-scope");
  const cutBody = await storedBody(cut.contentDigest);
  expect(cutBody.rows.map((row) => row.subjectRef)).toEqual(
    wholeBody.rows.map((row) => row.subjectRef),
  );
  expect(cutBody.coverage.truncated).toBe(true);

  const manifest = async (contentDigest: string | null) =>
    (
      JSON.parse(
        await (await env.EVIDENCE.get(`reports/${contentDigest ?? ""}.explanation`))!.text(),
      ) as { inputManifest: { truncated: boolean; positionObservationIds: number[] } }
    ).inputManifest;
  const wholeManifest = await manifest(whole.contentDigest);
  const cutManifest = await manifest(cut.contentDigest);
  expect(cutManifest.positionObservationIds).toEqual(wholeManifest.positionObservationIds);
  expect([wholeManifest.truncated, cutManifest.truncated]).toEqual([false, true]);
}, 120_000);
