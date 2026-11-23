// The Processor's snapshot walk (snapshot-memo.ts, ADR 0129 slice 2) against
// the shipped selections it replaces in the scheduled reads, member for
// member: `snapshotCtes` (container snapshots and artifact containers), the
// MyJCB past-months selection and the V Point run selection. Random stores draw
// the states the rules distinguish: tied and ordered capture times, several
// pages per capture, run and unit outcomes, a dataset's unit scope, the legacy
// unit aliases, a dataset two sources share, published, failed, pending and
// superseded parses, complete, partial, empty and missing coverage claims, the
// required parser version and runs hidden from financial views. `drawn`
// records the states the seeds drew; the last test checks that the seeds
// together drew each. The scaled card store is compared too. Every value is
// synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { completeSnapshotCandidates } from "../src/concepts";
import {
  ELIGIBLE_VPOINT_RUNS,
  MYJCB_PAST_MONTHS_CONNECTION,
  myjcbPastMonthsSnapshotCtes,
} from "../src/current-captures";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentRewardBucketsSql, REWARD_READ_RELEASE } from "../src/rewards";
import {
  SNAPSHOT_MEMBERS_SQL,
  SNAPSHOT_MEMO_KEY_SQL,
  SNAPSHOT_MEMO_STALE_ERROR,
  SNAPSHOT_SELECTION_DIGEST,
  snapshotSelectionDigest,
  STORE_SNAPSHOT_MEMO_SQL,
  type SnapshotMemberRow,
} from "../src/snapshot-memo";
import {
  latestBalanceCandidatesSql,
  positionCutSql,
  positionsSql,
  positionValuationsSql,
  type SnapshotSource,
} from "../src/sql";
import { fullCoreSchema, scaledStore, STATEMENT_CI_SCALE } from "./card-usage-scale-fixture";
import { type ArtifactSpec, type ParseSpec, QualityStore } from "./collection-quality-fixture";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

/**
 * The shipped selections, as the same member rows: a container snapshot is
 * every sealed artifact of its run, source, dataset and unit, the rows
 * `CURRENT_SNAPSHOT` matches.
 */
export const SHIPPED_MEMBERS_SQL = `WITH ${completeSnapshotCandidates.ctes}, ${myjcbPastMonthsSnapshotCtes()}, ${ELIGIBLE_VPOINT_RUNS}
SELECT 'container' AS selection, snapshot.parser_name, member.id AS fetch_artifact_id,
       member.fetch_run_id, snapshot.required_version
FROM current_snapshots snapshot
JOIN observation_fetch_artifacts member ON member.fetch_run_id = snapshot.fetch_run_id
  AND member.source_id = snapshot.source_id AND member.dataset = snapshot.dataset
  AND member.fetch_unit_key IS snapshot.fetch_unit_key
UNION ALL
SELECT 'artifact-container', parser_name, artifact_id,
       (SELECT fetch_run_id FROM fetch_artifacts WHERE id = artifact_id), NULL
FROM current_artifact_containers
UNION ALL
SELECT 'myjcb-past-months', 'myjcb-credit-past-month-balances', fetch_artifact_id,
       (SELECT fetch_run_id FROM fetch_artifacts WHERE id = fetch_artifact_id), NULL
FROM current_myjcb_snapshots
UNION ALL
SELECT 'vpoint-run', '', 0, fetch_run_id, NULL FROM current_vpoint_runs`;

const key = (row: SnapshotMemberRow) =>
  `${row.selection}|${row.parser_name}|${row.fetch_artifact_id}|${row.fetch_run_id}|${row.required_version ?? ""}`;

export function members(db: Database, sql: string): string[] {
  return (db.query(sql).all() as SnapshotMemberRow[]).map(key).sort();
}

