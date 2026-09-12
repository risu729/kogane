// The reward second stage on the production schema of both databases (unified
// plan 04 §2, 05 §3–§7; U16). Every row is synthetic: no real member, balance
// or provider body appears here.
//
// What is proved, in one sentence each:
//   G2-19  a rebuild under the same rule, calendar and evaluation instant
//          produces the identical snapshot; a later instant produces a new one
//          and never mutates the published one.
//   G2-20  a saved simulation that kept only a digest is reported
//          `not_reproducible`; one that retained its request is replayed.
//   Building rows are invisible: a bounded invocation publishes nothing.
//   The pointer never moves backwards.
//   G0-09  dropping the reward READ tables leaves every CORE claim, rule and
//          offer untouched, and old cursors expire.
//   The flag is off by default, and with it off the lane never runs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  captureRewardInput,
  rewardReadProjectionEnabled,
  runRewardReadProjection,
} from "../src/reward-read-projection.ts";
import { promoteRewardClaims } from "../src/reward-claims-job.ts";
import { runScheduled } from "../src/worker.ts";
import { currentCoreRevision } from "../src/balance-projection-job.ts";
import { readInputRecord } from "../src/projection-input.ts";
import { applyReadMigrations } from "../../../packages/storage-d1/src/migrations.ts";
import { checkReadCursor } from "../../../packages/storage-d1/src/read/index.ts";
import { sha256Hex } from "../../../packages/domain/src/context.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;

const EVALUATED_AT = "2026-09-11T00:00:00.000Z";
const LATER = "2026-10-01T00:00:00.000Z";

/** The reward lane with the READ database as its target. */
const on = (base: Env = env): Env =>
  ({
    ...base,
    REWARD_CLAIMS_ENABLED: "true",
    REWARD_READ_PROJECTION_ENABLED: "true",
  }) as unknown as Env;

const store = () => env.DATA as unknown as Parameters<typeof runRewardReadProjection>[1];

const run = (evaluatedAt: string, options: { writeBudget?: number } = {}) =>
  runRewardReadProjection(on(), store(), { now: () => evaluatedAt, ...options });

const readFirst = async <T>(sql: string, ...args: unknown[]): Promise<T | null> =>
  await env.READ.prepare(sql)
    .bind(...args)
    .first<T>();

const readAll = async <T>(sql: string, ...args: unknown[]): Promise<T[]> =>
  (
    await env.READ.prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;

const readCount = async (sql: string, ...args: unknown[]): Promise<number> =>
  (await env.READ.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  // One published V Point parse with two buckets: one the provider dated (so
  // it is time-limited) and one it did not.
  await seedArtifact(env, 830, "v-point", "balance-info", "balance-info.json", { synthetic: true });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(830,'v-point-balance-info','1.0.0','2026-09-08T00:00:00.000Z','ok','[]') RETURNING id`,
  ).first<{ id: number }>();
  await publishParse(env.DB, parse!.id);
  for (const [account, amount, expiration] of [
    ["v-point:common:bucket-0", 5000, "2026-12-31"],
    ["v-point:common:bucket-1", 3000, ""],
  ] as const)
    await env.DB.prepare(
      `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,
        observed_at,raw_locator,extra_json)
       VALUES(?,?,'available_point_bucket',?,?,0,'V_POINT','2026-09-08','2026-09-08T00:00:00.000Z','$',?)`,
    )
      .bind(
        parse!.id,
        account,
        amount,
        String(amount),
        JSON.stringify({ _kogane: { asset: "v_point", expiration } }),
      )
      .run();
  await promoteRewardClaims(env.DB, { now: "2026-09-08T00:00:00.000Z" });

  // A verified synthetic offer and two saved simulations: one that retained
  // its request and one that kept only its digest.
  await env.DB.prepare(
    `INSERT INTO conversion_offers(offer_id,version,source_program_ref,destination_program_ref,
      from_unit_ref,to_unit_ref,ratio_numerator,ratio_denominator,minimum_coefficient,minimum_scale,
      increment_coefficient,increment_scale,fixed_fees_json,eligibility_policy_ref,
      eligible_bucket_kinds_json,eligible_restriction_refs_json,valid_time_json,
      application_deadline_json,processing_policy_ref,processing_days,rounding_policy_ref,
      rounding_scale,rounding_mode,evidence_refs_json,verification,recorded_at)
     VALUES('offer:synthetic','v1','program:v-point','program:synthetic-cash','points:v-point','JPY',
       '1','2','100',0,'100',0,'[]','policy:synthetic:eligibility','["regular"]','[]',
       '{"kind":"unknown","reasonCode":"synthetic"}','{"kind":"unknown","reasonCode":"synthetic"}',
       'policy:synthetic:processing',3,'policy:synthetic:rounding',0,'down','[]','verified',
       '2026-09-08T00:00:00.000Z')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO conversion_simulations(input_digest,plan_json,search_coverage,policy_release,computed_at)
     VALUES(?1,?2,'bounded','conversion-search-v1','2026-09-09T00:00:00.000Z')`,
  )
    .bind(
      "a".repeat(64),
      JSON.stringify({
        request: {
          offerId: "offer:synthetic",
          offerVersion: "v1",
          quantity: { coefficient: "1000", scale: 0, unitRef: "points:v-point" },
        },
      }),
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO conversion_simulations(input_digest,plan_json,search_coverage,policy_release,computed_at)
     VALUES(?1,'{"offerRef":"offer:forgotten@v1"}','bounded','conversion-search-v1','2026-09-09T00:00:00.000Z')`,
  )
    .bind("b".repeat(64))
    .run();
}, 30000);

