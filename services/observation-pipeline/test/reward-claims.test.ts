// Reward bucket promotion (A11): migration 0033 plus the promotion job.
// Every value here is synthetic. The job promotes rows that are already
// published; no parser is invoked and no observation is rewritten.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { runScheduled } from "../src/worker.ts";
import {
  observedExpiry,
  promoteRewardClaims,
  rewardClaimsEnabled,
  REWARD_PROMOTION_RELEASE,
} from "../src/reward-claims-job.ts";
import {
  applyMigration,
  layerBMigrations,
  publishParse,
  seedArtifact,
  startPipeline,
} from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

interface ClaimRow {
  bucket_ref: string;
  bucket_kind: string;
  program_id: string;
  holding_ref: string;
  unit_ref: string;
  quantity_coefficient: string | null;
  quantity_status: string;
  restriction_refs_json: string;
  observed_expiry_json: string | null;
}

async function seedParse(
  id: number,
  source: string,
  parser: string,
  dataset: string,
): Promise<number> {
  await seedArtifact(env, id, source, dataset, `${dataset}.json`, { synthetic: true });
  const run = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,?,'1.0.0','2026-09-08T00:00:00.000Z','ok','[]') RETURNING id`,
  )
    .bind(id, parser)
    .first<{ id: number }>();
  return run!.id;
}

async function seedBalance(
  parseRunId: number,
  sourceAccount: string,
  metric: string,
  amount: number,
  instrument: string,
  extra: Record<string, unknown>,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO balance_observations
     (parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
     VALUES(?,?,?,?,?,0,?,'2026-09-08','2026-09-08T00:00:00.000Z','$',?) RETURNING id`,
  )
    .bind(
      parseRunId,
      sourceAccount,
      metric,
      amount,
      String(amount),
      instrument,
      JSON.stringify(extra),
    )
    .first<{ id: number }>();
  return row!.id;
}

const claims = async (programId: string): Promise<ClaimRow[]> =>
  (
    await env.DB.prepare(
      `SELECT bucket_ref,bucket_kind,program_id,holding_ref,unit_ref,quantity_coefficient,
       quantity_status,restriction_refs_json,observed_expiry_json
       FROM reward_bucket_claims WHERE program_id=? ORDER BY id`,
    )
      .bind(programId)
      .all<ClaimRow>()
  ).results;

test("migration 0033 seeds only programmes with a documented unit and refuses an unverified computable rule", async () => {
  const programs = (
    await env.DB.prepare(
      "SELECT program_id,unit_ref,holding_kind FROM reward_programs ORDER BY program_id",
    ).all<{ program_id: string; unit_ref: string; holding_kind: string }>()
  ).results;
  expect(programs).toEqual([
    {
      program_id: "program:mobile-suica-sf",
      unit_ref: "JPY",
      holding_kind: "prepaid-balance",
    },
    { program_id: "program:v-point", unit_ref: "points:v-point", holding_kind: "reward-points" },
    {
      program_id: "program:v-point-pay",
      unit_ref: "JPY",
      holding_kind: "prepaid-balance",
    },
  ]);
  const rules = (
    await env.DB.prepare(
      "SELECT rule_id,family,verification,deadline_calendar_ref FROM expiry_rules ORDER BY rule_id",
    ).all<{
      rule_id: string;
      family: string;
      verification: string;
      deadline_calendar_ref: string;
    }>()
  ).results;
  expect(rules).toEqual([
    {
      rule_id: "rule:mobile-suica-sf:validity",
      family: "unsupported",
      verification: "needs-rule-verification",
      deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
    },
    {
      rule_id: "rule:v-point-pay:prepaid-validity",
      family: "unsupported",
      verification: "needs-rule-verification",
      deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
    },
    {
      rule_id: "rule:v-point:fixed-expiry-lot",
      family: "fixed-lot",
      verification: "verified",
      deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
    },
    {
      rule_id: "rule:v-point:regular-inactivity",
      family: "inactivity",
      verification: "verified",
      deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
    },
  ]);
  // No conversion offer is seeded: the one candidate route is search-excerpt
  // evidence only and could not be simulated.
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM conversion_offers").first<number>("n"),
  ).toBe(0);
  // The CHECK forbids an unverified rule that would still compute a deadline.
  await expect(
    env.DB.prepare(
      `INSERT INTO expiry_rules(rule_id,version,family,program_id,applicability_json,
       qualifying_activity_policy_ref,deadline_calendar_ref,priority_policy_ref,evidence_refs_json,verification,recorded_at)
       VALUES('rule:bad','v1','inactivity','program:v-point','{}','policy:x','Asia/Tokyo:end-of-day:assumed',NULL,'[]','needs-rule-verification','2026-09-09')`,
    ).run(),
  ).rejects.toThrow();
  // An inactivity rule without a qualifying-activity policy is refused too.
  await expect(
    env.DB.prepare(
      `INSERT INTO expiry_rules(rule_id,version,family,program_id,applicability_json,
       qualifying_activity_policy_ref,deadline_calendar_ref,priority_policy_ref,evidence_refs_json,verification,recorded_at)
       VALUES('rule:bad2','v1','inactivity','program:v-point','{}',NULL,'Asia/Tokyo:end-of-day:assumed',NULL,'[]','verified','2026-09-09')`,
    ).run(),
  ).rejects.toThrow();
});

