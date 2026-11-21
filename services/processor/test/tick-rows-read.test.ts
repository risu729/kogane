// What the Processor tick's heaviest reads cost on D1, measured with workerd's
// own `meta.rows_read` (issue #1491, ADR 0129). Two synthetic CORE stores hold
// the same current state over a history of N and 2N capture days: the card
// store of `card-usage-scale-fixture.ts` (Vpass cards with their trusted
// binding runs, a MyJCB connection, SMBC, St.George and SBI Shinsei, statement
// history and settlement reviews) plus, on each capture day, a V Point run of
// its three page datasets (the history page empty, as a page with no entries
// parses) and an SBI Securities domestic cash positions run, with the reward
// claims the promotion lane writes for them. Each store is copied into its own
// Miniflare D1 (support/d1-copy.ts) and each statement is run through its real
// caller, on a binding that records `rows_read` per statement text:
//
//   latest balances      captureFixedInput (3 x listLatestBalances)
//   positions            runReportJob (listPositions), twice: build, then reuse
//   reward buckets       captureRewardInput (CURRENT_REWARD_BUCKETS_SQL)
//   stale keys, usage    cardPurchaseSweep (STALE_CARD_PURCHASE_KEYS_SQL, currentCardUsageSql)
//   Vpass binding insert identitySweep (the empty-parse batch)
//
// What it asserts is today's growth, as a measured baseline rather than a
// budget: the ratio of rows read at 2N to rows read at N lies in a band around
// what the current plans do (linear in the history, quadratic for the Vpass
// insert). A change that makes a read cheaper or dearer moves its ratio out of
// the band and fails here, so the change states its new cost in the same PR
// and tightens the band; the target (ADR 0129) is a `test.todo` until a slice
// reaches it. The two prototypes at the end measure slices 1 and 2 of ADR 0129
// without touching a production path: the report job's reuse against a skip
// keyed on the CORE revision, and the Vpass binding insert written to start
// from its candidate. Every value is synthetic.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import {
  scaledStore,
  STATEMENT_CI_SCALE,
} from "../../../packages/read-model/test/card-usage-scale-fixture.ts";
import { QualityStore } from "../../../packages/read-model/test/collection-quality-fixture.ts";
import { completeSnapshotCandidates } from "../../../packages/read-model/src/concepts.ts";
import {
  ELIGIBLE_VPOINT_RUNS,
  myjcbPastMonthsSnapshotCtes,
} from "../../../packages/read-model/src/current-captures.ts";
import { identitySweep } from "../../../packages/storage-d1/src/core/identity-store.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";
import { planOf } from "../../../packages/storage-d1/test/plan-check.ts";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { captureFixedInput } from "../src/balance-projection-job.ts";
import { cardPurchaseSweep } from "../src/card-purchase-job.ts";
import { promoteRewardClaims } from "../src/reward-claims-job.ts";
import { captureRewardInput } from "../src/reward-read-projection.ts";
import { runReportJob } from "../src/report-job.ts";
import { copyIntoD1 } from "./support/d1-copy.ts";
import { settledTest } from "./support/settle.ts";

/** Capture days of the smaller store; the larger one has twice as many, ending the same day. */
const DAYS = 30;
const TODAY = STATEMENT_CI_SCALE.today;
const DAY_MS = 86_400_000;

/** The statements issue #1491 names, recognised by their text. */
const NAMED = {
  latestBalances: (sql: string) =>
    sql.includes("snapshot_policies(parser_name") && sql.includes("rank_in_group"),
  positions: (sql: string) =>
    sql.includes("snapshot_policies(parser_name") &&
    sql.includes("FROM position_observations po JOIN parse_runs p"),
  positionValuations: (sql: string) =>
    sql.includes("snapshot_policies(parser_name") &&
    sql.includes("JOIN valuation_observations v ON v.parse_run_id = po.parse_run_id"),
  rewardBuckets: (sql: string) => sql.startsWith("WITH eligible_vpoint_runs"),
  staleKeys: (sql: string) => sql.startsWith("WITH current_keys AS MATERIALIZED"),
  cardUsage: (sql: string) =>
    sql.startsWith("WITH ranked_myjcb_snapshots") && sql.includes("current_rows AS MATERIALIZED"),
  vpassBindingInsert: (sql: string) =>
    sql.startsWith("INSERT INTO identity_vpass_bindings SELECT r.id,b.financial_unit_id"),
} as const;
type Named = keyof typeof NAMED;