/** Mulberry32: a small deterministic generator, so a failing seed replays. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEED_COUNT = Number(process.env["KOGANE_RANDOM_SEEDS"] ?? 24);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => 9_001 + index * 7_919);

/** Every state a seed may draw; the last test checks that the seeds drew each. */
const drawn = new Set<string>();

interface ContainerShape {
  source: string;
  parser: string;
  dataset: string;
  /** The unit each capture is filed under; null for none. */
  units: readonly (string | null)[];
  /** The version the dataset's policy requires (null: any). */
  version: string | null;
  coverage: boolean;
}

/** Datasets with a snapshot policy row (migration-seeded), over both policies and scopes. */
const CONTAINERS: readonly ContainerShape[] = [
  {
    source: "sbi-securities",
    parser: "sbi-domestic-cash-positions",
    dataset: "domestic-cash-positions",
    units: ["cash-positions"],
    version: null,
    coverage: false,
  },
  {
    // `domestic` is a legacy alias of `income-history-income` (snapshotPartitionUnitSql).
    source: "sbi-securities",
    parser: "sbi-income-payments",
    dataset: "income-payments",
    units: ["income-history-income", "domestic"],
    version: "0.1.3",
    coverage: true,
  },
  {
    source: "sbi-securities",
    parser: "sbi-realised-gains",
    dataset: "realised-gains",
    units: ["income-history-gains", "domestic"],
    version: "0.1.3",
    coverage: true,
  },
  {
    // The same dataset as SBI's: the shipped policy join is by dataset alone.
    source: "sony-bank",
    parser: "sony-bank-realised-gains",
    dataset: "realised-gains",
    units: [null],
    version: "1.0.0",
    coverage: true,
  },
  {
    // `primary` and no unit are one partition (the retired importer's alias).
    source: "sbi-shinsei-bank",
    parser: "sbi-shinsei-top-balances-and-activity",
    dataset: "top-accounts-balance-and-activity",
    units: ["primary", null],
    version: null,
    coverage: false,
  },
  {
    source: "st-george",
    parser: "st-george-balances",
    dataset: "account-snapshot",
    units: [null],
    version: "1.0.1",
    coverage: true,
  },
];

/** Times from a small pool, so captures tie as often as they order. */
const at = (random: () => number) =>
  new Date(Date.UTC(2099, 0, 1 + Math.floor(random() * 6), Math.floor(random() * 2))).toISOString();

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

type ParseState = "published" | "failed" | "pending" | "superseded" | "none";
function parseState(random: () => number): ParseState {
  const draw = random();
  return draw < 0.72
    ? "published"
    : draw < 0.8
      ? "failed"
      : draw < 0.88
        ? "pending"
        : draw < 0.94
          ? "superseded"
          : "none";
}

/** A random run outcome, with its units' outcomes. */
function outcomes(random: () => number): {
  outcome: "success" | "partial" | "failed";
  unit: "success" | "failed";
} {
  const draw = random();
  const outcome = draw < 0.65 ? "success" : draw < 0.85 ? "partial" : "failed";
  const unit = outcome === "success" || random() < 0.6 ? "success" : "failed";
  drawn.add(`run:${outcome}:unit-${unit}`);
  return { outcome, unit };
}

function maybeHide(store: QualityStore, random: () => number, run: number): void {
  if (random() >= 0.06) return;
  drawn.add("run:hidden-from-financial-views");
  store.db
    .query(
      "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms) VALUES(?,'exclude_from_financial_views','synthetic',0)",
    )
    .run(run);
}

