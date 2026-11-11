import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCollectionResult } from "../src/local/windows-chrome-collector";
import { reportDownloadFixture, reportListFixture } from "./monthly-report-fixtures";

const source = readFileSync(`${import.meta.dir}/../container/server.mjs`, "utf8");
const body = source.slice(
  source.indexOf("async function collectAuthenticatedReadsInPage("),
  source.indexOf("async function collect({"),
);
const HISTORY_PATH = "/SFC/app/IFAI_AccountAdapter/getCasaAccountActivitySpecificPeriod";
const account = (accountNo: string, currency = "JPY", productCode = "601") => ({
  accountNo,
  currency,
  productCode,
  balance: "1000",
  yenEqui: "1000",
});
const THREE_ACCOUNTS = [
  account("000000000000001"),
  account("000000000000002", "JPY", "603"),
  account("000000000000003", "USD", "621"),
];

interface Call {
  path: string;
  body: any;
  token: string | undefined;
  signal: boolean;
}

/** Runs the real in-page function against a serial synthetic provider. */
async function runInPage(options: {
  savingsDetails: unknown[];
  failAccount?: string;
  reportPeriods?: string[];
  historyDescription?: string;
  reportPdf?: string;
  afterHistoryRead?: () => void;
}) {
  const run = new Function(`return (${body})`)() as (session: {
    authorization: string;
    csrfToken: string;
    storedReportPeriods: string[];
  }) => Promise<string>;
  const core = await Bun.file(`${import.meta.dir}/fixtures/core-responses.json`).json();
  const period = await Bun.file(
    `${import.meta.dir}/../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/savings-activity.json`,
  ).json();
  core.topBalances.responseParam.overview.responseParam.savingsDetails = options.savingsDetails;
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let active = 0,
    maximum = 0;
  globalThis.fetch = (async (url, init) => {
    active += 1;
    maximum = Math.max(maximum, active);
    const path = String(url),
      request = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      body: request,
      token: (init?.headers as Record<string, string> | undefined)?.["X-CSRF-Token"],
      signal: init?.signal instanceof AbortSignal,
    });
    try {
      let value: any;
      if (path.endsWith("/validateToken")) value = { header: { adapterResultCode: "0" } };
      else if (path.endsWith("/getAccountsBalanceAndActivity"))
        value = structuredClone(core.topBalances);
      else if (path.endsWith("/getBalanceSummaryAndStage"))
        value = structuredClone(core.balanceSummary);
      else if (path.endsWith("/getExchangeRate")) value = structuredClone(core.exchangeRate);
      else if (path.endsWith("/getYenDepositAccount")) value = structuredClone(core.yenDeposit);
      else if (path.endsWith("/getStatementReport"))
        value = reportListFixture(options.reportPeriods ?? []);
      else if (path.endsWith("/downloadStatement")) {
        const { year, month } = request.requestParam;
        value = reportDownloadFixture(`${year}-${month}`, options.reportPdf);
      } else {
        expect(path).toBe(HISTORY_PATH);
        expect(request.requestParam).toMatchObject({ type: "1", eventType: "3" });
        if (request.requestParam.accountNo === options.failAccount)
          throw new Error("synthetic network failure");
        value = structuredClone(period.response);
        const activity = value.responseParam.activity.responseParam;
        activity.accountNo = request.requestParam.accountNo;
        activity.currency = activity.accountNo.endsWith("3") ? "USD" : "JPY";
        const display = (date: string) =>
          `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}`;
        activity.fromDate = display(request.requestParam.fromDate);
        activity.toDate = display(request.requestParam.toDate);
        for (const row of activity.activityDetails) row.postingDate = activity.toDate;
        if (options.historyDescription)
          activity.activityDetails[0].description = options.historyDescription;
        options.afterHistoryRead?.();
      }
      value.header.newToken = `synthetic-token-${calls.length}`;
      await Promise.resolve();
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    } finally {
      active -= 1;
    }
  }) as typeof fetch;
  try {
    const result = await run({
      authorization: "synthetic-authorization",
      csrfToken: "synthetic-initial-token",
      storedReportPeriods: [],
    });
    return { result, calls, maximum };
  } finally {
    globalThis.fetch = original;
  }
}

