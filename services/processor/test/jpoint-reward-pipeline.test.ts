// Synthetic SOURCE -> total-only claims -> bounded same-input provider READ sections.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { startPipeline, seedArtifact, seedUnitRun, publishParse } from "./harness.ts";
import { promoteRewardClaims } from "../src/reward-claims-job.ts";
import { captureRewardInput, runRewardReadProjection } from "../src/reward-read-projection.ts";
import { rewardProviderSections } from "../../../packages/storage-d1/src/read/reward-provider-expiry.ts";
import { createRewardReader } from "../../../packages/read-model/src/rewards.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import type { RewardProviderExpiryDisplayMetadata } from "../../../packages/domain/src/reward-expiry-observations.ts";
let mf: Miniflare;
let env: Env;
beforeAll(async () => ({ mf, env } = await startPipeline()), 30000);
afterAll(async () => await mf?.dispose());
let id = 9600;
const observed: RewardProviderExpiryDisplayMetadata = {
  coverage: "observed",
  reasonCode: null,
  displays: [
    {
      displayRef: "total-expiring-subset",
      scope: "holding-subset",
      quantity: {
        unitRef: "points:j-point",
        value: {
          status: "exact",
          value: { coefficient: "200", scale: 0 },
          normalizationVersion: "decimal-v1",
        },
      },
      expires: { kind: "local-date", value: "2099-12-31", zone: "Asia/Tokyo", basis: "provider" },
      rawLocator: "json:$.total.expiry",
    },
  ],
};
async function seed(
  conn: string,
  day: number,
  metadata: unknown,
  total: string | null = "1000",
  publish = true,
) {
  const artifact = ++id;
  await seedArtifact(env, artifact, "myjcb", "jpoint-balance", `${conn}/jpoint-balance.json`, {
    synthetic: true,
  });
  const parse = (await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'myjcb-jpoint-balance','1.0.0',?,'ok','[]') RETURNING id",
  )
    .bind(artifact, `2099-01-${String(day).padStart(2, "0")}T00:00:00.000Z`)
    .first<{ id: number }>())!.id;
  const fact = (await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json) VALUES(?,?,'displayed_jpoint_total',?,0,'J_POINT',?,'json:$.total',?) RETURNING id`,
  )
    .bind(
      parse,
      `myjcb:${conn}:j-point:total`,
      total,
      `2099-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      JSON.stringify({ _kogane: { rewardExpiryDisplays: metadata } }),
    )
    .first<{ id: number }>())!.id;
  if (publish) await publishParse(env.DB, parse);
  return { parse, fact };
}
const at = "2099-02-01T00:00:00.000Z";
const run = (writeBudget: number) =>
  runRewardReadProjection({ ...env, REWARD_READ_PROJECTION_ENABLED: "true" } as Env, env.DATA, {
    now: () => at,
    writeBudget,
  });
