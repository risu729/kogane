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
       FROM reward_bucket_claims_v2 WHERE program_id=? ORDER BY id`,
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

test("reference and claim tables are append-only; retired CORE projections are absent", async () => {
  for (const sql of [
    "UPDATE reward_programs SET unit_ref='x' WHERE program_id='program:v-point'",
    "DELETE FROM reward_programs WHERE program_id='program:v-point'",
    "UPDATE expiry_rules SET family='none' WHERE rule_id='rule:v-point:regular-inactivity'",
    "DELETE FROM expiry_rules WHERE rule_id='rule:v-point:regular-inactivity'",
  ])
    await expect(env.DB.prepare(sql).run()).rejects.toThrow();
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='expiry_estimates'",
    ).first<number>("n"),
  ).toBe(0);
});

test("V Point common buckets stay unclassified with or without expiry; structural restrictions and qualification remain", async () => {
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
    ["unclassified", "300", "points:v-point", [], null],
    [
      "unclassified",
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
    (await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims_v2").first<number>(
      "n",
    )) ?? 0;
  const again = await promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" });
  expect(again.promoted).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims_v2").first<number>("n"),
  ).toBe(before);
  // Running the same batch twice concurrently must also be a no-op the second time.
  await Promise.all([
    promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" }),
    promoteRewardClaims(env.DB, { now: "2026-09-09T00:00:00.000Z" }),
  ]);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims_v2").first<number>("n"),
  ).toBe(before);
  const bumped = await promoteRewardClaims(env.DB, {
    release: "reward-promotion-v2-test",
    now: "2026-09-09T00:00:00.000Z",
  });
  expect(bumped.promoted).toBe(before);
  expect(REWARD_PROMOTION_RELEASE).toBe("reward-promotion-v2");
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
      `INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
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
  // The lane set every other deployment already had: the reward lane is absent,
  // not present-and-empty. The balance projection, collection scan and
  // operation dispatch lanes always report themselves (each is `skipped`
  // while its own flag is off), so they are present here.
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "collection_scan",
    "identity_sweep",
    "balance_projection",
    // Unflagged (ADR 0020).
    "price_promotion",
    "operation_dispatch",
    "decision_outbox",
    // Unflagged (ADR 0064): the audit log's daily overflow aggregate.
    "audit_overflow",
  ]);

  const enabled = { ...env, REWARD_CLAIMS_ENABLED: "true" } as unknown as Env;
  expect(rewardClaimsEnabled(enabled.REWARD_CLAIMS_ENABLED)).toBe(true);
  lines.length = 0;
  await runScheduled(enabled, undefined, (line) => lines.push(JSON.parse(line)));
  // The reward lane runs before the decision outbox, which only the audit
  // overflow aggregate follows.
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "collection_scan",
    "identity_sweep",
    "balance_projection",
    "reward_claims_sweep",
    "price_promotion",
    "operation_dispatch",
    "decision_outbox",
    "audit_overflow",
  ]);
  // Counts and identifiers only: no amount, account label or provider text.
  expect(Object.keys(lines[4]!).sort()).toEqual([
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
  // 0041 adds the revision triggers of these very tables (U16), so it cannot
  // be applied before 0033 creates them; the upgrade applies the pair in
  // order below.
  const earlier = layerBMigrations().filter(
    (name) => name < "0042" && !name.startsWith("0033_") && !name.startsWith("0041_"),
  );
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
    await applyMigration(upgrade.env.DB, "0041_reward_revision_triggers.sql");
    await applyMigration(upgrade.env.DB, "0077_reward_bucket_claims_v2.sql");

    // Existing evidence is untouched and the new tables start empty.
    expect(
      await upgrade.env.DB.prepare("SELECT count(*) AS n FROM balance_observations").first<number>(
        "n",
      ),
    ).toBe(observationsBefore);
    expect(
      await upgrade.env.DB.prepare(
        "SELECT count(*) AS n FROM reward_bucket_claims_v2",
      ).first<number>("n"),
    ).toBe(0);
    const promoted = await promoteRewardClaims(upgrade.env.DB, {
      now: "2026-09-09T00:00:00.000Z",
    });
    expect(promoted.promoted).toBe(1);
  } finally {
    await upgrade.mf.dispose();
  }
}, 60000);