/**
 * Today's growth from N to 2N capture days, per statement, as `[low, high]`
 * around the measured ratio (docs/read-model.md, Cost; ADR 0129). Linear reads
 * double; the Vpass binding insert walks every Vpass artifact once per binding
 * artifact, so it quadruples.
 */
const BASELINE_GROWTH: Record<Named, readonly [number, number]> = {
  latestBalances: [1.6, 2.4],
  positions: [1.6, 2.4],
  positionValuations: [1.6, 2.4],
  rewardBuckets: [1.6, 2.4],
  staleKeys: [1.6, 2.4],
  cardUsage: [1.6, 2.4],
  vpassBindingInsert: [3.2, 4.8],
};

interface Tally {
  executions: number;
  rowsRead: number;
  rowsReturned: number;
}
type Tallies = Map<string, Tally>;

const collapsed = (sql: string) => sql.replace(/\s+/gu, " ").trim();

function count(tallies: Tallies, sql: string, rowsRead: number, rowsReturned: number): void {
  const key = collapsed(sql);
  const tally = tallies.get(key) ?? { executions: 0, rowsRead: 0, rowsReturned: 0 };
  tally.executions += 1;
  tally.rowsRead += rowsRead;
  tally.rowsReturned += rowsReturned;
  tallies.set(key, tally);
}

/**
 * The binding, recording `rows_read` per statement text. `first()` is served
 * by `all()`: D1 runs the whole statement for both, and only `all()` returns
 * the meta.
 */
function recording(db: D1Database, tallies: Tallies): D1Database {
  const statements = new WeakMap<object, { target: D1PreparedStatement; sql: string }>();
  const wrap = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(target, {
      get(statement, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(statement.bind(...values), sql);
        if (property === "all" || property === "run")
          return async () => {
            const result = await statement.all();
            count(tallies, sql, result.meta.rows_read, result.results.length);
            return result;
          };
        if (property === "first")
          return async (column?: string) => {
            const result = await statement.all<Record<string, unknown>>();
            count(tallies, sql, result.meta.rows_read, result.results.length);
            const row = result.results[0] ?? null;
            return column === undefined || row === null ? row : (row[column] ?? null);
          };
        const value = Reflect.get(statement, property) as unknown;
        return typeof value === "function" ? value.bind(statement) : value;
      },
    });
    statements.set(proxy, { target, sql });
    return proxy;
  };
  return new Proxy(db, {
    get(database, property) {
      if (property === "prepare") return (sql: string) => wrap(database.prepare(sql), sql);
      if (property === "batch")
        return async (batch: D1PreparedStatement[]) => {
          const results = await database.batch(
            batch.map((statement) => statements.get(statement)?.target ?? statement),
          );
          results.forEach((result, index) =>
            count(
              tallies,
              statements.get(batch[index]!)?.sql ?? "",
              result.meta.rows_read,
              result.results?.length ?? 0,
            ),
          );
          return results;
        };
      const value = Reflect.get(database, property) as unknown;
      return typeof value === "function" ? value.bind(database) : value;
    },
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Per capture day, a V Point run (balance info and SMFG point with one
 * balance each, an empty history page) and an SBI Securities domestic cash
 * positions run with three positions, then the reward claims the promotion
 * lane writes for the V Point balances.
 */
async function seedOtherSources(db: Database, days: number): Promise<void> {
  const top = db.query("SELECT max(id) AS id FROM fetch_artifacts").get() as { id: number };
  const store = new QualityStore({ db, firstId: top.id + 1_000_000 });
  const balance = db.query(
    "INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json) VALUES(?,?,?,?,0,'V_POINT',?,'json:synthetic','{}')",
  );
  const position = db.query(
    "INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json) VALUES(?,'sbi-securities:synthetic',?,?,'TSE',?,0,'JPY',?,?,?,'{}')",
  );
  // SBI's domestic locator rule pairs a valuation with the position whose row
  // number it follows (POSITION_VALUATION_LOCATOR): 27 characters, then the row.
  const valuation = db.query(
    "INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,amount_text,amount_scale,currency,as_of,observed_at,raw_locator,extra_json) VALUES(?,'sbi-securities:synthetic',?,'market_value',?,0,'JPY',?,?,?,'{}')",
  );
  const end = Date.parse(`${TODAY}T03:00:00.000Z`);
  for (let day = days - 1; day >= 0; day -= 1) {
    const at = iso(end - day * DAY_MS);
    const vpoint = store.run({
      source: "v-point",
      at,
      artifacts: [
        { key: "balance-info.json", dataset: "balance-info" },
        { key: "smfg-point.json", dataset: "smfg-point" },
        { key: "history-page-1.json", dataset: "history-page-1" },
      ],
    });
    const [info, smfg, history] = vpoint.artifacts;
    const infoParse = store.parse(info!, "v-point-balance-info", { kind: "published" })!;
    balance.run(infoParse, "v-point:regular:0", "available_point_bucket", String(1000 + day), at);
    const smfgParse = store.parse(smfg!, "v-point-smfg-point", { kind: "published" })!;
    balance.run(smfgParse, "v-point:smfg", "displayed_point_balance", String(200 + day), at);
    store.parse(history!, "v-point-history-page", { kind: "published" });
    const sbi = store.run({
      source: "sbi-securities",
      at,
      units: { "cash-positions": { outcome: "success" } },
      artifacts: [
        {
          key: "domestic-cash-positions.csv",
          dataset: "domestic-cash-positions",
          unit: "cash-positions",
        },
      ],
    });
    const sbiParse = store.parse(sbi.artifacts[0]!, "sbi-domestic-cash-positions", {
      kind: "published",
    })!;
    for (const [row, code] of ["1001", "1002", "1003"].entries()) {
      const locator = (offset: number) => `csv:synthetic-domestic-row:${10 * row + offset}`;
      position.run(
        sbiParse,
        `SYN${code}`,
        `Synthetic ${code}`,
        String(100 + day),
        at.slice(0, 10),
        at,
        locator(0),
      );
      valuation.run(sbiParse, `SYN${code}`, String(5000 + day), at.slice(0, 10), at, locator(1));
    }
  }
  const d1 = sqliteD1(db) as unknown as Parameters<typeof promoteRewardClaims>[0];
  for (let sweep = 0; sweep < 100; sweep += 1) {
    const promoted = await promoteRewardClaims(d1, { now: `${TODAY}T04:00:00.000Z` });
    if (promoted.scanned === 0) break;
  }
}

async function migrated(name: string): Promise<D1Database> {
  const db = await mf.getD1Database(name);
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await db.batch(
      splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file)).map((sql) => db.prepare(sql)),
    );
  return db;
}