test("reference and claim tables are append-only; the projections are not", async () => {
  for (const sql of [
    "UPDATE reward_programs SET unit_ref='x' WHERE program_id='program:v-point'",
    "DELETE FROM reward_programs WHERE program_id='program:v-point'",
    "UPDATE expiry_rules SET family='none' WHERE rule_id='rule:v-point:regular-inactivity'",
    "DELETE FROM expiry_rules WHERE rule_id='rule:v-point:regular-inactivity'",
  ])
    await expect(env.DB.prepare(sql).run()).rejects.toThrow();
  await env.DB.prepare(
    `INSERT INTO expiry_estimates(holding_ref,rule_id,rule_version,context_id,state,
     expiring_buckets_json,uncertainty_codes_json,source_expiry_refs_json,policy_release,computed_at)
     VALUES('holding:x','rule:v-point:regular-inactivity','v1','ctx:1','partial','[]','["history_incomplete"]','[]','reward-model-v1','2026-09-09')`,
  ).run();
  // A projection is rebuildable, so it may be replaced in place.
  await env.DB.prepare(
    "UPDATE expiry_estimates SET state='computed' WHERE holding_ref='holding:x'",
  ).run();
  await env.DB.prepare("DELETE FROM expiry_estimates WHERE holding_ref='holding:x'").run();
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM expiry_estimates").first<number>("n"),
  ).toBe(0);
});

test("V Point buckets promote by restriction and by whether the provider dated them", async () => {
  const parse = await seedParse(900, "v-point", "v-point-balance-info", "balance-info");
  await seedBalance(parse, "v-point:common:bucket-0", "available_point_bucket", 300, "V_POINT", {
    _kogane: { asset: "v_point", expiration: "", pointTypeMeaning: "unmapped-provider-enum" },
  });
  await seedBalance(parse, "v-point:common:bucket-1", "available_point_bucket", 500, "V_POINT", {
    _kogane: { asset: "v_point", expiration: "20261231" },
  });
  await seedBalance(
    parse,
    "v-point:store-limited:group-0:item-0",
    "available_point_bucket",
    120,
    "V_POINT",
    { _kogane: { asset: "v_point", expiration: "2026/11/30" } },
  );
  // Not a holding: last month's earnings become a qualification bucket.
  const smfg = await seedParse(901, "v-point", "v-point-smfg-point", "smfg-point");
  await seedBalance(smfg, "v-point:smfg:smbc", "displayed_point_balance", 42, "V_POINT", {
    _kogane: { asset: "v_point", providerBreakdownMeaning: "not-inferred" },
  });
  await publishParse(env.DB, parse);
  await publishParse(env.DB, smfg);

  const result = await promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" });
  expect(result.promoted).toBe(4);
  const rows = await claims("program:v-point");
  expect(
    rows.map((row) => [
      row.bucket_kind,
      row.quantity_coefficient,
      row.unit_ref,
      JSON.parse(row.restriction_refs_json),
      row.observed_expiry_json === null ? null : JSON.parse(row.observed_expiry_json),
    ]),
  ).toEqual([
    ["regular", "300", "points:v-point", [], null],
    [
      "time-limited",
      "500",
      "points:v-point",
      [],
      { kind: "local-date", value: "2026-12-31", zone: "Asia/Tokyo", basis: "provider" },
    ],
    [
      "restricted",
      "120",
      "points:v-point",
      ["restriction:v-point:store-limited"],
      { kind: "local-date", value: "2026-11-30", zone: "Asia/Tokyo", basis: "provider" },
    ],
    ["qualification", "42", "points:v-point", ["measure:v-point:previous-month-earned"], null],
  ]);
  expect(rows.every((row) => row.quantity_status === "exact")).toBe(true);
});