test("bounded resume fixes original subset, new missing/not-displayed replaces it without a remainder", async () => {
  const first = await seed("conn-a", 1, observed);
  await seed("conn-b", 1, {
    coverage: "unknown",
    reasonCode: "provider_expiry_unavailable",
    displays: [],
  });
  const pending = await seed("conn-c", 1, observed, "1000", false);
  expect((await promoteRewardClaims(env.DB)).promoted).toBe(2);
  expect((await promoteRewardClaims(env.DB)).promoted).toBe(0);
  const holdings = await createRewardReader(d1Executor(env.DB)).holdings({
    programId: "program:j-point",
    offset: 0,
  });
  expect(holdings.rows).toHaveLength(2);
  expect(holdings.rows[0]!.holding.buckets).toHaveLength(1);
  expect(holdings.rows[0]!.holding.buckets[0]!.observedExpiry).toBeNull();
  expect(holdings.rows[0]!.holding.buckets[0]!.quantity.value).toMatchObject({
    status: "exact",
    value: { coefficient: "1000" },
  });
  const captured = await captureRewardInput(env.DB, { now: () => at });
  expect(captured.ok).toBe(true);
  if (!captured.ok) throw new Error("capture");
  expect(captured.captured.input.content.providerSections?.[0]?.sourceFactRefs).toEqual([
    `balance:${first.fact}`,
  ]);
  const building = await run(1);
  expect(building.status).toBe("building");
  expect(await rewardProviderSections(env.READ, building.snapshotId!)).toEqual([]);
  await seed(
    "conn-a",
    2,
    { coverage: "not-displayed", reasonCode: "provider_expiry_not_displayed", displays: [] },
    null,
  );
  await promoteRewardClaims(env.DB);
  const resumed = await run(1);
  expect(resumed.status).toBe("complete");
  const fixed = await rewardProviderSections(env.READ, resumed.snapshotId!);
  expect(fixed[0]!.displays[0]!.quantity.value).toMatchObject({
    status: "exact",
    value: { coefficient: "200" },
  });
  expect(fixed[0]!.sourceFactRefs).toEqual([`balance:${first.fact}`]);
  const newer = await run(5);
  expect(newer.status).toBe("complete");
  expect(newer.snapshotId).not.toBe(resumed.snapshotId);
  const next = await rewardProviderSections(env.READ, newer.snapshotId!);
  expect(next[0]!.coverage).toBe("not-displayed");
  expect(next[0]!.displays).toEqual([]);
  expect(next[1]!.coverage).toBe("unknown");
  expect(next.some((s) => s.sourceFactRefs.includes(`balance:${pending.fact}`))).toBe(false);
  const nowHoldings = await createRewardReader(d1Executor(env.DB)).holdings({
    programId: "program:j-point",
    offset: 0,
  });
  expect(nowHoldings.rows[0]!.holding.buckets[0]!.quantity.value.status).toBe("missing");
});

test("successful reward unit on partial parent promotes while failed sibling remains unavailable", async () => {
  await seedUnitRun(env, {
    id: 9700,
    source: "myjcb",
    dataset: "jpoint-balance",
    runOutcome: "partial",
    units: [
      {
        id: 9701,
        key: "unit-good:j-point",
        kind: "reward-balance",
        outcome: "success",
        artifacts: [
          { id: 9701, key: "unit-good/jpoint-balance.json", payload: { synthetic: "good" } },
        ],
      },
      {
        id: 9702,
        key: "unit-failed:j-point",
        kind: "reward-balance",
        outcome: "failed",
        failureCode: "unavailable",
        artifacts: [
          { id: 9702, key: "unit-failed/jpoint-balance.json", payload: { synthetic: "failed" } },
        ],
      },
    ],
  });
  for (const [artifact, connection] of [
    [9701, "unit-good"],
    [9702, "unit-failed"],
  ] as const) {
    const parse = (await env.DB.prepare(
      "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'myjcb-jpoint-balance','1.0.0','2099-01-03T00:00:00.000Z','ok','[]') RETURNING id",
    )
      .bind(artifact)
      .first<{ id: number }>())!.id;
    await env.DB.prepare(
      "INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json) VALUES(?,?,'displayed_jpoint_total','300',0,'J_POINT','2099-01-03T00:00:00.000Z','json:$.total','{}')",
    )
      .bind(parse, `myjcb:${connection}:j-point:total`)
      .run();
    await publishParse(env.DB, parse);
  }
  expect((await promoteRewardClaims(env.DB)).promoted).toBe(1);
  const claims = await env.DB.prepare(
    "SELECT holding_ref FROM reward_bucket_claims_v2 WHERE holding_ref LIKE '%unit-%' ORDER BY holding_ref",
  ).all<{ holding_ref: string }>();
  expect(claims.results.map((r) => r.holding_ref)).toEqual([
    "program:j-point:myjcb:unit-good:j-point:total",
  ]);
});