test("migration 0077 preserves legacy claims and re-promotes their original evidence under v2", async () => {
  const upgrade = await startPipeline(
    layerBMigrations().filter((name) => !name.startsWith("0077_")),
  );
  try {
    await seedArtifact(upgrade.env, 11, "v-point", "balance-info", "balance-info.json", {
      synthetic: true,
    });
    const parse = await upgrade.env.DB.prepare(
      `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES(11,'v-point-balance-info','1.0.0','2026-09-08','ok','[]') RETURNING id`,
    ).first<{ id: number }>();
    const originalExtra = JSON.stringify({
      _kogane: { expiration: "20261231", pointTypeMeaning: "unmapped-provider-enum" },
      point_type: "synthetic-unverified-code",
    });
    const observation = await upgrade.env.DB.prepare(
      `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,'v-point:common:bucket-0','available_point_bucket',7,'7',0,'V_POINT','2026-09-08','2026-09-08','$.result.common[0]',?) RETURNING id`,
    )
      .bind(parse!.id, originalExtra)
      .first<{ id: number }>();
    await publishParse(upgrade.env.DB, parse!.id);
    const claimSql = (table: string, kind: string, digest: string) =>
      upgrade.env.DB.prepare(
        `INSERT INTO ${table}(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
         program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
         quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,promotion_release,recorded_at)
         VALUES(?,?,'balance',?,'program:v-point','program:v-point:member','program:v-point:v-point:common:bucket-0',?,'[]','points:v-point','7',0,'exact',NULL,'2026-09-08','reward-promotion-v1','2026-09-09')`,
      ).bind(digest, parse!.id, observation!.id, kind);
    await claimSql("reward_bucket_claims", "time-limited", "legacy-claim").run();
    const legacyBefore = await upgrade.env.DB.prepare("SELECT * FROM reward_bucket_claims").all();
    const evidenceBefore = await upgrade.env.DB.prepare("SELECT * FROM balance_observations").all();
    const revisionBefore = await upgrade.env.DB.prepare(
      "SELECT source_revision FROM core_source_revision WHERE id=1",
    ).first<number>("source_revision");
    await applyMigration(upgrade.env.DB, "0077_reward_bucket_claims_v2.sql");
    expect(
      (await upgrade.env.DB.prepare("SELECT * FROM reward_bucket_claims").all()).results,
    ).toEqual(legacyBefore.results);
    expect(
      (await upgrade.env.DB.prepare("SELECT * FROM balance_observations").all()).results,
    ).toEqual(evidenceBefore.results);
    expect(
      await upgrade.env.DB.prepare(
        "SELECT count(*) AS n FROM reward_bucket_claims_v2",
      ).first<number>("n"),
    ).toBe(0);
    expect(await promoteRewardClaims(upgrade.env.DB)).toMatchObject({
      promoted: 1,
      release: "reward-promotion-v2",
    });
    const promoted = await upgrade.env.DB.prepare(
      `SELECT c.source_fact_kind,c.source_fact_id,c.bucket_kind,c.quantity_coefficient,c.quantity_scale,
       c.observed_expiry_json,c.promotion_release,b.raw_locator,b.extra_json
       FROM reward_bucket_claims_v2 c JOIN balance_observations b ON b.id=c.source_fact_id`,
    ).first();
    expect(promoted).toEqual({
      source_fact_kind: "balance",
      source_fact_id: observation!.id,
      bucket_kind: "unclassified",
      quantity_coefficient: "7",
      quantity_scale: 0,
      observed_expiry_json: JSON.stringify({
        kind: "local-date",
        value: "2026-12-31",
        zone: "Asia/Tokyo",
        basis: "provider",
      }),
      promotion_release: "reward-promotion-v2",
      raw_locator: "$.result.common[0]",
      extra_json: originalExtra,
    });
    expect(
      await upgrade.env.DB.prepare(
        "SELECT source_revision FROM core_source_revision WHERE id=1",
      ).first<number>("source_revision"),
    ).toBe(revisionBefore! + 1);
    expect(await promoteRewardClaims(upgrade.env.DB)).toMatchObject({ promoted: 0 });
    expect(
      await promoteRewardClaims(upgrade.env.DB, { release: "reward-promotion-v2-test" }),
    ).toMatchObject({ promoted: 1 });
    expect(
      (await upgrade.env.DB.prepare("SELECT * FROM reward_bucket_claims").all()).results,
    ).toEqual(legacyBefore.results);
    for (const table of ["reward_bucket_claims", "reward_bucket_claims_v2"]) {
      await expect(
        upgrade.env.DB.prepare(`UPDATE ${table} SET bucket_kind='regular'`).run(),
      ).rejects.toThrow("append-only");
      await expect(upgrade.env.DB.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(
        "append-only",
      );
    }
    await expect(
      claimSql("reward_bucket_claims_v2", "invented-kind", "wrong-kind").run(),
    ).rejects.toThrow();
    await expect(
      claimSql("reward_bucket_claims", "unclassified", "legacy-unknown").run(),
    ).rejects.toThrow();
  } finally {
    await upgrade.mf.dispose();
  }
}, 60000);

test("an ineligible page cannot starve later reward claims and each batch stays bounded", async () => {
  const parse = await seedParse(950, "mobile-suica", "mobile-suica-sf-history", "sf-history");
  for (let index = 0; index < 3; index++) {
    await seedBalance(parse, "mobile-suica:other", "sf_balance_after_transaction", 1, "JPY", {});
    await seedBalance(parse, "mobile-suica:sf", "sf_balance_after_transaction", 1, "USD", {});
    await seedBalance(parse, "mobile-suica:sf", "unrelated_measure", 1, "JPY", {});
  }
  const first = await seedBalance(
    parse,
    "mobile-suica:sf",
    "sf_balance_after_transaction",
    2,
    "JPY",
    {},
  );
  const second = await seedBalance(
    parse,
    "mobile-suica:sf",
    "sf_balance_after_transaction",
    3,
    "JPY",
    {},
  );
  await publishParse(env.DB, parse);
  const one = await promoteRewardClaims(env.DB, { limit: 1 });
  expect(one).toMatchObject({ scanned: 1, promoted: 1, skipped: 0, cursor: first });
  const two = await promoteRewardClaims(env.DB, { limit: 1 });
  expect(two).toMatchObject({ scanned: 1, promoted: 1, skipped: 0, cursor: second });
  expect(await promoteRewardClaims(env.DB, { limit: 1 })).toMatchObject({
    scanned: 0,
    promoted: 0,
  });
});

test("a lower-id observation published later is promoted without replaying completed claims", async () => {
  const delayed = await seedParse(951, "v-point", "v-point-balance-info", "balance-info");
  const low = await seedBalance(
    delayed,
    "v-point:common:delayed",
    "available_point_bucket",
    2,
    "V_POINT",
    {},
  );
  const current = await seedParse(952, "v-point", "v-point-balance-info", "balance-info");
  const high = await seedBalance(
    current,
    "v-point:common:current",
    "available_point_bucket",
    3,
    "V_POINT",
    {},
  );
  await publishParse(env.DB, current);
  expect(await promoteRewardClaims(env.DB)).toMatchObject({ promoted: 1, cursor: high });
  await publishParse(env.DB, delayed);
  expect(await promoteRewardClaims(env.DB)).toMatchObject({ scanned: 1, promoted: 1 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM reward_bucket_claims_v2 WHERE source_fact_kind='balance' AND source_fact_id IN (?,?) AND promotion_release=?",
    )
      .bind(low, high, REWARD_PROMOTION_RELEASE)
      .first<number>("n"),
  ).toBe(2);
  expect(await promoteRewardClaims(env.DB)).toMatchObject({ scanned: 0, promoted: 0 });
});
