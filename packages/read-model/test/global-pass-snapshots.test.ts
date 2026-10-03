// GLOBAL PASS activity currentness (ADR 0026's amendment of 2026-10-04): a
// walked month is one snapshot of several page artifacts
// (`activity-YYYY-MM.html`, `activity-YYYY-MM-p2.html`, ...), and the newest
// run whose every page of that month has an active parse is the current one.
//
// Two proofs:
//  * on stores with one page per month and run (every run before the
//    collector walked pages), the snapshot selects exactly what the shipped
//    per-key ranking selected, frozen below, on hand-built and random stores;
//  * on walked months, a page a newer run no longer shows stops being current
//    with its month, and a month whose newer pages are not all parsed keeps
//    its older complete snapshot.
// Everything is synthetic: placeholder rows on a minimal CORE store.
import { describe, expect, test } from "bun:test";
import { CardStore } from "./card-usage-fixture";
import { activeStateProjection } from "../src/index";
import { GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES } from "../src/sql";

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
  /** One page artifact; `parsed` publishes an `ok` parse with one placeholder row. */
  page(run: number, key: string, fetchedAt: string, parsed = true): number {
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
