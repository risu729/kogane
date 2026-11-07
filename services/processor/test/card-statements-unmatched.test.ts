// The review read of card statements without a settlement candidate
// (packages/application/src/query/card-statements-unmatched.ts,
// docs/card-settlements.md, Statements without a candidate) on the complete
// CORE schema: each closed code, the ADR 0074 planner's read-only answer, the
// grouping of overlapping windows, the bounded list of a window of 32 equal
// debits (ADR 0074, amendment 2026-11-07), that a swept statement leaves the list,
// that the read writes nothing, and that its own lookups are keyed without
// table statistics. Every value is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  reviewUnmatchedCardStatements,
  UNMATCHED_DEBIT_PARSERS_SQL,
  UNMATCHED_HELD_ALIASES_SQL,
  UNMATCHED_HELD_KEYS_SQL,
  UNMATCHED_RESERVED_STATEMENTS_SQL,
  type UnmatchedAllocation,
  type UnmatchedCardStatement,
} from "../../../packages/application/src/query/card-statements-unmatched.ts";
import type { Grant } from "../../../packages/application/src/grants.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare, env: Env, db: D1Database;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
  await seed();
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

const resolver: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic",
    role: "deposit",
    status: "provider-local",
    reason: "test",
  },
  instruments: [],
  issues: [],
});

const WHOLE: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

/** Statement totals: [period, total, due date]. */
const STATEMENTS: [string, string, string | null][] = [
  ["2098-01", "3000", "2098-01-10"], // two debits pay it, and nothing else can use them
  ["2098-02", "5000", "2098-02-10"], // one smaller debit: a shortfall
  ["2098-03", "-1200", "2098-03-10"], // a refund
  ["2098-04", "4000", "2098-04-10"], // nothing in the window
  ["2098-05", "7000", "2098-05-10"], // an equal debit the sweep has not reached
  ["2098-06", "3000", "2098-06-10"], // two statements whose windows share one debit pair
  ["2098-07", "3000", "2098-06-14"],
  ["2098-08", "2000", null], // no due date
  ["2098-09", "3000", "2098-09-28"], // two debits sum to it, beside a third whose date is no civil date
  ["2098-10", "3000", "2098-10-20"], // 32 equal debits: any three of them sum to it
];
/** SMBC debits: [provider id, magnitude, debit date]. */
const DEBITS: [string, string, string][] = [
  ["d-1a", "1000", "2098-01-09"],
  ["d-1b", "2000", "2098-01-11"],
  ["d-2", "2000", "2098-02-10"],
  ["d-5", "7000", "2098-05-10"],
  ["d-6a", "1000", "2098-06-11"],
  ["d-6b", "2000", "2098-06-12"],
  ["d-9a", "1000", "2098-09-27"],
  ["d-9b", "2000", "2098-09-29"],
  // Not a civil date, yet inside the window's text comparison: the sweep never
  // compares it, and the planner must see it, not lose it.
  ["d-9c", "1000", "2098-09-31"],
  // The planner's own bound of 32 debits, each a third of the total: 4,960
  // exact three-debit sums, of which the answer lists the first 50.
  ...Array.from<unknown, [string, string, string]>({ length: 32 }, (_, index) => [
    `d-10-${String(index).padStart(2, "0")}`,
    "1000",
    "2098-10-20",
  ]),
];

async function seed() {
  for (const [id, source, parser] of [
    [701, "myjcb", "myjcb-credit-statement-total"],
    [702, "smbc-bank", "smbc-direct-transactions"],
  ] as const) {
    await seedArtifact(env, id, source, "synthetic", "synthetic-" + id, {});
    await db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2098-09-12','ok','[]')",
      )
      .bind(id, id, parser)
      .run();
  }
  for (const [period, total, due] of STATEMENTS)
    await db
      .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
 VALUES(701,'myjcb:synthetic:root','credit_statement_payment_amount',?,?,0,'JPY',?,?,?)`)
      .bind(
        Number(total),
        total,
        period + "-01",
        "synthetic-" + period,
        JSON.stringify({
          _kogane: {
            period,
            ...(due === null ? {} : { paymentDate: due }),
            snapshotSemantics: "provider-reported-monthly-payment-amount",
          },
        }),
      )
      .run();
  for (const [providerId, amount, date] of DEBITS)
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
  VALUES(702,'smbc-bank:synthetic',?,'posted',?,?,0,'JPY','synthetic',?,?,?)`)
      .bind(
        providerId,
        -Number(amount),
        "-" + amount,
        date + "T00:00:00+09:00",
        "synthetic-" + providerId,
        JSON.stringify({
          id: providerId,
          _kogane: {
            direction: "outflow",
            amountSignSource: "direction",
            identityOrigin: "provider-id",
          },
        }),
      )
      .run();
  for (const [id, source] of [
    [701, "myjcb"],
    [702, "smbc-bank"],
  ] as const) {
    await publishParse(db, id);
    await identifyParse(
      db,
      {
        id,
        artifact_id: id,
        source_id: source,
        producer_id: "collector-r2-importer",
        fetch_run_id: id,
      },
      resolver,
    );
  }
}

