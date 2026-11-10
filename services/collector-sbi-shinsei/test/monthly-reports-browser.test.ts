import { expect, test } from "bun:test";
import { parseMonthlyReports } from "../src/monthly-reports";
import { reportListFixture, reportDownloadFixture } from "./monthly-report-fixtures";
const source = await Bun.file(new URL("../container/server.mjs", import.meta.url)).text();
const start = source.indexOf("async function collectAuthenticatedReadsInPage(");
const end = source.indexOf("\nasync function collect({", start);
async function run(stored: string[], failure: "none" | "http" | "schema" = "none", large = false) {
  const fixtures = await Bun.file(
    new URL("./fixtures/core-responses.json", import.meta.url),
  ).json();
  const paths: string[] = [];
  const periods: string[] = [];
  const routeValues: Record<string, unknown> = {
    "/SFC/app/IFCM_CommonAdapter/validateToken": {
      header: { adapterResultCode: "0", newToken: "synthetic-next" },
    },
    "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity": fixtures.topBalances,
    "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage": fixtures.balanceSummary,
    "/SFC/app/IFCM_CommonAdapter/getExchangeRate": fixtures.exchangeRate,
    "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount": fixtures.yenDeposit,
    "/SFC/app/AIAI_AccountInfomationAdapter/getStatementReport": reportListFixture(
      large
        ? ["2099-01", "2099-02", "2099-03", "2099-04", "2099-05", "2099-06"]
        : ["2099-01", "2099-03", "2099-02"],
    ),
  };
  const listed = routeValues["/SFC/app/AIAI_AccountInfomationAdapter/getStatementReport"] as {
    header: Record<string, unknown>;
  };
  listed.header.newToken = "synthetic-report-token";
  const fakeFetch = async (
    input: unknown,
    options?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    const path = String(input);
    paths.push(path);
    expect(options?.method).toBe("POST");
    if (path.endsWith("/downloadStatement")) {
      expect(options?.headers?.["X-CSRF-Token"]).toBe("synthetic-report-token");
      const body = JSON.parse(String(options?.body)).requestParam;
      expect(Object.keys(body).sort()).toEqual(["month", "year"]);
      const period = `${body.year}-${body.month}`;
      periods.push(period);
      if (failure === "http") return new Response("private-provider-error", { status: 403 });
      return Response.json(
        reportDownloadFixture(
          period,
          failure === "schema"
            ? "<html>challenge</html>"
            : large
              ? "%PDF-" + "A".repeat(1024 * 1024 - 5)
              : undefined,
        ),
      );
    }
    if (!(path in routeValues)) throw new Error("unapproved route in synthetic test");
    return Response.json(routeValues[path]);
  };
  const collect = new Function("fetch", `return (${source.slice(start, end)})`)(fakeFetch) as (
    session: Record<string, unknown>,
  ) => Promise<string>;
  const result = JSON.parse(
    await collect({
      authorization: "synthetic-authorization",
      csrfToken: "synthetic-csrf",
      storedReportPeriods: stored,
    }),
  );
  expect(JSON.stringify(result)).not.toContain("synthetic-report-token");
  return { result, paths, periods };
}
test("the real in-page function collects every offered report initially and only the latest afterward", async () => {
  const first = await run([]);
  expect(first.periods).toEqual(["2099-03", "2099-02", "2099-01"]);
  const late = await run(["2099-03", "2099-02"]);
  expect(late.periods).toEqual(["2099-03", "2099-01"]);
  expect(parseMonthlyReports(first.result.documents, []).failures).toEqual([]);
  const later = await run(["2099-01", "2099-02", "2099-03"]);
  expect(later.periods).toEqual(["2099-03"]);
  expect(
    parseMonthlyReports(later.result.documents, ["2099-01", "2099-02", "2099-03"]).artifacts,
  ).toHaveLength(1);
});
test.each(["http", "schema"] as const)(
  "a %s failure stops further provider reads and retains core evidence",
  async (failure) => {
    const { result, periods } = await run([], failure);
    expect(periods).toEqual(["2099-03"]);
    expect(Object.keys(result.responses)).toHaveLength(4);
    const parsed = parseMonthlyReports(result.documents, []);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.failures).toHaveLength(3);
    expect(JSON.stringify(parsed.failures)).not.toContain("private-provider-error");
  },
);

test("the aggregate budget stops later reads and records a partial resumable prefix", async () => {
  const { result, periods } = await run([], "none", true);
  const parsed = parseMonthlyReports(result.documents, []);
  expect(parsed.artifacts.length).toBeGreaterThan(0);
  expect(parsed.artifacts.length).toBeLessThan(6);
  expect(parsed.failures.length).toBeGreaterThan(0);
  expect(periods.length).toBeLessThanOrEqual(6);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(
    10 * 1024 * 1024,
  );
});
