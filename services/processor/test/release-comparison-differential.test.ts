// The release comparison's statements (src/release-adoption.ts) against their
// text as shipped at f50019fd7 (release-comparison-legacy-sql.ts), on the full
// CORE schema, never analyzed. The legacy `sided` and `claims` CTEs read both
// sides through one `OR` join and called a row `base` whenever its run was the
// artifact's published run, so an artifact whose published run is also the
// candidate run (the release is active for it) showed every observation and
// claim as base-only. The current text reads each side through its own join.
//
// - Wherever no artifact's published run is its candidate run (every store
//   before an activation), all seven statements answer exactly as the legacy
//   text: random stores and one scaled store.
// - Where some are, the current text answers what the legacy text answers once
//   each shared run is copied into a distinct candidate run with the same
//   observations, values and claims: the two sides are compared as two equal
//   result sets.
// - Plans: no statement walks an observation, value or claim table; each is
//   reached through its parse run index.
//
// Seeding writes the rows the statements read and nothing else, so the CORE
// triggers that guard the pipeline's own writes are dropped on the copy and
// foreign keys stay off; the schema, views and indexes are CORE's. Every row
// is synthetic: made-up sources, locators and decimal values.
import { beforeAll, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { fullCoreSchema } from "../../../packages/read-model/test/card-usage-scale-fixture.ts";
import { fromTemplate } from "../../../packages/read-model/test/schema-template.ts";
import { RELEASE_COMPARISON_SQL } from "../src/release-adoption.ts";
import { LEGACY_RELEASE_COMPARISON_SQL } from "./release-comparison-legacy-sql.ts";

const SOURCE = "synthetic-bank";
const DATASET = "synthetic-balances";
const PARSER = "synthetic-parser";
const RELEASE = "synthetic-parser-2.0.0-0000000000000000";
const OTHER_RELEASE = "synthetic-parser-3.0.0-0000000000000000";
const BIND = [SOURCE, DATASET, PARSER, RELEASE] as const;
const STATEMENTS = Object.keys(RELEASE_COMPARISON_SQL) as (keyof typeof RELEASE_COMPARISON_SQL)[];
const KINDS = ["transaction", "balance", "position", "valuation"] as const;
type Kind = (typeof KINDS)[number];

beforeAll(() => store().close(), 30_000);

/** A fresh CORE copy that accepts the comparison's rows on their own. */
function store(): Database {
  const db = fromTemplate("release-comparison-untriggered-core", () => {
    const core = fullCoreSchema();
    for (const { name } of core
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all())
      core.exec(`DROP TRIGGER "${name}"`);
    return core;
  });
  db.exec("PRAGMA foreign_keys=OFF");
  return db;
}

/** Mulberry32: a seeded generator, so a failing store can be rebuilt. */
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

class Seeder {
  private next = 1000;
  constructor(readonly db: Database) {}
  id(): number {
    return ++this.next;
  }
  exec(sql: string, args: SQLQueryBindings[]): void {
    this.db.query<unknown, SQLQueryBindings[]>(sql).run(...args);
  }
  /** An artifact; `id` fixes its id, so two stores built side by side name it alike. */
  artifact(source: string, dataset: string, id = this.id()): number {
    this.exec(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,lineage_disposition,dataset,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,1,?,'synthetic-producer','synthetic-client',?,'provider_response','exact','not_applicable',?,?,3,'v1',?,0)`,
      [id, source, `a-${id}.json`, dataset, "a".repeat(64), id.toString(16).padStart(64, "0")],
    );
    return id;
  }
  run(artifact: number, version: string): number {
    const id = this.id();
    this.exec(
      `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES(?,?,?,?,'2099-01-01','ok','[]')`,
      [id, artifact, PARSER, version],
    );
    return id;
  }
  publish(artifact: number, run: number): void {
    this.exec(
      `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
       VALUES(?,?,?,'1','2099-01-01','normal')`,
      [artifact, PARSER, run],
    );
  }
  candidate(run: number, release: string): void {
    this.exec(
      `INSERT INTO parse_run_candidates(parse_run_id,release_id,fingerprint,state,created_at)
       VALUES(?,?,'synthetic-fingerprint','compared','2099-01-01')`,
      [run, release],
    );
  }
  observation(run: number, kind: Kind, locator: string, role: string): number {
    const id = this.id();
    if (kind === "transaction")
      this.exec(
        `INSERT INTO transaction_observations(id,parse_run_id,source_account,raw_locator,external_id,extra_json)
         VALUES(?,?,'synthetic-account',?,?,'{}')`,
        [id, run, locator, role === "" ? null : role],
      );
    else if (kind === "balance")
      this.exec(
        `INSERT INTO balance_observations(id,parse_run_id,source_account,metric,instrument,raw_locator,extra_json)
         VALUES(?,?,'synthetic-account',?,'JPY',?,'{}')`,
        [id, run, role, locator],
      );
    else if (kind === "position")
      this.exec(
        `INSERT INTO position_observations(id,parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
         VALUES(?,?,'synthetic-account',?,'1',0,?,'{}')`,
        [id, run, role, locator],
      );
    else
      this.exec(
        `INSERT INTO valuation_observations(id,parse_run_id,source_account,subject,metric,currency,raw_locator,extra_json)
         VALUES(?,?,'synthetic-account','SYN',?,'JPY',?,'{}')`,
        [id, run, role, locator],
      );
    return id;
  }
  value(kind: Kind, observation: number, run: number, coefficient: string | null): void {
    this.exec(
      `INSERT INTO observation_decimal_values(kind,observation_id,parse_run_id,policy_version,status,coefficient,scale,basis)
       VALUES(?,?,?,'decimal-v1',?,?,?,?)`,
      [
        kind,
        observation,
        run,
        coefficient === null ? "missing" : "exact",
        coefficient,
        coefficient === null ? null : 0,
        coefficient === null ? "none" : "decimal_text",
      ],
    );
  }
  claim(run: number, claim: string, scope: string, completeness: string, observed: number): void {
    this.exec(
      `INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,
        evidence_refs_json,policy_version,absence_meaning,parent_run_status,parent_run_failure_count)
       VALUES(?,?,?,'complete-container',?,0,?,'[]','synthetic-policy',?,'success',0)`,
      [run, claim, scope, completeness, observed, observed > 0 ? "not-applicable" : "unknown"],
    );
  }
}

interface RunContent {
  observations: {
    kind: Kind;
    locator: string;
    role: string;
    coefficient: string | null | undefined;
  }[];
  claims: { claim: string; scope: string; completeness: string; observed: number }[];
}

function content(next: () => number): RunContent {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  return {
    // Few locators and roles, so keys match, go missing and repeat.
    observations: Array.from({ length: Math.floor(next() * 5) }, () => ({
      kind: pick(KINDS),
      locator: pick(["$[0]", "$[1]", "$[2]"]),
      role: pick(["", "r1", "r2"]),
      coefficient: pick([undefined, null, "1", "2"]),
    })),
    claims: Array.from({ length: Math.floor(next() * 3) }, (_, index) => ({
      claim: `claim-${index}`,
      scope: pick(["scope-a", "scope-b"]),
      completeness: pick(["complete", "partial"]),
      observed: Math.floor(next() * 3),
    })),
  };
}

function write(seed: Seeder, run: number, body: RunContent): void {
  for (const row of body.observations) {
    const id = seed.observation(run, row.kind, row.locator, row.role);
    if (row.coefficient !== undefined) seed.value(row.kind, id, run, row.coefficient);
  }
  for (const claim of body.claims)
    seed.claim(run, claim.claim, claim.scope, claim.completeness, claim.observed);
}

/**
 * One random store. With `shared`, some artifacts' published run is also the
 * release's candidate run. Returns the store and its split twin, where each
 * shared run is a distinct candidate run with the same content instead.
 */
function randomStores(seedValue: number, shared: boolean): { store: Database; split: Database } {
  const next = random(seedValue);
  const stores = { store: new Seeder(store()), split: new Seeder(store()) };
  const artifacts = 1 + Math.floor(next() * 8);
  for (let index = 0; index < artifacts; index += 1) {
    // Decoys outside the scope and inside it, in the same shape.
    const source = next() < 0.15 ? "other-bank" : SOURCE;
    const dataset = next() < 0.15 ? "other-dataset" : DATASET;
    const published = next() < 0.75;
    const hasCandidate = next() < 0.75;
    const same = shared && published && hasCandidate && next() < 0.6;
    const otherRelease = next() < 0.2;
    const base = content(next);
    const candidate = same ? base : content(next);
    for (const [name, seed] of Object.entries(stores)) {
      const artifact = seed.artifact(source, dataset, 1_000_000 + index);
      let baseRun: number | null = null;
      if (published) {
        baseRun = seed.run(artifact, "1.0.0");
        write(seed, baseRun, base);
        seed.publish(artifact, baseRun);
      }
      if (hasCandidate) {
        let candidateRun: number;
        if (same && name === "store") candidateRun = baseRun!;
        else {
          candidateRun = seed.run(artifact, "2.0.0");
          write(seed, candidateRun, candidate);
        }
        seed.candidate(candidateRun, RELEASE);
      }
      if (otherRelease) {
        const run = seed.run(artifact, "3.0.0");
        write(seed, run, content(random(seedValue * 31 + index)));
        seed.candidate(run, OTHER_RELEASE);
      }
    }
  }
  return { store: stores.store.db, split: stores.split.db };
}

const answer = (db: Database, sql: string) =>
  db.query<Record<string, unknown>, SQLQueryBindings[]>(sql).all(...BIND);

function sharesARun(db: Database): boolean {
  return (
    db
      .query<{ n: number }, SQLQueryBindings[]>(
        `SELECT count(*) AS n FROM published_parse_runs pub
         JOIN release_candidate_runs cand ON cand.parse_run_id=pub.parse_run_id AND cand.release_id=?`,
      )
      .get(RELEASE)!.n > 0
  );
}

test("with no shared run, every statement answers as the shipped text, on 200 random stores", () => {
  for (let seedValue = 1; seedValue <= 200; seedValue += 1) {
    const { store: db, split } = randomStores(seedValue, false);
    expect(sharesARun(db)).toBe(false);
    for (const name of STATEMENTS)
      expect({ seedValue, name, rows: answer(db, RELEASE_COMPARISON_SQL[name]) }).toEqual({
        seedValue,
        name,
        rows: answer(db, LEGACY_RELEASE_COMPARISON_SQL[name]),
      });
    db.close();
    split.close();
  }
}, 120_000);

test("a shared run compares as two equal sides: the shipped text on the split store, on 200 random stores", () => {
  let differed = 0;
  let sharedStores = 0;
  for (let seedValue = 1; seedValue <= 200; seedValue += 1) {
    const { store: db, split } = randomStores(seedValue, true);
    if (sharesARun(db)) sharedStores += 1;
    for (const name of STATEMENTS) {
      const current = answer(db, RELEASE_COMPARISON_SQL[name]);
      expect({ seedValue, name, rows: current }).toEqual({
        seedValue,
        name,
        rows: answer(split, LEGACY_RELEASE_COMPARISON_SQL[name]),
      });
      if (!Bun.deepEquals(current, answer(db, LEGACY_RELEASE_COMPARISON_SQL[name]))) differed += 1;
    }
    db.close();
    split.close();
  }
  // The generator does reach the shape, and the shipped text misreads it.
  expect(sharedStores).toBeGreaterThan(60);
  expect(differed).toBeGreaterThan(60);
}, 120_000);

test("an active release compared with itself is identical, where the shipped text called every row base-only", () => {
  const seed = new Seeder(store());
  for (let index = 0; index < 2; index += 1) {
    const artifact = seed.artifact(SOURCE, DATASET);
    const run = seed.run(artifact, "2.0.0");
    const id = seed.observation(run, "balance", `$[${index}]`, "synthetic_metric");
    seed.value("balance", id, run, "1");
    seed.claim(run, "claim-0", "scope-a", "complete", 1);
    seed.publish(artifact, run);
    seed.candidate(run, RELEASE);
  }
  const db = seed.db;
  const one = (sql: string) => answer(db, sql)[0];
  expect(one(RELEASE_COMPARISON_SQL.locators)).toEqual({
    matched: 2,
    base_only: 0,
    candidate_only: 0,
    ambiguous: 0,
  });
  expect(one(LEGACY_RELEASE_COMPARISON_SQL.locators)).toEqual({
    matched: 0,
    base_only: 2,
    candidate_only: 0,
    ambiguous: 0,
  });
  expect(answer(db, RELEASE_COMPARISON_SQL.byKind)).toEqual([
    { kind: "balance", base: 2, candidate: 2 },
  ]);
  expect(one(RELEASE_COMPARISON_SQL.values)).toEqual({
    compared: 2,
    differing: 0,
    missing_one_side: 0,
  });
  expect(one(RELEASE_COMPARISON_SQL.coverage)).toEqual({
    base_claims: 2,
    candidate_claims: 2,
    differing: 0,
  });
  expect(one(LEGACY_RELEASE_COMPARISON_SQL.coverage)).toEqual({
    base_claims: 2,
    candidate_claims: 0,
    differing: 2,
  });
  expect(answer(db, RELEASE_COMPARISON_SQL.sample)).toEqual([]);
  db.close();
});

test("on a scaled store every statement answers as the shipped text", () => {
  const seed = new Seeder(store());
  const next = random(4242);
  for (let index = 0; index < 3000; index += 1) {
    const artifact = seed.artifact(SOURCE, index % 10 === 0 ? "other-dataset" : DATASET);
    const base = seed.run(artifact, "1.0.0");
    write(seed, base, content(next));
    seed.publish(artifact, base);
    if (index % 3 !== 0) {
      const candidate = seed.run(artifact, "2.0.0");
      write(seed, candidate, content(next));
      seed.candidate(candidate, RELEASE);
    }
  }
  const db = seed.db;
  for (const name of STATEMENTS)
    expect({ name, rows: answer(db, RELEASE_COMPARISON_SQL[name]) }).toEqual({
      name,
      rows: answer(db, LEGACY_RELEASE_COMPARISON_SQL[name]),
    });
  db.close();
}, 120_000);

// The shipped text walked the materialized observation rows (`o`) and the
// candidate view (`cand`) once per scope row through its `OR` join; each
// side now reaches them by its parse run.
test("no statement walks an observation, value or claim table without statistics", () => {
  const db = fullCoreSchema();
  const walked =
    /^SCAN (transaction_observations|balance_observations|position_observations|valuation_observations|observation_decimal_values|parse_coverage_claims|o|c|cand)\b/u;
  const walks = (sql: string) =>
    db
      .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...BIND)
      .map((row) => row.detail)
      .filter((detail) => walked.test(detail));
  for (const name of STATEMENTS)
    expect({ name, walked: walks(RELEASE_COMPARISON_SQL[name]) }).toEqual({ name, walked: [] });
  // The check sees the shipped text's walks.
  expect(
    STATEMENTS.filter((name) => walks(LEGACY_RELEASE_COMPARISON_SQL[name]).length > 0),
  ).toEqual(["byKind", "locators", "values", "coverage", "sample"]);
  db.close();
});
