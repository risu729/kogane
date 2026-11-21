// `activity` with a `from`/`to` window over the real transactions read
// (INV05). The window places a row by the calendar date its `as_of` starts
// with, so a row whose `as_of` starts with none (null, a year-month, an
// impossible day) is left out of the page. The answer names that as the gap
// `undated_rows_excluded` for the row's source and is `partial`, instead of a
// `complete` answer whose freshness says every row carries an `as_of`.
// Synthetic store only: seeded source ids with placeholder accounts, amounts and descriptions.
import { describe, expect, test } from "bun:test";
import { createObservationReader } from "../../read-model/src/index";
import {
  publishTransactions,
  QualityStore,
  type SyntheticTransaction,
} from "../../read-model/test/transaction-shapes-store";
import { openContext } from "../src/context/open.ts";
import { executeQuery, type QueryData } from "../src/query/execute.ts";
import type { QueryRequest } from "../src/query/spec.ts";
import type { Grant } from "../src/grants.ts";
import { CONTEXT_INPUTS, grant, OVERVIEW, reader as fixtureReader } from "./fixture.ts";
import { sqliteExecutor } from "./read-store.ts";

const WINDOW = { from: "2026-03-01", to: "2026-03-31" };

async function activity(
  sources: Record<string, readonly SyntheticTransaction[]>,
  filters: Record<string, string>,
  grantValue: Grant = grant(),
) {
  const store = new QualityStore();
  try {
    for (const [source, rows] of Object.entries(sources))
      publishTransactions(store, source, "synthetic-activity", rows);
    const reader = createObservationReader(sqliteExecutor(store.db));
    const body: QueryRequest = { intent: "activity", filters, cursor: null, limit: null };
    const overview = await reader.overview();
    const opened = await openContext(grantValue, CONTEXT_INPUTS, { query: body });
    const outcome = await executeQuery({
      grant: grantValue,
      opened,
      request: body,
      reader,
      // Only the sources the test stores are in the perimeter: every other
      // seeded source would otherwise be a no_rows_in_scope gap.
      overview: { ...overview, sources: overview.sources.filter((row) => row.id in sources) },
    });
    if (!outcome.ok) throw new Error(`query refused: ${outcome.error.code}`);
    const data = outcome.result.data as QueryData;
    if (data.intent !== "activity") throw new Error("not an activity answer");
    return { result: outcome.result, asOfs: data.rows.map((row) => row.asOf) };
  } finally {
    store.db.close();
  }
}

