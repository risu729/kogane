import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { captureProviderExpirySections } from "../src/reward-provider-expiry.ts";
import type { RewardBucketSqlRow } from "../src/rewards.ts";
import type { SqlExecutor } from "../src/reader.ts";
test("more than100 selected parents use bounded queries and exact samefact metadata", async () => {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE balance_observations(id INTEGER,parse_run_id INTEGER,metric TEXT,extra_json TEXT)",
  );
  const parents = Array.from(
    { length: 150 },
    (_, index) =>
      ({
        program_id: "program:j-point",
        source_fact_kind: "balance",
        source_fact_id: index + 1,
        parse_run_id: index + 501,
        id: index + 1,
        bucket_kind: "unclassified",
        restriction_refs_json: "[]",
        quantity_coefficient: "1000",
        quantity_scale: 0,
        quantity_status: "exact",
        observed_expiry_json: null,
        institution_ref: "institution:jcb",
        program_ref: "j-point",
        source_id: "myjcb",
        program_unit_ref: "points:j-point",
        holding_kind: "reward-points",
        terms_evidence_refs_json: "[]",
        release_id: "synthetic",
        holding_ref: `conn-${index}`,
        bucket_ref: `total-${index}`,
        unit_ref: "points:j-point",
        observed_at: "2099-01-01T00:00:00.000Z",
      }) satisfies RewardBucketSqlRow,
  );
  for (const parent of parents)
    db.run("INSERT INTO balance_observations VALUES(?,?,?,?)", [
      parent.source_fact_id,
      parent.parse_run_id,
      "displayed_jpoint_total",
      JSON.stringify({
        _kogane: {
          rewardExpiryDisplays: {
            coverage: "not-displayed",
            reasonCode: "provider_expiry_not_displayed",
            displays: [],
          },
        },
      }),
    ]);
  const sizes: number[] = [];
  const sql: SqlExecutor = {
    async all<T>(text: string, args: readonly unknown[]) {
      sizes.push(args.length);
      expect(args.length).toBeLessThanOrEqual(100);
      return db.query(text).all(...(args as never[])) as T[];
    },
    async first<T>(text: string, args: readonly unknown[]) {
      return db.query(text).get(...(args as never[])) as T | null;
    },
  };
  const sections = await captureProviderExpirySections(sql, parents);
  expect(sizes).toEqual([100, 50]);
  expect(sections).toHaveLength(150);
  expect(sections[149]!.sourceFactRefs).toEqual(["balance:150"]);
  expect(sections.every((s) => s.coverage === "not-displayed")).toBe(true);
  const mismatched = await captureProviderExpirySections(sql, [
    { ...parents[0]!, parse_run_id: 99999 },
  ]);
  expect(mismatched[0]!.coverage).toBe("unknown");
  expect(mismatched[0]!.displays).toEqual([]);
  db.close();
});

test("an acquisition-history lot is not a total and gets no provider display section", async () => {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE balance_observations(id INTEGER,parse_run_id INTEGER,metric TEXT,extra_json TEXT)",
  );
  const holding = "program:j-point:myjcb:conn-a:j-point:total";
  const claim = (
    factId: number,
    parseRunId: number,
    bucketRef: string,
    kind: string,
  ): RewardBucketSqlRow => ({
    program_id: "program:j-point",
    source_fact_kind: "balance",
    source_fact_id: factId,
    parse_run_id: parseRunId,
    id: factId,
    bucket_kind: kind,
    restriction_refs_json: "[]",
    quantity_coefficient: "40",
    quantity_scale: 0,
    quantity_status: "exact",
    observed_expiry_json: null,
    institution_ref: "institution:jcb",
    program_ref: "j-point",
    source_id: "myjcb",
    program_unit_ref: "points:j-point",
    holding_kind: "reward-points",
    terms_evidence_refs_json: "[]",
    release_id: "synthetic",
    holding_ref: holding,
    bucket_ref: bucketRef,
    unit_ref: "points:j-point",
    observed_at: "2099-01-01T00:00:00.000Z",
  });
  // Two lots of one complete history capture (ADR 0107): their own facts are
  // acquisition-bucket stocks with an observed expiry month, not a total.
  const lots = [
    claim(11, 701, "program:j-point:myjcb:conn-a:j-point:acquired:2099-01-15", "time-limited"),
    claim(12, 701, "program:j-point:myjcb:conn-a:j-point:acquired:2099-02-15", "time-limited"),
  ];
  for (const lot of lots)
    db.run("INSERT INTO balance_observations VALUES(?,?,?,?)", [
      lot.source_fact_id,
      lot.parse_run_id,
      "jpoint_acquisition_remaining",
      JSON.stringify({ _kogane: { observedExpiry: { kind: "unknown", reasonCode: "x" } } }),
    ]);
  // The total of another connection, which the reader selected.
  const total = claim(21, 702, "program:j-point:myjcb:conn-b:j-point:total", "unclassified");
  db.run("INSERT INTO balance_observations VALUES(?,?,?,?)", [
    total.source_fact_id,
    total.parse_run_id,
    "displayed_jpoint_total",
    JSON.stringify({
      _kogane: {
        rewardExpiryDisplays: {
          coverage: "not-displayed",
          reasonCode: "provider_expiry_not_displayed",
          displays: [],
        },
      },
    }),
  ]);
  const sql: SqlExecutor = {
    async all<T>(text: string, args: readonly unknown[]) {
      return db.query(text).all(...(args as never[])) as T[];
    },
    async first<T>(text: string, args: readonly unknown[]) {
      return db.query(text).get(...(args as never[])) as T | null;
    },
  };
  expect(await captureProviderExpirySections(sql, lots)).toEqual([]);
  const sections = await captureProviderExpirySections(sql, [...lots, total]);
  expect(sections.map((section) => section.parentBucketRef)).toEqual([total.bucket_ref]);
  expect(sections[0]!.coverage).toBe("not-displayed");
  db.close();
});
