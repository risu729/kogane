// `publicationMarks`: the newest publication event and the number of runs
// excluded from financial views, over every source or over listed sources
// only. The agent context pins them in its publication marker (ADR 0091
// amendment of 2026-11-21), so they must move with a listed source's
// publication or exclusion and never with an unlisted source's (SC18).
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createObservationReader, type SqlExecutor } from "../src/index";
import { baseWorld, migrated } from "./card-usage-fixture";

beforeAll(() => {
  migrated().close();
}, 60_000);

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

describe("publication marks", () => {
  test("move with a listed source's publication and exclusion, never with another source's", async () => {
    const { store } = baseWorld();
    const reader = createObservationReader(recording(store.db));
    const before = {
      all: await reader.publicationMarks(null),
      vpass: await reader.publicationMarks(["vpass"]),
      bank: await reader.publicationMarks(["smbc-bank"]),
    };
    expect(before.all.publicationEvent).toBeGreaterThan(0);
    expect(before.vpass.publicationEvent).toBeGreaterThan(0);

    const run = store.run("smbc-bank");
    store.bankRow(run, "2026-08-01T00:00:00.000Z");
    const published = {
      all: await reader.publicationMarks(null),
      vpass: await reader.publicationMarks(["vpass"]),
      bank: await reader.publicationMarks(["smbc-bank"]),
    };
    expect(published.all.publicationEvent).toBeGreaterThan(before.all.publicationEvent);
    expect(published.bank.publicationEvent).toBe(published.all.publicationEvent);
    expect(published.vpass).toEqual(before.vpass);

    // The fixture's Layer A stub keeps only the two columns the views read.
    store.db.run(
      "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind) VALUES(?,'exclude_from_financial_views')",
      [run],
    );
    const excluded = {
      all: await reader.publicationMarks(null),
      vpass: await reader.publicationMarks(["vpass"]),
      bank: await reader.publicationMarks(["smbc-bank"]),
    };
    expect(excluded.all.exclusions).toBe(published.all.exclusions + 1);
    expect(excluded.bank.exclusions).toBe(published.bank.exclusions + 1);
    expect(excluded.vpass).toEqual(before.vpass);
    // Both lists together are the sum of their exclusions and the newer event.
    expect(await reader.publicationMarks(["smbc-bank", "vpass", "smbc-bank"])).toEqual({
      publicationEvent: excluded.bank.publicationEvent,
      exclusions: excluded.bank.exclusions + excluded.vpass.exclusions,
    });
  });

  test("reads nothing for an empty list and binds a repeated source once", async () => {
    const { store } = baseWorld();
    const executor = recording(store.db);
    const reader = createObservationReader(executor);
    expect(await reader.publicationMarks([])).toEqual({ publicationEvent: 0, exclusions: 0 });
    expect(executor.binds).toEqual([]);
    await reader.publicationMarks(["vpass", "myjcb", "vpass"]);
    expect(executor.binds).toEqual([['["myjcb","vpass"]']]);
    await reader.publicationMarks(null);
    expect(executor.binds.at(-1)).toEqual([]);
  });
});