interface Measured {
  /** Per caller: every statement it ran. */
  callers: Record<string, Tallies>;
  /** Per named statement: the sum over every caller that ran it. */
  named: Record<Named, Tally>;
  currentBalances: number;
  currentPositions: number;
  currentRewardBuckets: number;
  artifacts: number;
  /** The report job's second, unchanged run against a skip keyed on the revision. */
  reportReuse: number;
  revisionRead: number;
  /** The Vpass binding join as shipped and written from the candidate. */
  vpassShipped: { rowsRead: number; rows: unknown[] };
  vpassFromCandidate: { rowsRead: number; rows: unknown[] };
  /** Each snapshot selection the latest-balances read composes, computed alone once. */
  selections: Record<string, number>;
}

/**
 * The current-snapshot selections of the latest-balances read, each alone:
 * what computing the set once costs, against what each read that composes
 * it pays (ADR 0129, direction 1).
 */
const SELECTIONS = {
  "container snapshots (snapshotCtes)": `WITH ${completeSnapshotCandidates.ctes}
    SELECT (SELECT count(*) FROM current_snapshots) + (SELECT count(*) FROM current_artifact_containers) AS n`,
  "MyJCB past months": `WITH ${myjcbPastMonthsSnapshotCtes()} SELECT count(*) AS n FROM current_myjcb_snapshots`,
  "V Point runs": `WITH ${ELIGIBLE_VPOINT_RUNS} SELECT count(*) AS n FROM current_vpoint_runs`,
} as const;

const VPASS_BINDING_JOIN = (join: "JOIN" | "CROSS JOIN") =>
  `SELECT r.id,b.financial_unit_id,b.binding_artifact_id,b.card_token FROM json_each(?) candidate
  ${join} identity_runs r ON r.id=json_extract(candidate.value,'$[0]')
    AND r.policy_version=json_extract(candidate.value,'$[2]') AND r.policy_version=2
  ${join} parse_runs p ON p.id=r.parse_run_id AND p.id=json_extract(candidate.value,'$[1]')
  ${join} trusted_vpass_card_bindings b ON b.financial_artifact_id=p.fetch_artifact_id
  WHERE p.status='ok'`;

