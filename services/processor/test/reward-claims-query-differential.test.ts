// Scoped extension proof against the exact candidate read shipped at f6fb5bdd.
// Full CORE migrations, real sealed observation/unit views, all triggers/foreign keys,
// no ANALYZE. Provider values are synthetic. No Worker runtime is started.
import { beforeAll, expect, test } from "bun:test";
import { fromTemplate } from "../../../packages/read-model/test/schema-template.ts";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { rewardCandidateQuery, REWARD_PROMOTION_RELEASE } from "../src/reward-claims-job.ts";
import { FROZEN_REWARD_CANDIDATE_QUERY } from "./reward-claims-legacy-query.ts";
const PRODUCER = "collector-r2-importer",
  CLIENT = "reward-query-fixture",
  SHA = "a".repeat(64);
type Bind = string | number | null;
interface Candidate {
  id: number;
  parse_run_id: number;
  source_id: string;
  parser_name: string;
  source_account: string;
  metric: string;
  instrument: string;
  observed_at: string | null;
  as_of: string | null;
  extra_json: string;
  decimal_status: string | null;
  coefficient: string | null;
  scale: number | null;
}
interface Spec {
  source: string;
  parser: string;
  account: string;
  metric: string;
  instrument: string;
  dataset: string;
  outcome: "success" | "partial" | "failed";
  unit: "none" | "success" | "failed" | "absent-report" | "safe-code";
  error: "none" | "run" | "own" | "sibling";
  siblingFailed: boolean;
  sealed: boolean;
  published: boolean;
  excluded: boolean;
  claimed: "none" | "current" | "previous";
  decimal: "exact" | "missing" | "unparsed" | "fraction" | "conflict";
  observedAt: string | null;
  asOf: string | null;
  extra: string;
}
const total: Spec = {
  source: "myjcb",
  parser: "myjcb-jpoint-balance",
  account: "myjcb:synthetic-a:j-point:total",
  metric: "displayed_jpoint_total",
  instrument: "J_POINT",
  dataset: "jpoint-balance",
  outcome: "success",
  unit: "success",
  error: "none",
  siblingFailed: false,
  sealed: true,
  published: true,
  excluded: false,
  claimed: "none",
  decimal: "exact",
  observedAt: "2099-01-01T00:00:00.000Z",
  asOf: null,
  extra: '{"synthetic":"total"}',
};
const legacy: Spec[] = [
  {
    ...total,
    source: "v-point",
    parser: "v-point-balance-info",
    account: "v-point:regular:0",
    metric: "available_point_bucket",
    instrument: "V_POINT",
    dataset: "balance-info",
    unit: "none",
  },
  {
    ...total,
    source: "v-point",
    parser: "v-point-balance-info",
    account: "v-point:store-limited:0",
    metric: "available_point_bucket",
    instrument: "V_POINT",
    dataset: "balance-info",
    unit: "none",
  },
  {
    ...total,
    source: "v-point",
    parser: "v-point-smfg-point",
    account: "v-point:smfg",
    metric: "displayed_point_balance",
    instrument: "V_POINT",
    dataset: "smfg-point",
    unit: "none",
  },
  {
    ...total,
    source: "v-point-pay",
    parser: "v-point-pay-notification-event",
    account: "v-point-pay:card",
    metric: "prepaid_balance_after_event",
    instrument: "JPY",
    dataset: "notification",
    unit: "none",
  },
  {
    ...total,
    source: "mobile-suica",
    parser: "mobile-suica-sf-history",
    account: "mobile-suica:sf",
    metric: "sf_balance_after_transaction",
    instrument: "JPY",
    dataset: "history",
    unit: "none",
  },
];
const overrides: Partial<Spec>[] = [
  {},
  { outcome: "partial" },
  { outcome: "failed" },
  { unit: "failed" },
  { unit: "none", outcome: "partial" },
  { unit: "absent-report", outcome: "partial" },
  { unit: "safe-code", outcome: "partial" },
  { error: "run" },
  { error: "own" },
  { error: "sibling" },
  { siblingFailed: true },
  { sealed: false },
  { published: false },
  { excluded: true },
  { claimed: "current" },
  { claimed: "previous" },
  { decimal: "missing" },
  { decimal: "unparsed" },
  { decimal: "fraction" },
  { decimal: "conflict" },
  { observedAt: null, asOf: "2099-01-02", extra: '{"synthetic":"as-of"}' },
  { source: "vpass" },
  { parser: "myjcb-credit-ledger" },
  { metric: "different_metric" },
  { instrument: "JPY" },
  { dataset: "credit-ledger" },
  { account: "myjcb::j-point:total" },
  { account: "myjcb:UPPER:j-point:total" },
  { account: "myjcb:-bad:j-point:total" },
  { account: "myjcb:a_b:j-point:total" },
  { account: "myjcb:conn:normal" },
  { account: `myjcb:${"a".repeat(65)}:j-point:total` },
  { account: `myjcb:${"a".repeat(64)}:j-point:total` },
  { account: "myjcb:a:j-point:total" },
];
function fullSchema(): Database {
  const db = fromTemplate("reward-candidate-differential-full-core", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const dir = new URL("../../../packages/storage-d1/migrations/core/", import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(new URL(file, dir), "utf8"));
    db.run(
      "INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Synthetic reward query',1)",
      [CLIENT],
    );
    db.run("INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)", [
      CLIENT,
      PRODUCER,
    ]);
    for (const source of ["myjcb", "v-point", "v-point-pay", "mobile-suica", "vpass"])
      db.run(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
        [CLIENT, PRODUCER, source],
      );
    db.run(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/synthetic-reward-query',0)",
      [SHA],
    );
    return db;
  });
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
beforeAll(() => fullSchema().close(), 30000);
function claim(db: Database, row: Candidate, release: string): void {
  const program =
    row.parser_name === "myjcb-jpoint-balance"
      ? "program:j-point"
      : row.source_id === "v-point-pay"
        ? "program:v-point-pay"
        : row.source_id === "mobile-suica"
          ? "program:mobile-suica-sf"
          : "program:v-point";
  db.query(
    `INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,promotion_release,recorded_at) VALUES(?,?,'balance',?,?,?,?,'unclassified','[]','synthetic-unit','1000',0,'exact',NULL,'2099-01-01',?,'2099-01-01')`,
  ).run(
    `synthetic:${row.id}:${release}`,
    row.parse_run_id,
    row.id,
    program,
    `holding:${row.id}`,
    `bucket:${row.id}`,
    release,
  );
}
function seed(db: Database, spec: Spec, id: number): Candidate {
  const run = (sql: string, ...args: Bind[]) => db.query(sql).run(...args);
  const at = 4070908800000 + id;
  const descriptor = id.toString(16).padStart(64, "0");
  run(
    "INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms) VALUES(?,?,?,'synthetic-reward-query',?,?)",
    id,
    PRODUCER,
    CLIENT,
    `session-${id}`,
    at,
  );
  run(
    "INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms) VALUES(?,?,?,?,?,?,?)",
    id,
    id,
    PRODUCER,
    spec.source,
    CLIENT,
    `run-${id}`,
    at,
  );
  const unit = spec.unit === "none" ? null : id * 10;
  const sibling = id * 10 + 1;
  function addUnit(value: number, outcome: string | null, code: string | null) {
    run(
      "INSERT INTO fetch_units(id,fetch_run_id,unit_kind,unit_key,terminal_report_required,recorded_by_client_id,recorded_at_ms) VALUES(?,?,'reward-balance',?,0,?,?)",
      value,
      id,
      `unit-${value}`,
      CLIENT,
      at,
    );
    if (outcome !== null)
      run(
        "INSERT INTO fetch_unit_reports(fetch_unit_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,safe_failure_code,recorded_at_ms) VALUES(?,'terminal','terminal',?,?,?,?)",
        value,
        CLIENT,
        outcome,
        code,
        at,
      );
  }
  if (unit !== null)
    addUnit(
      unit,
      spec.unit === "absent-report" ? null : spec.unit === "failed" ? "failed" : "success",
      spec.unit === "safe-code" ? "synthetic_unavailable" : null,
    );
  if (spec.siblingFailed || spec.error === "sibling")
    addUnit(sibling, spec.siblingFailed ? "failed" : "success", null);
  const artifacts: [number, string, number | null, string][] = [
    [id * 10, "provider_response", unit, `${id}/jpoint-balance.json`],
  ];
  if (spec.error !== "none")
    artifacts.push([
      id * 10 + 1,
      "collector_error",
      spec.error === "run" ? null : spec.error === "sibling" ? sibling : unit,
      `error-${id}.json`,
    ]);
  for (const [artifact, role, owner, key] of artifacts)
    run(
      "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,fetch_unit_id,artifact_key,artifact_role,payload_fidelity,container_kind,lineage_disposition,dataset,declared_media_type,media_type_basis,fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'single','not_applicable',?,'application/json','response_header',?,'response',?,3,'v1',?,?)",
      artifact,
      id,
      spec.source,
      PRODUCER,
      CLIENT,
      owner,
      key,
      role,
      role === "collector_error" ? "generated" : "exact",
      spec.dataset,
      at,
      SHA,
      descriptor,
      at,
    );
  run(
    "INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id) VALUES(?,?,?,?,'operator',?,?)",
    id,
    id,
    descriptor,
    artifacts.length,
    at,
    CLIENT,
  );
  for (const [, , , key] of artifacts)
    run(
      "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
      id,
      id,
      key,
      SHA,
      descriptor,
    );
  run(
    "INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms) VALUES(?,'terminal','terminal',?,?,?)",
    id,
    CLIENT,
    spec.outcome,
    at,
  );
  if (spec.sealed)
    run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      id,
      id,
      at,
      CLIENT,
    );
  if (spec.excluded)
    run(
      "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms) VALUES(?,'exclude_from_financial_views','synthetic-query-excluded',?)",
      id,
      at,
    );
  run(
    "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1.0.0','2099-01-01','pending','[]')",
    id,
    id * 10,
    spec.parser,
  );
  const amount =
    spec.decimal === "missing"
      ? null
      : spec.decimal === "unparsed"
        ? "not-a-number"
        : spec.decimal === "fraction"
          ? "12.50"
          : "1000";
  run(
    "INSERT INTO balance_observations(id,parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,observed_at,as_of,raw_locator,extra_json) VALUES(?,?,?,?,?,?,0,?,?,?,'json:$.synthetic',?)",
    id,
    id,
    spec.account,
    spec.metric,
    spec.decimal === "conflict" ? 2 : null,
    amount,
    spec.instrument,
    spec.observedAt,
    spec.asOf,
    spec.extra,
  );
  run("UPDATE parse_runs SET status='ok' WHERE id=?", id);
  if (spec.published) {
    run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2099-01-01')",
      id * 10,
      spec.parser,
      id,
    );
    run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,'1.0.0','2099-01-01','normal')",
      id * 10,
      spec.parser,
      id,
    );
  }
  const decimal = db
    .query<{ status: string; coefficient: string | null; scale: number | null }, number[]>(
      "SELECT status,coefficient,scale FROM observation_decimal_values WHERE kind='balance' AND observation_id=? AND policy_version='decimal-v1'",
    )
    .get(id)!;
  const row: Candidate = {
    id,
    parse_run_id: id,
    source_id: spec.source,
    parser_name: spec.parser,
    source_account: spec.account,
    metric: spec.metric,
    instrument: spec.instrument,
    observed_at: spec.observedAt,
    as_of: spec.asOf,
    extra_json: spec.extra,
    decimal_status: decimal.status,
    coefficient: decimal.coefficient,
    scale: decimal.scale,
  };
  if (spec.claimed !== "none")
    claim(
      db,
      row,
      spec.claimed === "current" ? REWARD_PROMOTION_RELEASE : "reward-promotion-previous",
    );
  return row;
}
// Independent expected extension: public source/parser/measure, valid connection total,
// sealed/published/not-excluded, plus whole-run success or its own successful unit.
// It deliberately does not read PROMOTION_RULES, current SQL, or the generic SQL helper.
function expectedPoint(spec: Spec, policyEnabled: boolean): boolean {
  const whole =
    spec.outcome === "success" &&
    spec.error === "none" &&
    !spec.siblingFailed &&
    spec.unit !== "failed" &&
    spec.unit !== "safe-code";
  const own =
    policyEnabled &&
    spec.dataset === "jpoint-balance" &&
    spec.unit === "success" &&
    spec.error !== "run" &&
    spec.error !== "own";
  return (
    spec.source === "myjcb" &&
    spec.parser === "myjcb-jpoint-balance" &&
    spec.metric === "displayed_jpoint_total" &&
    spec.instrument === "J_POINT" &&
    /^myjcb:[a-z0-9][a-z0-9-]{0,63}:j-point:total$/u.test(spec.account) &&
    spec.sealed &&
    spec.published &&
    !spec.excluded &&
    spec.claimed !== "current" &&
    (whole || own)
  );
}
function query(db: Database, sql: string, bindings: readonly (string | number)[]): Candidate[] {
  return db.query<Candidate, SQLQueryBindings[]>(sql).all(...bindings);
}
function current(db: Database, limit: number): Candidate[] {
  const q = rewardCandidateQuery(REWARD_PROMOTION_RELEASE, limit);
  return query(db, q.sql, q.bindings);
}
function frozen(db: Database, limit: number): Candidate[] {
  return query(db, FROZEN_REWARD_CANDIDATE_QUERY.sql, [
    REWARD_PROMOTION_RELEASE,
    limit,
    ...FROZEN_REWARD_CANDIDATE_QUERY.scopeBindings,
  ]);
}
function drain(db: Database, limit: number, legacyQuery = false): Candidate[] {
  db.exec("SAVEPOINT candidate_drain");
  try {
    const all: Candidate[] = [];
    for (let page = 0; page < 10000; page++) {
      const rows = legacyQuery ? frozen(db, limit) : current(db, limit);
      if (rows.length === 0) return all;
      expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
      for (const row of rows) {
        expect(all.some((old) => old.id === row.id)).toBe(false);
        claim(db, row, REWARD_PROMOTION_RELEASE);
      }
      all.push(...rows);
    }
    throw new Error("candidate drain did not terminate");
  } finally {
    db.exec("ROLLBACK TO candidate_drain; RELEASE candidate_drain");
  }
}
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const CASES = overrides.flatMap((change) => [
  ...legacy.map((base) => ({ ...base, ...change })),
  { ...total, ...change },
]);
for (const [name, specs] of [
  ["scaled", Array.from({ length: 8 }, () => CASES).flat()],
  ...Array.from({ length: 8 }, (_, index) => {
    const next = random(index + 1);
    return [
      `random seed ${index + 1}`,
      Array.from({ length: 180 }, () => ({
        ...[...legacy, total][Math.floor(next() * 6)]!,
        ...overrides[Math.floor(next() * overrides.length)]!,
      })),
    ] as const;
  }),
] as const)
  test(`reward candidate ${name}: old rows equal frozen query plus only independently expected J-POINT additions`, () => {
    const db = fullSchema();
    try {
      const models = db.transaction(() =>
        specs.map((spec, index) => ({ spec, row: seed(db, spec, index + 1) })),
      )();
      for (const policyEnabled of [true, false]) {
        db.run(
          "UPDATE dataset_snapshot_policies SET unit_scope=? WHERE parser_name='myjcb-jpoint-balance' AND dataset='jpoint-balance'",
          [policyEnabled ? "unit" : "run"],
        );
        const old = drain(db, 37, true);
        const expected = [
          ...old,
          ...models.filter(({ spec }) => expectedPoint(spec, policyEnabled)).map(({ row }) => row),
        ].sort((a, b) => a.id - b.id);
        if (name === "scaled" && policyEnabled) expect(expected.length).toBeGreaterThan(500);
        expect(
          current(db, 5000).filter((row) => row.parser_name !== "myjcb-jpoint-balance"),
        ).toEqual(old);
        for (const limit of [1, 7, 37, 500]) {
          expect(current(db, limit)).toEqual(expected.slice(0, limit)); // One-row drains cover the random stores; scaled stores use native bounded pages.
          if (specs.length < 500 || limit >= 37) expect(drain(db, limit)).toEqual(expected);
        }
      }
    } finally {
      db.close();
    }
  });