describe("activity with a from/to window names the rows it cannot place (INV05)", () => {
  test("a null as_of in scope makes the windowed answer partial with undated_rows_excluded", async () => {
    const { result, asOfs } = await activity(
      { paypay: [{ asOf: "2026-03-04" }, { asOf: null }] },
      WINDOW,
    );
    expect(asOfs).toEqual(["2026-03-04"]);
    expect(result.completeness).toBe("partial");
    expect(result.coverage.gaps).toEqual([
      { reasonCode: "undated_rows_excluded", scopeRef: "source:paypay" },
    ]);
    expect(result.quality.freshness).toMatchObject({
      state: "partial",
      reasonCodes: ["undated_rows_excluded"],
    });
  });

  test("a year-month and an impossible day are left out and named; a zone-less date-time is placed", async () => {
    const { result, asOfs } = await activity(
      {
        paypay: [
          { asOf: "2026-03-04T10:00:00" },
          { asOf: "2026-03-05T05:00:00+09:00" },
          { asOf: "2026-03-03T23:00:00.000Z" },
        ],
        wise: [{ asOf: "2026-03" }, { asOf: "2026-03-04" }],
        opal: [{ asOf: "2026-02-30" }, { asOf: "2026-03-06" }],
      },
      WINDOW,
    );
    expect(asOfs).toEqual([
      "2026-03-06",
      "2026-03-05T05:00:00+09:00",
      "2026-03-04T10:00:00",
      "2026-03-04",
      "2026-03-03T23:00:00.000Z",
    ]);
    expect(result.completeness).toBe("partial");
    expect(result.coverage.gaps).toEqual([
      { reasonCode: "undated_rows_excluded", scopeRef: "source:opal" },
      { reasonCode: "undated_rows_excluded", scopeRef: "source:wise" },
    ]);
  });

  test("a source whose rows are all undated is undated_rows_excluded, not no_rows_in_scope", async () => {
    const { result, asOfs } = await activity(
      {
        paypay: [{ asOf: "2026-03-04" }],
        wise: [{ asOf: null }, { asOf: "2026-03" }],
      },
      { to: "2026-12-31" },
    );
    expect(asOfs).toEqual(["2026-03-04"]);
    expect(result.coverage.gaps).toEqual([
      { reasonCode: "undated_rows_excluded", scopeRef: "source:wise" },
    ]);
  });

  test("every row dated: the windowed answer stays complete and claims every row carries an as_of", async () => {
    const { result, asOfs } = await activity(
      { paypay: [{ asOf: "2026-03-04" }, { asOf: "2026-04-01" }] },
      WINDOW,
    );
    expect(asOfs).toEqual(["2026-03-04"]);
    expect(result.completeness).toBe("complete");
    expect(result.coverage.gaps).toEqual([]);
    expect(result.quality.freshness).toMatchObject({
      state: "verified",
      reasonCodes: ["every_row_carries_an_as_of"],
    });
  });

  test("without a window the undated row is returned and named as_of_missing, as before", async () => {
    const { result, asOfs } = await activity(
      { paypay: [{ asOf: "2026-03-04" }, { asOf: null }] },
      {},
    );
    expect(asOfs).toEqual(["2026-03-04", null]);
    expect(result.completeness).toBe("complete");
    expect(result.coverage.gaps).toEqual([]);
    expect(result.quality.freshness).toMatchObject({
      state: "partial",
      reasonCodes: ["as_of_missing"],
    });
  });

  test("only undated rows inside the account and q filters count", async () => {
    const sources = {
      paypay: [
        { asOf: "2026-03-04", account: "account-1", description: "kept line" },
        { asOf: null, account: "account-2", description: "kept line" },
        { asOf: null, account: "account-1", description: "other line" },
      ],
    };
    const narrowed = await activity(sources, {
      ...WINDOW,
      account: "account-1",
      q: "kept",
    });
    expect(narrowed.result.completeness).toBe("complete");
    expect(narrowed.result.coverage.gaps).toEqual([]);
    const byAccount = await activity(sources, {
      ...WINDOW,
      account: "account-2",
    });
    expect(byAccount.result.coverage.gaps).toEqual([
      { reasonCode: "undated_rows_excluded", scopeRef: "source:paypay" },
    ]);
  });

  test("a source outside the grant is never named, whatever its rows (SC18)", async () => {
    const { result } = await activity(
      { paypay: [{ asOf: "2026-03-04" }], wise: [{ asOf: null }] },
      WINDOW,
      grant({ scopes: { sources: ["paypay"], accounts: "*" } }),
    );
    expect(result.completeness).toBe("complete");
    expect(result.coverage.gaps).toEqual([]);
  });
});

describe("a grant narrowed by account bounds the count (SC18)", () => {
  const sources = {
    paypay: [
      { asOf: "2026-03-04", account: "account-1" },
      { asOf: null, account: "account-2" },
    ],
    wise: [{ asOf: "2026-03", account: "account-2" }],
  };

  test("undated rows only in an account outside the grant name nothing", async () => {
    const { result, asOfs } = await activity(
      sources,
      WINDOW,
      grant({ scopes: { sources: "*", accounts: ["account-1"] } }),
    );
    expect(asOfs).toEqual(["2026-03-04"]);
    // wise has no row in the granted account, so it is named as having none;
    // its hidden undated row does not turn it into undated_rows_excluded.
    expect(result.coverage.gaps).toEqual([
      { reasonCode: "no_rows_in_scope", scopeRef: "source:wise" },
    ]);
    expect(result.quality.freshness).toMatchObject({
      state: "verified",
      reasonCodes: ["every_row_carries_an_as_of"],
    });
  });

  test("the same store answers the same as one without the hidden account's rows", async () => {
    const narrowed = grant({ scopes: { sources: ["paypay", "wise"], accounts: ["account-1"] } });
    const withHidden = await activity(sources, WINDOW, narrowed);
    const without = await activity(
      { paypay: [{ asOf: "2026-03-04", account: "account-1" }], wise: [] },
      WINDOW,
      narrowed,
    );
    expect(withHidden.result.completeness).toBe(without.result.completeness);
    expect(withHidden.result.coverage).toEqual(without.result.coverage);
    expect(withHidden.result.quality).toEqual(without.result.quality);
  });

  test("an undated row in a granted account is named for its source", async () => {
    const { result } = await activity(
      sources,
      WINDOW,
      grant({ scopes: { sources: "*", accounts: ["account-2"] } }),
    );
    expect(result.completeness).toBe("partial");
    expect(result.coverage.gaps).toEqual([
      { reasonCode: "undated_rows_excluded", scopeRef: "source:paypay" },
      { reasonCode: "undated_rows_excluded", scopeRef: "source:wise" },
    ]);
  });
});