test("prepaid balances promote under their own programme and keep the JPY unit", async () => {
  const pay = await seedParse(902, "v-point-pay", "v-point-pay-notification-event", "notification");
  await seedBalance(pay, "v-point-pay:prepaid-yen", "prepaid_balance_after_event", 3000, "JPY", {
    _kogane: { balanceScope: "v-point-pay-prepaid-yen" },
  });
  const suica = await seedParse(903, "mobile-suica", "mobile-suica-sf-history", "sf-history");
  await seedBalance(suica, "mobile-suica:sf", "sf_balance_after_transaction", 1500, "JPY", {
    _kogane: { canonicalDataset: "sf-history" },
  });
  await publishParse(env.DB, pay);
  await publishParse(env.DB, suica);
  await promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" });
  expect(
    (await claims("program:v-point-pay")).map((row) => [row.bucket_kind, row.quantity_coefficient]),
  ).toEqual([["regular", "3000"]]);
  expect(
    (await claims("program:mobile-suica-sf")).map((row) => [
      row.bucket_kind,
      row.quantity_coefficient,
      row.holding_ref,
      row.bucket_ref,
    ]),
  ).toEqual([
    ["regular", "1500", "program:mobile-suica-sf:sf", "program:mobile-suica-sf:mobile-suica:sf"],
  ]);
});

test("promotion is idempotent: re-running adds nothing and a release bump promotes afresh", async () => {
  const before =
    (await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims").first<number>("n")) ??
    0;
  const again = await promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" });
  expect(again.promoted).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims").first<number>("n"),
  ).toBe(before);
  // Running the same batch twice concurrently must also be a no-op the second time.
  await Promise.all([
    promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" }),
    promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" }),
  ]);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims").first<number>("n"),
  ).toBe(before);
  const bumped = await promoteRewardClaims(env.DB, {
    release: "reward-promotion-v2-test",
    now: "2026-09-09T00:00:00.000Z",
  });
  expect(bumped.promoted).toBe(before);
  expect(REWARD_PROMOTION_RELEASE).toBe("reward-promotion-v1");
});

test("an unpublished parse run is never promoted, at the job and at the trigger", async () => {
  const parse = await seedParse(904, "v-point", "v-point-balance-info", "balance-info");
  const observation = await seedBalance(
    parse,
    "v-point:common:bucket-0",
    "available_point_bucket",
    999,
    "V_POINT",
    { _kogane: { expiration: "" } },
  );
  const result = await promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" });
  expect(result.promoted).toBe(0);
  await expect(
    env.DB.prepare(
      `INSERT INTO reward_bucket_claims(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
       program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
       quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,promotion_release,recorded_at)
       VALUES('digest-unpublished',?,'balance',?,'program:v-point','h','b','regular','[]','points:v-point','1',0,'exact',NULL,'2026-09-09','x','2026-09-09')`,
    )
      .bind(parse, observation)
      .run(),
  ).rejects.toThrow();
});

