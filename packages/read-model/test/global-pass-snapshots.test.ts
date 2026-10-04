// GLOBAL PASS activity currentness (ADR 0026's amendment of 2026-10-04): a
// walked month is one snapshot of several page artifacts
// (`activity-YYYY-MM.html`, `activity-YYYY-MM-p2.html`, ...), and the newest
// run whose every page of that month has an active parse is the current one.
//
// Three proofs:
//  * on stores with one page per month and run (every run before the
//    collector walked pages), the snapshot selects exactly what the shipped
//    per-key ranking selected, frozen below, on hand-built and random stores
//    and on a scaled store with the complete CORE schema;
//  * on walked months, a page a newer run no longer shows stops being current
//    with its month, and a month whose newer pages are not all parsed keeps
//    its older complete snapshot (hand-built, and against an independent
//    model on the scaled store);
//  * without table statistics (D1 runs no `ANALYZE`), the Transactions plan
//    reads the artifacts once for the snapshot, as the per-key ranking did,
//    and reaches a run's pages of a month by index, never by a scan per month
//    (docs/read-model.md, Cost).
// Everything is synthetic: placeholder rows on CORE stores.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { CardStore } from "./card-usage-fixture";
import { explain, type PlanStep } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { activeStateProjection } from "../src/index";
import { GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES, transactionsSql } from "../src/sql";

const ACTIVE = activeStateProjection.predicate;
const PARSE_CHAIN = activeStateProjection.parseChain;

/** The per-key ranking `listTransactions` shipped before this change, frozen. */
const FROZEN_PER_KEY_CTES = `ranked_global_pass_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.artifact_key
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'global-pass-activity'
           AND fa.dataset = 'globalpass-activity'
       ), current_global_pass_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_global_pass_snapshots
         WHERE snapshot_rank = 1
       )`;

class GlobalPassStore {
  readonly store = new CardStore();
  private next = 10_000;
  constructor() {
    this.store.db.run("INSERT INTO sources VALUES('global-pass','synthetic')");
  }
  private id(): number {
    this.next += 1;
    return this.next;
  }
  run(outcome: "success" | "failure" = "success"): number {
    const id = this.id();
    const db = this.store.db;
    db.run(
      "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,'collector-r2-importer','synthetic-global-pass')",
      [id, `synthetic-session-${id}`],
    );
    db.run(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,'global-pass',?,'collector-r2-importer',0)",
      [id, id],
    );
    db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal',?,0,0)", [id, outcome]);
    db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [id]);
    return id;
  }
  /**
   * One page artifact; `parsed` publishes an `ok` parse with `rows`
   * placeholder rows (one by default; zero is the empty month 1.2.0 reads).
   */
  page(run: number, key: string, fetchedAt: string, parsed = true, rows = 1): number {
    const db = this.store.db;
    const artifact = this.id();
    db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
       VALUES(?,?,'global-pass','globalpass-activity',?,'text/html',?,?,?,'sanitized_provider_capture')`,
      [
        artifact,
        run,
        key,
        Date.parse(fetchedAt),
        Date.parse(fetchedAt),
        artifact.toString(16).padStart(64, "0"),
      ],
    );
    if (!parsed) return artifact;
    const parse = this.id();
    db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'global-pass-activity','1.1.0','2026-09-01','pending','[]')",
      [parse, artifact],
    );
    for (let row = 0; row < rows; row += 1)
      db.run(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,amount_text,amount_scale,currency,description,as_of,raw_locator,extra_json)
         VALUES(?,'global-pass:card',?,'1.00',2,'USD','SYNTHETIC','2099-01-02',?,'{}')`,
        [parse, `global-pass:synthetic-${artifact}:${row}`, `html:activity-record=${row + 1}`],
      );
    db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
    db.run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,'global-pass-activity',NULL,?,'normal','pipeline','parse_ok','2026-09-01')",
      [artifact, parse],
    );
    db.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'global-pass-activity',?,'1.1.0','2026-09-01','normal')",
      [artifact, parse],
    );
    return artifact;
  }
  current(ctes: string): number[] {
    return this.store.db
      .query(
        `WITH ${ctes} SELECT fetch_artifact_id AS id FROM current_global_pass_snapshots ORDER BY 1`,
      )
      .all()
      .map((row) => (row as { id: number }).id);
  }
}

