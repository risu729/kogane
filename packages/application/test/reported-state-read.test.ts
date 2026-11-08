// `readReportedStateRequest` (src/query/reported-state-read.ts): the request
// rules `GET /api/v2/reported-state` and `kogane.reported-state.read` share
// (ADR 0081 point 2). A body and the query string that spells the same
// request get one refusal, decided before the store is read; only the row
// bound needs the read. Every date and id is invented.
import { describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  parseReportedStateRequest,
  readReportedStateRequest,
  REPORTED_STATE_REFUSALS,
  reportedStateBodyFromQuery,
} from "../src/query/reported-state-read.ts";

/** 2026-09-10T03:00:00Z: 12:00 on 2026-09-10 in Tokyo. */
const NOW = Date.parse("2026-09-10T03:00:00Z");

/** An executor that records each statement and answers `rows` empty rows to each. */
function recorded(rows = 0): { sql: SqlExecutor; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    sql: {
      all: async <T>(query: string) => {
        queries.push(query);
        return Array.from({ length: rows }, () => ({})) as T[];
      },
      first: async (query: string) => {
        queries.push(query);
        return null;
      },
    },
  };
}

describe("one refusal for a body and its query string", () => {
  const cases: [Record<string, unknown>, string, keyof typeof REPORTED_STATE_REFUSALS][] = [
    [{}, "", "invalid_date"],
    [{ date: "20260910" }, "date=20260910", "invalid_date"],
    [{ date: "2026-9-1" }, "date=2026-9-1", "invalid_date"],
    [{ date: "2026-02-30" }, "date=2026-02-30", "invalid_date"],
    [{ date: "2026-09-10T00:00:00Z" }, "date=2026-09-10T00:00:00Z", "invalid_date"],
    [{ date: "2026-09-11" }, "date=2026-09-11", "date_in_future"],
    [{ date: "" }, "date=", "invalid_query"],
    [{ date: "2026-09-10", offset: "0" }, "date=2026-09-10&offset=0", "invalid_query"],
    [{ date: "2026-09-10", source: "SMBC" }, "date=2026-09-10&source=SMBC", "invalid_query"],
    [{ date: "2026-09-10", account: " x" }, "date=2026-09-10&account=%20x", "invalid_query"],
    [{ date: "2026-09-10", source: "" }, "date=2026-09-10&source=", "invalid_query"],
    // An unknown key wins over a malformed date, on both.
    [{ date: "bad", view: "x" }, "date=bad&view=x", "invalid_query"],
    // A key named like a prototype slot is a key like any other (the route
    // refused `__proto__` before the service shared its rules).
    [
      JSON.parse('{"date":"2026-09-10","__proto__":"x"}'),
      "date=2026-09-10&__proto__=x",
      "invalid_query",
    ],
    [{ date: "2026-09-10", constructor: "x" }, "date=2026-09-10&constructor=x", "invalid_query"],
  ];
  test.each(cases)("%j", async (body, query, refusal) => {
    const fromQuery = reportedStateBodyFromQuery(new URLSearchParams(query));
    if (!fromQuery.ok) throw new Error("the query string is a body");
    for (const request of [body, fromQuery.body]) {
      const probe = recorded();
      expect(await readReportedStateRequest({ sql: probe.sql, body: request, now: NOW })).toEqual({
        ok: false,
        refusal,
        status: 400,
      });
      // Refused before the store is read.
      expect(probe.queries).toEqual([]);
    }
  });

  test("a value of the wrong type is malformed, and a non-object body is invalid_query", () => {
    for (const [body, refusal] of [
      [null, "invalid_query"],
      ["2026-09-10", "invalid_query"],
      [["2026-09-10"], "invalid_query"],
      [{ date: 20260910 }, "invalid_date"],
      [{ date: "2026-09-10", source: 1 }, "invalid_query"],
      [{ date: "2026-09-10", account: ["acct-1"] }, "invalid_query"],
    ] as const)
      expect(parseReportedStateRequest(body, NOW)).toMatchObject({ ok: false, refusal });
  });

  test("a repeated parameter is invalid_query on the route", () => {
    expect(
      reportedStateBodyFromQuery(new URLSearchParams("date=2026-09-10&date=2026-09-10")),
    ).toEqual({ ok: false, refusal: "invalid_query", status: 400 });
  });

  test("today in Tokyo is answered, its filters kept", () => {
    expect(
      parseReportedStateRequest(
        { date: "2026-09-10", source: "smbc-bank", account: "acct-1" },
        NOW,
      ),
    ).toEqual({ ok: true, value: { date: "2026-09-10", source: "smbc-bank", account: "acct-1" } });
    // 15:00Z on 2026-09-10 is already 2026-09-11 in Tokyo.
    expect(
      parseReportedStateRequest({ date: "2026-09-11" }, Date.parse("2026-09-10T15:00:00Z")),
    ).toEqual({ ok: true, value: { date: "2026-09-11" } });
  });
});

describe("the read", () => {
  test("past the row bound is result_limit_exceeded (413), never cut", async () => {
    expect(
      await readReportedStateRequest({
        sql: recorded(5001).sql,
        body: { date: "2026-09-10" },
        now: NOW,
      }),
    ).toEqual({ ok: false, refusal: "result_limit_exceeded", status: 413 });
  });

  test("an empty store answers its state", async () => {
    const outcome = await readReportedStateRequest({
      sql: recorded().sql,
      body: { date: "2026-09-10" },
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: true, state: { date: "2026-09-10", accounts: [] } });
  });
});
