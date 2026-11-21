// `publicationMarks`: the newest publication event, the number of runs
// excluded from financial views and the dataset policy columns the lists
// read, over every source or over listed sources only. The agent context pins
// them in its publication marker (ADR 0091 amendment of 2026-11-21), so they
// must move with a listed source's publication, exclusion or policy update and
// never with an unlisted source's (SC18).
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
    expect(await reader.publicationMarks(["smbc-bank", "vpass", "smbc-bank"])).toMatchObject({
      publicationEvent: excluded.bank.publicationEvent,
      exclusions: excluded.bank.exclusions + excluded.vpass.exclusions,
    });
  });

  test("move with a listed source's policy update, never with another source's", async () => {
    const { store } = baseWorld();
    const reader = createObservationReader(recording(store.db));
    const marks = async () => ({
      all: await reader.publicationMarks(null),
      vpass: await reader.publicationMarks(["vpass"]),
      bank: await reader.publicationMarks(["smbc-bank"]),
    });
    const before = await marks();
    // The seeded smbc-bank row is one of the listed source's policies.
    expect(before.bank.snapshotPolicies).toContain('"smbc-bank"');
    expect(before.vpass.snapshotPolicies).not.toContain('"smbc-bank"');
    // The operator step of docs/parser-coverage.md: an in-place update that
    // records no parse run, no publication event and no exclusion.
    store.db.run(
      `UPDATE dataset_snapshot_policies SET unit_scope=CASE unit_scope WHEN 'unit' THEN 'run' ELSE 'unit' END
        WHERE source_id='smbc-bank' AND dataset='balance-normalized'`,
    );
    const after = await marks();
    expect(after.bank).toMatchObject({
      publicationEvent: before.bank.publicationEvent,
      exclusions: before.bank.exclusions,
    });
    expect(after.bank.snapshotPolicies).not.toBe(before.bank.snapshotPolicies);
    expect(after.all.snapshotPolicies).not.toBe(before.all.snapshotPolicies);
    expect(after.vpass).toEqual(before.vpass);
    // A column the lists do not read moves nothing.
    store.db.run("UPDATE dataset_snapshot_policies SET updated_at_ms=updated_at_ms+1");
    expect(await marks()).toEqual(after);
  });

  // Every policy column the snapshot CTEs or the unit eligibility predicate
  // read (packages/parsers/src/snapshot-query.ts) moves the listed mark; the
  // two they do not read move nothing, so an operator's bookkeeping update
  // does not make an earlier cursor stale.
  const POLICY_COLUMNS: readonly (readonly [string, string, boolean])[] = [
    ["source_id", "source_id || '-renamed'", true],
    ["parser_name", "parser_name || '-renamed'", true],
    ["dataset", "dataset || '-renamed'", true],
    [
      "policy_id",
      "CASE policy_id WHEN 'coverage-v1' THEN 'legacy-warning-compat-v1' ELSE 'coverage-v1' END",
      true,
    ],
    ["required_parser_version", "coalesce(required_parser_version, '') || '9'", true],
    ["replaces_previous_on_complete_empty", "1 - replaces_previous_on_complete_empty", true],
    ["unit_scope", "CASE unit_scope WHEN 'unit' THEN 'run' ELSE 'unit' END", true],
    ["snapshot_selection", "1 - snapshot_selection", true],
    ["policy_version", "policy_version + 1", false],
    ["updated_at_ms", "updated_at_ms + 1", false],
  ];
  test("classify every policy column as read or not read", () => {
    // A column a later migration adds must be placed in the list above.
    const { store } = baseWorld();
    const columns = store.db
      .query("SELECT name FROM pragma_table_info('dataset_snapshot_policies')")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name).sort()).toEqual(
      POLICY_COLUMNS.map(([column]) => column).sort(),
    );
  });
  for (const [column, next, read] of POLICY_COLUMNS)
    test(`${read ? "move" : "hold"} when a policy row's ${column} changes`, async () => {
      const { store } = baseWorld();
      const reader = createObservationReader(recording(store.db));
      const before = await reader.publicationMarks(["smbc-bank"]);
      store.db.run(
        `UPDATE dataset_snapshot_policies SET ${column}=${next}
          WHERE source_id='smbc-bank' AND dataset='balance-normalized'`,
      );
      const after = await reader.publicationMarks(["smbc-bank"]);
      if (read) expect(after.snapshotPolicies).not.toBe(before.snapshotPolicies);
      else expect(after).toEqual(before);
    });

  test("reads nothing for an empty list and binds a repeated source once", async () => {
    const { store } = baseWorld();
    const executor = recording(store.db);
    const reader = createObservationReader(executor);
    expect(await reader.publicationMarks([])).toEqual({
      publicationEvent: 0,
      exclusions: 0,
      snapshotPolicies: "[]",
    });
    expect(executor.binds).toEqual([]);
    await reader.publicationMarks(["vpass", "myjcb", "vpass"]);
    expect(executor.binds).toEqual([['["myjcb","vpass"]']]);
    await reader.publicationMarks(null);
    expect(executor.binds.at(-1)).toEqual([]);
  });
});