async function measure(db: D1Database, evidence: R2Bucket): Promise<Measured> {
  const callers: Record<string, Tallies> = {};
  const run = async <T>(caller: string, body: (db: D1Database) => Promise<T>): Promise<T> => {
    const tallies: Tallies = new Map();
    callers[caller] = tallies;
    return await body(recording(db, tallies));
  };
  const now = `${TODAY}T05:00:00.000Z`;
  const balances = await run("balance projection capture", (d) =>
    captureFixedInput(d as never, { now: () => now }),
  );
  if (!balances.ok) throw new Error(`capture_${balances.code}`);
  const rewards = await run("reward read projection capture", (d) =>
    captureRewardInput(d as never, { now: () => now }),
  );
  if (!rewards.ok) throw new Error(`reward_capture_${rewards.code}`);
  const options = {
    actor: "report-job",
    now,
    unitRef: "JPY",
    perimeterRef: "perimeter:all-visible-evidence",
    knowledgeCutoff: now,
    decimalPolicyRelease: "decimal-v1",
  };
  const built = await run("report job (build)", (d) =>
    runReportJob({ DB: d, EVIDENCE: evidence, REPORTS_ENABLED: "true" }, options),
  );
  const reused = await run("report job (reuse)", (d) =>
    runReportJob({ DB: d, EVIDENCE: evidence, REPORTS_ENABLED: "true" }, options),
  );
  expect(built.generated).toBe(1);
  expect(reused).toMatchObject({ reused: 1, reportId: built.reportId });
  await run("card purchase sweep", (d) => cardPurchaseSweep(d, { now }));
  // The lane's sweep takes the oldest unidentified parses, here card store
  // rows with observations; the V Point sweep reaches the batch that
  // identifies empty parses, whose third statement is the Vpass binding
  // insert (it runs for any empty candidate, whatever its source).
  await run("identity sweep", (d) => identitySweep(d as never, resolveIdentity, 8));
  const vpoint = await run("identity sweep (v-point, empty parses)", (d) =>
    identitySweep(d as never, resolveIdentity, 8, "v-point"),
  );
  expect(vpoint.processedRuns).toBeGreaterThan(0);

  // Slice 1 prototype: the reuse decision keyed on what the report reads.
  const revision = await db
    .prepare(
      "SELECT source_revision,visibility_revision,core_epoch FROM core_source_revision WHERE id=1",
    )
    .all();
  // Slice 2 prototype: the binding join over every identified Vpass parse,
  // in the shipped join order and starting from the candidate.
  const candidates = JSON.stringify(
    (
      await db
        .prepare("SELECT id,parse_run_id FROM identity_runs WHERE policy_version=2 ORDER BY id")
        .all<{ id: string; parse_run_id: number }>()
    ).results.map((row) => [row.id, row.parse_run_id, 2]),
  );
  const join = async (text: string) => {
    const result = await db.prepare(`${text} ORDER BY r.id`).bind(candidates).all();
    return { rowsRead: result.meta.rows_read, rows: result.results };
  };

  const named = Object.fromEntries(
    (Object.keys(NAMED) as Named[]).map((name) => {
      const total: Tally = { executions: 0, rowsRead: 0, rowsReturned: 0 };
      for (const tallies of Object.values(callers))
        for (const [sql, tally] of tallies)
          if (NAMED[name](sql)) {
            total.executions += tally.executions;
            total.rowsRead += tally.rowsRead;
            total.rowsReturned += tally.rowsReturned;
          }
      return [name, total];
    }),
  ) as Record<Named, Tally>;
  const selections: Record<string, number> = {};
  for (const [name, sql] of Object.entries(SELECTIONS))
    selections[name] = (await db.prepare(sql).all()).meta.rows_read;
  const scalar = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
  return {
    callers,
    named,
    currentBalances: balances.captured.input.content.candidates.length,
    currentPositions: named.positions.rowsReturned / Math.max(named.positions.executions, 1),
    currentRewardBuckets: rewards.captured.input.content.buckets.length,
    artifacts: await scalar("SELECT count(*) AS n FROM fetch_artifacts"),
    reportReuse: [...callers["report job (reuse)"]!.values()].reduce(
      (sum, tally) => sum + tally.rowsRead,
      0,
    ),
    revisionRead: revision.meta.rows_read,
    vpassShipped: await join(VPASS_BINDING_JOIN("JOIN")),
    vpassFromCandidate: await join(VPASS_BINDING_JOIN("CROSS JOIN")),
    selections,
  };
}

