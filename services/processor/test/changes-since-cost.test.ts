// What the "changes since a time" digest costs on D1 (ADR 0127), measured
// with workerd's own `rows_read` on the complete CORE schema: two stores hold
// the same recent activity over an older history of different sizes, both
// past every walk. The digest answers the same on both, and each query reads
// the same number of rows on both, so what it reads is bounded by its walks,
// not by the store. It also runs every query on D1 itself, whose limits (five
// terms in a compound SELECT) bun:sqlite does not have. Every value is
// synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Grant } from "../../../packages/application/src/index.ts";
import { readChangesSince } from "../../../packages/application/src/query/changes-since.ts";
import { ChangesWorld } from "../../../packages/application/test/changes-since-world.ts";
import {
  CHANGES_SINCE_EVENT_WALK,
  CHANGES_SINCE_PARSE_WALK,
  CHANGES_SINCE_RUN_WALK,
} from "../../../packages/domain/src/changes-since.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import { validChangesSince } from "../../../packages/observation-shared/src/changes-since-contract.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";

const NOW = "2099-03-02T00:00:00.000Z";
const SINCE_MS = Date.parse("2099-03-01T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const GRANT: Grant = {
  principal: "synthetic-owner",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

let mf: Miniflare;
beforeAll(() => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('local')}}",
      compatibilityDate: "2026-09-07",
      d1Databases: ["SMALL", "LARGE"],
    }),
  );
});
afterAll(async () => {
  await mf?.dispose();
});

/**
 * The world's statements: the registry and one old capture first, the recent
 * activity last. The older history is written between the two, so every
 * walk meets it in recording order.
 */
function world() {
  const changes = new ChangesWorld(1_000_000);
  const old = changes.run("vpass", SINCE_MS - 40 * 24 * HOUR, "success", 1);
  const split = changes.statements.length;
  for (const [index, source] of ["vpass", "myjcb", "sony-bank", "wise"].entries()) {
    const at = SINCE_MS + index * HOUR;
    const { artifacts } = changes.run(source, at, index === 3 ? "open" : "success", 2);
    changes.parse(artifacts[0]!, iso(at + 60_000), "published", { transaction: 3, balance: 1 });
    changes.parse(artifacts[1]!, iso(at + 120_000), "failed");
  }
  changes.parse(old.artifacts[0]!, iso(SINCE_MS + 5 * HOUR), "superseded", { position: 2 });
  changes.event("ev-recent", 1, "purchase", iso(SINCE_MS + 6 * HOUR));
  changes.event("ev-recent", 2, "purchase", iso(SINCE_MS + 7 * HOUR));
  return {
    before: changes.statements.slice(0, split),
    after: changes.statements.slice(split),
    oldArtifact: old.artifacts[0]!,
  };
}

/** `size` older runs, parse runs and event revisions, written in one statement each. */
function history(size: number, oldArtifact: number): string[] {
  const series = (count: number) =>
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
  const at = SINCE_MS - 30 * 24 * HOUR;
  return [
    `${series(size)} INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
     SELECT i,'collector-r2-importer','synthetic-changes','synthetic-history','history-'||i,${at}+i FROM n`,
    `${series(size)} INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
     SELECT i,i,'collector-r2-importer','vpass','synthetic-changes','default',${at}+i FROM n`,
    `${series(size * 10)} INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json)
     SELECT i,${oldArtifact},'history-parser','1.0.0',strftime('%Y-%m-%dT%H:%M:%fZ',(${at}+i)/1000.0,'unixepoch'),'error','synthetic_failure','[]' FROM n`,
    `${series(size * 4)} INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     SELECT 'dr_history_'||i,'relation','event:history-'||i,1,'accept','rule','rule:synthetic',NULL,'synthetic','[]',NULL,NULL,'2099-01-01T00:00:00.000Z' FROM n`,
    `${series(size * 4)} INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
     SELECT 'history-'||i,1,'purchase','captured',NULL,'{"kind":"local-date","value":"2099-01-01","zone":null,"basis":"provider"}','cash-movement',
      '[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]','dr_history_'||i,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ',(${at}+i)/1000.0,'unixepoch') FROM n`,
  ];
}

async function store(binding: string, size: number) {
  const db = await mf.getD1Database(binding);
  for (const file of migrationFiles(CORE_MIGRATIONS_URL)) {
    const statements = splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file));
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  const { before, after, oldArtifact } = world();
  const replay = async (statements: { sql: string; values: unknown[] }[]) => {
    for (let offset = 0; offset < statements.length; offset += 80)
      await db.batch(
        statements
          .slice(offset, offset + 80)
          .map(({ sql, values }) =>
            values.length ? db.prepare(sql).bind(...values) : db.prepare(sql),
          ),
      );
  };
  await replay(before);
  for (const sql of history(size, oldArtifact)) await db.prepare(sql).run();
  await replay(after);
  return db;
}

/** A D1 executor that keeps each statement's `rows_read`. */
function measured(db: D1Database, reads: number[]): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) => {
      const result = await db
        .prepare(text)
        .bind(...args)
        .all<T>();
      reads.push(result.meta.rows_read);
      return result.results;
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      const result = await db
        .prepare(text)
        .bind(...args)
        .all<T>();
      reads.push(result.meta.rows_read);
      return result.results[0] ?? null;
    },
  };
}

test("each query reads the same rows over a history three times larger, and answers the same", async () => {
  // Both histories pass every walk: runs of one source, parse runs, events.
  const small = Math.max(CHANGES_SINCE_RUN_WALK, CHANGES_SINCE_EVENT_WALK) + 100;
  expect(small * 10).toBeGreaterThan(CHANGES_SINCE_PARSE_WALK);
  const answers = [];
  const costs: number[][] = [];
  for (const [binding, size] of [
    ["SMALL", small],
    ["LARGE", small * 3],
  ] as const) {
    const db = await store(binding, size);
    const reads: number[] = [];
    const outcome = await readChangesSince({
      grant: GRANT,
      sql: measured(db, reads),
      served: { events: true },
      request: { since: iso(SINCE_MS) },
      now: NOW,
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(validChangesSince({ apiVersion: 2, ...outcome.answer })).toBe(true);
    answers.push(outcome.answer);
    costs.push(reads);
  }
  console.info("changes since: D1 rows_read per query", { small: costs[0], large: costs[1] });
  expect(answers[1]).toEqual(answers[0]!);
  expect(costs[1]).toEqual(costs[0]!);
  const answer = answers[0]!;
  expect(
    answer.sources.map((line) => [line.source, line.runs, line.parses, line.observations]),
  ).toEqual([
    ["myjcb", [1, 0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [3, 1, 0, 0]],
    ["sony-bank", [1, 0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [3, 1, 0, 0]],
    // The re-parse of the old capture is new; its successor is unadopted.
    ["vpass", [1, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 0], [3, 1, 2, 0]],
    ["wise", [0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0], [3, 1, 0, 0]],
  ]);
  expect(answer.sources.every((line) => line.cut.length === 0)).toBe(true);
  expect(answer.events).toMatchObject({ complete: true, new: [1, 0, 0, 0, 0, 0, 0, 0] });
}, 300_000);
