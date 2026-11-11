import { beforeAll, expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "../../read-model/test/collection-quality-fixture";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture";
import type { SqlExecutor } from "../../read-model/src/reader";
import {
  CollectionQualityLimitError,
  queryAccountCoverage,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../src/query/collection-quality";

beforeAll(() => fullCoreSchema().close(), 60_000);
const AS_OF = "2099-01-10T00:00:00.000Z";
const NOMINAL = "2099-01-02T21:15:00.000Z";
const FINISHED = "2099-01-02T21:17:00.000Z";
const executor = (store: QualityStore): SqlExecutor => ({
  all: async <T>(sql: string, args: readonly unknown[]) =>
    store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
  first: async <T>(sql: string, args: readonly unknown[]) =>
    (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
});

test.each([
  [
    "older success after nominal but before actual failure",
    "2099-01-02T21:16:30.000Z",
    "success",
    true,
  ],
  ["equal time", FINISHED, "success", true],
  ["later failure", "2099-01-02T21:18:00.000Z", "failed", true],
  ["later partial run", "2099-01-02T21:18:00.000Z", "partial", true],
  ["later registered success", "2099-01-02T21:18:00.000Z", "success", false],
] as const)("current V Point recovery: %s", async (_label, at, outcome, unresolved) => {
  const store = new QualityStore();
  try {
    store.occurrence("vpoint", {
      nominalAt: NOMINAL,
      startedAt: "2099-01-02T21:16:00.000Z",
      finishedAt: FINISHED,
      status: "failed",
      failureCode: "reauthentication_pending",
      runIds: ["expired-run"],
    });
    store.run({ source: "v-point", at, outcome, artifacts: [] });
    const source = (
      await queryCollectionQualitySummary(executor(store), { asOf: AS_OF })
    ).sources.find((entry) => entry.sourceId === "v-point")!;
    expect(source.reasons.includes("user_action_required")).toBe(unresolved);
    expect(source.freshness.state).toBe(unresolved ? "human-required" : "stale");
    expect(source.schedules[0]!.latest).toMatchObject({
      status: "failed",
      failureCode: "reauthentication_pending",
      finishedAt: FINISHED,
    });
    expect(source.reasons).toContain("occurrence_failed");
    expect(
      store.db
        .query(
          "SELECT status, failure_code FROM collection_schedule_occurrences WHERE schedule_id = 'vpoint'",
        )
        .get(),
    ).toEqual({
      status: "failed",
      failure_code: "reauthentication_pending",
    });
  } finally {
    store.db.close();
  }
});

test.each([null, "not-an-instant"])(
  "missing or invalid actual failure time %p cannot establish recovery",
  async (time) => {
    const store = new QualityStore();
    try {
      store.occurrence("vpoint", {
        nominalAt: NOMINAL,
        status: "failed",
        failureCode: "reauthentication_pending",
      });
      store.run({ source: "v-point", at: "2099-01-02T21:18:00.000Z", artifacts: [] });
      const real = executor(store);
      // Simulate an older/invalid read record without weakening CORE's NOT NULL constraint.
      const input: SqlExecutor = {
        ...real,
        all: async <T>(sql: string, args: readonly unknown[]) => {
          const rows = await real.all<Record<string, unknown>>(sql, args);
          return rows.map((row) =>
            row.id === "vpoint"
              ? {
                  ...row,
                  occurrence_started_at: time,
                  occurrence_finished_at: time,
                }
              : row,
          ) as T[];
        },
      };
      const source = (await queryCollectionQualitySummary(input, { asOf: AS_OF })).sources.find(
        (entry) => entry.sourceId === "v-point",
      )!;
      expect(source.reasons).toContain("user_action_required");
    } finally {
      store.db.close();
    }
  },
);

test("a newer refused attempt is not cleared by yesterday's successful recovery", async () => {
  const store = new QualityStore();
  try {
    store.run({ source: "v-point", at: "2099-01-02T21:18:00.000Z", artifacts: [] });
    store.occurrence("vpoint", {
      nominalAt: "2099-01-03T21:15:00.000Z",
      status: "failed",
      failureCode: "human_required_session_refresh",
    });
    const source = (
      await queryCollectionQualitySummary(executor(store), { asOf: AS_OF })
    ).sources.find((entry) => entry.sourceId === "v-point")!;
    expect(source.reasons).toContain("user_action_required");
    expect(source.freshness.state).toBe("human-required");
  } finally {
    store.db.close();
  }
});

test("V Point Pay and unrelated authentication codes retain their own meaning", async () => {
  const store = new QualityStore();
  try {
    for (const id of ["vpoint-pay", "vpass"])
      store.occurrence(id, {
        nominalAt: NOMINAL,
        status: "failed",
        failureCode: "reauthentication_pending",
      });
    store.occurrence("vpoint", {
      nominalAt: NOMINAL,
      status: "failed",
      failureCode: "authentication_required",
    });
    const summary = await queryCollectionQualitySummary(executor(store), { asOf: AS_OF });
    for (const id of ["v-point-pay", "vpass", "v-point"])
      expect(summary.sources.find((entry) => entry.sourceId === id)!.reasons).not.toContain(
        "user_action_required",
      );
  } finally {
    store.db.close();
  }
});

test("the V Point cells and account reads enforce the shared 200-job bound", async () => {
  const store = new QualityStore();
  try {
    const count = store.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM collection_schedules",
    )[0]!.count;
    const add = (index: number) =>
      store.db.run(
        `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
       VALUES(?,NULL,'processor',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
        [`synthetic-${index}`],
      );
    for (let index = count; index < 200; index += 1) add(index);
    expect(
      await queryCollectionQualityCells(executor(store), {
        sourceId: "v-point",
        offset: 0,
        asOf: AS_OF,
      }),
    ).not.toBeNull();
    expect(
      await queryAccountCoverage(executor(store), { sourceId: "v-point", asOf: AS_OF }),
    ).not.toBeNull();
    add(200);
    await expect(
      queryCollectionQualityCells(executor(store), { sourceId: "v-point", offset: 0, asOf: AS_OF }),
    ).rejects.toBeInstanceOf(CollectionQualityLimitError);
    await expect(
      queryAccountCoverage(executor(store), { sourceId: "v-point", asOf: AS_OF }),
    ).rejects.toBeInstanceOf(CollectionQualityLimitError);
  } finally {
    store.db.close();
  }
});

test("an unregistered successful terminal alone does not clear an expired session", async () => {
  const store = new QualityStore();
  try {
    store.occurrence("vpoint", {
      nominalAt: NOMINAL,
      status: "failed",
      failureCode: "reauthentication_pending",
    });
    store.terminal({
      source: "v-point",
      runId: "unregistered-followup",
      outcome: "success",
      seenAt: "2099-01-02T21:18:00.000Z",
    });
    const source = (
      await queryCollectionQualitySummary(executor(store), { asOf: AS_OF })
    ).sources.find((entry) => entry.sourceId === "v-point")!;
    expect(source.latestFetchRun).toBeNull();
    expect(source.reasons).toContain("user_action_required");
    expect(source.reasons).toContain("unregistered_terminals");
  } finally {
    store.db.close();
  }
});