test("reward candidate plan on real CORE views preserves indexed probes without statistics", () => {
  const db = fullSchema();
  try {
    db.transaction(() =>
      Array.from({ length: 4 }, () => CASES)
        .flat()
        .forEach((spec, index) => seed(db, spec, index + 1)),
    )();
    expect(db.query("SELECT name FROM sqlite_master WHERE name='sqlite_stat1'").get()).toBeNull();
    const plan = (sql: string, args: readonly (string | number)[]) =>
      db
        .query<{ detail: string }, SQLQueryBindings[]>("EXPLAIN QUERY PLAN " + sql)
        .all(...args)
        .map((row) => row.detail);
    const q = rewardCandidateQuery(REWARD_PROMOTION_RELEASE, 500);
    const old = plan(FROZEN_REWARD_CANDIDATE_QUERY.sql, [
        REWARD_PROMOTION_RELEASE,
        500,
        ...FROZEN_REWARD_CANDIDATE_QUERY.scopeBindings,
      ]),
      fresh = plan(q.sql, q.bindings);
    const scans = (steps: string[]) => steps.filter((step) => /^SCAN /u.test(step));
    expect(scans(old)).toEqual(["SCAN b"]);
    expect(scans(fresh)).toEqual(["SCAN b", "SCAN unit_policy"]);
    expect(
      fresh.some((step) =>
        /^SEARCH e USING INDEX idx_fetch_artifacts_run_role \(fetch_run_id=\? AND artifact_role=\?\)/u.test(
          step,
        ),
      ),
    ).toBe(true);
    expect(
      fresh.some((step) => /^SEARCH claimed USING INDEX reward_bucket_claims_v2_fact/u.test(step)),
    ).toBe(true);
    expect(
      fresh.some((step) =>
        /^SEARCH ur USING INDEX idx_fetch_unit_reports_one_terminal/u.test(step),
      ),
    ).toBe(true);
    expect(
      fresh.some((step) =>
        /^SEARCH s EXISTS USING COVERING INDEX sqlite_autoindex_fetch_run_seals_1/u.test(step),
      ),
    ).toBe(true);
    expect(fresh.some((step) => /USING AUTOMATIC/u.test(step))).toBe(false);
    expect(fresh.filter((step) => /^SCAN (?:a|e|u|ur|claimed|pub|p|seal|s)\b/u.test(step))).toEqual(
      [],
    );
  } finally {
    db.close();
  }
});