/** A deterministic generator, so a failing store can be rebuilt. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("GLOBAL PASS activity snapshots", () => {
  test("one page per month and run: the same artifacts the per-key ranking chose", () => {
    const s = new GlobalPassStore();
    const older = s.run();
    s.page(older, "activity-2099-01.html", "2099-02-01T00:00:00Z");
    s.page(older, "activity-2098-12.html", "2099-02-01T00:00:00Z");
    const newer = s.run();
    s.page(newer, "activity-2099-01.html", "2099-02-02T00:00:00Z");
    // A newer page with no active parse leaves the older one current.
    s.page(newer, "activity-2098-12.html", "2099-02-02T00:00:00Z", false);
    // A failed run is never current.
    const failed = s.run("failure");
    s.page(failed, "activity-2099-01.html", "2099-02-03T00:00:00Z");
    const chosen = s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES);
    expect(chosen).toEqual(s.current(FROZEN_PER_KEY_CTES));
    expect(chosen).toHaveLength(2);
  });

  test("one page per month and run, random stores: identical to the per-key ranking", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      const s = new GlobalPassStore();
      const runs = 1 + Math.floor(next() * 6);
      for (let index = 0; index < runs; index += 1) {
        const run = s.run(next() < 0.15 ? "failure" : "success");
        for (const month of ["2099-01", "2098-12", "2098-11"]) {
          if (next() < 0.3) continue;
          // Equal fetch times across runs exercise the artifact id tiebreak.
          const day = 1 + Math.floor(next() * 3);
          s.page(run, `activity-${month}.html`, `2099-02-0${day}T00:00:00Z`, next() > 0.2);
        }
      }
      expect(s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES)).toEqual(s.current(FROZEN_PER_KEY_CTES));
    }
  });

  test("a walked month's pages are current together", () => {
    const s = new GlobalPassStore();
    const run = s.run();
    const first = s.page(run, "activity-2099-01.html", "2099-02-01T00:00:00Z");
    const second = s.page(run, "activity-2099-01-p2.html", "2099-02-01T00:00:00Z");
    const other = s.page(run, "activity-2098-12.html", "2099-02-01T00:00:00Z");
    expect(s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES)).toEqual([first, second, other]);
  });

  test("a page the newer capture no longer shows stops being current (nothing counted twice)", () => {
    // The month had two pages; a row left it, the rest fit on one page, and
    // the newer run stored page 1 only. The per-key ranking kept the old page
    // 2 current beside the new page 1, which shows the moved row again.
    const s = new GlobalPassStore();
    const older = s.run();
    s.page(older, "activity-2099-01.html", "2099-02-01T00:00:00Z");
    const stale = s.page(older, "activity-2099-01-p2.html", "2099-02-01T00:00:00Z");
    const newer = s.run();
    const fresh = s.page(newer, "activity-2099-01.html", "2099-02-02T00:00:00Z");
    expect(s.current(FROZEN_PER_KEY_CTES)).toEqual([stale, fresh]);
    expect(s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES)).toEqual([fresh]);
  });

  test("limit: a newer empty month (an ok parse with no row) supersedes an older capture with rows", () => {
    // global-pass-activity 1.2.0 reads the observed empty month as an ok parse
    // with no observation (ADR 0026's empty-month amendment). The month is
    // then current with nothing in it, and an older run's rows for the same
    // month stop being current. The parser cannot tell the observed empty
    // month from a page whose list failed to render (the same markup); this
    // pins the read model's behaviour so a change to it is visible. A newer
    // capture with rows supersedes the empty reading in turn.
    const s = new GlobalPassStore();
    const older = s.run();
    s.page(older, "activity-2099-01.html", "2099-02-01T00:00:00Z", true, 2);
    s.page(older, "activity-2099-01-p2.html", "2099-02-01T00:00:00Z");
    const other = s.page(older, "activity-2098-12.html", "2099-02-01T00:00:00Z");
    const newer = s.run();
    const empty = s.page(newer, "activity-2099-01.html", "2099-02-02T00:00:00Z", true, 0);
    expect(s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES)).toEqual([other, empty]);
    const current = s.store.db
      .query(
        `WITH ${GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES}
         SELECT COUNT(*) AS n FROM transaction_observations o
         JOIN parse_runs p ON p.id = o.parse_run_id
         WHERE p.fetch_artifact_id IN (SELECT fetch_artifact_id FROM current_global_pass_snapshots)`,
      )
      .get() as { n: number };
    // Only the other month's row: the empty month contributes none.
    expect(current.n).toBe(1);
    const latest = s.run();
    const refilled = s.page(latest, "activity-2099-01.html", "2099-02-03T00:00:00Z");
    expect(s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES)).toEqual([other, refilled]);
  });

  test("a newer run whose pages are not all parsed keeps the older whole month", () => {
    const s = new GlobalPassStore();
    const older = s.run();
    const a = s.page(older, "activity-2099-01.html", "2099-02-01T00:00:00Z");
    const b = s.page(older, "activity-2099-01-p2.html", "2099-02-01T00:00:00Z");
    const newer = s.run();
    s.page(newer, "activity-2099-01.html", "2099-02-02T00:00:00Z");
    s.page(newer, "activity-2099-01-p2.html", "2099-02-02T00:00:00Z", false);
    expect(s.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES)).toEqual([a, b]);
  });
});

const CLIENT = "synthetic-global-pass-scale";
const PRODUCER = "collector-r2-importer";
const SHA = "b".repeat(64);
const MONTHS = ["2099-03", "2099-02", "2099-01", "2098-12"] as const;
const DAY_MS = 86_400_000;
const START_MS = Date.parse("2099-01-01T00:00:00Z");

interface ScaledPage {
  run: number;
  id: number;
  month: string;
  at: number;
  parsed: boolean;
}

/**
 * GLOBAL PASS runs on the complete CORE schema (every migration, foreign keys
 * on, never analyzed), written in the order the ingest Worker writes them: a
 * sealed run per capture with its activity pages and a manifest. Each parse
 * carries one placeholder row; currentness reads no observation.
 */
