// The collection quality read (ADR 0045): every distinguished state on
// hand-built stores with the complete CORE schema, the configuration it
// enumerates, and its plans on a scaled store without table statistics
// (D1 runs no `ANALYZE`; docs/read-model.md, Cost). Everything is synthetic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { explain, type PlanStep } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { QualityStore } from "./collection-quality-fixture";
import {
  CELL_QUALITY_SQL,
  COLLECTION_QUALITY_ROW_BOUND,
  ONE_SOURCE_QUALITY_SQL,
  SCHEDULE_QUALITY_SQL,
  SOURCE_QUALITY_SQL,
  TERMINAL_QUALITY_SQL,
  UNCOMPOSED_QUERY_RULE_PARSERS,
  UNREGISTERED_QUALITY_SQL,
  type CellQualityRow,
  type ScheduleQualityRow,
  type SourceQualityRow,
  type TerminalQualityRow,
  type UnregisteredQualityRow,
} from "../src/collection-quality";
import {
  latestBalancesSql,
  MYJCB_LEDGER_MEMBER,
  positionsSql,
  transactionsSql,
  VPASS_SNAPSHOT_MEMBER,
} from "../src/sql";
import {
  SMBC_DIRECT_MEMBER,
  MONEYFORWARD_MEMBER,
  VPOINT_MEMBER,
  MYJCB_PAST_MONTHS_MEMBER,
} from "../src/current-captures";

const JOBS = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../config/alarm-jobs.json"), "utf8"),
) as { id: string }[];

// The first store pays the one-time CORE schema build (schema-template.ts,
// every migration in order), which crosses the first test's 5 s default
// timeout on a loaded runner. Pay it here, outside any test's budget.
beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

function cells(store: QualityStore, source: string, offset = 0): CellQualityRow[] {
  return store.all<CellQualityRow>(CELL_QUALITY_SQL, [source, offset]);
}

/** The fields a state assertion reads, without the run ids each test names itself. */
function brief(row: CellQualityRow) {
  return {
    dataset: row.dataset,
    parser: row.parser_name,
    unit: row.fetch_unit_key,
    period: row.period,
    state: row.period_state,
    rule: row.current_rule,
    artifacts: row.artifacts,
    published: row.published,
    pending: row.pending,
    failed: row.failed,
    unpublished: row.unpublished,
    notQueued: row.not_queued,
    notEligible: row.not_eligible,
    succeeded: row.newest_run_succeeded,
  };
}

const byKey = (rows: CellQualityRow[], parser: string | null, period: string | null) =>
  rows.find((row) => row.parser_name === parser && row.period === period);

