import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCollectionResult } from "../src/local/windows-chrome-collector";

test("scheduled same-page reads serialize every savings account and retain successful accounts after a failed one", async () => {
  const source = readFileSync(`${import.meta.dir}/../container/server.mjs`, "utf8");
  const body = source.slice(
    source.indexOf("async function collectAuthenticatedReadsInPage("),
    source.indexOf("async function collect({"),
  );
  const run = new Function(`return (${body})`)() as (session: {
    authorization: string;
    csrfToken: string;
  }) => Promise<string>;
  const core = await Bun.file(`${import.meta.dir}/fixtures/core-responses.json`).json();
  const period = await Bun.file(
    `${import.meta.dir}/../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/savings-activity.json`,
  ).json();
  core.topBalances.responseParam.overview.responseParam.savingsDetails = [
    {
      accountNo: "000000000000001",
      currency: "JPY",
      productCode: "601",
      balance: "1000",
      yenEqui: "1000",
    },
    {
      accountNo: "000000000000002",
      currency: "JPY",
      productCode: "603",
      balance: "1000",
      yenEqui: "1000",
    },
    {
      accountNo: "000000000000003",
      currency: "USD",
      productCode: "621",
      balance: "10.00",
      yenEqui: "1000",
    },
  ];
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: any; token: string | undefined }> = [];
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
      else {
        expect(path).toBe("/SFC/app/IFAI_AccountAdapter/getCasaAccountActivitySpecificPeriod");
        expect(request.requestParam).toMatchObject({ type: "1", eventType: "3" });
        if (request.requestParam.accountNo === "000000000000002")
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
    });
    expect(maximum).toBe(1);
    const requests = calls.filter((call) =>
      call.path.endsWith("/getCasaAccountActivitySpecificPeriod"),
    );
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
  } finally {
    globalThis.fetch = original;
  }
});