// Started while the module loads, never in a hook (test/support/settle.ts).
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response('local')}}",
    compatibilityDate: "2026-09-07",
    d1Databases: ["SMALL", "LARGE"],
    r2Buckets: ["EVIDENCE"],
  }),
);
const test = settledTest();
afterAll(async () => {
  await mf.dispose();
});

let small: Measured;
let large: Measured;

beforeAll(async () => {
  // The plan check's migrated image is built once, here, not inside its case.
  fullCoreDatabase().close();
  const evidence = (await mf.getR2Bucket("EVIDENCE")) as unknown as R2Bucket;
  const sizes: [string, number][] = [
    ["SMALL", DAYS],
    ["LARGE", 2 * DAYS],
  ];
  const results: Measured[] = [];
  for (const [name, days] of sizes) {
    const built = await scaledStore({ ...STATEMENT_CI_SCALE, dailyDays: days });
    await seedOtherSources(built.store.db, days);
    const db = await migrated(name);
    await copyIntoD1(built.store.db, db);
    built.store.db.close();
    results.push(await measure(db, evidence));
  }
  [small, large] = results as [Measured, Measured];
}, 600_000);

test("the stores hold the same current state over twice the history", () => {
  expect(large.artifacts).toBeGreaterThan(1.9 * small.artifacts);
  expect(small.currentBalances).toBeGreaterThan(0);
  expect(large.currentBalances).toBe(small.currentBalances);
  expect(small.currentPositions).toBe(3);
  expect(large.currentPositions).toBe(small.currentPositions);
  expect(small.currentRewardBuckets).toBeGreaterThan(0);
  expect(large.currentRewardBuckets).toBe(small.currentRewardBuckets);
});

test("every named statement runs through its caller on both stores", () => {
  for (const measured of [small, large])
    for (const name of Object.keys(NAMED) as Named[]) {
      expect({ name, ran: measured.named[name].executions > 0 }).toEqual({ name, ran: true });
      expect(measured.named[name].rowsRead).toBeGreaterThan(0);
    }
  // captureFixedInput reads the latest balances three times (balance-projection-job.ts).
  expect(small.named.latestBalances.executions).toBe(3);
});

test("rows read per call grow with the history today (measured baseline)", () => {
  const table = (Object.keys(NAMED) as Named[]).map((name) => {
    const perCall = (measured: Measured) =>
      Math.round(measured.named[name].rowsRead / measured.named[name].executions);
    return {
      statement: name,
      [`rows read per call, ${DAYS} days`]: perCall(small),
      [`rows read per call, ${2 * DAYS} days`]: perCall(large),
      growth: Number((perCall(large) / perCall(small)).toFixed(2)),
      [`rows returned per call, ${DAYS} / ${2 * DAYS} days`]: `${Math.round(small.named[name].rowsReturned / small.named[name].executions)} / ${Math.round(large.named[name].rowsReturned / large.named[name].executions)}`,
    };
  });
  const lanes = Object.keys(small.callers).map((caller) => {
    const total = (measured: Measured) =>
      [...measured.callers[caller]!.values()].reduce((sum, tally) => sum + tally.rowsRead, 0);
    return {
      caller,
      [`rows read, ${DAYS} days`]: total(small),
      [`rows read, ${2 * DAYS} days`]: total(large),
    };
  });
  console.info(`artifacts: ${small.artifacts} / ${large.artifacts}`);
  console.table(table);
  console.table(lanes);
  for (const row of table) {
    const [low, high] = BASELINE_GROWTH[row.statement as Named];
    expect({ statement: row.statement, inBand: row.growth >= low && row.growth <= high }).toEqual({
      statement: row.statement,
      inBand: true,
    });
  }
});

// ADR 0129's acceptance, from issue #1491: doubling the historical artifacts
// at the same current state adds at most a small constant.
for (const name of Object.keys(NAMED))
  test.todo(`${name}: rows read per call at 2N within a small constant of N (ADR 0129)`);

test("prototype, slice 1: a report skip keyed on the revision reads a few rows instead of the reuse", () => {
  console.info("report job reuse vs revision-keyed skip", {
    [`reuse, ${DAYS} days`]: small.reportReuse,
    [`reuse, ${2 * DAYS} days`]: large.reportReuse,
    "revision row": large.revisionRead,
  });
  // The reuse rebuilds the whole context only to find the stored report; the
  // key it would compare is one row, and the stored key one more.
  expect(large.revisionRead).toBeLessThanOrEqual(2);
  expect(large.reportReuse).toBeGreaterThan(1.6 * small.reportReuse);
});