test("an unreadable provider expiry stays listed as unknown and is never invented", () => {
  expect(observedExpiry("20261231", "Asia/Tokyo")).toEqual({
    kind: "local-date",
    value: "2026-12-31",
    zone: "Asia/Tokyo",
    basis: "provider",
  });
  expect(observedExpiry("2026年3月1日", "Asia/Tokyo")).toEqual({
    kind: "local-date",
    value: "2026-03-01",
    zone: "Asia/Tokyo",
    basis: "provider",
  });
  expect(observedExpiry("当月末まで", "Asia/Tokyo")).toEqual({
    kind: "unknown",
    reasonCode: "provider_expiry_unparsed",
  });
  expect(observedExpiry("", "Asia/Tokyo")).toBeNull();
  expect(observedExpiry(undefined, "Asia/Tokyo")).toBeNull();
});

test("the scheduled lane never runs while the flag is off", async () => {
  // Anything but an explicit "1"/"true" is off, including an absent binding.
  expect(rewardClaimsEnabled(env.REWARD_CLAIMS_ENABLED)).toBe(false);
  expect(rewardClaimsEnabled(undefined)).toBe(false);
  expect(rewardClaimsEnabled("false")).toBe(false);
  expect(rewardClaimsEnabled("1")).toBe(true);
  const lines: Record<string, unknown>[] = [];
  await runScheduled(env, undefined, (line) => lines.push(JSON.parse(line)));
  expect(lines.map((line) => line.event)).toEqual(["observation_sweep", "identity_sweep"]);

  const enabled = { ...env, REWARD_CLAIMS_ENABLED: "true" } as unknown as Env;
  expect(rewardClaimsEnabled(enabled.REWARD_CLAIMS_ENABLED)).toBe(true);
  lines.length = 0;
  await runScheduled(enabled, undefined, (line) => lines.push(JSON.parse(line)));
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "identity_sweep",
    "reward_claims_sweep",
  ]);
  // Counts and identifiers only: no amount, account label or provider text.
  expect(Object.keys(lines[2]!).sort()).toEqual([
    "cursor",
    "enabled",
    "event",
    "promoted",
    "release",
    "scanned",
    "skipped",
  ]);
}, 60000);

test("migration 0033 applies on the earlier Layer B schema with rows already present", async () => {
  const earlier = layerBMigrations().filter((name) => !name.startsWith("0033_"));
  const upgrade = await startPipeline(earlier);
  try {
    await seedArtifact(upgrade.env, 10, "v-point", "balance-info", "balance-info.json", {
      synthetic: true,
    });
    const parse = await upgrade.env.DB.prepare(
      `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES(10,'v-point-balance-info','1.0.0','2026-09-08','ok','[]') RETURNING id`,
    ).first<{ id: number }>();
    await upgrade.env.DB.prepare(
      `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,'v-point:common:bucket-0','available_point_bucket',700,'700',0,'V_POINT','2026-09-08','2026-09-08','$','{"_kogane":{"expiration":""}}')`,
    )
      .bind(parse!.id)
      .run();
    await publishParse(upgrade.env.DB, parse!.id);
    const observationsBefore = await upgrade.env.DB.prepare(
      "SELECT count(*) AS n FROM balance_observations",
    ).first<number>("n");

    await applyMigration(upgrade.env.DB, "0033_reward_buckets.sql");

    // Existing evidence is untouched and the new tables start empty.
    expect(
      await upgrade.env.DB.prepare("SELECT count(*) AS n FROM balance_observations").first<number>(
        "n",
      ),
    ).toBe(observationsBefore);
    expect(
      await upgrade.env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims").first<number>(
        "n",
      ),
    ).toBe(0);
    const promoted = await promoteRewardClaims(upgrade.env.DB, {
      now: "2026-09-09T00:00:00.000Z",
    });
    expect(promoted.promoted).toBe(1);
  } finally {
    await upgrade.mf.dispose();
  }
}, 60000);
