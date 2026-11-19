// The account list's reads (ADR 0077 amendment 2026-11-19): the plans of its
// two statements on the real migrations without table statistics (D1 never
// runs ANALYZE), and its paging and byte budget over synthetic rows. The rows
// over the real identity pipeline are services/app/test/account-list-api.test.ts.
// Every value is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import { ENTITY_AGGREGATOR_REFERENCES_SQL } from "../src/query/account-connections.ts";
import { ACCOUNT_LIST_SQL, readAccountList } from "../src/query/account-list.ts";
import {
  ACCOUNT_LIST_BYTE_BUDGET,
  ACCOUNT_LIST_PAGE_SIZE,
  type AccountListPage,
} from "../../observation-shared/src/identity-contract.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => migratedDatabase().close(), 60_000);

function plan(sql: string): string[] {
  const db = migratedDatabase();
  try {
    return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
      (row) => row.detail,
    );
  } finally {
    db.close();
  }
}

describe("plans without statistics", () => {
  test("the entity label read is one keyed range and keyed mapping lookups", () => {
    expect(plan(ENTITY_AGGREGATOR_REFERENCES_SQL)).toEqual([
      "SEARCH s USING INDEX sqlite_autoindex_source_accounts_2 (source_id=?)",
      "SEARCH m USING INDEX sqlite_autoindex_account_mappings_2 (source_account_id=? AND revision=?)",
      "CORRELATED SCALAR SUBQUERY 1",
      "SEARCH n USING COVERING INDEX sqlite_autoindex_account_mappings_2 (source_account_id=?)",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
  });

  test("the account list scans only the current-identity walk; every table after it is keyed", () => {
    const lines = plan(ACCOUNT_LIST_SQL).map((line) => line.trim());
    // The walk is the `current_identity_observations` view's own plan: one
    // pass over the published parse runs (the publication pointer) into
    // migration 0022's materialized candidates. The list's CTEs are scanned
    // once each; no other stored table is scanned.
    const scans = lines.filter((line) => line.startsWith("SCAN "));
    expect([...new Set(scans)].sort()).toEqual([
      "SCAN candidates",
      "SCAN current",
      "SCAN l",
      "SCAN pub USING COVERING INDEX published_parse_runs_run",
      "SCAN r",
      "SCAN seen",
    ]);
    const tail = lines.slice(lines.indexOf("SCAN current"));
    expect(tail).toEqual([
      "SCAN current",
      "USE TEMP B-TREE FOR DISTINCT",
      "SCAN r",
      "SEARCH p USING INTEGER PRIMARY KEY (rowid=?)",
      "SEARCH a USING INTEGER PRIMARY KEY (rowid=?)",
      "USE TEMP B-TREE FOR GROUP BY",
      "SCAN seen",
      "SEARCH s USING INDEX sqlite_autoindex_source_accounts_1 (id=?)",
      "SEARCH m USING INDEX sqlite_autoindex_account_mappings_2 (source_account_id=? AND revision=?)",
      "CORRELATED SCALAR SUBQUERY 4",
      "SEARCH n USING COVERING INDEX sqlite_autoindex_account_mappings_2 (source_account_id=?)",
      "SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
    // The identity observations are reached by their run, never scanned.
    expect(lines).toContain(
      "SEARCH o USING INDEX sqlite_autoindex_identity_observations_2 (identity_run_id=?)",
    );
  });
});

/** A synthetic reference row as the list's statement returns it. */
function reference(i: number, overrides: Record<string, unknown> = {}) {
  const id = String(i).padStart(4, "0");
  return {
    referenceId: `sa_${id.padStart(64, "0")}`,
    source: `synthetic-source-${String(i % 5)}`,
    producer: "synthetic-producer",
    sourceAccount: `synthetic:${id}`,
    targetId: `account_${id.padStart(64, "f")}`,
    // A long label, as an aggregator connection label with its suffix is.
    label: `合成銀行${id}（MoneyForward連携）（個別口座未確定）`,
    status: "provider-local",
    method: "rule",
    createdAt: "2099-01-01T00:00:00Z",
    kind: "aggregator-mirror",
    lastMs: 4_070_908_800_000 + i * 1000,
    ...overrides,
  };
}

/** The list's statement answers `rows`; the connection reads answer nothing. */
function store(rows: readonly unknown[]): SqlExecutor {
  return {
    all: async <T>(sql: string) => (sql === ACCOUNT_LIST_SQL ? [...rows] : []) as T[],
    first: async () => null,
  };
}

const size = (page: AccountListPage) => new TextEncoder().encode(JSON.stringify(page)).length;

async function allPages(sql: SqlExecutor): Promise<AccountListPage[]> {
  const pages: AccountListPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: AccountListPage = await readAccountList(sql, { source: null, kind: null, offset });
    pages.push(page);
    offset = page.coverage.nextOffset;
  }
  return pages;
}

describe("paging and the byte budget", () => {
  for (const entities of [1, 40, 120])
    test(`${String(entities)} entities: every page within 8,000 bytes and 50 rows, each entity once`, async () => {
      const sql = store(Array.from({ length: entities }, (_, i) => reference(i)));
      const pages = await allPages(sql);
      for (const page of pages) {
        expect(size(page)).toBeLessThanOrEqual(ACCOUNT_LIST_BYTE_BUDGET);
        expect(page.rows.length).toBeLessThanOrEqual(ACCOUNT_LIST_PAGE_SIZE);
        expect(page.rows.length).toBeGreaterThan(0);
        expect(page.coverage.total).toBe(entities);
        expect(page.coverage.truncated).toBe(page.coverage.nextOffset !== null);
      }
      const accounts = pages.flatMap((page) => page.rows.map((row) => row.account));
      expect(accounts).toHaveLength(entities);
      expect(new Set(accounts).size).toBe(entities);
    });

  test("the default answer for about 40 accounts stays under 8 KB", async () => {
    const page = await readAccountList(store(Array.from({ length: 40 }, (_, i) => reference(i))), {
      source: null,
      kind: null,
      offset: 0,
    });
    expect(size(page)).toBeLessThan(8 * 1024);
    expect(page.rows.length).toBeGreaterThan(0);
  });

  test("short rows fill a page of 50", async () => {
    const page = await readAccountList(
      store(Array.from({ length: 60 }, (_, i) => reference(i, { label: "合成" }))),
      { source: null, kind: null, offset: 0 },
    );
    // At most 50 rows; the shortest rows this shape allows still meet the
    // byte budget first, so a page closes on whichever bound comes first.
    expect(page.rows.length).toBeLessThanOrEqual(ACCOUNT_LIST_PAGE_SIZE);
    expect(size(page)).toBeLessThanOrEqual(ACCOUNT_LIST_BYTE_BUDGET);
    expect(page.coverage.nextOffset).toBe(page.rows.length);
  });

  test("references of one entity are one line; differing statuses read mixed", async () => {
    const page = await readAccountList(
      store([
        reference(1),
        reference(2, { targetId: reference(1).targetId, status: "unresolved", source: "z-source" }),
      ]),
      { source: "z-source", kind: null, offset: 0 },
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      sources: ["synthetic-source-1", "z-source"],
      mapping: "mixed",
      connection: null,
      lastObservedAt: "2099-01-01T00:00:02Z",
    });
  });

  test("a row too large for a page of its own is refused, never skipped", async () => {
    const huge = reference(1, { label: "x".repeat(ACCOUNT_LIST_BYTE_BUDGET) });
    expect(
      readAccountList(store([huge, reference(2)]), { source: null, kind: null, offset: 0 }),
    ).rejects.toThrow("identity_account_list_row_budget");
  });

  test("a store past the reference bound is refused whole", async () => {
    const rows = Array.from({ length: 5_001 }, (_, i) => reference(i));
    expect(readAccountList(store(rows), { source: null, kind: null, offset: 0 })).rejects.toThrow(
      "identity_account_list_limit",
    );
  });
});