afterAll(async () => {
  await mf?.dispose();
});

test("the flag is off by default and the lane does not run", async () => {
  expect(rewardReadProjectionEnabled(env.REWARD_READ_PROJECTION_ENABLED)).toBe(false);
  expect(rewardReadProjectionEnabled("false")).toBe(false);
  expect(rewardReadProjectionEnabled(undefined)).toBe(false);
  expect(rewardReadProjectionEnabled("true")).toBe(true);

  const lines: string[] = [];
  await runScheduled(
    env,
    {
      parse: async () => ({ skipped: true }),
      identity: async () => ({ skipped: true }),
      balanceProjection: async () => ({ skipped: true }),
      rewardReadProjection: async () => ({ ran: true }),
    },
    (line) => lines.push(line),
  );
  expect(lines.some((line) => line.includes("reward_read_projection"))).toBe(false);
  expect(await readCount("SELECT count(*) AS n FROM reward_expiry_snapshots")).toBe(0);
});

test("the lane runs between the claim sweep and the report job when the flag is on", async () => {
  const lanes: string[] = [];
  await runScheduled(
    on(),
    {
      parse: async () => ({ skipped: true }),
      identity: async () => ({ skipped: true }),
      balanceProjection: async () => ({ skipped: true }),
      rewards: async () => ({ promoted: 0 }),
      rewardReadProjection: async () => ({ status: "stubbed" }),
      reports: async () => ({ skipped: true }),
      decisions: async () => ({ skipped: true }),
    },
    (line) => lanes.push(JSON.parse(line).event as string),
  );
  expect(lanes.indexOf("reward_read_projection")).toBeGreaterThan(
    lanes.indexOf("reward_claims_sweep"),
  );
  expect(lanes.indexOf("reward_read_projection")).toBeLessThan(lanes.indexOf("decision_outbox"));
});

test("G2-19: a build fixes its evaluation instant, publishes it, and writes nothing to CORE", async () => {
  const revision = await currentCoreRevision(env.DB);
  const built = await run(EVALUATED_AT);
  expect(built).toMatchObject({
    status: "complete",
    active: true,
    evaluatedAt: EVALUATED_AT,
    sourceRevision: revision.source_revision,
  });
  expect(built.estimateCount).toBeGreaterThan(0);

  const snapshot = await readFirst<{
    evaluated_at: string;
    calendar_rule_id: string;
    rule_count: number;
    status: string;
    claims_release: string;
  }>(
    `SELECT evaluated_at,calendar_rule_id,rule_count,status,claims_release
     FROM reward_expiry_snapshots WHERE snapshot_id=?1`,
    built.snapshotId,
  );
  expect(snapshot).toMatchObject({
    evaluated_at: EVALUATED_AT,
    calendar_rule_id: "UTC:start-of-day:assumed",
    status: "complete",
    claims_release: "reward-promotion-v1",
  });
  // The deadline the provider displayed is carried across as a date, not an
  // instant, and the bucket it did not date keeps its row.
  const rows = await readAll<{ bucket_ref: string; expires_on: string | null; state: string }>(
    `SELECT bucket_ref,expires_on,state FROM reward_expiry_estimates
     WHERE snapshot_id=?1 AND rule_id='rule:v-point:fixed-expiry-lot' ORDER BY row_seq`,
    built.snapshotId,
  );
  expect(rows.length).toBe(2);
  expect(rows.map((row) => row.expires_on)).toEqual(["2026-12-31", null]);

  // CORE's own reward projections are untouched: the flag moves where the rows
  // are written, never what CORE holds.
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM expiry_estimates").first<{ n: number }>(),
  ).toMatchObject({ n: 0 });
  // The fixed input is on record in CORE and in DATA.
  expect(await readInputRecord(env.DB, built.inputDigest!)).not.toBeNull();
  expect(
    (await env.DATA.list({ prefix: `projection-inputs/${built.inputDigest!}/` })).objects.length,
  ).toBe(1);
});