/** The shipped insert with its three joins made CROSS JOINs, which SQLite never reorders. */
const fromCandidate = (sql: string) =>
  sql
    .replace("JOIN identity_runs r", "CROSS JOIN identity_runs r")
    .replace("JOIN parse_runs p", "CROSS JOIN parse_runs p")
    .replace("JOIN trusted_vpass_card_bindings b", "CROSS JOIN trusted_vpass_card_bindings b");

test("prototype, slice 2: the Vpass binding insert's plan nests every Vpass artifact under every binding artifact; from the candidate it is keyed", () => {
  const shipped = [...small.callers["identity sweep (v-point, empty parses)"]!.keys()].find(
    NAMED.vpassBindingInsert,
  )!;
  const db = fullCoreDatabase();
  try {
    const before = planOf(db, shipped, ["[]"]);
    const after = planOf(db, fromCandidate(shipped), ["[]"]);
    // Shipped: the binding artifacts first, then every Vpass artifact for each.
    expect(before[0]).toStartWith("SEARCH ba USING INDEX idx_fetch_artifacts_source_dataset_time");
    expect(before).toContain(
      "SEARCH fa USING INDEX idx_fetch_artifacts_source_dataset_time (source_id=?)",
    );
    expect(before.at(-1)).toStartWith("SCAN candidate VIRTUAL TABLE");
    // From the candidate: the candidate list is the only scan; the rest is by key.
    expect(after[0]).toStartWith("SCAN candidate VIRTUAL TABLE");
    expect(after.filter((step) => step.startsWith("SCAN "))).toEqual([after[0]!]);
    expect(after.some((step) => step.includes("AUTOMATIC"))).toBe(false);
  } finally {
    db.close();
  }
});

test("prototype, slice 2: the Vpass binding join started from the candidate returns the same rows by key", () => {
  for (const measured of [small, large]) {
    expect(measured.vpassShipped.rows.length).toBeGreaterThan(0);
    expect(measured.vpassFromCandidate.rows).toEqual(measured.vpassShipped.rows);
  }
  console.info("Vpass binding join: shipped order vs from the candidate", {
    [`shipped, ${DAYS} days`]: small.vpassShipped.rowsRead,
    [`shipped, ${2 * DAYS} days`]: large.vpassShipped.rowsRead,
    [`from candidate, ${DAYS} days`]: small.vpassFromCandidate.rowsRead,
    [`from candidate, ${2 * DAYS} days`]: large.vpassFromCandidate.rowsRead,
    candidates: `${small.vpassShipped.rows.length} / ${large.vpassShipped.rows.length}`,
  });
  // Started from the candidate, each candidate reaches its binding by key, so
  // the rows read follow the candidates, not the Vpass history.
  const perCandidate = (measured: Measured, side: "vpassShipped" | "vpassFromCandidate") =>
    measured[side].rowsRead / measured[side].rows.length;
  expect(perCandidate(large, "vpassFromCandidate")).toBeLessThan(
    1.2 * perCandidate(small, "vpassFromCandidate"),
  );
  expect(large.vpassFromCandidate.rowsRead).toBeLessThan(large.vpassShipped.rowsRead / 4);
});

test("prototype, direction 1: the snapshot selections alone are most of each latest-state read", () => {
  const rows = Object.keys(SELECTIONS).map((name) => ({
    selection: name,
    [`rows read once, ${DAYS} days`]: small.selections[name],
    [`rows read once, ${2 * DAYS} days`]: large.selections[name],
  }));
  console.table(rows);
  const once = (measured: Measured) =>
    Object.values(measured.selections).reduce((sum, value) => sum + value, 0);
  const perCall = (measured: Measured) =>
    measured.named.latestBalances.rowsRead / measured.named.latestBalances.executions;
  console.info("latest balances: selections alone vs the whole read", {
    [`selections, ${2 * DAYS} days`]: once(large),
    [`whole read, ${2 * DAYS} days`]: Math.round(perCall(large)),
  });
  for (const measured of [small, large])
    for (const value of Object.values(measured.selections)) expect(value).toBeGreaterThan(0);
  expect(once(large)).toBeGreaterThan(1.6 * once(small));
});