describe("collection quality: attempts, terminals and sources", () => {
  test("every configured job is enumerated from collection_schedules, with its newest receipt and lease", () => {
    const store = new QualityStore();
    store.db.run(
      `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
       VALUES('synthetic-job','synthetic-source','collection',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
    );
    store.occurrence("vpass", { nominalAt: "2099-01-01T21:00:00.000Z", status: "completed" });
    store.occurrence("vpass", {
      nominalAt: "2099-01-02T21:00:00.000Z",
      status: "failed",
      failureCode: "human_required",
      runIds: ["synthetic-run-b"],
    });
    store.lease("vpass", "2099-01-02T21:00:01.000Z");
    const rows = store.all<ScheduleQualityRow>(SCHEDULE_QUALITY_SQL);
    // The configured jobs as they are stored, plus the one added here: no count is assumed.
    expect(rows.map((row) => row.id)).toEqual(
      [...JOBS.map((job) => job.id), "synthetic-job"].sort(),
    );
    const vpass = rows.find((row) => row.id === "vpass")!;
    expect(vpass).toMatchObject({
      occurrence_status: "failed",
      occurrence_failure_code: "human_required",
      occurrence_nominal_at: "2099-01-02T21:00:00.000Z",
      occurrence_run_ids: '["synthetic-run-b"]',
      lease_started_at: "2099-01-02T21:00:01.000Z",
    });
    // A job that never ran has no receipt; a lease released (null ref) is not held.
    store.db.run("UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL");
    const again = store.all<ScheduleQualityRow>(SCHEDULE_QUALITY_SQL);
    expect(again.find((row) => row.id === "vpass")!.lease_started_at).toBeNull();
    expect(again.find((row) => row.id === "myjcb")).toMatchObject({
      occurrence_status: null,
      lease_started_at: null,
    });
    expect(COLLECTION_QUALITY_ROW_BOUND).toBeGreaterThan(JOBS.length);
  });

  test("a receipt's terminals are exactly the runs it names, every row of each", () => {
    const store = new QualityStore();
    const run = store.run({
      source: "vpass",
      at: "2099-01-02T00:00:00Z",
      artifacts: [{ key: "evidence.json", dataset: null }],
    });
    // Blocked under one contract, registered under the next: two rows of one run.
    store.terminal({
      source: "vpass",
      runId: "run-a",
      outcome: "success",
      contract: "terminal-registration-v1",
      blockedCode: "registration_contract_superseded",
    });
    store.terminal({ source: "vpass", runId: "run-a", outcome: "success", fetchRun: run.run });
    store.terminal({ source: "vpass", runId: "run-unrelated", outcome: "failed" });
    store.terminal({
      source: "myjcb",
      runId: "run-a",
      outcome: "partial",
      coverage: "partial",
      stage: { state: "retryable", failureCode: "operation_budget" },
    });
    const rows = store.all<TerminalQualityRow>(TERMINAL_QUALITY_SQL, [
      JSON.stringify([
        ["vpass", "run-a"],
        ["myjcb", "run-a"],
        ["vpass", "run-never-seen"],
      ]),
    ]);
    expect(rows.map((row) => [row.source, row.run_id, row.blocked_code])).toEqual([
      ["vpass", "run-a", "registration_contract_superseded"],
      ["vpass", "run-a", null],
      ["myjcb", "run-a", null],
    ]);
    expect(rows[1]!.visible_fetch_run_id).toBe(run.run);
    expect(rows[2]).toMatchObject({
      provider_outcome: "partial",
      coverage_status: "partial",
      registered_stage_state: "retryable",
      registered_stage_failure_code: "operation_budget",
    });
  });

  test("never-registered terminals are counted once per run by its newest row", () => {
    const store = new QualityStore();
    const run = store.run({ source: "vpass", at: "2099-01-02T00:00:00Z", artifacts: [] });
    // Registered under a later contract: not counted, whatever the earlier row says.
    store.terminal({
      source: "vpass",
      runId: "run-a",
      outcome: "success",
      contract: "terminal-registration-v1",
      blockedCode: "registration_contract_superseded",
    });
    store.terminal({ source: "vpass", runId: "run-a", outcome: "success", fetchRun: run.run });
    // Blocked first, still pending under a newer contract: one pending run.
    store.terminal({
      source: "vpass",
      runId: "run-b",
      outcome: "success",
      contract: "terminal-registration-v1",
      blockedCode: "registration_contract_superseded",
    });
    store.terminal({
      source: "vpass",
      runId: "run-b",
      outcome: "success",
      seenAt: "2099-01-03T00:00:00.000Z",
    });
    store.terminal({
      source: "vpass",
      runId: "run-c",
      outcome: null,
      blockedCode: "manifest_invalid",
    });
    store.terminal({ source: "myjcb", runId: "run-d", outcome: "success" });
    const rows = store.all<UnregisteredQualityRow>(UNREGISTERED_QUALITY_SQL, [
      JSON.stringify(["vpass"]),
    ]);
    expect(rows).toEqual([
      { source: "vpass", blocked_code: null, runs: 1, newest_seen_at: "2099-01-03T00:00:00.000Z" },
      {
        source: "vpass",
        blocked_code: "manifest_invalid",
        runs: 1,
        newest_seen_at: "2099-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("every visible source with its newest visible run; synthetic and excluded runs are not sources' runs", () => {
    const store = new QualityStore();
    store.run({ source: "sony-bank", at: "2099-01-01T00:00:00Z", artifacts: [] });
    const partial = store.run({
      source: "sony-bank",
      at: "2099-01-02T00:00:00Z",
      outcome: "partial",
      artifacts: [],
    });
    const rows = store.all<SourceQualityRow>(SOURCE_QUALITY_SQL);
    const visible = store.all<{ id: string }>("SELECT id FROM observation_sources ORDER BY id");
    expect(rows.map((row) => row.source_id)).toEqual(visible.map((row) => row.id));
    expect(rows.some((row) => row.source_id === "kogane-synthetic")).toBe(false);
    expect(rows.find((row) => row.source_id === "sony-bank")).toMatchObject({
      fetch_run_id: partial.run,
      succeeded: 0,
    });
    expect(rows.find((row) => row.source_id === "vpass")).toMatchObject({
      fetch_run_id: null,
      succeeded: null,
    });
    expect(store.all(ONE_SOURCE_QUALITY_SQL, ["kogane-synthetic"])).toEqual([]);
    expect(
      store.all<SourceQualityRow>(ONE_SOURCE_QUALITY_SQL, ["sony-bank"])[0]!.fetch_run_id,
    ).toBe(partial.run);
  });
});

describe("collection quality: cells", () => {
  test("GLOBAL PASS months: current, older current behind a pending page, refused, and not yet parsed", () => {
    const s = new QualityStore();
    const first = s.run({
      source: "global-pass",
      at: "2099-02-01T00:00:00Z",
      artifacts: [
        { key: "activity-2099-01.html", dataset: "globalpass-activity" },
        { key: "activity-2098-12.html", dataset: "globalpass-activity" },
      ],
    });
    for (const artifact of first.artifacts)
      s.parse(artifact, "global-pass-activity", { kind: "published" });
    const second = s.run({
      source: "global-pass",
      at: "2099-02-02T00:00:00Z",
      artifacts: [
        { key: "activity-2099-01.html", dataset: "globalpass-activity" },
        { key: "activity-2099-01-p2.html", dataset: "globalpass-activity" },
        { key: "activity-2098-12.html", dataset: "globalpass-activity" },
        { key: "activity-2098-11.html", dataset: "globalpass-activity" },
      ],
    });
    s.parse(second.artifacts[0]!, "global-pass-activity", { kind: "published" });
    s.parse(second.artifacts[1]!, "global-pass-activity", { kind: "published" });
    s.parse(second.artifacts[2]!, "global-pass-activity", { kind: "pending" });
    s.parse(second.artifacts[3]!, "global-pass-activity", {
      kind: "failed",
      code: "parser_rejected",
      withRun: true,
    });
    // A partial run: no parse job is ever created for its pages.
    const third = s.run({
      source: "global-pass",
      at: "2099-02-03T00:00:00Z",
      outcome: "partial",
      artifacts: [{ key: "activity-2099-02.html", dataset: "globalpass-activity" }],
    });
    const rows = cells(s, "global-pass");
    expect(rows.map((row) => [row.period, row.parser_name])).toEqual([
      ["2099-02", null],
      ["2099-01", "global-pass-activity"],
      ["2098-12", "global-pass-activity"],
      ["2098-11", "global-pass-activity"],
    ]);
    const walked = byKey(rows, "global-pass-activity", "2099-01")!;
    expect(brief(walked)).toMatchObject({ rule: "global-pass-month", artifacts: 2, published: 2 });
    expect([walked.newest_run_id, walked.current_run_id]).toEqual([second.run, second.run]);
    expect(walked.current_captured_at).toBe("2099-02-02T00:00:00.000Z");
    // The producer's newest run captured another month only.
    expect(walked.latest_producer_run_id).toBe(third.run);
    const behind = byKey(rows, "global-pass-activity", "2098-12")!;
    expect(brief(behind)).toMatchObject({ artifacts: 1, pending: 1, published: 0 });
    expect([behind.newest_run_id, behind.current_run_id]).toEqual([second.run, first.run]);
    const refused = byKey(rows, "global-pass-activity", "2098-11")!;
    expect(brief(refused)).toMatchObject({ failed: 1 });
    expect(JSON.parse(refused.failure_codes_json)).toEqual(["parser_rejected"]);
    expect(refused.current_run_id).toBeNull();
    const waiting = byKey(rows, null, "2099-02")!;
    expect(brief(waiting)).toMatchObject({
      rule: "global-pass-month",
      notEligible: 1,
      notQueued: 0,
      succeeded: 0,
    });
    expect(waiting.current_run_id).toBeNull();
  });

  test("an unparsed capture is shown only while it is newer than every parsed capture of its slot", () => {
    const s = new QualityStore();
    const unit = { "moneyforward-account-v2-synthetic": { outcome: "success" as const } };
    const month = {
      key: "account-01-month-2099-01.html",
      dataset: "monthly-transactions",
      unit: "moneyforward-account-v2-synthetic",
    };
    const first = s.run({
      source: "moneyforward-me",
      at: "2099-02-01T00:00:00Z",
      units: unit,
      artifacts: [month],
    });
    s.parse(first.artifacts[0]!, "moneyforward-monthly-transactions", { kind: "published" });
    s.run({
      source: "moneyforward-me",
      at: "2099-02-02T00:00:00Z",
      outcome: "partial",
      units: unit,
      artifacts: [month],
    });
    let rows = cells(s, "moneyforward-me");
    expect(rows.map((row) => row.parser_name)).toEqual([null, "moneyforward-monthly-transactions"]);
    const third = s.run({
      source: "moneyforward-me",
      at: "2099-02-03T00:00:00Z",
      units: unit,
      artifacts: [month],
    });
    s.parse(third.artifacts[0]!, "moneyforward-monthly-transactions", { kind: "published" });
    rows = cells(s, "moneyforward-me");
    expect(rows.map((row) => row.parser_name)).toEqual(["moneyforward-monthly-transactions"]);
    expect(rows[0]).toMatchObject({
      newest_run_id: third.run,
      current_run_id: third.run,
      current_rule: "moneyforward-account-month",
      latest_producer_run_id: third.run,
    });
    expect(UNCOMPOSED_QUERY_RULE_PARSERS).not.toContain("moneyforward-monthly-transactions");
  });

  test("Vpass card-months: a refused page keeps the older capture current; a failed unit says so", () => {
    const s = new QualityStore();
    const cards = {
      "card-a": { outcome: "success" as const },
      "card-b": { outcome: "success" as const },
    };
    // One run captures both cards; each card's page has its own key.
    const page = (unit: string, month: string) => ({
      key: `months/${month}/top-00${unit === "card-a" ? 1 : 2}.json`,
      dataset: "statement-page",
      unit,
    });
    const first = s.run({
      source: "vpass",
      at: "2099-02-01T00:00:00Z",
      units: cards,
      artifacts: [page("card-a", "209901"), page("card-b", "209901")],
    });
    for (const artifact of first.artifacts)
      s.parse(artifact, "vpass-statement-page", { kind: "published" });
    const second = s.run({
      source: "vpass",
      at: "2099-02-02T00:00:00Z",
      units: cards,
      artifacts: [page("card-a", "209901")],
    });
    s.parse(second.artifacts[0]!, "vpass-statement-page", {
      kind: "failed",
      code: "parser_rejected",
    });
    s.run({
      source: "vpass",
      at: "2099-02-03T00:00:00Z",
      outcome: "success",
      units: { "card-b": { outcome: "failed", code: "human_required" } },
      artifacts: [page("card-b", "209902")],
    });
    const rows = cells(s, "vpass");
    const a = rows.find((row) => row.fetch_unit_key === "card-a")!;
    expect(brief(a)).toMatchObject({ rule: "vpass-card-month", period: "209901", failed: 1 });
    expect([a.newest_run_id, a.current_run_id]).toEqual([second.run, first.run]);
    const b = rows.filter((row) => row.fetch_unit_key === "card-b");
    expect(b.map((row) => [row.period, row.parser_name])).toEqual([
      ["209902", null],
      ["209901", "vpass-statement-page"],
    ]);
    // The unit's own failure makes the run partial, so nothing was queued.
    expect(b[0]).toMatchObject({
      unit_failed: 1,
      unit_failure_code: "human_required",
      not_eligible: 1,
    });
    expect(b[1]).toMatchObject({ current_run_id: first.run, unit_failed: 0 });
    // Card A's newest run is the second: the third run named card B's units
    // only, so card A's cell is in its unit's latest run and card B's older
    // month is not.
    expect(a.latest_producer_run_id).toBe(second.run);
    expect(b[1]!.latest_producer_run_id).not.toBe(b[1]!.newest_run_id);
  });

  test("MyJCB statement slots: a placed slot is current, a label no rule places never is", () => {
    const s = new QualityStore();
    const run = s.run({
      source: "myjcb",
      at: "2099-01-20T00:00:00Z",
      units: { "conn-1": { outcome: "success" } },
      artifacts: [
        {
          key: "conn-1/credit-ledger-00.json",
          dataset: "credit-ledger",
          unit: "conn-1",
          period: "2099-02",
          state: "confirmed",
        },
        {
          key: "conn-1/credit-ledger-02.json",
          dataset: "credit-ledger",
          unit: "conn-1",
          period: "detailMonth-2",
          state: "unconfirmed",
        },
      ],
    });
    for (const artifact of run.artifacts)
      s.parse(artifact, "myjcb-credit-ledger", { kind: "published" });
    const rows = cells(s, "myjcb");
    expect(rows.map((row) => [row.period, row.period_state, row.current_run_id])).toEqual([
      ["2099-02", "confirmed", run.run],
      [null, "unconfirmed", null],
    ]);
    expect(rows.every((row) => row.current_rule === "myjcb-statement-slot")).toBe(true);
  });

  test("container snapshots: an incomplete coverage claim keeps the older capture; the other parser is its own cell", () => {
    const s = new QualityStore();
    const snapshot = [{ key: "account-snapshot.json", dataset: "account-snapshot" }];
    const first = s.run({ source: "st-george", at: "2099-01-01T00:00:00Z", artifacts: snapshot });
    s.parse(first.artifacts[0]!, "st-george-balances", {
      kind: "published",
      claim: { completeness: "complete" },
    });
    s.parse(first.artifacts[0]!, "st-george-transactions", { kind: "published" });
    const second = s.run({ source: "st-george", at: "2099-01-02T00:00:00Z", artifacts: snapshot });
    s.parse(second.artifacts[0]!, "st-george-balances", {
      kind: "published",
      claim: { completeness: "partial", cause: "page_missing" },
    });
    s.parse(second.artifacts[0]!, "st-george-transactions", { kind: "published" });
    const rows = cells(s, "st-george");
    const balances = rows.find((row) => row.parser_name === "st-george-balances")!;
    expect(balances).toMatchObject({
      current_rule: "container-snapshot",
      newest_run_id: second.run,
      current_run_id: first.run,
      published: 1,
      incomplete_coverage: 1,
    });
    expect(JSON.parse(balances.coverage_causes_json!)).toEqual(["page_missing"]);
    const transactions = rows.find((row) => row.parser_name === "st-george-transactions")!;
    expect(transactions).toMatchObject({
      current_rule: "published-eligible",
      current_run_id: second.run,
      incomplete_coverage: null,
    });
  });

  test("history pages and parser-selected artifacts: published, unpublished, and the Mizuho container", () => {
    const s = new QualityStore();
    const sony = s.run({
      source: "sony-bank",
      at: "2099-01-01T00:00:00Z",
      artifacts: [
        { key: "yen-history-page-0001.json", dataset: "yen-history-page-0001" },
        { key: "yen-history-page-0002.json", dataset: "yen-history-page-0002" },
        { key: "gross-balance.json", dataset: "gross-balance" },
      ],
    });
    s.parse(sony.artifacts[0]!, "sony-bank-history-json", { kind: "published" });
    s.parse(sony.artifacts[1]!, "sony-bank-history-json", { kind: "superseded" });
    s.parse(sony.artifacts[2]!, "sony-bank-gross-balance", { kind: "published" });
    const rows = cells(s, "sony-bank");
    expect(
      rows.map((row) => [
        row.dataset,
        row.current_rule,
        row.published,
        row.unpublished,
        row.current_run_id,
      ]),
    ).toEqual([
      ["gross-balance", "container-snapshot", 1, 0, sony.run],
      ["yen-history-page-0001", "published-eligible", 1, 0, sony.run],
      ["yen-history-page-0002", "published-eligible", 0, 1, null],
    ]);
    const mizuho = s.run({
      source: "mizuho-bank",
      at: "2099-01-01T00:00:00Z",
      units: { "account-list": { outcome: "success" } },
      artifacts: [
        { key: "account-list.html", dataset: null, unit: "account-list" },
        // Evidence no parser reads is not a cell.
        { key: "manifest.json", dataset: null, role: "collector_manifest" },
      ],
    });
    s.parse(mizuho.artifacts[0]!, "mizuho-account-list", {
      kind: "published",
      claim: { completeness: "complete" },
    });
    expect(cells(s, "mizuho-bank").map(brief)).toEqual([
      {
        dataset: null,
        parser: "mizuho-account-list",
        unit: "account-list",
        period: null,
        state: null,
        rule: "container-snapshot",
        artifacts: 1,
        published: 1,
        pending: 0,
        failed: 0,
        unpublished: 0,
        notQueued: 0,
        notEligible: 0,
        succeeded: 1,
      },
    ]);
  });

  test("a successful run's artifacts no job names yet are not queued, and pages are bounded", () => {
    const s = new QualityStore();
    s.run({
      source: "sony-bank",
      at: "2099-01-01T00:00:00Z",
      artifacts: Array.from({ length: 501 }, (_, index) => ({
        key: `yen-history-page-${String(index + 1).padStart(4, "0")}.json`,
        dataset: `yen-history-page-${String(index + 1).padStart(4, "0")}`,
      })),
    });
    const first = cells(s, "sony-bank");
    // One row past the page: the caller reports truncation without a count query.
    expect(first).toHaveLength(501);
    expect(first.every((row) => row.parser_name === null && row.not_queued === 1)).toBe(true);
    const rest = cells(s, "sony-bank", 500);
    expect(rest.map((row) => row.dataset)).toEqual(["yen-history-page-0501"]);
    expect(cells(s, "vpass")).toEqual([]);
  });
});

/**
 * The parsers a current read narrows beyond `activeStateProjection` and the
 * snapshot policies, read from the shipped texts: every
 * `p.parser_name <> 'x' OR ...` and `p.parser_name NOT IN ('x', ...) OR ...`
 * guard, the shape every such rule of those reads takes.
 */
function narrowedParsers(sql: string): string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(/p\.parser_name <> '([a-z0-9-]+)'\s+OR\b/gu))
    found.add(match[1]!);
  for (const match of sql.matchAll(/p\.parser_name NOT IN \(([^)]*)\)\s+OR\b/gu))
    for (const name of match[1]!.matchAll(/'([a-z0-9-]+)'/gu)) found.add(name[1]!);
  return [...found].sort();
}

describe("collection quality: the uncomposed per-query rules are the ones the reads apply", () => {
  /** The rules this read composes, by the parser each guard names and the membership it applies. */
  const COMPOSED: Record<string, string> = {
    "global-pass-activity":
      "fa.id IN (SELECT fetch_artifact_id FROM current_global_pass_snapshots)",
    "vpass-statement-page": VPASS_SNAPSHOT_MEMBER,
    "myjcb-credit-ledger": MYJCB_LEDGER_MEMBER,
    "smbc-direct-transactions": SMBC_DIRECT_MEMBER,
    "moneyforward-monthly-transactions": MONEYFORWARD_MEMBER,
    "v-point-history-page": VPOINT_MEMBER,
    "v-point-balance-info": VPOINT_MEMBER,
    "v-point-smfg-point": VPOINT_MEMBER,
    "myjcb-credit-past-month-balances": MYJCB_PAST_MONTHS_MEMBER,
  };
  const reads = [
    transactionsSql({}, 0).sql,
    latestBalancesSql({}, 0, 501).sql,
    positionsSql({}, 0).sql,
  ].join("\n");

  test("every parser the Transactions, Balances and Positions reads narrow is composed here or named", () => {
    // Both ways: a rule added to a read, or one dropped from it, fails until
    // the list (or the composition) follows.
    expect(narrowedParsers(reads)).toEqual(
      [...Object.keys(COMPOSED), ...UNCOMPOSED_QUERY_RULE_PARSERS].sort(),
    );
    // The guard is read the way the shipped texts write it.
    expect(
      narrowedParsers("p.parser_name <> 'a-b'\n OR x AND p.parser_name NOT IN ('c', 'd') OR y"),
    ).toEqual(["a-b", "c", "d"]);
  });

  test("the composed rules are the reads' own membership texts; the uncomposed ones appear nowhere here", () => {
    for (const membership of Object.values(COMPOSED)) {
      expect(reads).toContain(membership.replaceAll("cq_current_myjcb", "current_myjcb"));
      expect(CELL_QUALITY_SQL).toContain(membership);
    }
    for (const parser of UNCOMPOSED_QUERY_RULE_PARSERS)
      expect(CELL_QUALITY_SQL).not.toContain(`'${parser}'`);
  });
});

/** Every step under `root`, the root included (steps come parent first). */
function subtree(steps: readonly PlanStep[], root: PlanStep): PlanStep[] {
  const inside = new Set([root.id]);
  for (const step of steps) if (inside.has(step.parent)) inside.add(step.id);
  return steps.filter((step) => inside.has(step.id));
}

function ancestors(steps: readonly PlanStep[], step: PlanStep): string[] {
  const byId = new Map(steps.map((entry) => [entry.id, entry]));
  const found: string[] = [];
  for (let at = byId.get(step.parent); at !== undefined; at = byId.get(at.parent))
    found.push(at.detail);
  return found;
}

/**
 * The snapshot CTEs composed unchanged: each makes the one pass over the
 * artifacts (and the automatic index over the terminal reports) the
 * Transactions, Balances and Positions reads already make.
 */
const COMPOSED_SNAPSHOT_STEPS = [
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_global_pass_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_vpass_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_myjcb_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_artifact_containers$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_smbc_direct_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_moneyforward_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) cq_ranked_myjcb_snapshots$/u,
  /^(?:MATERIALIZE|CO-ROUTINE) ranked_vpoint_runs$/u,
];

/**
 * Relations this read may scan whole: its own per-source CTEs (by the aliases
 * the SQL gives them), the snapshot policy rows and the request's JSON array.
 * A base table is never one of these names, so a whole-table scan of one shows
 * up under its own alias and fails.
 */
const OWN_SCANS = new Set([
  "fa",
  "ordered",
  "n",
  "k",
  "targeted",
  "c",
  "cq_members",
  "cq_latest_units",
  "cq_empty_units",
  "cq_result",
  "unit_latest",
  "parsed",
  "dataset_snapshot_policies",
  "unit_policy",
  "container_policy",
  "snapshot_policies",
]);

/** Relations an automatic index may be built over: CTEs, each evaluated once. */
const AUTOMATIC_INDEXES = new Set([
  "k",
  "producer",
  "producer_unit",
  "claims",
  "publication",
  "parsed",
  "ranked_vpass_snapshots",
  "ranked_snapshots",
  "ranked_artifact_containers",
  "ranked_myjcb_snapshots",
  "snapshot",
  "ranked_smbc_direct_snapshots",
  "ranked_moneyforward_snapshots",
  "cq_ranked_myjcb_snapshots",
  "ranked_vpoint_runs",
]);

const insideComposed = (steps: readonly PlanStep[], step: PlanStep): boolean =>
  ancestors(steps, step).some((detail) =>
    COMPOSED_SNAPSHOT_STEPS.some((pattern) => pattern.test(detail)),
  );

/** Whole-relation reads outside the composed snapshot CTEs and this read's own relations. */
function unboundedScans(steps: readonly PlanStep[]): string[] {
  return steps
    .filter((step) => !insideComposed(steps, step))
    .filter((step) => {
      const name = step.detail.split(" ")[1]!;
      if (step.detail.startsWith("SCAN ")) {
        if (/^\(subquery-\d+\)$/u.test(name) || name === "CONSTANT") return false;
        if (step.detail.includes(" VIRTUAL TABLE ")) return false;
        return !(OWN_SCANS.has(name) && !step.detail.includes(" USING "));
      }
      if (/ USING AUTOMATIC /u.test(step.detail))
        return !(AUTOMATIC_INDEXES.has(name) || /^\(subquery-\d+\)$/u.test(name));
      return false;
    })
    .map((step) => step.detail);
}

const DAY_MS = 86_400_000;
const START_MS = Date.parse("2099-01-01T00:00:00Z");

describe("collection quality on the complete CORE schema without statistics", () => {
  let scaled: QualityStore;

  beforeAll(() => {
    scaled = new QualityStore();
    // Daily GLOBAL PASS, Vpass, Sony and St George captures over a season,
    // every parse published, so each composed rule has work to do.
    for (let day = 0; day < 90; day += 1) {
      const at = new Date(START_MS + day * DAY_MS).toISOString();
      const smbc = scaled.run({
        source: "smbc-bank",
        at,
        artifacts: [
          {
            key: "transactions/20990101-20990131.normalized.json",
            dataset: "transactions-normalized",
          },
        ],
      });
      scaled.parse(smbc.artifacts[0]!, "smbc-direct-transactions", { kind: "published" });
      const mf = scaled.run({
        source: "moneyforward-me",
        at,
        units: { "moneyforward-account-v2-synthetic": { outcome: "success" } },
        artifacts: [
          {
            key: "account-month-2099-01.html",
            dataset: "monthly-transactions",
            unit: "moneyforward-account-v2-synthetic",
          },
        ],
      });
      scaled.parse(mf.artifacts[0]!, "moneyforward-monthly-transactions", { kind: "published" });
      const past = scaled.run({
        source: "myjcb",
        at,
        units: { "connection-a": { outcome: "success" } },
        artifacts: [
          {
            key: "connection-a/credit-past-months.json",
            dataset: "credit-past-months",
            unit: "connection-a",
          },
        ],
      });
      scaled.parse(past.artifacts[0]!, "myjcb-credit-past-month-balances", { kind: "published" });
      const point = scaled.run({
        source: "v-point",
        at,
        artifacts: [
          { key: "balance-info.json", dataset: "balance-info" },
          { key: "smfg-point.json", dataset: "smfg-point" },
          { key: "history-page-0001.json", dataset: "history-page-0001" },
        ],
      });
      ["v-point-balance-info", "v-point-smfg-point", "v-point-history-page"].forEach(
        (parser, index) => scaled.parse(point.artifacts[index]!, parser, { kind: "published" }),
      );
      const gp = scaled.run({
        source: "global-pass",
        at,
        artifacts: ["2099-03", "2099-02", "2099-01"].map((month) => ({
          key: `activity-${month}.html`,
          dataset: "globalpass-activity",
        })),
      });
      for (const artifact of gp.artifacts)
        scaled.parse(artifact, "global-pass-activity", { kind: "published" });
      const vpass = scaled.run({
        source: "vpass",
        at,
        units: { "card-a": { outcome: "success" }, "card-b": { outcome: "success" } },
        artifacts: ["card-a", "card-b"].flatMap((unit, index) =>
          ["209901", "209902"].map((month) => ({
            key: `months/${month}/top-00${index + 1}.json`,
            dataset: "statement-page",
            unit,
          })),
        ),
      });
      for (const artifact of vpass.artifacts)
        scaled.parse(artifact, "vpass-statement-page", { kind: "published" });
      const sony = scaled.run({
        source: "sony-bank",
        at,
        artifacts: [
          { key: "gross-balance.json", dataset: "gross-balance" },
          { key: "yen-history-page-0001.json", dataset: "yen-history-page-0001" },
        ],
      });
      scaled.parse(sony.artifacts[0]!, "sony-bank-gross-balance", { kind: "published" });
      scaled.parse(sony.artifacts[1]!, "sony-bank-history-json", { kind: "published" });
      const george = scaled.run({
        source: "st-george",
        at,
        artifacts: [{ key: "account-snapshot.json", dataset: "account-snapshot" }],
      });
      scaled.parse(george.artifacts[0]!, "st-george-balances", {
        kind: "published",
        claim: { completeness: "complete" },
      });
    }
  }, 120_000);

  test("the store is what D1 runs: no table statistics", () => {
    expect(
      scaled.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      (scaled.db.query("SELECT count(*) AS n FROM fetch_artifacts").get() as { n: number }).n,
    ).toBeGreaterThan(800);
  });

  test("the scaled store reads as the rules say: one current capture per cell, the newest", () => {
    const newest = "2099-03-31T00:00:00.000Z";
    for (const source of [
      "global-pass",
      "vpass",
      "sony-bank",
      "st-george",
      "smbc-bank",
      "moneyforward-me",
      "myjcb",
      "v-point",
    ]) {
      const rows = cells(scaled, source);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.newest_captured_at).toBe(newest);
        expect(row.current_captured_at).toBe(newest);
        expect(row.current_run_id).toBe(row.newest_run_id);
      }
    }
  });

  test("the plan check catches a whole scan of a base table or an index built over one", () => {
    for (const sql of [
      "SELECT id FROM parse_runs WHERE status = 'ok'",
      "SELECT id FROM observation_fetch_artifacts WHERE dataset = 'x'",
      `SELECT j.parser_name FROM collection_schedules s
         JOIN observation_parse_jobs j ON j.last_error_code = s.id`,
    ])
      expect(unboundedScans(explain(scaled.db, sql, []))).not.toEqual([]);
  });

  test("the cell read reaches one source by index and scans nothing whole but the composed snapshot CTEs", () => {
    const steps = explain(scaled.db, CELL_QUALITY_SQL, ["global-pass", 0]);
    expect(unboundedScans(steps)).toEqual([]);
    // The source's artifacts, by its index, never a pass over every artifact.
    expect(
      steps.some((step) =>
        /^SEARCH a USING INDEX idx_fetch_artifacts_source_dataset_time \(source_id=\?\)$/u.test(
          step.detail,
        ),
      ),
    ).toBe(true);
    // No observation table is read at all.
    expect(steps.filter((step) => /_observations\b/u.test(step.detail))).toEqual([]);
    // Every per-row snapshot membership is answered from one evaluation of its
    // CTE: an IN list materialized once, or an automatic index built once.
    for (const name of ["ranked_vpass_snapshots", "ranked_snapshots", "ranked_artifact_containers"])
      expect(steps.some((step) => step.detail.startsWith(`SEARCH ${name} USING AUTOMATIC`))).toBe(
        true,
      );
    for (const name of ["ranked_global_pass_snapshots", "ranked_myjcb_snapshots"]) {
      const root = steps.find((step) => step.detail === `MATERIALIZE ${name}`);
      expect(root).toBeDefined();
      expect(ancestors(steps, root!)[0]).toMatch(/^LIST SUBQUERY \d+$/u);
    }
    // The source's runs and their units by index.
    expect(
      steps.some((step) =>
        /^SEARCH run USING INDEX idx_fetch_runs_source \(source_id=\?\)$/u.test(step.detail),
      ),
    ).toBe(true);
    expect(
      steps.some((step) =>
        /^SEARCH unit USING (?:COVERING )?INDEX idx_fetch_units_run \(fetch_run_id=\?\)/u.test(
          step.detail,
        ),
      ),
    ).toBe(true);
    // Parse jobs, parse runs, publications, claims and unit reports by key only.
    const keyed = subtree(steps, steps[0]!).filter((step) =>
      /^SCAN (?:job|attempt|failed|pub|claim|unit|published|parse_runs|observation_parse_jobs)\b/u.test(
        step.detail,
      ),
    );
    expect(keyed).toEqual([]);
  });

  test("the summary reads are keyed by job, run and source", () => {
    for (const [sql, args] of [
      [SCHEDULE_QUALITY_SQL, []],
      [SOURCE_QUALITY_SQL, []],
      [ONE_SOURCE_QUALITY_SQL, ["vpass"]],
      [TERMINAL_QUALITY_SQL, [JSON.stringify([["vpass", "run-a"]])]],
      [UNREGISTERED_QUALITY_SQL, [JSON.stringify(["vpass"])]],
    ] as const) {
      const steps = explain(scaled.db, sql, args);
      const scans = steps
        .filter((step) => step.detail.startsWith("SCAN "))
        .map((step) => step.detail)
        // The configured jobs and the declared sources are configuration rows;
        // the JSON arrays are the request's own pairs.
        .filter(
          (detail) =>
            !/^SCAN (?:s USING (?:COVERING )?INDEX sqlite_autoindex_(?:collection_schedules|sources)_1|pair VIRTUAL TABLE|wanted VIRTUAL TABLE)/u.test(
              detail,
            ),
        );
      expect(scans).toEqual([]);
    }
  });

  test("timings on the scaled store (printed, not asserted)", () => {
    for (const source of [
      "global-pass",
      "vpass",
      "sony-bank",
      "st-george",
      "smbc-bank",
      "moneyforward-me",
      "myjcb",
      "v-point",
    ]) {
      const started = performance.now();
      cells(scaled, source);
      console.log(
        `collection quality cells ${source}: ${(performance.now() - started).toFixed(1)} ms`,
      );
    }
  });
});