async function review(grant: Grant = WHOLE) {
  const outcome = await reviewUnmatchedCardStatements({
    grant,
    sql: d1Executor(db),
    request: { offset: 0 },
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.review;
}

const byPeriod = (items: readonly UnmatchedCardStatement[]) =>
  new Map(items.map((item) => [item.statement.period, item]));
const memberIds = (item: UnmatchedCardStatement | undefined) =>
  item?.planner && "allocations" in item.planner
    ? item.planner.allocations.map((allocation) =>
        allocation.members.map((member) => member.ref.id),
      )
    : null;

/** Rows per table of the store, so a read that writes anything is seen. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  const counts: Record<string, number> = {};
  for (const { name } of tables)
    counts[name] = (await db
      .prepare(`SELECT count(*) AS n FROM "${name}"`)
      .first<{ n: number }>())!.n;
  return counts;
}

async function debitId(providerId: string): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM transaction_observations WHERE external_id=?")
    .bind(providerId)
    .first<{ id: number }>();
  return "transaction:" + row!.id;
}

test("each statement without a candidate carries its closed code and, where asked, the planner's answer", async () => {
  const before = await rowCounts();
  const page = await review();
  expect(page.items).toHaveLength(STATEMENTS.length);
  expect(page.nextOffset).toBeNull();
  const items = byPeriod(page.items);
  expect(Object.fromEntries([...items].map(([period, item]) => [period, item.code]))).toEqual({
    "2098-01": "no_equal_amount_debit",
    "2098-02": "no_equal_amount_debit",
    "2098-03": "statement_total_refund_or_zero",
    "2098-04": "no_debit_in_window",
    "2098-05": "equal_amount_debit_awaiting_sweep",
    "2098-06": "no_equal_amount_debit",
    "2098-07": "no_equal_amount_debit",
    "2098-08": "statement_not_comparable",
    "2098-09": "no_equal_amount_debit",
    "2098-10": "no_equal_amount_debit",
  });
  // Two whole debits pay the first statement exactly: listed, never acceptable.
  expect(items.get("2098-01")?.planner).toMatchObject({
    status: "proposed",
    codes: [],
    allocationCount: 1,
    allocationsTruncated: false,
  });
  expect(memberIds(items.get("2098-01"))).toEqual([
    [await debitId("d-1a"), await debitId("d-1b")].sort(),
  ]);
  const first = items.get("2098-01")!.planner as { allocations: UnmatchedAllocation[] };
  const [allocation] = first.allocations;
  expect(allocation).toMatchObject({ kind: "multiple-debits", ownership: "unknown" });
  expect(allocation?.rejectionConditions).toContain("owner_not_established");
  // A shortfall names its shape and computes no remainder.
  expect(items.get("2098-02")?.planner).toEqual({
    status: "unsupported",
    codes: ["no_exact_allocation", "in_window_debits_below_total"],
    allocations: [],
    allocationCount: 0,
    allocationsTruncated: false,
  });
  // Overlapping windows are planned together, so the shared pair is contested.
  for (const period of ["2098-06", "2098-07"])
    expect(items.get(period)?.planner).toMatchObject({
      status: "needs_review",
      codes: ["candidate_not_unique", "debit_in_other_statement_allocation"],
    });
  // A debit without a civil date is not dropped before the planner: it could
  // replace a member, so the exact pair is not proposed alone (ADR 0074).
  expect(items.get("2098-09")?.debitsInWindow).toBe(3);
  expect(items.get("2098-09")?.planner).toMatchObject({ status: "needs_review" });
  expect((items.get("2098-09")!.planner as { codes: string[] }).codes).toContain(
    "excluded_debit_competes",
  );
  // The worst window is counted whole and listed first-50, fewest debits first
  // then by member ref ids, and says it stops short (ADR 0074, 2026-11-07).
  const worst = items.get("2098-10")!;
  expect(worst.debitsInWindow).toBe(32);
  expect(worst.planner).toMatchObject({
    status: "needs_review",
    codes: ["candidate_not_unique"],
    allocationCount: 4960,
    allocationsTruncated: true,
  });
  const listed = memberIds(worst)!;
  expect(listed).toHaveLength(50);
  const worstIds = (
    await Promise.all(
      Array.from({ length: 32 }, (_, index) => debitId(`d-10-${String(index).padStart(2, "0")}`)),
    )
  ).sort();
  const firstTriples: string[][] = [];
  for (let a = 0; a < 32 && firstTriples.length < 50; a++)
    for (let b = a + 1; b < 32 && firstTriples.length < 50; b++)
      for (let c = b + 1; c < 32 && firstTriples.length < 50; c++)
        firstTriples.push([worstIds[a]!, worstIds[b]!, worstIds[c]!]);
  expect(listed).toEqual(firstTriples);
  expect(page.manifest.planner.bounds).toEqual({ statements: 16, debits: 32, allocations: 50 });
  // The planner is asked only about no_equal_amount_debit.
  for (const period of ["2098-03", "2098-04", "2098-05", "2098-08"])
    expect(items.get(period)?.planner).toBeNull();
  expect(items.get("2098-04")?.debitsInWindow).toBe(0);
  expect(items.get("2098-08")?.debitsInWindow).toBeNull();
  expect(items.get("2098-08")?.statement.paymentDate).toBeNull();
  expect(page.items.every((item) => item.acceptable === false)).toBe(true);
  expect(page.manifest).toMatchObject({
    acceptance: "single-debit-candidates-only",
    planner: {
      release: "card-statement-allocation-v2",
      partition: "page-overlapping-windows",
      policy: {
        policyVersion: "card-statement-unmatched-display-v1",
        window: { minDaysFromDue: -3, maxDaysFromDue: 3 },
        maxDebitsPerAllocation: 3,
      },
    },
  });
  expect(await rowCounts()).toEqual(before);
});

test("a statement the sweep pairs leaves the list, and the sweep counts the refund under its own code", async () => {
  const result = await cardSettlementSweep(db);
  expect(result).toMatchObject({
    proposed: 1,
    written: 1,
    unmatched: {
      statement_total_refund_or_zero: 1,
      statement_not_comparable: 1,
      no_debit_in_window: 1,
      no_equal_amount_debit: 6,
    },
  });
  const page = await review();
  expect(page.items.map((item) => item.statement.period)).not.toContain("2098-05");
  expect(page.items).toHaveLength(STATEMENTS.length - 1);
});

test("a grant without records.read or the whole store is refused before anything is read", async () => {
  for (const [grant, code, refs] of [
    [{ ...WHOLE, capabilities: ["summary.read"] }, "unauthorized", ["capability:records.read"]],
    [
      { ...WHOLE, scopes: { sources: ["myjcb"], accounts: "*" } },
      "evidence_restricted",
      ["scope:source"],
    ],
  ] as const) {
    const outcome = await reviewUnmatchedCardStatements({
      grant: grant as Grant,
      sql: {
        all: () => Promise.reject(new Error("read")),
        first: () => Promise.reject(new Error("read")),
      },
      request: { offset: 0 },
    });
    expect(outcome).toMatchObject({ ok: false, error: { code, refs } });
  }
});

test("the read's own lookups are keyed, without table statistics", async () => {
  const plans: Record<string, [string, unknown]> = {
    parsers: [UNMATCHED_DEBIT_PARSERS_SQL, "[1,2]"],
    keys: [UNMATCHED_HELD_KEYS_SQL, '["k"]'],
    aliases: [UNMATCHED_HELD_ALIASES_SQL, '["a"]'],
    statements: [UNMATCHED_RESERVED_STATEMENTS_SQL, '["s"]'],
  };
  for (const [name, [sql, value]] of Object.entries(plans)) {
    const rows = (
      await db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .bind(value)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    const scans = rows.filter(
      (detail) => /^SCAN /u.test(detail) && !/^SCAN [jkas]\b/u.test(detail),
    );
    expect({ name, scans }).toEqual({ name, scans: [] });
  }
});
