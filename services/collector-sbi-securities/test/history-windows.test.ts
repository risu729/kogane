import { afterEach, describe, expect, test } from "bun:test";
import {
  collectHistoryArtifacts,
  foreignHistoryRange,
  historyWindows,
  jstDate,
  SbiHistoryError,
  historyYearStart,
} from "../src/history-windows";
import {
  collectForeignHistoryArtifacts,
  collectForeignTradeRecords,
  fetchForeignHistoryRange,
} from "../src/sbi";
import { assertDomesticHistoryRange, parseDomesticTradeRecords } from "../src/main-site";
import { safeFailureCode, sbiRunPlan } from "../src/shared-run";
import type { ForeignSession } from "../src/types";

describe("scheduled SBI execution history windows", () => {
  test("the January-start retained interval is covered exactly once, preserving the normal newest 90 days", () => {
    for (const to of ["2099-11-10", "2100-03-01", "2096-02-29"]) {
      const from = historyYearStart(to);
      const windows = historyWindows({ from, to });
      expect(windows.length).toBeLessThanOrEqual(13);
      expect(windows[0]!.to).toBe(to);
      expect(windows.at(-1)!.from).toBe(from);
      const days = new Set<string>();
      for (const [index, window] of windows.entries()) {
        const length = (Date.parse(window.to) - Date.parse(window.from)) / 86400000 + 1;
        expect(length).toBeGreaterThan(0);
        expect(length).toBeLessThanOrEqual(90);
        if (index === 0) expect(length).toBe(90);
        for (let day = Date.parse(window.from); day <= Date.parse(window.to); day += 86400000) {
          const value = new Date(day).toISOString().slice(0, 10);
          expect(days.has(value)).toBe(false);
          days.add(value);
        }
      }
      expect(days.size).toBe((Date.parse(to) - Date.parse(from)) / 86400000 + 1);
    }
    expect(historyYearStart("2096-02-29")).toBe("2094-01-01");
    expect(() => historyYearStart("2100-02-29")).toThrow("sbi_history_window_invalid");
    expect(historyYearStart(jstDate(new Date("2099-12-31T15:01:00Z")))).toBe("2098-01-01");
    expect(jstDate(new Date("2099-01-01T15:01:00Z"))).toBe("2099-01-02");
    for (const range of [
      { from: "2099-02-30", to: "2099-03-01" },
      { from: "2099-02-01", to: "2099-01-01" },
      { from: "2090-01-01", to: "2099-01-01" },
    ])
      expect(() => historyWindows(range)).toThrow("sbi_history_window_invalid");
  });

  test("foreign mobile retention preserves the observed January-start scan, not the web rolling cutoff", () => {
    expect(foreignHistoryRange(2, "2099-11-10")).toEqual({ from: "2097-01-01", to: "2099-11-10" });
    expect(historyWindows(foreignHistoryRange(2, "2098-08-26"))).toHaveLength(11);
    expect(historyWindows(foreignHistoryRange(2, "2099-12-31"))).toHaveLength(13);
    for (const years of [undefined, null, "2", 1, 3])
      expect(() => foreignHistoryRange(years, "2099-11-10")).toThrow(
        "sbi_foreign_history_retention_unavailable",
      );
  });

  test("a failed older window keeps newer evidence and returns a closed partial-unit code", async () => {
    const failures: SbiHistoryError[] = [];
    let called = 0;
    const artifacts = await collectHistoryArtifacts({
      dataset: "domestic-trade-records",
      range: { from: "2097-01-01", to: "2099-01-01" },
      collect: async () => {
        if (++called === 2) throw new Error("SENTINEL provider payload");
        return { records: [], hasMore: false };
      },
      onError: (error) => failures.push(error),
    });
    expect(called).toBe(9);
    expect(artifacts).toHaveLength(8);
    expect(artifacts[0]!.artifactKey).toBeUndefined();
    expect(failures.map(safeFailureCode)).toEqual(["sbi_domestic_history_window_failed"]);
    const plan = await sbiRunPlan({
      runId: "synthetic-history",
      producerVersion: "test",
      attemptId: "attempt-test",
      startedAt: "2099-01-01T00:00:00Z",
      completedAt: "2099-01-01T00:01:00Z",
      status: "partial",
      scope: "domestic",
      artifacts,
      failures: failures.map((error) => ({ scope: "domestic", code: safeFailureCode(error) })),
    });
    expect(new Set(plan.artifacts.map((artifact) => artifact.artifactKey)).size).toBe(8);
    expect(plan.run.units[0]).toMatchObject({
      artifactCount: 8,
      coverageStatus: "partial",
      safeErrorCode: "sbi_domestic_history_window_failed",
    });
    expect(plan.run.ranges).toHaveLength(8);
    for (const artifact of plan.artifacts)
      expect(
        plan.run.ranges.some((range) => range.rangeKey === `${artifact.artifactKey}:requested`),
      ).toBe(true);
    expect(JSON.stringify(plan.run)).not.toContain("SENTINEL");
  });

  test("a confirmed empty domestic result is evidence; a search error and the unwalked cap fail closed", () => {
    const form = '<form><input name="ACT_search"></form>';
    expect(
      parseDomesticTradeRecords(`${form}<p>指定された条件での約定履歴は見つかりませんでした。</p>`),
    ).toEqual({ records: [], hasMore: false });
    expect(() => parseDomesticTradeRecords(`${form}<p>期間が正しくありません</p>`)).toThrow(
      "omitted its result table",
    );
    const row =
      "<tr><td>99/01/01</td><td>合成会社 DEMO 合成市場</td><td>買付 合成口座/指値</td><td>3 20</td><td></td><td>99/01/03 60</td><td></td></tr>";
    const page = (rows: string) =>
      `<table><tr><th>約定日</th><th>約定数量</th></tr>${rows}</table>`;
    const first = parseDomesticTradeRecords(page(row + row));
    const second = parseDomesticTradeRecords(page(row + row));
    expect(first.records.map((entry) => entry.id)).toEqual(second.records.map((entry) => entry.id));
    expect(new Set(first.records.map((entry) => entry.id)).size).toBe(2);
    expect(() => parseDomesticTradeRecords(page(row.repeat(200)))).toThrow(
      "sbi_domestic_history_truncated",
    );
  });
  test("a cleared or clamped domestic date form cannot confirm a requested historical window", () => {
    const range = { from: "2097-01-01", to: "2097-03-31" };
    const matching = () =>
      new URLSearchParams({
        ref_from_yyyy: "2097",
        ref_from_mm: "1",
        ref_from_dd: "01",
        ref_to_yyyy: "2097",
        ref_to_mm: "03",
        ref_to_dd: "31",
      });
    expect(() => assertDomesticHistoryRange(matching(), range)).not.toThrow();
    for (const [key, value] of [
      ["ref_from_yyyy", "2098"],
      ["ref_from_mm", ""],
      ["ref_to_dd", "30"],
      ["ref_to_mm", "3e0"],
    ]) {
      const fields = matching();
      fields.set(key!, value!);
      expect(() => assertDomesticHistoryRange(fields, range)).toThrow(
        "sbi_domestic_history_range_mismatch",
      );
    }
    const missing = matching();
    missing.delete("ref_from_dd");
    expect(() => assertDomesticHistoryRange(missing, range)).toThrow(
      "sbi_domestic_history_range_mismatch",
    );
  });
});