function parse(
  store: QualityStore,
  random: () => number,
  artifact: number,
  parser: string,
  shape: { version: string | null; coverage: boolean },
): void {
  const state = parseState(random);
  drawn.add(`parse:${state}`);
  if (state === "none") return;
  if (state !== "published") {
    const spec: ParseSpec =
      state === "failed"
        ? { kind: "failed", code: "synthetic_failure", withRun: random() < 0.5 }
        : state === "pending"
          ? { kind: "pending" }
          : { kind: "superseded" };
    store.parse(artifact, parser, spec);
    return;
  }
  const wrongVersion = shape.version !== null && random() < 0.08;
  if (wrongVersion) drawn.add("parse:other-version");
  const version = wrongVersion ? "9.9.9" : (shape.version ?? "1.0.0");
  if (!shape.coverage) {
    store.parse(artifact, parser, { kind: "published", version });
    return;
  }
  const draw = random();
  const claim =
    draw < 0.72
      ? { completeness: "complete" as const }
      : draw < 0.8
        ? { completeness: "complete" as const, observed: 0 }
        : draw < 0.9
          ? { completeness: "partial" as const }
          : undefined;
  drawn.add(
    `claim:${claim === undefined ? "none" : claim.observed === 0 ? "empty" : claim.completeness}`,
  );
  store.parse(
    artifact,
    parser,
    claim === undefined ? { kind: "published", version } : { kind: "published", version, claim },
  );
}

function containerCaptures(store: QualityStore, random: () => number): void {
  for (const shape of CONTAINERS) {
    const captures = 1 + Math.floor(random() * 5);
    for (let capture = 0; capture < captures; capture += 1) {
      const unit = pick(random, shape.units);
      if (unit === "domestic" || unit === "primary") drawn.add("unit:legacy-alias");
      const { outcome, unit: unitOutcome } = outcomes(random);
      const pages = random() < 0.3 ? 2 : 1;
      if (pages === 2) drawn.add("capture:two-pages");
      const artifacts: ArtifactSpec[] = Array.from({ length: pages }, (_, page) => ({
        key: `${shape.dataset}-${page}.json`,
        dataset: shape.dataset,
        ...(unit === null ? {} : { unit }),
      }));
      const written = store.run({
        source: shape.source,
        at: at(random),
        outcome,
        ...(unit === null ? {} : { units: { [unit]: { outcome: unitOutcome } } }),
        artifacts,
      });
      for (const artifact of written.artifacts) parse(store, random, artifact, shape.parser, shape);
      maybeHide(store, random, written.run);
    }
  }
}

function artifactContainerCaptures(store: QualityStore, random: () => number): void {
  const captures = 1 + Math.floor(random() * 4);
  for (let capture = 0; capture < captures; capture += 1) {
    const { outcome, unit } = outcomes(random);
    const labelled = random() < 0.5;
    drawn.add(`mizuho:${labelled ? "labelled" : "unlabelled"}`);
    const written = store.run({
      source: "mizuho-bank",
      at: at(random),
      outcome,
      units: { "account-list": { outcome: unit } },
      artifacts: [
        {
          key: "account-list.html",
          dataset: labelled ? "mizuho-account-list-html" : null,
          unit: "account-list",
        },
        { key: "other-page.html", dataset: null, unit: "account-list" },
      ],
    });
    parse(store, random, written.artifacts[0]!, "mizuho-account-list", {
      version: null,
      coverage: true,
    });
    maybeHide(store, random, written.run);
  }
}

function myjcbCaptures(store: QualityStore, random: () => number): void {
  const captures = 1 + Math.floor(random() * 5);
  for (let capture = 0; capture < captures; capture += 1) {
    const connection = pick(random, ["connection-a", "connection-b"]);
    const { outcome, unit } = outcomes(random);
    const written = store.run({
      source: "myjcb",
      at: at(random),
      outcome,
      units: { [connection]: { outcome: unit } },
      artifacts: [
        {
          key: `${connection}/past-months-${capture}.json`,
          dataset: "credit-past-months",
          unit: connection,
        },
      ],
    });
    parse(store, random, written.artifacts[0]!, "myjcb-credit-past-month-balances", {
      version: null,
      coverage: false,
    });
    maybeHide(store, random, written.run);
  }
}