class ScaledGlobalPassStore {
  readonly db: Database = fullCoreSchema();
  /** Every activity page, for the independent model. */
  readonly pages: ScaledPage[] = [];
  private id = 1_000;

  constructor() {
    this.db.run("INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Scale client',1)", [
      CLIENT,
    ]);
    this.db.run("INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)", [
      CLIENT,
      PRODUCER,
    ]);
    this.db.run(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,'global-pass')",
      [CLIENT, PRODUCER],
    );
    this.db.run(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/global-pass-scale',0)",
      [SHA],
    );
  }

  private next(): number {
    this.id += 1;
    return this.id;
  }

  /** One sealed `success` run; each month lists its pages' parse states, page 1 first. */
  capture(at: number, months: readonly { month: string; parsed: readonly boolean[] }[]): void {
    const db = this.db;
    const session = this.next();
    db.run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,'synthetic-global-pass',?,?)`,
      [session, PRODUCER, CLIENT, `scale-session-${session}`, at],
    );
    const run = this.next();
    db.run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,'global-pass',?,'default',?)`,
      [run, session, PRODUCER, CLIENT, at],
    );
    const stored: { key: string; id: number }[] = [];
    const artifact = (key: string, dataset: string, role: string, mime: string): number => {
      const id = this.next();
      // A sanitized page is a transformed capture whose source is not kept.
      const sanitized = role === "sanitized_provider_capture";
      db.run(
        `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,fetch_unit_id,artifact_key,artifact_role,
          payload_fidelity,container_kind,lineage_disposition,dataset,format_id,format_version,declared_media_type,media_type_basis,
          fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
         VALUES(?,?,'global-pass',?,?,NULL,?,?,?,'single',?,?,NULL,NULL,?,'response_header',?,'response',?,3,'v1',?,?)`,
        [
          id,
          run,
          PRODUCER,
          CLIENT,
          key,
          role,
          sanitized ? "transformed" : "generated",
          sanitized ? "source_not_retained_for_security" : "not_applicable",
          dataset,
          mime,
          at,
          SHA,
          id.toString(16).padStart(64, "0"),
          at,
        ],
      );
      if (sanitized)
        for (const [index, kind] of ["extracted", "redacted"].entries())
          db.run(
            `INSERT INTO artifact_transform_steps(fetch_artifact_id,step_index,step_kind,transformer_id,transformer_version,recorded_by_client_id,recorded_at_ms)
             VALUES(?,?,?,'synthetic','1',?,?)`,
            [id, index, kind, CLIENT, at],
          );
      stored.push({ key, id });
      return id;
    };
    for (const { month, parsed } of months) {
      for (const [index, ok] of parsed.entries()) {
        const key = index === 0 ? `activity-${month}.html` : `activity-${month}-p${index + 1}.html`;
        const id = artifact(key, "globalpass-activity", "sanitized_provider_capture", "text/html");
        this.pages.push({ run, id, month, at, parsed: ok });
        if (ok) this.parse(id);
      }
    }
    artifact("manifest.json", "collector-manifest", "collector_manifest", "application/json");
    const inventory = this.next();
    db.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,?,'operator',?,?)`,
      [inventory, run, inventory.toString(16).padStart(64, "0"), stored.length, at, CLIENT],
    );
    for (const { key, id } of stored)
      db.run(
        "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
        [inventory, run, key, SHA, id.toString(16).padStart(64, "0")],
      );
    db.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
        started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,'success',?,'manifest',?,'manifest',?)`,
      [run, CLIENT, at, at, at],
    );
    db.run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      [inventory, run, at, CLIENT],
    );
  }

  private parse(artifact: number): void {
    const db = this.db;
    const parse = this.next();
    db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'global-pass-activity','1.1.0','2026-09-01','pending','[]')",
      [parse, artifact],
    );
    db.run(
      `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,amount_text,amount_scale,currency,description,as_of,raw_locator,extra_json)
       VALUES(?,'global-pass:card',?,'1.00',2,'USD','SYNTHETIC','2099-01-02','html:activity-record=1','{}')`,
      [parse, `global-pass:synthetic-${artifact}:0`],
    );
    db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
    db.run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,'global-pass-activity',NULL,?,'normal','pipeline','parse_ok','2026-09-01')",
      [artifact, parse],
    );
    db.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'global-pass-activity',?,'1.1.0','2026-09-01','normal')",
      [artifact, parse],
    );
  }

  current(ctes: string): number[] {
    return this.db
      .query(
        `WITH ${ctes} SELECT fetch_artifact_id AS id FROM current_global_pass_snapshots ORDER BY 1`,
      )
      .all()
      .map((row) => (row as { id: number }).id);
  }

  /**
   * The rule written independently of the SQL: per month, the newest run
   * (newest page time, then newest page id) whose pages of that month all
   * parsed, and every one of those pages.
   */
  modelled(): number[] {
    const byRunMonth = new Map<string, ScaledPage[]>();
    for (const page of this.pages) {
      const key = `${page.run}/${page.month}`;
      byRunMonth.set(key, [...(byRunMonth.get(key) ?? []), page]);
    }
    const best = new Map<string, { at: number; id: number; pages: number[] }>();
    for (const pages of byRunMonth.values()) {
      if (!pages.every((page) => page.parsed)) continue;
      const month = pages[0]!.month;
      const at = Math.max(...pages.map((page) => page.at));
      const id = Math.max(...pages.map((page) => page.id));
      const held = best.get(month);
      if (held === undefined || at > held.at || (at === held.at && id > held.id))
        best.set(month, { at, id, pages: pages.map((page) => page.id) });
    }
    return [...best.values()].flatMap((entry) => entry.pages).sort((a, b) => a - b);
  }
}

