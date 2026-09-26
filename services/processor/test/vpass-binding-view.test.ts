// Migration 0055's `trusted_vpass_card_bindings` is one select for both
// producers; ADR 0023 specifies it as migration 0021's select verbatim UNION
// ALL the collector's select (`vpass-binding-legacy-sql.ts`). This differential
// test runs both on random stores and requires the same rows, and checks that
// the random stores are sharp enough to catch a dropped condition.
//
// The stores hold only the relations the view reads, as plain tables with
// `fetch_runs`' real uniqueness on (acquisition session, source, run key), so
// they can draw shapes CORE's triggers would refuse as well as the ones it
// accepts: wrong producers, namespaces, run keys, unit kinds and keys, token
// shapes, reports, artifact fields, extra units and extra bindings, and
// failed or missing run and artifact visibility. Every value is synthetic.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { IMPORTER_BINDING_SELECT_0021, TRUSTED_BINDINGS_SPEC } from "./vpass-binding-legacy-sql.ts";

const SHIPPED = (() => {
  const text = readFileSync(
    new URL(
      "../../../packages/storage-d1/migrations/core/0055_vpass_collector_card_binding.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const marker = "CREATE VIEW trusted_vpass_card_bindings AS\n";
  return text.slice(text.indexOf(marker) + marker.length).replace(/;\s*$/u, "");
})();

const SCHEMA = `
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY, producer_id TEXT, external_id_namespace TEXT);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY, source_id TEXT, producer_id TEXT,
  acquisition_session_id INTEGER, source_run_key TEXT,
  UNIQUE(acquisition_session_id, source_id, source_run_key));
CREATE TABLE observation_fetch_runs(id INTEGER PRIMARY KEY, status TEXT, failure_count INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY, fetch_run_id INTEGER, unit_key TEXT, unit_kind TEXT);
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER, report_kind TEXT, normalized_outcome TEXT, safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY, fetch_run_id INTEGER, source_id TEXT, fetch_unit_id INTEGER,
  artifact_key TEXT, artifact_role TEXT, dataset TEXT, format_id TEXT, format_version TEXT);
CREATE TABLE observation_fetch_artifacts(id INTEGER PRIMARY KEY);
`;

const IMPORTER = "collector-r2-importer";
const COLLECTOR = "collector-vpass";
const TOKENS = [
  `vpass-card-v1-${"a".repeat(64)}`,
  `vpass-card-v1-${"b".repeat(64)}`,
  `vpass-card-v1-${"A".repeat(64)}`,
  `vpass-card-v1-${"c".repeat(63)}`,
] as const;

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function store(seed: number): Database {
  const next = random(seed);
  const chance = (p: number) => next() < p;
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  let id = 0;
  const newId = () => (id += 1);
  const run = (sql: string, ...binds: (string | number | null)[]) => db.query(sql).run(...binds);

  const visible = (runId: number) => {
    if (chance(0.9))
      run(
        "INSERT INTO observation_fetch_runs VALUES(?,?,?)",
        runId,
        chance(0.88) ? "success" : "partial",
        chance(0.92) ? 0 : 1,
      );
  };
  const unit = (runId: number, key: string, kind = chance(0.92) ? "card" : "connection") => {
    const unitId = newId();
    run("INSERT INTO fetch_units VALUES(?,?,?,?)", unitId, runId, key, kind);
    if (chance(0.92))
      run(
        "INSERT INTO fetch_unit_reports VALUES(?,?,?,?)",
        unitId,
        chance(0.95) ? "terminal" : "progress",
        chance(0.9) ? "success" : "partial",
        chance(0.95) ? null : "synthetic_code",
      );
    if (chance(0.06))
      run("INSERT INTO fetch_unit_reports VALUES(?,'progress','partial',NULL)", unitId);
    return unitId;
  };
  const bindingArtifact = (runId: number, unitId: number, source = "vpass") => {
    const artifactId = newId();
    run(
      "INSERT INTO fetch_artifacts VALUES(?,?,?,?,?,?,?,?,?)",
      artifactId,
      runId,
      chance(0.96) ? source : "myjcb",
      unitId,
      chance(0.95) ? "card-identity-binding.json" : "other.json",
      chance(0.95) ? "collector_derived" : "provider_response",
      chance(0.95) ? "card-identity-binding" : null,
      chance(0.96) ? "vpass-card-identity-binding-json" : "other-format",
      chance(0.96) ? "1" : "2",
    );
    if (chance(0.5)) run("INSERT INTO observation_fetch_artifacts VALUES(?)", artifactId);
  };
  const financialArtifacts = (runId: number, unitId: number) => {
    for (let index = 0; index < 1 + Math.floor(next() * 3); index += 1) {
      const artifactId = newId();
      run(
        "INSERT INTO fetch_artifacts VALUES(?,?,?,?,?,?,?,?,?)",
        artifactId,
        runId,
        chance(0.95) ? "vpass" : "myjcb",
        chance(0.95) ? unitId : null,
        `months/20260${index + 1}/top-000.json`,
        "sanitized_provider_capture",
        null,
        null,
        null,
      );
      if (chance(0.92)) run("INSERT INTO observation_fetch_artifacts VALUES(?)", artifactId);
    }
  };

  for (let session = 1; session <= 12; session += 1) {
    const sessionId = newId();
    const producer = pick([IMPORTER, IMPORTER, COLLECTOR, COLLECTOR, "vpass-json"]);
    const namespace =
      producer === IMPORTER
        ? chance(0.9)
          ? "vpass-worker-card-v1"
          : "shared-r2"
        : chance(0.9)
          ? "shared-r2"
          : "vpass-worker-card-v1";
    run(
      "INSERT INTO acquisition_sessions VALUES(?,?,?)",
      sessionId,
      chance(0.95) ? producer : IMPORTER,
      namespace,
    );
    const cards = 1 + Math.floor(next() * 3);
    for (let card = 1; card <= cards; card += 1) {
      const label = chance(0.95) ? `card-00${card}` : `card-${card}`;
      const runId = newId();
      const collectorShape = producer !== IMPORTER;
      const runKey = collectorShape
        ? chance(0.85)
          ? `s${sessionId}-${label}:terminal-registration-v${pick([1, 1, 2])}`
          : pick([`s${sessionId}-card-999:terminal-registration-v1`, `s${sessionId}-${label}`])
        : `s${sessionId}-${label}`;
      run(
        "INSERT OR IGNORE INTO fetch_runs VALUES(?,?,?,?,?)",
        runId,
        chance(0.97) ? "vpass" : "myjcb",
        chance(0.97) ? producer : COLLECTOR,
        sessionId,
        runKey,
      );
      visible(runId);
      const financialUnit = unit(runId, label);
      financialArtifacts(runId, financialUnit);
      const token = pick(TOKENS);
      if (collectorShape) {
        // The collector's binding in its own run, sometimes doubled or crowded.
        if (chance(0.85)) {
          const bindingUnit = unit(runId, token);
          bindingArtifact(runId, bindingUnit);
          if (chance(0.08)) bindingArtifact(runId, bindingUnit);
          if (chance(0.08)) bindingArtifact(runId, unit(runId, pick(TOKENS)));
        }
        if (chance(0.08)) unit(runId, "card-900");
        if (chance(0.05)) unit(runId, pick(TOKENS));
      }
      // A sibling binding run, as the importer wrote it (also drawn for the
      // collector, whose view branch must not accept it).
      if (!collectorShape ? chance(0.85) : chance(0.2)) {
        const siblingId = newId();
        run(
          "INSERT OR IGNORE INTO fetch_runs VALUES(?,?,?,?,?)",
          siblingId,
          chance(0.97) ? "vpass" : "myjcb",
          chance(0.95) ? producer : COLLECTOR,
          sessionId,
          chance(0.93) ? `${label}-vpass-card-binding-v1` : `${label}-other`,
        );
        visible(siblingId);
        const bindingUnit = unit(siblingId, token);
        bindingArtifact(siblingId, bindingUnit);
        if (chance(0.06)) bindingArtifact(siblingId, bindingUnit);
        if (chance(0.06)) unit(siblingId, pick(TOKENS));
      }
    }
  }
  db.exec(`CREATE VIEW spec AS ${TRUSTED_BINDINGS_SPEC}`);
  db.exec(`CREATE VIEW importer_0021 AS ${IMPORTER_BINDING_SELECT_0021}`);
  return db;
}

const ORDER = " ORDER BY financial_artifact_id, financial_unit_id, binding_artifact_id, card_token";
const rows = (db: Database, relation: string) =>
  db.query(`SELECT * FROM ${relation}${ORDER}`).all();

const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1);

test("the shipped view returns exactly the specified rows on random stores", () => {
  let importer = 0;
  let collector = 0;
  let rejected = 0;
  for (const seed of SEEDS) {
    const db = store(seed);
    db.exec(`CREATE VIEW shipped AS ${SHIPPED}`);
    const spec = rows(db, "spec");
    expect([seed, rows(db, "shipped")]).toEqual([seed, spec]);
    // The importer's rows are migration 0021's, unchanged.
    expect(
      db
        .query(
          `SELECT s.* FROM shipped s JOIN fetch_artifacts a ON a.id=s.financial_artifact_id
             JOIN fetch_runs r ON r.id=a.fetch_run_id WHERE r.producer_id=?${ORDER.replace(/(\w+_id|card_token)/gu, "s.$1")}`,
        )
        .all(IMPORTER),
    ).toEqual(rows(db, "importer_0021"));
    const counted = db
      .query(
        `SELECT r.producer_id AS producer, count(*) AS n FROM spec s
           JOIN fetch_artifacts a ON a.id=s.financial_artifact_id
           JOIN fetch_runs r ON r.id=a.fetch_run_id GROUP BY r.producer_id`,
      )
      .all() as { producer: string; n: number }[];
    importer += counted.find((row) => row.producer === IMPORTER)?.n ?? 0;
    collector += counted.find((row) => row.producer === COLLECTOR)?.n ?? 0;
    rejected += (
      db
        .query(
          `SELECT count(*) AS n FROM fetch_artifacts a JOIN fetch_units u ON u.id=a.fetch_unit_id
            WHERE a.artifact_key GLOB 'months/*' AND a.id NOT IN (SELECT financial_artifact_id FROM spec)`,
        )
        .get() as { n: number }
    ).n;
    db.close();
  }
  // The seeds drew both kinds of binding and many rejected captures.
  expect(importer).toBeGreaterThan(20);
  expect(collector).toBeGreaterThan(20);
  expect(rejected).toBeGreaterThan(40);
});

const MUTATIONS: [string, string, string][] = [
  [
    "the collector run may hold a third unit",
    "AND (financial.producer_id='collector-r2-importer' OR other.id<>fu.id))",
    "AND 1)",
  ],
  [
    "the collector run key need not name the ordinal",
    "AND financial.source_run_key GLOB '*-'||fu.unit_key||':terminal-registration-v[0-9]*'))",
    "))",
  ],
  [
    "the collector's namespace is not checked",
    "WHEN 'collector-vpass' THEN 'shared-r2' END",
    "WHEN 'collector-vpass' THEN session.external_id_namespace END",
  ],
  [
    "the collector's binding may be a sibling run",
    "WHEN 'collector-vpass' THEN financial.source_run_key END",
    "WHEN 'collector-vpass' THEN fu.unit_key||'-vpass-card-binding-v1' END",
  ],
  [
    "the importer's namespace is not checked",
    "WHEN 'collector-r2-importer' THEN 'vpass-worker-card-v1'",
    "WHEN 'collector-r2-importer' THEN session.external_id_namespace",
  ],
  [
    "the importer's binding run may hold another unit",
    "AND other.id<>bu.id\n   AND (financial.producer_id='collector-r2-importer' OR other.id<>fu.id))",
    "AND other.id<>bu.id\n   AND financial.producer_id<>'collector-r2-importer' AND other.id<>fu.id)",
  ],
  [
    "a second binding artifact is allowed",
    "AND other.dataset='card-identity-binding' AND other.id<>ba.id)",
    "AND 0)",
  ],
  [
    "a failed binding report is allowed",
    "AND (ur.normalized_outcome<>'success' OR ur.safe_failure_code IS NOT NULL))",
    "AND 0)",
  ],
];

test.each(MUTATIONS)("the random stores catch: %s", (_, from, to) => {
  expect(SHIPPED).toContain(from);
  const mutated = SHIPPED.replace(from, to);
  const caught = SEEDS.some((seed) => {
    const db = store(seed);
    db.exec(`CREATE VIEW mutated AS ${mutated}`);
    const differs = JSON.stringify(rows(db, "mutated")) !== JSON.stringify(rows(db, "spec"));
    db.close();
    return differs;
  });
  expect(caught).toBe(true);
});