test("G2-19: the same instant rebuilds the same snapshot, a later one builds a new snapshot", async () => {
  const first = await run(EVALUATED_AT);
  expect(["complete", "unchanged"]).toContain(first.status);
  const firstRows = await readAll<Record<string, unknown>>(
    "SELECT row_key,row_digest,expires_on FROM reward_expiry_estimates WHERE snapshot_id=?1 ORDER BY row_seq",
    first.snapshotId,
  );

  // The same rules, the same claims and the same instant: the same content, so
  // the same snapshot id and no rebuild.
  const again = await run(EVALUATED_AT);
  expect(again.snapshotId).toBe(first.snapshotId);
  expect(again.status).toBe("unchanged");
  expect(
    await readAll<Record<string, unknown>>(
      "SELECT row_key,row_digest,expires_on FROM reward_expiry_estimates WHERE snapshot_id=?1 ORDER BY row_seq",
      first.snapshotId,
    ),
  ).toEqual(firstRows);

  // A later instant is a different input: a new snapshot, and the earlier one
  // is untouched, not re-evaluated.
  const later = await run(LATER);
  expect(later.status).toBe("complete");
  expect(later.snapshotId).not.toBe(first.snapshotId);
  expect(later.evaluatedAt).toBe(LATER);
  expect(
    await readAll<Record<string, unknown>>(
      "SELECT row_key,row_digest,expires_on FROM reward_expiry_estimates WHERE snapshot_id=?1 ORDER BY row_seq",
      first.snapshotId,
    ),
  ).toEqual(firstRows);
  expect(
    await readFirst<{ evaluated_at: string }>(
      "SELECT evaluated_at FROM reward_expiry_snapshots WHERE snapshot_id=?1",
      first.snapshotId,
    ),
  ).toMatchObject({ evaluated_at: EVALUATED_AT });
  const pointer = await readFirst<{ snapshot_id: string; evaluated_at: string }>(
    "SELECT snapshot_id,evaluated_at FROM reward_snapshot_pointer WHERE id=1",
  );
  expect(pointer).toMatchObject({ snapshot_id: later.snapshotId!, evaluated_at: LATER });
});

test("fresh captures ignore the retired CORE simulation cache", async () => {
  const built = await run("2026-10-02T00:00:00.000Z");
  expect(["complete", "unchanged"]).toContain(built.status);
  expect(
    await readAll(
      "SELECT * FROM reward_conversion_simulations WHERE snapshot_id=?1",
      built.snapshotId,
    ),
  ).toEqual([]);
});

test("a bounded invocation publishes nothing: building rows are invisible", async () => {
  // A budget of one row cannot finish the build, so nothing is sealed and the
  // pointer stays where it was.
  const pointerBefore = await readFirst<{ snapshot_id: string }>(
    "SELECT snapshot_id FROM reward_snapshot_pointer WHERE id=1",
  );
  const partial = await run("2026-10-03T00:00:00.000Z", { writeBudget: 1 });
  expect(partial.status).toBe("building");
  expect(partial.active).toBe(false);
  expect(
    await readFirst<{ status: string }>(
      "SELECT status FROM reward_expiry_snapshots WHERE snapshot_id=?1",
      partial.snapshotId,
    ),
  ).toMatchObject({ status: "building" });
  expect(
    await readFirst<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM reward_snapshot_pointer WHERE id=1",
    ),
  ).toEqual(pointerBefore);

  // The next invocation resumes the same build from its stored input and
  // finishes it; the rows it wrote before the pause are not rewritten.
  const finished = await run("2026-10-04T00:00:00.000Z");
  expect(finished.snapshotId).toBe(partial.snapshotId);
  expect(finished.status).toBe("complete");
  // The resumed build kept the instant of its own input, not the new clock.
  expect(finished.evaluatedAt).toBe("2026-10-03T00:00:00.000Z");
  expect(
    await readFirst<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM reward_snapshot_pointer WHERE id=1",
    ),
  ).toMatchObject({ snapshot_id: partial.snapshotId! });
});

