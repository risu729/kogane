// What the Processor tick's heaviest reads cost on D1, measured with workerd's
// own `meta.rows_read` (issue #1491). Two synthetic CORE stores hold the same
// current balances, positions, reward buckets and stale card purchase keys over
// a history of N and 2N capture days (the current card usage page also returns
// the older statement months the longer history still holds as current): the
// card store of `card-usage-scale-fixture.ts` (Vpass cards with their trusted
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
// What it asserts is a ceiling on today's growth: the ratio of rows read at 2N
// to rows read at N stays at or under what the current plans do (linear in
// the history, quadratic for the Vpass insert), so a change that makes one of
// these reads grow faster with history fails here. A change that makes a read
// cheaper passes; it restates the cost in docs/read-model.md and lowers the
// ceiling to its new measurement in the same PR. The issue's acceptance, a
// cost that does not grow with history, is a `test.todo` per statement. The
// last cases record facts of the shipped statements that the documents quote:
// the report job's reuse of an unchanged report, the Vpass insert's plan, and
// the snapshot selections' share of a latest-balances read. Every value is
// synthetic.
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

/** A statement's text on one line, as the matchers below read it. */
const collapsed = (sql: string) => sql.replace(/\s+/gu, " ").trim();

/** The statements issue #1491 names, recognised by their collapsed text. */
const NAMED = {
  latestBalances: (sql: string) =>
    sql.includes("snapshot_policies(parser_name") && sql.includes("rank_in_group"),
  // The report job's one-cut check (POSITION_CUT_SQL) wraps the same text and
  // returns one row, so it is not a page of positions.
  positions: (sql: string) =>
    sql.includes("snapshot_policies(parser_name") &&
    sql.includes("FROM position_observations po JOIN parse_runs p") &&
    !sql.startsWith("SELECT count(*) AS current_rows"),
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
 * The most each statement's rows read per call may grow from N to 2N capture
 * days (docs/read-model.md, Rows read by the latest-state reads). Today the
 * linear reads double (1.84 to 2.00) and the Vpass binding insert, which walks
 * every Vpass artifact once per binding artifact, nearly quadruples (3.74).
 */
const GROWTH_CEILING: Record<Named, number> = {
  latestBalances: 2.4,
  positions: 2.4,
  positionValuations: 2.4,
  rewardBuckets: 2.4,
  staleKeys: 2.4,
  cardUsage: 2.4,
  vpassBindingInsert: 4.8,
};

interface Tally {
  executions: number;
  rowsRead: number;
  rowsReturned: number;
}
/** Per statement text, exactly as the caller prepared it. */
type Tallies = Map<string, Tally>;

function count(tallies: Tallies, sql: string, rowsRead: number, rowsReturned: number): void {
  const tally = tallies.get(sql) ?? { executions: 0, rowsRead: 0, rowsReturned: 0 };
  tally.executions += 1;
  tally.rowsRead += rowsRead;
  tally.rowsReturned += rowsReturned;
  tallies.set(sql, tally);
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
  /** Rows read by the report job's first run, which stores the report, and by its second, which reuses it. */
  reportBuild: number;
  reportReuse: number;
  /** Each snapshot selection the latest-balances read composes, computed alone once. */
  selections: Record<string, number>;
}

/**
 * The current-snapshot selections the latest-balances read composes, each
 * evaluated alone: their share of what one read costs.
 */
const SELECTIONS = {
  "container snapshots (snapshotCtes)": `WITH ${completeSnapshotCandidates.ctes}
    SELECT (SELECT count(*) FROM current_snapshots) + (SELECT count(*) FROM current_artifact_containers) AS n`,
  "MyJCB past months": `WITH ${myjcbPastMonthsSnapshotCtes()} SELECT count(*) AS n FROM current_myjcb_snapshots`,
  "V Point runs": `WITH ${ELIGIBLE_VPOINT_RUNS} SELECT count(*) AS n FROM current_vpoint_runs`,
} as const;

const rowsReadBy = (tallies: Tallies) =>
  [...tallies.values()].reduce((sum, tally) => sum + tally.rowsRead, 0);

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

  const named = Object.fromEntries(
    (Object.keys(NAMED) as Named[]).map((name) => {
      const total: Tally = { executions: 0, rowsRead: 0, rowsReturned: 0 };
      for (const tallies of Object.values(callers))
        for (const [sql, tally] of tallies)
          if (NAMED[name](collapsed(sql))) {
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
    reportBuild: rowsReadBy(callers["report job (build)"]!),
    reportReuse: rowsReadBy(callers["report job (reuse)"]!),
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

test("the stores hold the same current balances, positions, reward buckets and stale keys over twice the history", () => {
  expect(large.artifacts).toBeGreaterThan(1.9 * small.artifacts);
  const staleKeys = (measured: Measured) =>
    measured.named.staleKeys.rowsReturned / measured.named.staleKeys.executions;
  expect(small.named.staleKeys.rowsReturned).toBeGreaterThan(0);
  expect(staleKeys(large)).toBe(staleKeys(small));
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

test("rows read per call grow with the history no faster than today", () => {
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
  const lanes = Object.keys(small.callers).map((caller) => ({
    caller,
    [`rows read, ${DAYS} days`]: rowsReadBy(small.callers[caller]!),
    [`rows read, ${2 * DAYS} days`]: rowsReadBy(large.callers[caller]!),
  }));
  console.info(`artifacts: ${small.artifacts} / ${large.artifacts}`);
  console.table(table);
  console.table(lanes);
  for (const row of table) {
    const ceiling = GROWTH_CEILING[row.statement as Named];
    // The received object names the measured growth and its ceiling.
    expect({
      statement: row.statement,
      growth: row.growth,
      ceiling,
      withinCeiling: row.growth <= ceiling,
    }).toMatchObject({ statement: row.statement, withinCeiling: true });
  }
});

// Issue #1491's acceptance: doubling the historical artifacts at the same
// current state adds at most a small constant.
for (const name of Object.keys(NAMED))
  test.todo(`${name}: rows read per call at 2N within a small constant of N (issue #1491)`);

test("the report job's second run over unchanged inputs reads as much as its first", () => {
  console.info("report job: build vs reuse of the stored report", {
    [`build, ${DAYS} days`]: small.reportBuild,
    [`reuse, ${DAYS} days`]: small.reportReuse,
    [`build, ${2 * DAYS} days`]: large.reportBuild,
    [`reuse, ${2 * DAYS} days`]: large.reportReuse,
  });
  // runReportJob reads every position, valuation, decimal and price before it
  // compares the manifest digest with the stored report.
  for (const measured of [small, large])
    expect(measured.reportReuse).toBeGreaterThan(0.95 * measured.reportBuild);
  expect(large.reportReuse).toBeGreaterThan(1.6 * small.reportReuse);
});

test("the Vpass binding insert's plan nests every Vpass artifact under every binding artifact", () => {
  const shipped = [...small.callers["identity sweep (v-point, empty parses)"]!.keys()].find((sql) =>
    NAMED.vpassBindingInsert(collapsed(sql)),
  )!;
  const db = fullCoreDatabase();
  try {
    const plan = planOf(db, shipped, ["[]"]);
    // The binding artifacts first, then every Vpass artifact for each; the
    // batch's candidates are the innermost loop.
    expect(plan[0]).toStartWith("SEARCH ba USING INDEX idx_fetch_artifacts_source_dataset_time");
    expect(plan).toContain(
      "SEARCH fa USING INDEX idx_fetch_artifacts_source_dataset_time (source_id=?)",
    );
    expect(plan.at(-1)).toStartWith("SCAN candidate VIRTUAL TABLE");
  } finally {
    db.close();
  }
});

test("the snapshot selections alone are most of a latest-balances read", () => {
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
  for (const measured of [small, large]) {
    for (const value of Object.values(measured.selections)) expect(value).toBeGreaterThan(0);
    expect(once(measured)).toBeGreaterThan(0.5 * perCall(measured));
    expect(once(measured)).toBeLessThan(perCall(measured));
  }
  expect(once(large)).toBeGreaterThan(1.6 * once(small));
});