describe("the gap is the same on every page and leaves the cursor alone (ADR 0091)", () => {
  async function pages(rows: readonly SyntheticTransaction[]) {
    const store = new QualityStore();
    try {
      publishTransactions(store, "paypay", "synthetic-activity", rows);
      const reader = createObservationReader(sqliteExecutor(store.db));
      const overview = await reader.overview();
      const scoped = {
        ...overview,
        sources: overview.sources.filter((row) => row.id === "paypay"),
      };
      const out = [];
      let cursor: string | null = null;
      do {
        const body: QueryRequest = { intent: "activity", filters: WINDOW, cursor, limit: 2 };
        const opened = await openContext(grant(), CONTEXT_INPUTS, { query: body });
        const outcome = await executeQuery({
          grant: grant(),
          opened,
          request: body,
          reader,
          overview: scoped,
        });
        if (!outcome.ok) throw new Error(`query refused: ${outcome.error.code}`);
        out.push(outcome.result);
        cursor = outcome.result.nextCursor;
      } while (cursor !== null);
      return out;
    } finally {
      store.db.close();
    }
  }

  test("every page names the source; rows and cursors match a store without the undated row", async () => {
    const dated = [
      { asOf: "2026-03-01" },
      { asOf: "2026-03-02" },
      { asOf: "2026-03-03" },
      { asOf: "2026-03-04" },
      { asOf: "2026-03-05" },
    ];
    const withUndated = await pages([...dated, { asOf: null }, { asOf: "2026-03" }]);
    const plain = await pages(dated);
    expect(withUndated).toHaveLength(3);
    expect(plain).toHaveLength(3);
    for (const [index, page] of withUndated.entries()) {
      expect(page.completeness).toBe("partial");
      expect(page.coverage.gaps).toEqual([
        { reasonCode: "undated_rows_excluded", scopeRef: "source:paypay" },
      ]);
      expect(page.quality.freshness.reasonCodes).toEqual(["undated_rows_excluded"]);
      expect(page.data).toEqual(plain[index]!.data);
      expect(page.nextCursor).toBe(plain[index]!.nextCursor);
    }
    // Without the undated rows only the last page is complete.
    expect(plain.map((page) => page.completeness)).toEqual(["partial", "partial", "complete"]);
  });
});

describe("the undated count is read only for a window", () => {
  test("one count per scope pair with from or to, none without", async () => {
    const calls = async (filters: Record<string, string>) => {
      const reader = fixtureReader();
      const body: QueryRequest = { intent: "activity", filters, cursor: null, limit: null };
      const opened = await openContext(grant(), CONTEXT_INPUTS, { query: body });
      await executeQuery({ grant: grant(), opened, request: body, reader, overview: OVERVIEW });
      return reader.calls.filter((call) => call.startsWith("undated:"));
    };
    expect(await calls({})).toEqual([]);
    expect(await calls({ q: "line" })).toEqual([]);
    expect(await calls({ from: "2026-01-01" })).toEqual(["undated:*/*"]);
    expect(await calls({ to: "2026-12-31", source: "fixture-a" })).toEqual(["undated:fixture-a/*"]);
  });
});
