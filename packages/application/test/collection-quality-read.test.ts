// The collection quality reads under a grant (ADR 0081): the one service each
// page route and its agent read share. Grant, perimeter, store, request and
// bound are graded there, in a fixed order, and each refusal is one closed
// code. Synthetic complete-CORE stores; every key, run id and time is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import {
  COLLECTION_QUALITY_TABLES,
  COLLECTION_QUALITY_TABLES_SQL,
} from "../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import type { Grant } from "../src/grants.ts";
import {
  COLLECTION_QUALITY_MAX_OFFSET,
  collectionQualityServed,
  queryAccountCoverage,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
  readAccountCoverageForGrant,
  readCollectionQualityCellsForGrant,
  readCollectionQualitySummaryForGrant,
} from "../src/query/collection-quality.ts";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

const WHOLE: Grant = {
  principal: "synthetic-agent",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["evidence.read"],
  budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
};

/** The store, counting every statement it answers. */
function counted(store: QualityStore): SqlExecutor & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    all: async <T>(sql: string, args: readonly unknown[]) => {
      statements.push(sql);
      return store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(sql: string, args: readonly unknown[]) => {
      statements.push(sql);
      return (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
}

/** A store before CORE 0065, as the table check sees it. */
function unscheduled(sql: SqlExecutor): SqlExecutor {
  return {
    all: (text, args) => sql.all(text, args),
    first: async <T>(text: string, args: readonly unknown[]) =>
      text === COLLECTION_QUALITY_TABLES_SQL
        ? ({ present: COLLECTION_QUALITY_TABLES.length - 1 } as T)
        : sql.first<T>(text, args),
  };
}

type Read = (grant: Grant, sql: SqlExecutor, request: unknown) => Promise<unknown>;
const READS: Record<string, Read> = {
  "collection-quality.summary": (grant, sql, request) =>
    readCollectionQualitySummaryForGrant({ grant, sql, request }),
  "collection-quality.cells": (grant, sql, request) =>
    readCollectionQualityCellsForGrant({ grant, sql, request }),
  "collection-quality.accounts": (grant, sql, request) =>
    readAccountCoverageForGrant({ grant, sql, request }),
};
const VALID: Record<string, unknown> = {
  "collection-quality.summary": {},
  "collection-quality.cells": { source: "vpass" },
  "collection-quality.accounts": { source: "vpass" },
};

let store: QualityStore;
beforeAll(() => {
  store = new QualityStore();
  const run = store.run({
    source: "vpass",
    at: "2099-02-01T00:00:00Z",
    units: { "card-a": { outcome: "success" } },
    artifacts: [{ key: "months/209901/top-001.json", dataset: "statement-page", unit: "card-a" }],
  });
  store.parse(run.artifacts[0]!, "vpass-statement-page", { kind: "published" });
});

describe("the table check", () => {
  test("names exactly the tables the reads join, and a complete store has them", async () => {
    for (const table of COLLECTION_QUALITY_TABLES)
      expect(COLLECTION_QUALITY_TABLES_SQL).toContain(`'${table}'`);
    expect(COLLECTION_QUALITY_TABLES_SQL.match(/'[a-z_]+'/gu)).toHaveLength(
      COLLECTION_QUALITY_TABLES.length + 1,
    );
    expect(await collectionQualityServed(counted(store))).toBe(true);
    expect(await collectionQualityServed(unscheduled(counted(store)))).toBe(false);
  });
});

describe("every read grades the grant, then the store, before its request", () => {
  for (const [name, read] of Object.entries(READS)) {
    test(name, async () => {
      for (const [grant, code, refs] of [
        [
          { ...WHOLE, capabilities: ["summary.read", "records.read"] },
          "unauthorized",
          ["capability:evidence.read"],
        ],
        [
          { ...WHOLE, scopes: { sources: ["vpass"], accounts: "*" } },
          "evidence_restricted",
          ["scope:source"],
        ],
        [
          { ...WHOLE, scopes: { sources: "*", accounts: ["synthetic"] } },
          "evidence_restricted",
          ["scope:account"],
        ],
        [
          { ...WHOLE, scopes: { sources: ["vpass"], accounts: ["synthetic"] } },
          "evidence_restricted",
          ["scope:source", "scope:account"],
        ],
      ] as const) {
        const sql = counted(store);
        // Even a malformed request: authority is decided first, before any statement.
        expect(await read(grant as Grant, sql, { source: "Bad_Source", extra: 1 })).toMatchObject({
          ok: false,
          error: { code, refs, requestId: name },
        });
        expect(sql.statements).toEqual([]);
      }
      // A store without the scheduling tables: the table check (answered by
      // `unscheduled`), then the refusal, even for a request refused otherwise.
      const sql = counted(store);
      expect(await read(WHOLE, unscheduled(sql), { source: "Bad_Source", extra: 1 })).toMatchObject(
        {
          ok: false,
          refusal: "unavailable",
          error: { code: "unsupported_semantics", refs: ["store:collection-scheduling"] },
        },
      );
      expect(sql.statements).toEqual([]);
      // A request with a key the read does not take.
      expect(
        await read(WHOLE, counted(store), { ...(VALID[name] as object), extra: 1 }),
      ).toMatchObject({
        ok: false,
        refusal: "invalid_query",
        error: { code: "unsupported_semantics", refs: ["query"] },
      });
    });
  }
});

describe("the summary", () => {
  test("is the summary query's answer, takes no key, and overlays only matching alarms", async () => {
    const expected = await queryCollectionQualitySummary(counted(store));
    const plain = await readCollectionQualitySummaryForGrant({ grant: WHOLE, sql: counted(store) });
    expect(plain).toEqual({ ok: true, value: expected });
    expect(validApiResponse("/api/collection-quality", plain.ok && plain.value)).toBe(true);
    for (const request of [null, [], "x", { query: true }])
      expect(
        await readCollectionQualitySummaryForGrant({ grant: WHOLE, sql: counted(store), request }),
      ).toMatchObject({ ok: false, refusal: "invalid_query" });
    const jobs = expected.sources.flatMap((source) => source.schedules);
    const alarms = jobs.map((job) => ({
      id: job.id,
      enabled: job.enabled,
      nextNominalAt: job.nextNominalAt,
      nextRunAt: job.nextRunAt,
      alarm: { status: "observed", actualAt: null },
    }));
    // One job's stored setting no longer matches the reply: it stays unavailable.
    alarms[0]!.enabled = !alarms[0]!.enabled;
    const overlaid = await readCollectionQualitySummaryForGrant({
      grant: WHOLE,
      sql: counted(store),
      alarms: async () => ({ alarms }),
    });
    const statuses = overlaid.ok
      ? overlaid.value.sources.flatMap((source) => source.schedules.map((job) => job.alarm.status))
      : [];
    expect(statuses[0]).toBe("unavailable");
    expect(statuses.slice(1).every((status) => status === "observed")).toBe(true);
    expect(statuses.length).toBe(jobs.length);
    for (const relay of [
      async () => {
        throw new Error("synthetic relay failure");
      },
      async () => ({ alarms, unexpected: true }),
      async () => null,
    ])
      expect(
        await readCollectionQualitySummaryForGrant({
          grant: WHOLE,
          sql: counted(store),
          alarms: relay,
        }),
      ).toEqual({ ok: true, value: expected });
  });

  test("more jobs than the bound is budget_exceeded, never a cut answer", async () => {
    const crowded = new QualityStore();
    for (let index = 0; index < 200; index += 1)
      crowded.db.run(
        `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
         VALUES(?,NULL,'processor',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
        [`synthetic-${index}`],
      );
    let relayed = 0;
    expect(
      await readCollectionQualitySummaryForGrant({
        grant: WHOLE,
        sql: counted(crowded),
        alarms: async () => {
          relayed += 1;
          return { alarms: [] };
        },
      }),
    ).toMatchObject({
      ok: false,
      refusal: "limit_exceeded",
      error: { code: "budget_exceeded", refs: ["budget:jobs=200", "budget:sources=200"] },
    });
    // The relay is not asked for a summary that is refused.
    expect(relayed).toBe(0);
  });
});

describe("the cells", () => {
  test("is the cell query's page; source, keys, offset and visibility are refused in that order", async () => {
    const expected = await queryCollectionQualityCells(counted(store), {
      sourceId: "vpass",
      offset: 0,
    });
    expect(expected!.cells).toHaveLength(1);
    expect(
      await readCollectionQualityCellsForGrant({
        grant: WHOLE,
        sql: counted(store),
        request: { source: "vpass" },
      }),
    ).toEqual({ ok: true, value: expected! });
    expect(
      await readCollectionQualityCellsForGrant({
        grant: WHOLE,
        sql: counted(store),
        request: { source: "vpass", offset: 500 },
      }),
    ).toEqual({
      ok: true,
      value: (await queryCollectionQualityCells(counted(store), { sourceId: "vpass", offset: 500 }))!,
    });
    // [request, refusal, code, refs, statements run: the table check, then the source's row]
    for (const [request, refusal, code, refs, statements] of [
      [undefined, "unknown_source", "invalid_query", ["source"], 1],
      [{}, "unknown_source", "invalid_query", ["source"], 1],
      [{ source: 7 }, "unknown_source", "invalid_query", ["source"], 1],
      [
        { source: "Bad_Source", offset: -1, extra: 1 },
        "unknown_source",
        "invalid_query",
        ["source"],
        1,
      ],
      [{ source: "vpass/extra" }, "unknown_source", "invalid_query", ["source"], 1],
      [
        { source: "vpass", offset: -1, extra: 1 },
        "invalid_query",
        "unsupported_semantics",
        ["query"],
        1,
      ],
      [{ source: "vpass", offset: -1 }, "invalid_offset", "invalid_query", ["offset"], 1],
      [{ source: "vpass", offset: 1.5 }, "invalid_offset", "invalid_query", ["offset"], 1],
      [{ source: "vpass", offset: "01" }, "invalid_offset", "invalid_query", ["offset"], 1],
      [{ source: "vpass", offset: null }, "invalid_offset", "invalid_query", ["offset"], 1],
      [
        { source: "vpass", offset: COLLECTION_QUALITY_MAX_OFFSET + 1 },
        "invalid_offset",
        "invalid_query",
        ["offset"],
        1,
      ],
      [{ source: "no-such-source" }, "unknown_source", "invalid_query", ["source"], 2],
      [{ source: "kogane-synthetic" }, "unknown_source", "invalid_query", ["source"], 2],
    ] as const) {
      const sql = counted(store);
      const outcome = await readCollectionQualityCellsForGrant({ grant: WHOLE, sql, request });
      expect(outcome, JSON.stringify(request)).toMatchObject({
        ok: false,
        refusal,
        error: { code, refs, requestId: "collection-quality.cells" },
      });
      expect(sql.statements, JSON.stringify(request)).toHaveLength(statements);
      expect(sql.statements[0]).toBe(COLLECTION_QUALITY_TABLES_SQL);
    }
    expect(
      await readCollectionQualityCellsForGrant({
        grant: WHOLE,
        sql: counted(store),
        request: { source: "vpass", offset: COLLECTION_QUALITY_MAX_OFFSET },
      }),
    ).toMatchObject({ ok: true, value: { cells: [] } });
  });
});

describe("the accounts", () => {
  test("is the account query's answer under the same gate", async () => {
    const expected = await queryAccountCoverage(counted(store), { sourceId: "vpass" });
    expect(
      await readAccountCoverageForGrant({
        grant: WHOLE,
        sql: counted(store),
        request: { source: "vpass" },
      }),
    ).toEqual({ ok: true, value: expected! });
    expect(
      await readAccountCoverageForGrant({
        grant: WHOLE,
        sql: counted(store),
        request: { source: "vpass", offset: 0 },
      }),
    ).toMatchObject({ ok: false, refusal: "invalid_query" });
    expect(
      await readAccountCoverageForGrant({
        grant: WHOLE,
        sql: counted(store),
        request: { source: "Bad", offset: 0 },
      }),
    ).toMatchObject({ ok: false, refusal: "unknown_source" });
  });
});
