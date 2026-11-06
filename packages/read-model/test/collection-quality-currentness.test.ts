// Synthetic only. No provider value, production store or collector execution.
import { createHash } from "node:crypto";
import { beforeAll, expect, test } from "bun:test";
import { CELL_QUALITY_SQL, type CellQualityRow } from "../src/collection-quality";
import { latestBalancesSql, transactionsSql } from "../src/sql";
import {
  ELIGIBLE_VPOINT_RUNS,
  MONEYFORWARD_SNAPSHOT_CTES,
  myjcbPastMonthsSnapshotCtes,
  SMBC_DIRECT_SNAPSHOT_CTES,
} from "../src/current-captures";
import { cell } from "../../application/src/query/collection-quality";
import { validCollectionQualityCells } from "../../observation-shared/src/collection-quality-contract";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { QualityStore, type ArtifactSpec } from "./collection-quality-fixture";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);
const rows = (s: QualityStore, source: string) =>
  s.all<CellQualityRow>(CELL_QUALITY_SQL, [source, 0]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("extraction leaves the complete shipped SQL byte-identical to frozen base 4f3d1b3", () => {
  // Frozen rendered SQL digests taken from the base, before the extraction.
  // Exact bytes prove unchanged predicates/ranking/filtering/output on every
  // input, more strongly than only comparing a handful of selected rows.
  expect(hash(transactionsSql({}, 0).sql)).toBe(
    "9876071ea165908299b34c61aad1005b7531fe5a010c213c2bc193f2b1be3ff9",
  );
  expect(hash(latestBalancesSql({}, 0, 501).sql)).toBe(
    "8c260635f19d6028616e96fc1bc300ef3a96a5990468a3d86f60acfd2f598ba9",
  );
  expect(hash(latestBalancesSql({ source: "myjcb", measureView: "summaries" }, 0, 501).sql)).toBe(
    "023d01804a87ae85f6bad1550b18e675f33015d02c5ea9534d8a672e3fb6811a",
  );
});

test("SMBC request keys remain separate; failed/pending newest runs do not displace a published capture; artifact id breaks ties", () => {
  const s = new QualityStore();
  const a = {
    key: "transactions/20990101-20990131.normalized.json",
    dataset: "transactions-normalized",
  };
  const b = {
    key: "transactions/20990201-20990228.normalized.json",
    dataset: "transactions-normalized",
  };
  const first = s.run({ source: "smbc-bank", at: "2099-03-01T00:00:00Z", artifacts: [a, b] });
  for (const id of first.artifacts) s.parse(id, "smbc-direct-transactions", { kind: "published" });
  const second = s.run({ source: "smbc-bank", at: "2099-03-01T00:00:00Z", artifacts: [a] });
  s.parse(second.artifacts[0]!, "smbc-direct-transactions", { kind: "published" });
  const third = s.run({ source: "smbc-bank", at: "2099-03-02T00:00:00Z", artifacts: [a] });
  s.parse(third.artifacts[0]!, "smbc-direct-transactions", { kind: "pending" });
  const selected = rows(s, "smbc-bank");
  expect(selected).toHaveLength(2);
  expect(selected.find((x) => x.period === a.key)).toMatchObject({
    current_rule: "smbc-request-key",
    newest_run_id: third.run,
    current_run_id: second.run,
  });
  expect(selected.find((x) => x.period === b.key)).toMatchObject({ current_run_id: first.run });
  expect(cell(selected.find((x) => x.period === a.key)!).reasons).toContain("parse_pending");
  s.db.close();
});

test("MoneyForward separates account-months and admits only the existing v1/v2 units", () => {
  const s = new QualityStore();
  const ua = "moneyforward-account-v1-synthetic-a",
    ub = "moneyforward-account-v2-synthetic-b",
    bad = "unconfirmed-unit";
  const spec = (u: string, m: string) => ({
    key: `${u}-month-${m}.html`,
    dataset: "monthly-transactions",
    unit: u,
  });
  const a = spec(ua, "2099-01"),
    b = spec(ua, "2099-02"),
    c = spec(ub, "2099-01"),
    d = spec(bad, "2099-01");
  const first = s.run({
    source: "moneyforward-me",
    at: "2099-03-01T00:00:00Z",
    units: {
      [ua]: { outcome: "success" },
      [ub]: { outcome: "success" },
      [bad]: { outcome: "success" },
    },
    artifacts: [a, b, c, d],
  });
  for (const id of first.artifacts)
    s.parse(id, "moneyforward-monthly-transactions", { kind: "published" });
  const second = s.run({
    source: "moneyforward-me",
    at: "2099-03-02T00:00:00Z",
    units: { [ua]: { outcome: "success" } },
    artifacts: [a],
  });
  s.parse(second.artifacts[0]!, "moneyforward-monthly-transactions", { kind: "published" });
  const partial = s.run({
    source: "moneyforward-me",
    at: "2099-03-03T00:00:00Z",
    outcome: "partial",
    units: { [ua]: { outcome: "success" } },
    artifacts: [a],
  });
  const result = rows(s, "moneyforward-me");
  expect(
    result.find((x) => x.fetch_unit_key === ua && x.period === "2099-01" && x.parser_name !== null),
  ).toMatchObject({ current_run_id: second.run });
  expect(
    result.find((x) => x.fetch_unit_key === ua && x.period === "2099-01" && x.parser_name === null),
  ).toMatchObject({ newest_run_id: partial.run, current_run_id: null });
  expect(result.find((x) => x.fetch_unit_key === ua && x.period === "2099-02")).toMatchObject({
    current_run_id: first.run,
  });
  expect(result.find((x) => x.fetch_unit_key === ub)).toMatchObject({ current_run_id: first.run });
  expect(result.find((x) => x.fetch_unit_key === bad)).toMatchObject({ current_run_id: null });
  s.db.close();
});

test("MyJCB past-month connection ranking cannot replace the credit-ledger CTE or another connection", () => {
  const s = new QualityStore();
  const a = {
    key: "conn-a/credit-past-months.json",
    dataset: "credit-past-months",
    unit: "conn-a",
  };
  const b = {
    key: "conn-b/credit-past-months.json",
    dataset: "credit-past-months",
    unit: "conn-b",
  };
  const first = s.run({
    source: "myjcb",
    at: "2099-03-01T00:00:00Z",
    units: { "conn-a": { outcome: "success" }, "conn-b": { outcome: "success" } },
    artifacts: [a, b],
  });
  for (const id of first.artifacts)
    s.parse(id, "myjcb-credit-past-month-balances", { kind: "published" });
  const newer = s.run({
    source: "myjcb",
    at: "2099-03-02T00:00:00Z",
    units: { "conn-a": { outcome: "success" } },
    artifacts: [a],
  });
  s.parse(newer.artifacts[0]!, "myjcb-credit-past-month-balances", {
    kind: "failed",
    code: "parser_rejected",
  });
  const ledger = s.run({
    source: "myjcb",
    at: "2099-03-02T00:00:00Z",
    units: { "conn-a": { outcome: "success" } },
    artifacts: [
      {
        key: "conn-a/credit-ledger-00.json",
        dataset: "credit-ledger",
        unit: "conn-a",
        period: "2099-04",
        state: "confirmed",
      },
    ],
  });
  s.parse(ledger.artifacts[0]!, "myjcb-credit-ledger", { kind: "published" });
  const result = rows(s, "myjcb");
  expect(result.find((x) => x.period === "conn-a")).toMatchObject({
    current_rule: "myjcb-connection",
    current_run_id: first.run,
    newest_run_id: newer.run,
  });
  expect(result.find((x) => x.period === "conn-b")).toMatchObject({ current_run_id: first.run });
  expect(result.find((x) => x.parser_name === "myjcb-credit-ledger")).toMatchObject({
    current_rule: "myjcb-statement-slot",
    current_run_id: ledger.run,
  });
  s.db.close();
});

const pointArtifacts: ArtifactSpec[] = [
  { key: "balance-info.json", dataset: "balance-info" },
  { key: "smfg-point.json", dataset: "smfg-point" },
  { key: "history-page-0001.json", dataset: "history-page-0001" },
  { key: "history-page-0002.json", dataset: "history-page-0002" },
];
const pointParsers = [
  "v-point-balance-info",
  "v-point-smfg-point",
  "v-point-history-page",
  "v-point-history-page",
];
test("VPoint three-parser completeness refuses a missing page; a later complete run removes absent history pages", () => {
  const s = new QualityStore();
  const first = s.run({ source: "v-point", at: "2099-03-01T00:00:00Z", artifacts: pointArtifacts });
  first.artifacts.forEach((id, i) => s.parse(id, pointParsers[i]!, { kind: "published" }));
  const second = s.run({
    source: "v-point",
    at: "2099-03-02T00:00:00Z",
    artifacts: pointArtifacts,
  });
  second.artifacts.forEach((id, i) =>
    s.parse(id, pointParsers[i]!, i === 3 ? { kind: "pending" } : { kind: "published" }),
  );
  expect(rows(s, "v-point").every((x) => x.current_run_id === first.run)).toBe(true);
  const third = s.run({
    source: "v-point",
    at: "2099-03-03T00:00:00Z",
    artifacts: pointArtifacts.slice(0, 3),
  });
  third.artifacts.forEach((id, i) => s.parse(id, pointParsers[i]!, { kind: "published" }));
  const result = rows(s, "v-point");
  expect(
    result
      .filter((x) => x.dataset !== "history-page-0002")
      .every((x) => x.current_run_id === third.run),
  ).toBe(true);
  expect(result.find((x) => x.dataset === "history-page-0002")).toMatchObject({
    current_run_id: null,
    newest_run_id: second.run,
  });
  const answer = {
    apiVersion: 2,
    sourceId: "v-point",
    latestFetchRun: null,
    cells: result.map(cell),
    coverage: { limit: 500, truncated: false, nextOffset: null },
  };
  expect(validCollectionQualityCells(answer)).toBe(true);
  expect(
    result.every((x) => cell(x).reasons.includes("coverage_not_recorded") || x.pending > 0),
  ).toBe(true);
  s.db.close();
});

test("a VPoint run's completeness does not publish a different pending parser on an artifact", () => {
  const s = new QualityStore();
  const r = s.run({
    source: "v-point",
    at: "2099-03-01T00:00:00Z",
    artifacts: pointArtifacts.slice(0, 3),
  });
  r.artifacts.forEach((id, i) => s.parse(id, pointParsers[i]!, { kind: "published" }));
  s.parse(r.artifacts[0]!, "v-point-history-page", { kind: "pending" });
  const bad = rows(s, "v-point").find(
    (x) => x.dataset === "balance-info" && x.parser_name === "v-point-history-page",
  )!;
  expect(bad.current_run_id).toBeNull();
  expect(cell(bad).reasons).toContain("parse_pending");
  s.db.close();
});

test("quality current capture is a member of the shipped selection on randomized multi-capture stores", () => {
  // Existing dataset policies are exercised separately below. Seeded policy
  // state does not opt these six parsers into container replacement.
  for (let seed = 0; seed < 8; seed++) {
    const s = new QualityStore();
    const configs = [
      {
        source: "smbc-bank",
        parser: "smbc-direct-transactions",
        dataset: "transactions-normalized",
        key: "transactions/20990101-20990131.normalized.json",
        cte: SMBC_DIRECT_SNAPSHOT_CTES,
        table: "current_smbc_direct_snapshots",
      },
      {
        source: "moneyforward-me",
        parser: "moneyforward-monthly-transactions",
        dataset: "monthly-transactions",
        key: "account-month-2099-01.html",
        cte: MONEYFORWARD_SNAPSHOT_CTES,
        table: "current_moneyforward_snapshots",
      },
      {
        source: "myjcb",
        parser: "myjcb-credit-past-month-balances",
        dataset: "credit-past-months",
        key: "conn-a/credit-past-months.json",
        cte: myjcbPastMonthsSnapshotCtes("cq_"),
        table: "cq_current_myjcb_snapshots",
      },
    ];
    for (const c of configs) {
      for (let i = 0; i < 4; i++) {
        const run = s.run({
          source: c.source,
          at: `2099-03-${String(1 + ((i + seed) % 3)).padStart(2, "0")}T00:00:00Z`,
          units: { "moneyforward-account-v2-synthetic": { outcome: "success" } },
          artifacts: [
            { key: c.key, dataset: c.dataset, unit: "moneyforward-account-v2-synthetic" },
          ],
        });
        const kind = (seed + i) % 4;
        s.parse(
          run.artifacts[0]!,
          c.parser,
          kind === 0
            ? { kind: "pending" }
            : kind === 1
              ? { kind: "superseded" }
              : { kind: "published" },
        );
      }
      const selected = s.all<{ id: number }>(
        `WITH ${c.cte} SELECT fa.fetch_run_id AS id FROM ${c.table} member JOIN observation_fetch_artifacts fa ON fa.id=member.fetch_artifact_id`,
      );
      const quality = rows(s, c.source).find((x) => x.parser_name === c.parser)!;
      expect(quality.current_run_id).toBe(selected[0]?.id ?? null);
    }
    // Also prove that complete VPoint has exactly the selected run (f.id,
    // completed_at tie-breaking), rather than the newest successful attempt.
    const point = s.run({
      source: "v-point",
      at: "2099-03-01T00:00:00Z",
      artifacts: pointArtifacts.slice(0, 3),
    });
    point.artifacts.forEach((id, i) => s.parse(id, pointParsers[i]!, { kind: "published" }));
    const chosen = s.all<{ fetch_run_id: number }>(
      `WITH ${ELIGIBLE_VPOINT_RUNS} SELECT fetch_run_id FROM current_vpoint_runs`,
    );
    expect(rows(s, "v-point").every((x) => x.current_run_id === chosen[0]?.fetch_run_id)).toBe(
      true,
    );
    s.db.close();
  }
});

test("missing coverage is distinct from complete and incomplete stored claims; publishing is not full-history coverage", () => {
  const s = new QualityStore();
  const r = s.run({
    source: "global-pass",
    at: "2099-03-01T00:00:00Z",
    artifacts: [1, 2, 3].map((n) => ({
      key: `activity-2099-02-p${n}.html`,
      dataset: "globalpass-activity",
    })),
  });
  s.parse(r.artifacts[0]!, "global-pass-activity", {
    kind: "published",
    claim: { completeness: "complete" },
  });
  s.parse(r.artifacts[1]!, "global-pass-activity", {
    kind: "published",
    claim: { completeness: "unknown", cause: "page_missing" },
  });
  s.parse(r.artifacts[2]!, "global-pass-activity", { kind: "published" });
  const result = rows(s, "global-pass")[0]!;
  expect(result).toMatchObject({ published: 3, incomplete_coverage: 1, unreported_coverage: 1 });
  expect(cell(result).reasons).toEqual([
    "identity_not_recorded",
    "published_without_observations",
    "retention_not_assessed",
    "coverage_incomplete",
    "coverage_not_recorded",
  ]);
  s.db.close();
});

test("balance-only cells retain Balances' dataset policy gate without imposing it on VPoint history", () => {
  const s = new QualityStore();
  const point = s.run({
    source: "v-point",
    at: "2099-03-01T00:00:00Z",
    artifacts: pointArtifacts.slice(0, 3),
  });
  point.artifacts.forEach((id, i) => s.parse(id, pointParsers[i]!, { kind: "published" }));
  const jcb = s.run({
    source: "myjcb",
    at: "2099-03-01T00:00:00Z",
    artifacts: [{ key: "conn-a/credit-past-months.json", dataset: "credit-past-months" }],
  });
  s.parse(jcb.artifacts[0]!, "myjcb-credit-past-month-balances", { kind: "published" });
  expect(rows(s, "v-point").every((x) => x.current_run_id === point.run)).toBe(true);
  expect(rows(s, "myjcb")[0]!.current_run_id).toBe(jcb.run);
  // Synthetic policy input only: production registry and policies unchanged.
  // A required version absent from these published parses refuses balance
  // membership exactly as the shipped Balances predicate does.
  for (const [source, dataset, parser] of [
    ["v-point", "balance-info", "v-point-balance-info"],
    ["v-point", "smfg-point", "v-point-smfg-point"],
    ["v-point", "history-page-0001", "v-point-history-page"],
    ["myjcb", "credit-past-months", "myjcb-credit-past-month-balances"],
  ])
    s.db.run(
      "INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,required_parser_version) VALUES(?,?,?,'coverage-v1','9.0.0')",
      [source!, dataset!, parser!],
    );
  const pointRows = rows(s, "v-point");
  expect(
    pointRows
      .filter((x) => x.dataset !== "history-page-0001")
      .every((x) => x.current_run_id === null),
  ).toBe(true);
  expect(pointRows.find((x) => x.dataset === "history-page-0001")!.current_run_id).toBe(point.run);
  expect(rows(s, "myjcb")[0]!.current_run_id).toBeNull();
  s.db.close();
});