/** Every step under `root`, the root included (steps come parent first). */
function subtree(steps: readonly PlanStep[], root: PlanStep): PlanStep[] {
  const inside = new Set([root.id]);
  for (const step of steps) if (inside.has(step.parent)) inside.add(step.id);
  return steps.filter((step) => inside.has(step.id));
}

/** The base relations the plan scans whole under `root`, as `name<parent step>`. */
function baseTableScans(steps: readonly PlanStep[], root: PlanStep): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const bounded = new Set([
    "eligible_global_pass_snapshots",
    "ranked_global_pass_snapshots",
    "snapshot",
    "unit_policy",
  ]);
  return subtree(steps, root)
    .filter((step) => step.detail.startsWith("SCAN "))
    .map((step) => ({ step, name: step.detail.slice(5).split(" ")[0]! }))
    .filter(({ name }) => !bounded.has(name) && !/^\(subquery-\d+\)$/u.test(name))
    .map(({ step, name }) => `${name}<${byId.get(step.parent)?.detail}>`);
}

/** The step holding the GLOBAL PASS snapshot (the Transactions read's IN list). */
function globalPassRoot(steps: readonly PlanStep[]): PlanStep {
  const ranked = steps.find((step) =>
    /^(?:MATERIALIZE|CO-ROUTINE) ranked_global_pass_snapshots$/u.test(step.detail),
  );
  const root = steps.find((step) => step.id === ranked?.parent);
  if (root === undefined) throw new Error("the plan has no GLOBAL PASS snapshot");
  return root;
}