test("the capture is refused when the reward context will not hold still", async () => {
  const unstable = await captureRewardInput(env.DB as never, {
    now: () => EVALUATED_AT,
    duringCapture: async () => {
      // A claim promoted between the two revision reads moves the revision of
      // migration 0041, so the capture is discarded rather than mixed.
      await env.DB.prepare(
        `INSERT INTO membership_state_claims(claim_digest,parse_run_id,program_id,holding_ref,tier,
          valid_json,source,evidence_refs_json,recorded_at)
         VALUES(?1,NULL,'program:v-point','program:v-point:member','probe',
           '{"kind":"unknown","reasonCode":"synthetic"}','self-reported','[]',
           '2026-09-11T00:00:00.000Z')`,
      )
        .bind(await sha256Hex(`membership-probe-${String(Math.random())}`))
        .run();
    },
  });
  expect(unstable).toMatchObject({ ok: false, status: "pending", code: "input_capture_unstable" });
});

test("two ticks of one day are one input, and the next day is a new snapshot", async () => {
  // The rules consume a calendar day, so the fixed instant is the start of the
  // captured day: a second tick an hour later is the same input and rebuilds
  // nothing.
  const morning = await run("2026-11-01T01:00:00.000Z");
  expect(["complete", "unchanged"]).toContain(morning.status);
  expect(morning.evaluatedAt).toBe("2026-11-01T00:00:00.000Z");
  const evening = await run("2026-11-01T23:30:00.000Z");
  expect(evening.snapshotId).toBe(morning.snapshotId);
  expect(evening.status).toBe("unchanged");
  expect(evening.written).toBe(0);
  // The next day is a new evaluation and therefore a new snapshot.
  const tomorrow = await run("2026-11-02T00:30:00.000Z");
  expect(tomorrow.snapshotId).not.toBe(morning.snapshotId);
  expect(tomorrow.evaluatedAt).toBe("2026-11-02T00:00:00.000Z");
});

test("an unchanged build still moves the watermark, so a restriction change clears itself", async () => {
  const built = await run("2026-11-03T00:00:00.000Z");
  expect(["complete", "unchanged"]).toContain(built.status);
  // A use restriction moves the visibility revision without touching a single
  // reward claim, so the captured content is identical. The App refuses the
  // published snapshot until its watermark says it was verified under the new
  // revision (05 §7); only the pointer refresh can do that, because nothing
  // would be rebuilt.
  await env.DB.prepare(
    `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,affected_manifests_json,
      actor,reason)
     VALUES('balance:reward-probe','no-reuse','2026-11-03','[]','operator:1','synthetic')`,
  ).run();
  const revision = await currentCoreRevision(env.DB);
  const refreshed = await run("2026-11-03T12:00:00.000Z");
  expect(refreshed.status).toBe("unchanged");
  expect(refreshed.snapshotId).toBe(built.snapshotId);
  expect(refreshed.active).toBe(true);
  expect(
    await readFirst<{ visibility_revision: number; source_revision: number }>(
      "SELECT visibility_revision,source_revision FROM reward_snapshot_pointer WHERE id=1",
    ),
  ).toMatchObject({
    visibility_revision: revision.visibility_revision,
    source_revision: revision.source_revision,
  });
});

