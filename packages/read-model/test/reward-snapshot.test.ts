// Synthetic captures on the full migrated CORE schema; no provider data.
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { QualityStore, type ParseSpec } from "./collection-quality-fixture";
import { LEGACY_REWARD_BUCKETS_SQL } from "./reward-snapshot-legacy";
import {
  CURRENT_REWARD_BUCKETS_SQL,
  REWARD_READ_RELEASE,
  type RewardBucketSqlRow,
} from "../src/rewards";
import { vPointBalanceInfo, vPointHistoryPage } from "../../parsers/src/parsers/v-point";
import type { ArtifactMeta } from "../../parsers/src/types";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);
const artifacts = [
  { key: "balance-info.json", dataset: "balance-info" },
  { key: "smfg-point.json", dataset: "smfg-point" },
  { key: "history-page-0001.json", dataset: "history-page-0001" },
];
const parsers = ["v-point-balance-info", "v-point-smfg-point", "v-point-history-page"];
const current = (s: QualityStore, sql = CURRENT_REWARD_BUCKETS_SQL) =>
  s.db
    .query(
      sql === LEGACY_REWARD_BUCKETS_SQL
        ? sql.replaceAll("reward_bucket_claims", "reward_bucket_claims_v2")
        : sql,
    )
    .all(REWARD_READ_RELEASE, "program:v-point", 0) as RewardBucketSqlRow[];

