// `sourceParseRuns` against the read the agent service ran itself before ADR
// 0081 moved it here (services/app/src/agent-service.ts `scopedParseRuns`,
// frozen below): the overview's parse-run window over the listed sources
// only. On the shared card scenario both give the same rows for every scope.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createObservationReader,
  PAGE_LIMIT,
  type SqlExecutor,
  visibleEvidence,
} from "../src/index";
import { baseWorld, migrated } from "./card-usage-fixture";

beforeAll(() => {
  migrated().close();
}, 60_000);

/** `scopedParseRuns` as services/app shipped it; never edit by hand. */
function legacyScopedParseRuns(db: Database, sources: readonly string[]): unknown[] {
  if (sources.length === 0) return [];
  const placeholders = sources.map(() => "?").join(",");
  return db
    .query(
      `SELECT p.id, p.parser_name, p.parser_version
         FROM ${visibleEvidence.parseRuns} p
         JOIN observation_fetch_artifacts a ON a.id = p.fetch_artifact_id
        WHERE a.source_id IN (${placeholders})
        ORDER BY p.id DESC LIMIT ${String(PAGE_LIMIT)}`,
    )
    .all(...(sources as string[]));
}

function recording(db: Database): SqlExecutor & { statements: number } {
  const executor = {
    statements: 0,
    all: async <T>(text: string, args: readonly unknown[]) => {
      executor.statements += 1;
      return db.query(text).all(...(args as never[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      executor.statements += 1;
      return (db.query(text).get(...(args as never[])) as T | null) ?? null;
    },
  };
  return executor;
}

describe("the scoped parse-run window", () => {
  test("matches the agent service's former read for every scope", async () => {
    const { store } = baseWorld();
    const reader = createObservationReader(recording(store.db));
    const scopes = [["vpass"], ["myjcb"], ["smbc-bank"], ["myjcb", "vpass"], ["unknown"]];
    let seen = 0;
    for (const scope of scopes) {
      const rows = await reader.sourceParseRuns(scope);
      expect(rows).toEqual(legacyScopedParseRuns(store.db, scope) as never);
      seen += rows.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("reads nothing for an empty list and binds a repeated source once", async () => {
    const { store } = baseWorld();
    const executor = recording(store.db);
    const reader = createObservationReader(executor);
    expect(await reader.sourceParseRuns([])).toEqual([]);
    expect(executor.statements).toBe(0);
    expect(await reader.sourceParseRuns(["vpass", "vpass"])).toEqual(
      legacyScopedParseRuns(store.db, ["vpass"]) as never,
    );
  });
});