function vpointCaptures(store: QualityStore, random: () => number): void {
  const captures = 1 + Math.floor(random() * 5);
  for (let capture = 0; capture < captures; capture += 1) {
    const { outcome } = outcomes(random);
    const pages = random() < 0.3 ? 2 : 1;
    const written = store.run({
      source: "v-point",
      at: at(random),
      outcome,
      artifacts: [
        { key: "balance-info.json", dataset: "balance-info" },
        { key: "smfg-point.json", dataset: "smfg-point" },
        ...Array.from({ length: pages }, (_, page) => ({
          key: `history-page-${page + 1}.json`,
          dataset: `history-page-${page + 1}`,
        })),
      ],
    });
    const [info, smfg, ...history] = written.artifacts;
    const plain = { version: null, coverage: false };
    parse(store, random, info!, "v-point-balance-info", plain);
    parse(store, random, smfg!, "v-point-smfg-point", plain);
    for (const page of history) parse(store, random, page, "v-point-history-page", plain);
    maybeHide(store, random, written.run);
  }
}

function randomStore(seed: number): QualityStore {
  const random = generator(seed);
  const store = new QualityStore();
  containerCaptures(store, random);
  artifactContainerCaptures(store, random);
  myjcbCaptures(store, random);
  vpointCaptures(store, random);
  return store;
}

/** Which selections a store's shipped members reach, for the coverage check. */
function recordReach(rows: readonly string[]): void {
  for (const row of rows) drawn.add(`member:${row.split("|")[0]}`);
}

describe("the walk selects the shipped members", () => {
  for (const seed of SEEDS)
    test(`random store ${seed}`, () => {
      const store = randomStore(seed);
      try {
        const shipped = members(store.db, SHIPPED_MEMBERS_SQL);
        recordReach(shipped);
        const ties = store.db
          .query(
            `SELECT count(*) AS n FROM (SELECT source_id, dataset, fetched_at FROM observation_fetch_artifacts
             GROUP BY 1, 2, 3 HAVING count(DISTINCT fetch_run_id) > 1)`,
          )
          .get() as { n: number };
        if (ties.n > 0) drawn.add("capture:tied-times");
        expect(members(store.db, SNAPSHOT_MEMBERS_SQL)).toEqual(shipped);
      } finally {
        store.db.close();
      }
    });

  test("the scaled card store", async () => {
    const built = await scaledStore(STATEMENT_CI_SCALE);
    try {
      const shipped = members(built.store.db, SHIPPED_MEMBERS_SQL);
      expect(shipped.some((row) => row.startsWith("container|"))).toBe(true);
      expect(shipped.some((row) => row.startsWith("myjcb-past-months|"))).toBe(true);
      expect(members(built.store.db, SNAPSHOT_MEMBERS_SQL)).toEqual(shipped);
    } finally {
      built.store.db.close();
    }
  }, 120_000);

  test("the seeds drew every state", () => {
    const expected = [
      "run:success:unit-success",
      "run:partial:unit-success",
      "run:partial:unit-failed",
      "run:failed:unit-failed",
      "run:hidden-from-financial-views",
      "parse:published",
      "parse:failed",
      "parse:pending",
      "parse:superseded",
      "parse:none",
      "parse:other-version",
      "claim:complete",
      "claim:empty",
      "claim:partial",
      "claim:none",
      "unit:legacy-alias",
      "capture:two-pages",
      "capture:tied-times",
      "mizuho:labelled",
      "mizuho:unlabelled",
      "member:container",
      "member:artifact-container",
      "member:myjcb-past-months",
      "member:vpoint-run",
    ];
    expect(expected.filter((state) => !drawn.has(state))).toEqual([]);
  });
});

// ── The memo-backed reads ────────────────────────────────────────────────