function claim(s: QualityStore, parse: number, slot: number, amount: number, at: string): void {
  const fact = s.db
    .query(`INSERT INTO balance_observations
    (parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,
     observed_at,raw_locator,extra_json)
    VALUES(?,?,'available_point_bucket',?,?,0,'V_POINT',?,'json:synthetic','{}') RETURNING id`)
    .get(parse, `v-point:common:bucket-${slot}`, amount, String(amount), at) as { id: number };
  s.db.run(
    `INSERT INTO reward_bucket_claims_v2
    (claim_digest,parse_run_id,source_fact_kind,source_fact_id,program_id,holding_ref,bucket_ref,
     bucket_kind,restriction_refs_json,unit_ref,quantity_coefficient,quantity_scale,quantity_status,
     observed_expiry_json,observed_at,promotion_release,recorded_at)
    VALUES(?,?,'balance',?,'program:v-point','program:v-point:member',?,
      'regular','[]','points:v-point',?,0,'exact',NULL,?,?,?)`,
    [
      `synthetic-claim-${fact.id}`,
      parse,
      fact.id,
      `program:v-point:v-point:common:bucket-${slot}`,
      String(amount),
      at,
      REWARD_READ_RELEASE,
      at,
    ],
  );
}
function capture(
  s: QualityStore,
  day: number,
  amounts: number[],
  lastPage: ParseSpec = { kind: "published" },
  outcome: "success" | "failed" = "success",
) {
  const at = `2099-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const run = s.run({ source: "v-point", at, artifacts, outcome });
  const parses = run.artifacts.map((id, i) =>
    s.parse(id, parsers[i]!, i === 2 ? lastPage : { kind: "published" }),
  );
  amounts.forEach((amount, slot) => claim(s, parses[0]!, slot, amount, at));
  return { ...run, parses, at };
}

test("shrinking a complete array removes old slots, a deliberate difference from the shipped query", () => {
  const s = new QualityStore();
  capture(s, 1, [101, 102, 103]);
  const newer = capture(s, 2, [201]);
  expect(current(s).map((x) => [x.parse_run_id, x.quantity_coefficient])).toEqual([
    [newer.parses[0]!, "201"],
  ]);
  expect(current(s, LEGACY_REWARD_BUCKETS_SQL).map((x) => x.quantity_coefficient)).toEqual([
    "201",
    "102",
    "103",
  ]);
  expect(s.db.query("SELECT count(*) AS n FROM reward_bucket_claims_v2").get()).toEqual({ n: 4 });
  s.db.close();
});

test("reordering chooses every slot from the same new capture without inferring stable lot identities", () => {
  const s = new QualityStore();
  capture(s, 1, [11, 22, 33]);
  const newer = capture(s, 2, [33, 11, 22]);
  expect(current(s).map((x) => x.quantity_coefficient)).toEqual(["33", "11", "22"]);
  expect(new Set(current(s).map((x) => x.parse_run_id))).toEqual(new Set([newer.parses[0]!]));
  s.db.close();
});

test("a complete empty array with a published zero-row history clears every older bucket", () => {
  const fixture = (dataset: string) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../../tests/fixtures/observation-pipeline/v-point/${dataset}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const meta = (dataset: string): ArtifactMeta => ({
    id: 1,
    sourceId: "v-point",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2099-01-03T00:00:00.000Z",
    sha256: "0".repeat(64),
  });
  const balance = fixture("balance-info");
  balance.results.common = [];
  balance.results.store = [];
  const history = fixture("history-page-0001");
  history.results.total = 0;
  history.results.history = [];
  expect(
    vPointBalanceInfo.parse(new TextEncoder().encode(JSON.stringify(balance)), meta("balance-info"))
      .observations,
  ).toEqual([]);
  expect(
    vPointHistoryPage.parse(
      new TextEncoder().encode(JSON.stringify(history)),
      meta("history-page-0001"),
    ).observations,
  ).toEqual([]);
  const s = new QualityStore();
  capture(s, 1, [10, 20]);
  capture(s, 2, []);
  expect(current(s)).toEqual([]);
  expect(current(s, LEGACY_REWARD_BUCKETS_SQL)).toHaveLength(2);
  s.db.close();
});

test("a pending or failed newest page, and a failed fetch, retain the prior eligible set", () => {
  for (const spec of [
    { kind: "pending" },
    { kind: "error-run", code: "synthetic_rejection" },
  ] as const) {
    const s = new QualityStore();
    const prior = capture(s, 1, [10, 20]);
    capture(s, 2, [30], spec);
    expect(current(s).map((x) => x.parse_run_id)).toEqual([prior.parses[0]!, prior.parses[0]!]);
    s.db.close();
  }
  const s = new QualityStore();
  const prior = capture(s, 1, [10]);
  capture(s, 2, [20], { kind: "published" }, "failed");
  expect(current(s).map((x) => x.parse_run_id)).toEqual([prior.parses[0]!]);
  s.db.close();
});

test("publishing the missing page selects the new array, including an empty one", () => {
  const s = new QualityStore();
  capture(s, 1, [10, 20]);
  const newer = capture(s, 2, [], { kind: "pending" });
  expect(current(s)).toHaveLength(2);
  // Complete the existing pending job without inventing a second job.
  s.db.run(
    "UPDATE observation_parse_jobs SET status='done' WHERE fetch_artifact_id=? AND parser_name=?",
    [newer.artifacts[2]!, parsers[2]!],
  );
  const parse = s.id();
  s.db.run(
    `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,?,'v-point-history-page','1.0.0','2099-01-02','ok','[]')`,
    [parse, newer.artifacts[2]!],
  );
  s.db.run(
    `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
    VALUES(?,'v-point-history-page',NULL,?,'normal','synthetic','synthetic_publication','2099-01-02')`,
    [newer.artifacts[2]!, parse],
  );
  s.db.run(
    `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
    VALUES(?,'v-point-history-page',?,'1.0.0','2099-01-02','normal')`,
    [newer.artifacts[2]!, parse],
  );
  expect(current(s)).toEqual([]);
  s.db.close();
});

test("publication replacement and rollback use the current parse inside the selected run", () => {
  const s = new QualityStore();
  capture(s, 1, [10, 20, 30]);
  const newer = capture(s, 2, [40, 50]);
  const original = newer.parses[0]!;
  const replacement = s.id();
  s.db.run(
    `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,?,'v-point-balance-info','1.1.0','2099-01-03','ok','[]')`,
    [replacement, newer.artifacts[0]!],
  );
  const publish = (next: number, version: string, kind: "normal" | "rollback") => {
    const old = s.db
      .query(
        "SELECT parse_run_id FROM published_parse_runs WHERE fetch_artifact_id=? AND parser_name=?",
      )
      .get(newer.artifacts[0]!, parsers[0]!) as { parse_run_id: number };
    s.db.run(
      `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
      VALUES(?,?,?,?,?,'synthetic','synthetic_publication','2099-01-03')`,
      [newer.artifacts[0]!, parsers[0]!, old.parse_run_id, next, kind],
    );
    s.db.run(
      `UPDATE published_parse_runs SET parse_run_id=?,parser_version=?,publication_kind=? WHERE fetch_artifact_id=? AND parser_name=?`,
      [next, version, kind, newer.artifacts[0]!, parsers[0]!],
    );
  };
  publish(replacement, "1.1.0", "normal");
  claim(s, replacement, 0, 60, newer.at);
  expect(current(s).map((x) => x.quantity_coefficient)).toEqual(["60"]);
  publish(original, "1.0.0", "rollback");
  expect(current(s).map((x) => x.quantity_coefficient)).toEqual(["40", "50"]);
  expect(new Set(current(s).map((x) => x.parse_run_id))).toEqual(new Set([original]));
  s.db.close();
});

test("eligible run tie breaking and bounded promotion never fill current holes from older claims", () => {
  const s = new QualityStore();
  capture(s, 1, [10, 20]);
  const newer = capture(s, 1, [30]);
  expect(current(s).map((x) => x.parse_run_id)).toEqual([newer.parses[0]!]);
  const latest = capture(s, 2, []);
  // Promotion has not produced a claim in this new eligible run. It still
  // selects the new capture; claim existence is never a snapshot sentinel.
  expect(current(s)).toEqual([]);
  claim(s, latest.parses[0]!, 0, 70, latest.at);
  expect(current(s).map((x) => x.quantity_coefficient)).toEqual(["70"]);
  s.db.close();
});

test("seeded random shrinking and empty captures follow a snapshot-set oracle on an unanalyzed schema", () => {
  const s = new QualityStore();
  let seed = 554;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let day = 1; day <= 24; day++) {
    const amounts = Array.from({ length: random() % 18 }, () => random() % 1000);
    const newest = capture(s, day, amounts);
    expect(
      current(s).map((x) => [
        x.parse_run_id,
        x.bucket_ref.split("-").at(-1),
        x.quantity_coefficient,
      ]),
    ).toEqual(
      amounts
        .map((amount, slot) => [newest.parses[0]!, String(slot), String(amount)])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
  }
  const plans = s.db
    .query(`EXPLAIN QUERY PLAN ${CURRENT_REWARD_BUCKETS_SQL}`)
    .all(REWARD_READ_RELEASE, "program:v-point", 0) as { detail: string }[];
  expect(plans.some((x) => /SEARCH p USING INTEGER PRIMARY KEY/.test(x.detail))).toBe(true);
  expect(s.db.query("SELECT name FROM sqlite_master WHERE name='sqlite_stat1'").get()).toBeNull();
  s.db.close();
});

test("without array disappearance the snapshot selection matches the frozen shipped selection", () => {
  const s = new QualityStore();
  capture(s, 1, [10, 20]);
  capture(s, 2, [30, 40]);
  expect(current(s)).toEqual(current(s, LEGACY_REWARD_BUCKETS_SQL));
  s.db.close();
});

test("a second expected history page must also be published before the new set replaces the prior one", () => {
  const s = new QualityStore();
  const old = capture(s, 1, [10, 20]);
  const at = "2099-01-02T00:00:00.000Z";
  const run = s.run({
    source: "v-point",
    at,
    artifacts: [...artifacts, { key: "history-page-0002.json", dataset: "history-page-0002" }],
  });
  const parse = s.parse(run.artifacts[0]!, parsers[0]!, { kind: "published" })!;
  s.parse(run.artifacts[1]!, parsers[1]!, { kind: "published" });
  s.parse(run.artifacts[2]!, parsers[2]!, { kind: "published" });
  s.parse(run.artifacts[3]!, parsers[2]!, { kind: "pending" });
  claim(s, parse, 0, 30, at);
  expect(current(s).map((x) => x.parse_run_id)).toEqual([old.parses[0]!, old.parses[0]!]);
  s.db.close();
});

test("a V Point claim attached to another provider cannot join an eligible V Point set", () => {
  const s = new QualityStore();
  const real = capture(s, 1, [10]);
  const other = s.run({
    source: "sony-bank",
    at: "2099-01-02T00:00:00.000Z",
    artifacts: [{ key: "synthetic.json", dataset: "balance-info" }],
  });
  const parse = s.parse(other.artifacts[0]!, "v-point-balance-info", { kind: "published" })!;
  // An intentionally malformed synthetic claim that the real promoter would
  // not write: the reader still binds the programme to its actual source.
  claim(s, parse, 0, 99, "2099-01-02T00:00:00.000Z");
  expect(current(s).map((x) => [x.parse_run_id, x.quantity_coefficient])).toEqual([
    [real.parses[0]!, "10"],
  ]);
  s.db.close();
});
