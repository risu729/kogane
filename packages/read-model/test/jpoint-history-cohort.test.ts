import { expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "./collection-quality-fixture";
import { CURRENT_REWARD_BUCKETS_SQL, createRewardReader, REWARD_READ_RELEASE, type RewardBucketSqlRow } from "../src/rewards";
import { LEGACY_PRE_JPOINT_REWARD_SQL } from "./jpoint-history-legacy-sql";
import { myJcbJPointHistory } from "../../parsers/src/parsers/myjcb-jpoint-history";
import { syntheticJPointHistory } from "../../parsers/test/myjcb-jpoint-history-fixture";
import type { JPointHistory } from "../../domain/src/myjcb-jpoint-history";
import { summarizeHolding } from "../../domain/src/rewards";

function captured(s: QualityStore, index: number, total: string, history?: JPointHistory, options: { conn?: string; promote?: number } = {}) {
  const conn = options.conn ?? "synthetic";
  const at = new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString();
  const r = s.run({ source: "myjcb", at, units: {
    [`${conn}:j-point`]: { outcome: "success" },
    ...(history ? { [`${conn}:j-point-history`]: { outcome: "success" as const } } : {}),
  }, artifacts: [
    { key: `${conn}/jpoint-balance.json`, dataset: "jpoint-balance", unit: `${conn}:j-point` },
    ...(history ? [{ key: `${conn}/jpoint-history.json`, dataset: "jpoint-history", unit: `${conn}:j-point-history` }] : []),
  ] });
  const totalParse = s.parse(r.artifacts[0]!, "myjcb-jpoint-balance", { kind: "published", version: "1.0.1" });
  const sourceAccount = `myjcb:${conn}:j-point:total`;
  const insert = (parse: number, account: string, metric: string, amount: string, extra = "{}") =>
    (s.db.query(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json)
      VALUES(?,?,?,?,0,'J_POINT',?,'json:synthetic',?) RETURNING id`).get(parse, account, metric, amount, at, extra) as { id: number }).id;
  const claim = (parse: number, fact: number, account: string, amount: string, kind: string) =>
    s.db.run(`INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,promotion_release,recorded_at)
      VALUES(?,?,'balance',?,'program:j-point',?,?,?,'[]','points:j-point',?,0,'exact',NULL,?,?,?)`,
      [`synthetic-jpoint-${fact}`, parse, fact, `program:j-point:${sourceAccount}`, `program:j-point:${account}`, kind, amount, at, REWARD_READ_RELEASE, at]);
  const totalFact = insert(totalParse, sourceAccount, "displayed_jpoint_total", total);
  claim(totalParse, totalFact, sourceAccount, total, "unclassified");
  const remaining: { fact: number; amount: string; account: string }[] = [];
  let historyParse: number | undefined;
  if (history) {
    historyParse = s.parse(r.artifacts[1]!, myJcbJPointHistory.name, { kind: "published", version: myJcbJPointHistory.version,
      claim: { completeness: "complete", observed: history.rows.length * 4 } });
    const parsed = myJcbJPointHistory.parse(new TextEncoder().encode(JSON.stringify(history)), {
      id: r.artifacts[1]!, sourceId: "myjcb", dataset: "jpoint-history", artifactKey: `${conn}/jpoint-history.json`,
      fetchUnitKey: `${conn}:j-point-history`, mime: "application/json", url: null,
      fetchedAt: at, sha256: "a".repeat(64), runStatus: "success", runFailureCount: 0,
    });
    for (const observation of parsed.observations) {
      if (observation.kind !== "balance") throw new Error("synthetic balance expected");
      const fact = insert(historyParse, observation.sourceAccount, observation.metric, observation.amountText!, JSON.stringify(observation.extra));
      if (observation.metric === "jpoint_acquisition_remaining") remaining.push({ fact, amount: observation.amountText!, account: observation.sourceAccount });
    }
    remaining.slice(0, options.promote ?? remaining.length).forEach((row) => claim(historyParse!, row.fact, row.account, row.amount, "time-limited"));
  }
  return { ...r, at, remaining, finish: () => remaining.slice(options.promote ?? remaining.length)
    .forEach((row) => claim(historyParse!, row.fact, row.account, row.amount, "time-limited")) };
}
const current = (s: QualityStore, sql = CURRENT_REWARD_BUCKETS_SQL): RewardBucketSqlRow[] =>
  s.db.query(sql).all(REWARD_READ_RELEASE, "program:j-point", 0) as RewardBucketSqlRow[];
function withoutCohort(rows: RewardBucketSqlRow[]) {
  return rows.map(({ jpoint_history_state: _state, jpoint_history_observed_at: _at, jpoint_history_fact_id: _fact, ...row }) => row);
}
test("same-capture complete bucket membership replaces total once; newer total exposes an older-history gap", async () => {
  const s = new QualityStore();
  try {
    const old = captured(s, 1, "100", syntheticJPointHistory());
    expect(current(s).map((r) => r.quantity_coefficient)).toEqual(["0", "40", "60"]);
    expect(current(s).every((r) => r.jpoint_history_state === "current")).toBe(true);
    const reader = createRewardReader({
      all: async <T>(sql: string, args: readonly unknown[]) => s.db.query(sql).all(...args as SQLQueryBindings[]) as T[],
      first: async <T>(sql: string, args: readonly unknown[]) => s.db.query(sql).get(...args as SQLQueryBindings[]) as T | null,
    });
    const holding = (await reader.holdings({ programId: "program:j-point", offset: 0 })).rows[0]!;
    expect(holding.holding.buckets).toHaveLength(3);
    expect(summarizeHolding(holding.holding).consumable.value).toMatchObject({ status: "exact", value: { coefficient: "100" } });
    captured(s, 2, "200");
    expect(current(s).map((r) => [r.quantity_coefficient, r.jpoint_history_state])).toEqual([["200", "stale"]]);
    const newer = (await reader.holdings({ programId: "program:j-point", offset: 0 })).rows[0]!;
    expect(newer.pointHistoryCoverage).toMatchObject({ state: "stale", reasonCode: "history_not_current", observedAt: old.at });
    expect(newer.pointHistoryCoverage?.sourceFactRefs).toHaveLength(1);
    expect(s.db.query("SELECT COUNT(*) AS n FROM reward_bucket_claims_v2").get()).toEqual({ n: 5 });
  } finally { s.db.close(); }
});
test("shrinking membership does not resurrect removed buckets, and partial promotion never suppresses the total", () => {
  const s = new QualityStore();
  try {
    captured(s, 1, "100", syntheticJPointHistory());
    const smaller = syntheticJPointHistory();
    smaller.rows = [smaller.rows[1]!]; smaller.reportedTotal = "40";
    captured(s, 2, "40", smaller);
    expect(current(s).map((r) => r.quantity_coefficient)).toEqual(["40"]);
    const pending = captured(s, 3, "100", syntheticJPointHistory(), { promote: 2 });
    expect(current(s).map((r) => [r.quantity_coefficient, r.jpoint_history_state])).toEqual([["100", "stale"]]);
    pending.finish();
    expect(current(s).map((r) => r.quantity_coefficient)).toEqual(["0", "40", "60"]);
  } finally { s.db.close(); }
});
test("a history from another total revision is evidence only even if claims exist", () => {
  const s = new QualityStore();
  try {
    captured(s, 1, "200", syntheticJPointHistory());
    expect(current(s).map((r) => [r.quantity_coefficient, r.jpoint_history_state])).toEqual([["200", "stale"]]);
  } finally { s.db.close(); }
});
test("scaled seeded captures without history equal the frozen reader and use indexes without statistics", () => {
  const s = new QualityStore();
  try {
    let seed = 1251;
    for (let i = 1; i <= 600; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      captured(s, i, String(seed % 10000), undefined, { conn: `synthetic-${seed % 17}` });
    }
    expect(withoutCohort(current(s))).toEqual(current(s, LEGACY_PRE_JPOINT_REWARD_SQL));
    const plan = s.db.query("EXPLAIN QUERY PLAN " + CURRENT_REWARD_BUCKETS_SQL).all(REWARD_READ_RELEASE, "program:j-point", 0) as { detail: string }[];
    expect(plan.some((row) => /SEARCH .* USING/u.test(row.detail))).toBe(true);
    expect(s.db.query("SELECT name FROM sqlite_master WHERE name='sqlite_stat1'").get()).toBeNull();
  } finally { s.db.close(); }
}, 30000);