describe("foreign history keeps the observed GraphQL request and requires a complete page chain", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const session: ForeignSession = {
    sessionId: "synthetic-session",
    accountId: "synthetic-account",
    restUrl: "https://foreign.invalid/rest/",
    graphqlBffUrl: "https://foreign.invalid/graphql/bff",
    graphqlIntUrl: "https://foreign.invalid/graphql/int",
    userAgent: "synthetic",
    marketPriceHash: "synthetic-hash",
  };
  const window = { from: "2099-01-01", to: "2099-03-31" };
  const data = (hasNextPage: unknown) => ({
    checkJrNisaOpen: { opened: false },
    listTradeRecords: { tradeRecords: [], page: { hasNextPage } },
  });
  test("uses the historically observed BFF duration query and validates its response", async () => {
    let request: Record<string, any> | undefined;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(session.graphqlBffUrl);
      expect(new Headers(init?.headers).has("hash_token")).toBe(false);
      request = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          getSearchingDuration: {
            pastYears: 2,
            searchDateFrom: "2099-10-01",
            searchDateTo: "2099-11-01",
          },
        },
      });
    }) as typeof fetch;
    expect(await fetchForeignHistoryRange(session, "2099-11-10")).toEqual({
      from: "2097-01-01",
      to: "2099-11-10",
    });
    expect(request?.operationName).toBe("GetSearchingDuration");
    expect(request?.variables).toEqual({
      input: {
        countryCode: "US",
        searchFunction: "EXECUTION_HISTORY",
        searchDateType: "TRADE_DATE_BASE",
        dateType: "MONTH",
        quantity: 1,
      },
    });
    expect(request?.query).toContain("pastYears searchDateFrom searchDateTo");
    for (const duration of [
      null,
      { pastYears: 3, searchDateFrom: "", searchDateTo: "" },
      { pastYears: 2 },
      { pastYears: 2, searchDateFrom: null, searchDateTo: "" },
    ]) {
      globalThis.fetch = (async () =>
        Response.json({ data: { getSearchingDuration: duration } })) as unknown as typeof fetch;
      await expect(fetchForeignHistoryRange(session, "2099-11-10")).rejects.toThrow(
        "sbi_foreign_history_retention_unavailable",
      );
    }
  });
  test("unsupported mobile retention keeps the ordinary window only as named partial evidence", async () => {
    const errors: SbiHistoryError[] = [];
    const operations: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      operations.push(request.operationName);
      return Response.json({
        data:
          request.operationName === "GetSearchingDuration"
            ? { getSearchingDuration: { pastYears: 3, searchDateFrom: "", searchDateTo: "" } }
            : data(false),
      });
    }) as typeof fetch;
    const artifacts = await collectForeignHistoryArtifacts(session, {
      to: "2099-03-31",
      onHistoryError: (error) => errors.push(error),
    });
    expect(errors.map(safeFailureCode)).toEqual(["sbi_foreign_history_retention_unavailable"]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.window).toEqual({ from: "2099-01-01", to: "2099-03-31" });
    expect(operations).toEqual(["GetSearchingDuration", "GetTradeRecordList"]);
  });
  test("passes dates in existing fields, starts each window at page one, and preserves empty pages", async () => {
    const requests: Record<string, any>[] = [];
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return Response.json({ data: data(request.variables.input.page.pageNum === 1) });
    }) as typeof fetch;
    expect((await collectForeignTradeRecords(session, window)).pages).toHaveLength(2);
    expect(requests.map((request) => request.variables.input.page.pageNum)).toEqual([1, 2]);
    expect(requests[0]!.variables.input).toEqual({
      productCode: "FOREIGN_STOCK",
      countryCode: "US",
      specificAccountCode: null,
      tradeHistoryType: "TRADE_RECORD",
      searchDateType: "TRADE_DATE_BASE",
      searchDateFrom: window.from,
      searchDateTo: window.to,
      page: { pageNum: 1, pageSize: 999 },
    });
    expect(requests[0]!.operationName).toBe("GetTradeRecordList");
    expect(requests[0]!.query).not.toContain("pastYears");
    requests.length = 0;
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ data: data(false) });
    }) as typeof fetch;
    expect(
      (await collectForeignTradeRecords(session, { from: "2098-10-03", to: "2098-12-31" })).pages,
    ).toHaveLength(1);
    expect(requests[0]!.variables.input.page.pageNum).toBe(1);
  });
  test("missing page metadata, GraphQL errors and a chain beyond the observed bound never become complete", async () => {
    for (const hasNextPage of [undefined, null, "false"]) {
      globalThis.fetch = (async () =>
        Response.json({ data: data(hasNextPage) })) as unknown as typeof fetch;
      await expect(collectForeignTradeRecords(session, window)).rejects.toThrow(
        "sbi_foreign_history_page_invalid",
      );
    }
    globalThis.fetch = (async () =>
      Response.json({ errors: [{ message: "SENTINEL" }] })) as unknown as typeof fetch;
    await expect(collectForeignTradeRecords(session, window)).rejects.toThrow("returned errors");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ data: data(true) });
    }) as unknown as typeof fetch;
    await expect(collectForeignTradeRecords(session, window)).rejects.toThrow(
      "sbi_foreign_history_page_limit",
    );
    expect(calls).toBe(20);
  });
});