/** What the Processor's `ensureSnapshotMemo` writes, as one transaction. */
export function storeMemo(db: Database, nowMs = 1): void {
  db.transaction(() => {
    db.run(STORE_SNAPSHOT_MEMO_SQL.dropStaleMembers);
    db.run(STORE_SNAPSHOT_MEMO_SQL.dropStaleKeys);
    db.query(STORE_SNAPSHOT_MEMO_SQL.insertKey).run(nowMs);
    db.run(STORE_SNAPSHOT_MEMO_SQL.insertMembers);
  })();
}

/**
 * One balance, position, valuation and (for V Point) reward claim per ok
 * parse, so the readers have rows to choose between in every capture.
 */
function seedObservations(db: Database): void {
  const parses = db
    .query(
      `SELECT p.id, a.source_id,
              EXISTS (SELECT 1 FROM published_parse_runs pub WHERE pub.parse_run_id = p.id) AS published
       FROM parse_runs p JOIN fetch_artifacts a ON a.id = p.fetch_artifact_id
       WHERE p.status = 'ok' ORDER BY p.id`,
    )
    .all() as { id: number; source_id: string; published: number }[];
  for (const parse of parses) {
    db.query(
      `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,?,?,0,'JPY','2026-09-01','2026-09-01T00:00:00Z',?,'{}')`,
    ).run(
      parse.id,
      `acct-${parse.id % 3}`,
      "balance",
      parse.id * 100,
      String(parse.id * 100),
      `$.b${parse.id}`,
    );
    db.query(
      `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,NULL,NULL,'1',0,'JPY','2026-09-01','2026-09-01T00:00:00Z',?,'{}')`,
    ).run(parse.id, `acct-${parse.id % 3}`, `code-${parse.id % 4}`, `$.p${parse.id}`);
    db.query(
      `INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,amount_minor,amount_text,amount_scale,currency,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,'market_value',?,NULL,0,'JPY','2026-09-01','2026-09-01T00:00:00Z',?,'{}')`,
    ).run(parse.id, `acct-${parse.id % 3}`, `code-${parse.id % 4}`, parse.id, `$.v${parse.id}`);
    if (parse.source_id === "v-point" && parse.published === 1)
      db.query(
        `INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
           program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
           quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,
           promotion_release,recorded_at)
         VALUES(?,?,'balance',?,'program:v-point','holding:v-point',?,'regular','[]','points:v-point',
           '100',0,'exact',NULL,'2026-09-12T00:00:00Z',?,'2026-09-12T00:00:00Z')`,
      ).run(
        parse.id.toString(16).padStart(64, "0"),
        parse.id,
        parse.id,
        `bucket:${parse.id % 2}`,
        REWARD_READ_RELEASE,
      );
  }
}

/** Every reader the Processor runs on the memo, with the rows it returns. */
function readers(db: Database, source: SnapshotSource): Record<string, string[]> {
  const rows = (sql: string, args: readonly unknown[] = []) =>
    (db.query(sql).all(...(args as never[])) as object[]).map((row) => JSON.stringify(row)).sort();
  const page = positionsSql({}, 0, source);
  const positionIds = JSON.stringify(
    (db.query(page.sql).all(...(page.args as never[])) as { id: number }[]).map((row) => row.id),
  );
  return {
    balances: rows(latestBalanceCandidatesSql(source)),
    positions: rows(page.sql, page.args),
    valuations: rows(positionValuationsSql(source), [positionIds]),
    cut: rows(positionCutSql(source), [positionIds]),
    rewards: rows(currentRewardBucketsSql(source), [REWARD_READ_RELEASE, null, 0]),
  };
}

const memoReached = new Set<string>();