test("scheduled same-page reads serialize every savings account and retain successful accounts after a failed one", async () => {
  const { result, calls, maximum } = await runInPage({
    savingsDetails: THREE_ACCOUNTS,
    failAccount: "000000000000002",
  });
  expect(maximum).toBe(1);
  const requests = calls.filter((call) => call.path === HISTORY_PATH);
  expect(requests.map((call) => call.body.requestParam.accountNo)).toEqual([
    "000000000000001",
    "000000000000002",
    "000000000000003",
  ]);
  expect(requests.map((call) => call.token)).toEqual([
    "synthetic-token-5",
    "synthetic-token-6",
    "synthetic-token-6",
  ]);
  // History reads are bounded like report reads and run before the report list.
  expect(requests.every((call) => call.signal)).toBe(true);
  expect(calls.map((call) => call.path).indexOf(HISTORY_PATH)).toBeLessThan(
    calls.findIndex((call) => call.path.endsWith("/getStatementReport")),
  );
  expect(result).not.toContain("synthetic-token");
  const parsed = parseCollectionResult(result, new Date());
  expect(
    parsed.artifacts.filter((artifact) => artifact.dataset === "savings-activity"),
  ).toHaveLength(2);
  expect(parsed.failures).toMatchObject([
    {
      operation: "read:history-0002",
      errorType: "ProviderReadError",
      message: "provider_read_failed",
    },
  ]);
});

test("history keeps its own byte budget and reports count the history already held", async () => {
  const { result } = await runInPage({
    savingsDetails: [1, 2, 4, 5, 6].map((n) => account(`00000000000000${n}`)),
    historyDescription: "A".repeat(1_500_000),
    reportPeriods: ["2099-01", "2099-02", "2099-03"],
    reportPdf: "%PDF-" + "A".repeat(1024 * 1024 - 5),
  });
  const handoff = JSON.parse(result);
  expect(new TextEncoder().encode(result).byteLength).toBeLessThan(10 * 1024 * 1024);
  expect(
    new TextEncoder().encode(
      JSON.stringify({ ok: true, responses: handoff.responses, history: handoff.history }),
    ).byteLength,
  ).toBeLessThanOrEqual(6 * 1024 * 1024);
  expect(handoff.history.accounts.map((entry: any) => entry.errorCode ?? "read")).toEqual([
    "read",
    "read",
    "read",
    "read",
    "history_budget_exceeded",
  ]);
  expect(handoff.documents.downloads.map((entry: any) => entry.errorCode ?? "read")).toEqual([
    "read",
    "report_budget_exceeded",
    "report_budget_exceeded",
  ]);
  const parsed = parseCollectionResult(result, new Date(), []);
  expect(
    parsed.artifacts.filter((artifact) => artifact.dataset === "savings-activity"),
  ).toHaveLength(4);
  expect(parsed.failures).toContainEqual(
    expect.objectContaining({ operation: "read:history-0005", message: "provider_read_failed" }),
  );
});

test("history and reports share one deadline; later accounts fail closed without a read", async () => {
  const now = Date.now;
  let offset = 0;
  Date.now = () => now() + offset;
  try {
    const { result, calls } = await runInPage({
      savingsDetails: THREE_ACCOUNTS,
      reportPeriods: ["2099-01"],
      afterHistoryRead: () => {
        offset = 11 * 60 * 1000;
      },
    });
    expect(calls.filter((call) => call.path === HISTORY_PATH)).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith("/downloadStatement"))).toBe(false);
    const handoff = JSON.parse(result);
    expect(handoff.history.accounts.map((entry: any) => entry.errorCode ?? "read")).toEqual([
      "read",
      "history_budget_exceeded",
      "history_budget_exceeded",
    ]);
    const parsed = parseCollectionResult(result, new Date(now()), []);
    expect(
      parsed.failures
        .filter((failure) => failure.operation.startsWith("read:history"))
        .map((failure) => failure.operation),
    ).toEqual(["read:history-0002", "read:history-0003"]);
  } finally {
    Date.now = now;
  }
});

test("an unexpected savings inventory reads no history and keeps the core reads and reports", async () => {
  const { result, calls } = await runInPage({
    savingsDetails: [{ ...account("synthetic-account-1") }],
    reportPeriods: ["2099-01"],
  });
  expect(calls.some((call) => call.path === HISTORY_PATH)).toBe(false);
  const parsed = parseCollectionResult(result, new Date(), []);
  expect(parsed.artifacts.some((artifact) => artifact.dataset === "monthly-report-pdf")).toBe(true);
  expect(
    parsed.artifacts.some(
      (artifact) => artifact.filename === "raw-top-accounts-balance-and-activity.json",
    ),
  ).toBe(true);
  expect(parsed.failures).toEqual([
    {
      operation: "read:history",
      errorType: "ResponseSchemaError",
      message: "provider_response_invalid",
    },
  ]);
});
