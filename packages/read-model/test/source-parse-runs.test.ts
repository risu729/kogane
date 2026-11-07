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

function recording(db: Database): SqlExecutor & { binds: (readonly unknown[])[] } {
  const binds: (readonly unknown[])[] = [];
  return {
    binds,
    all: async <T>(text: string, args: readonly unknown[]) => {
      binds.push(args);
      return db.query(text).all(...(args as never[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      binds.push(args);
      return (db.query(text).get(...(args as never[])) as T | null) ?? null;
    },
  };
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
    expect(executor.binds).toEqual([]);
    expect(await reader.sourceParseRuns(["vpass", "myjcb", "vpass"])).toEqual(
      legacyScopedParseRuns(store.db, ["myjcb", "vpass"]) as never,
    );
    expect(executor.binds).toEqual([['["myjcb","vpass"]']]);
  });

  test("filters by source before the window, so newer runs of an unlisted source never crowd it out", async () => {
    const { store } = baseWorld();
    const reader = createObservationReader(recording(store.db));
    const vpass = await reader.sourceParseRuns(["vpass"]);
    expect(vpass.length).toBeGreaterThan(0);
    const run = store.run("smbc-bank");
    for (let index = 0; index <= PAGE_LIMIT; index += 1)
      store.bankRow(run, `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`);
    const overview = await reader.overview();
    expect(overview.parseRuns.some((row) => vpass.some((own) => own.id === row.id))).toBe(false);
    expect(await reader.sourceParseRuns(["vpass"])).toEqual(vpass);
    expect(await reader.sourceParseRuns(["vpass"])).toEqual(
      legacyScopedParseRuns(store.db, ["vpass"]) as never,
    );
  });
});