describe("the memo-backed reads return what the inline reads return", () => {
  test("the pinned digest is the digest of the walk", async () => {
    expect(await snapshotSelectionDigest()).toBe(SNAPSHOT_SELECTION_DIGEST);
  });

  for (const seed of SEEDS)
    test(`random store ${seed}`, () => {
      const store = randomStore(seed);
      try {
        seedObservations(store.db);
        storeMemo(store.db);
        const stored = (
          store.db
            .query(
              `SELECT selection, parser_name, fetch_artifact_id, fetch_run_id, required_version
               FROM snapshot_selection_members WHERE key_id = (${SNAPSHOT_MEMO_KEY_SQL})`,
            )
            .all() as SnapshotMemberRow[]
        )
          .map(key)
          .sort();
        expect(stored).toEqual(members(store.db, SNAPSHOT_MEMBERS_SQL));
        const inline = readers(store.db, "inline");
        for (const [name, found] of Object.entries(inline))
          if (found.length > 0 && !(name === "cut" && found[0]?.includes('"current_rows":0')))
            memoReached.add(name);
        expect(readers(store.db, "memo")).toEqual(inline);
      } finally {
        store.db.close();
      }
    });

  test("the scaled card store, with its history parsers", async () => {
    const built = await scaledStore(STATEMENT_CI_SCALE);
    try {
      storeMemo(built.store.db);
      const inline = readers(built.store.db, "inline");
      expect(inline["balances"]!.length).toBeGreaterThan(0);
      expect(readers(built.store.db, "memo")).toEqual(inline);
    } finally {
      built.store.db.close();
    }
  }, 120_000);

  test("the seeds gave every reader rows", () => {
    expect([...memoReached].sort()).toEqual(
      ["balances", "cut", "positions", "rewards", "valuations"].sort(),
    );
  });

  test("a read after a snapshot-input write fails until the memo is stored again", () => {
    const store = randomStore(SEEDS[0] ?? 9_001);
    try {
      seedObservations(store.db);
      storeMemo(store.db);
      const before = readers(store.db, "memo");
      store.db.run("UPDATE core_snapshot_input_revision SET revision = revision + 1 WHERE id = 1");
      expect(store.db.query(SNAPSHOT_MEMO_KEY_SQL).get()).toEqual({ key_id: null });
      expect(() => readers(store.db, "memo")).toThrow(SNAPSHOT_MEMO_STALE_ERROR);
      storeMemo(store.db, 2);
      expect(readers(store.db, "memo")).toEqual(before);
      // The keys of other revisions went with their members.
      expect(store.db.query("SELECT count(*) AS n FROM snapshot_selection_keys").get()).toEqual({
        n: 1,
      });
      expect(
        store.db
          .query(
            `SELECT count(*) AS n FROM snapshot_selection_members
             WHERE key_id NOT IN (SELECT id FROM snapshot_selection_keys)`,
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      store.db.close();
    }
  });

  test("another build's key for the same revision is neither read nor dropped", () => {
    const store = randomStore(SEEDS[1] ?? 16_920);
    try {
      storeMemo(store.db);
      store.db.run(
        `INSERT INTO snapshot_selection_keys(snapshot_revision, core_epoch, selection_digest, computed_at_ms)
         SELECT snapshot_revision, core_epoch, '${"0".repeat(64)}', 1 FROM snapshot_selection_keys`,
      );
      const ours = store.db.query(SNAPSHOT_MEMO_KEY_SQL).get() as { key_id: number };
      storeMemo(store.db, 3);
      expect(store.db.query(SNAPSHOT_MEMO_KEY_SQL).get()).toEqual(ours);
      expect(store.db.query("SELECT count(*) AS n FROM snapshot_selection_keys").get()).toEqual({
        n: 2,
      });
    } finally {
      store.db.close();
    }
  });
});

test("the registry keys MyJCB past-months containers by the shipped connection", () => {
  const migration = readFileSync(
    join(import.meta.dir, "../../storage-d1/migrations/core/0108_snapshot_selection_memo.sql"),
    "utf8",
  ).replace(/\s+/g, " ");
  const connection = MYJCB_PAST_MONTHS_CONNECTION("a").replace(/\s+/g, " ");
  // Both registry triggers and the backfill.
  expect(migration.split(`THEN ${connection} ELSE '' END`).length - 1).toBe(3);
});