test("G0-09: dropping the reward READ tables leaves every CORE claim intact and expires old cursors", async () => {
  const LOST_AT = "2026-10-05T00:00:00.000Z";
  const built = await run(LOST_AT);
  expect(["complete", "unchanged"]).toContain(built.status);
  const lostSnapshot = built.snapshotId!;
  const lostInstance = (await readFirst<{ read_instance_id: string }>(
    "SELECT read_instance_id FROM read_instance WHERE id=1",
  ))!.read_instance_id;
  const rowsOf = async (snapshotId: string) => ({
    estimates: await readAll<Record<string, unknown>>(
      "SELECT row_seq,row_key,row_digest FROM reward_expiry_estimates WHERE snapshot_id=?1 ORDER BY row_seq",
      snapshotId,
    ),
    simulations: await readAll<Record<string, unknown>>(
      "SELECT row_seq,request_digest,row_digest FROM reward_conversion_simulations WHERE snapshot_id=?1 ORDER BY row_seq",
      snapshotId,
    ),
    outputDigest: (await readFirst<{ output_digest: string }>(
      "SELECT output_digest FROM reward_expiry_snapshots WHERE snapshot_id=?1",
      snapshotId,
    ))!.output_digest,
  });
  const lostRows = await rowsOf(lostSnapshot);
  expect(lostRows.estimates.length).toBeGreaterThan(0);

  const coreDigest = async (): Promise<string> => {
    const claims = await env.DB.prepare(
      `SELECT id,claim_digest,program_id,bucket_ref,bucket_kind,quantity_coefficient,
        observed_expiry_json FROM reward_bucket_claims ORDER BY id`,
    ).all<Record<string, unknown>>();
    const rules = await env.DB.prepare(
      "SELECT rule_id,version,family,verification FROM expiry_rules ORDER BY rule_id,version",
    ).all<Record<string, unknown>>();
    const offers = await env.DB.prepare(
      "SELECT offer_id,version,ratio_numerator,ratio_denominator FROM conversion_offers ORDER BY offer_id",
    ).all<Record<string, unknown>>();
    const saved = await env.DB.prepare(
      "SELECT input_digest,plan_json FROM conversion_simulations ORDER BY input_digest",
    ).all<Record<string, unknown>>();
    return await sha256Hex(
      JSON.stringify({
        claims: claims.results,
        rules: rules.results,
        offers: offers.results,
        saved: saved.results,
      }),
    );
  };
  const before = await coreDigest();

  for (const table of [
    "reward_build_checkpoints",
    "reward_conversion_simulations",
    "reward_expiry_estimates",
    "reward_snapshot_input_refs",
    "reward_snapshot_pointer",
    "reward_expiry_snapshots",
    "read_build_checkpoints",
    "scope_relations",
    "snapshot_input_refs",
    "current_balance_projection",
    "balance_snapshot_pointer",
    "balance_read_snapshots",
    "read_instance",
  ])
    await env.READ.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyReadMigrations(env.READ);
  expect(await readCount("SELECT count(*) AS n FROM reward_expiry_snapshots")).toBe(0);

  // G2-19: rebuilt from the same fixed input — the same rules, claims, offers
  // and evaluation instant — the new database holds the same rows, digest for
  // digest, and the same output digest. Nothing about the rebuild depended on
  // the wall clock or on CORE's present.
  const rebuilt = await run(LOST_AT);
  expect(rebuilt.status).toBe("complete");
  expect(rebuilt.inputDigest).toBe(built.inputDigest);
  expect(rebuilt.evaluatedAt).toBe(LOST_AT);
  expect(await rowsOf(rebuilt.snapshotId!)).toEqual(lostRows);
  // The snapshot id is a digest of content and attempt, so it repeats across
  // rebuilds; the read instance is what tells the two databases apart.
  expect(rebuilt.snapshotId).toBe(lostSnapshot);
  const instance = (await readFirst<{ read_instance_id: string }>(
    "SELECT read_instance_id FROM read_instance WHERE id=1",
  ))!.read_instance_id;
  expect(instance).not.toBe(lostInstance);
  // A cursor from the lost database is `context_expired`, never continued
  // against rows that only look like its list (05 §7, G3-03).
  expect(
    checkReadCursor(
      {
        snapshotId: lostSnapshot,
        readInstanceId: lostInstance,
        filterDigest: "digest",
        position: 0,
        sortKey: "",
      },
      { filterDigest: "digest", readInstanceId: instance, snapshotReadable: true },
    ),
  ).toBe("context_expired");
  // Not one claim, rule, offer or saved simulation moved.
  expect(await coreDigest()).toBe(before);
}, 90000);