describe("GLOBAL PASS activity snapshots on the complete CORE schema without statistics", () => {
  let single: ScaledGlobalPassStore;
  let walked: ScaledGlobalPassStore;

  beforeAll(() => {
    const next = random(2026);
    // One page per month and run, as every stored run: 160 captures, two a
    // day (so captures share a time), a fifth of the pages unparsed.
    single = new ScaledGlobalPassStore();
    for (let capture = 0; capture < 160; capture += 1)
      single.capture(
        START_MS + Math.floor(capture / 2) * DAY_MS,
        MONTHS.filter(() => next() < 0.8).map((month) => ({ month, parsed: [next() > 0.2] })),
      );
    // Walked months: one to three pages, so a month grows and shrinks between
    // captures, and now and then a page of a capture is left unparsed.
    walked = new ScaledGlobalPassStore();
    for (let capture = 0; capture < 160; capture += 1)
      walked.capture(
        START_MS + Math.floor(capture / 2) * DAY_MS,
        MONTHS.filter(() => next() < 0.8).map((month) => ({
          month,
          parsed: Array.from({ length: 1 + Math.floor(next() * 3) }, () => next() > 0.1),
        })),
      );
  }, 60_000);

  test("the store is what D1 runs: no table statistics", () => {
    expect(
      single.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(single.pages.length).toBeGreaterThan(400);
    expect(walked.pages.length).toBeGreaterThan(800);
  });

  test("one page per month and run: exactly the per-key ranking's artifacts", () => {
    const chosen = single.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES);
    expect(chosen.length).toBe(MONTHS.length);
    expect(chosen).toEqual(single.current(FROZEN_PER_KEY_CTES));
    expect(chosen).toEqual(single.modelled());
  });

  test("walked months: the newest wholly parsed capture of each month, all its pages", () => {
    const chosen = walked.current(GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES);
    expect(chosen).toEqual(walked.modelled());
    // The store exercises the change: the per-key ranking keeps a page of an
    // older capture current beside a newer capture's page 1.
    expect(walked.current(FROZEN_PER_KEY_CTES)).not.toEqual(chosen);
  });

  test("the Transactions plan reads the artifacts once and each snapshot's pages by run", () => {
    const page = transactionsSql({}, 0);
    for (const db of [single.db, walked.db]) {
      const steps = explain(db, page.sql, page.args);
      const root = globalPassRoot(steps);
      // Computed once for the read, never per Transactions row.
      expect(root.detail.startsWith("CORRELATED ")).toBe(false);
      // One whole pass over the artifacts, for the eligible snapshots; the
      // expected-page count and the current pages are reached through the run.
      expect(baseTableScans(steps, root)).toEqual([
        "a<MATERIALIZE eligible_global_pass_snapshots>",
      ]);
      const byRun = subtree(steps, root).filter((step) =>
        /^SEARCH a USING (?:COVERING )?INDEX idx_fetch_artifacts_run_role \(fetch_run_id=\?/u.test(
          step.detail,
        ),
      );
      expect(byRun.length).toBeGreaterThanOrEqual(2);
    }
    // The shipped per-key ranking made the same single pass over the artifacts.
    const shipped = explain(
      single.db,
      `WITH ${FROZEN_PER_KEY_CTES} SELECT fetch_artifact_id FROM current_global_pass_snapshots`,
      [],
    );
    expect(
      shipped.filter((step) => /^SCAN a\b/u.test(step.detail)).map((step) => step.detail),
    ).toHaveLength(1);
  });
});
