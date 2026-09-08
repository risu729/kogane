// Local synthetic responses only; exercises the production bundle without live accounts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { classifyBalance } from "../shared/balance-semantics.ts";
import type { BalanceRow } from "../shared/api-contract.ts";

const client = join(import.meta.dir, "../web/dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("balance semantics browser: production build and Chromium required");
  process.exitCode = 1;
}

function row(
  id: number,
  source = "sbi-shinsei-bank",
  parser = "sbi-shinsei-yen-deposit-account",
  metric = "yen_deposit_account_balance",
  amount = "1234",
): BalanceRow {
  return {
    id,
    source_id: source,
    source_account: `${source}:synthetic`,
    parser: `${parser}@1`,
    metric,
    instrument: "JPY",
    amount_minor: amount,
    amount_text: null,
    as_of: "2026-09-08",
    observed_at: "2026-09-08T00:00:00Z",
  };
}
function interpreted(
  value: BalanceRow,
  evidence = [{ id: value.id, metric: value.metric }],
  conflict = false,
): BalanceRow {
  return {
    ...value,
    interpretation: {
      policyVersion: "balance-view-v1",
      semantic: classifyBalance({
        sourceId: value.source_id,
        sourceAccount: value.source_account,
        parserName: value.parser.split("@")[0]!,
        metric: value.metric,
      }),
      evidence,
      duplicateCount: evidence.length - 1,
      conflict,
    },
  };
}
const latest = [
  interpreted(row(101), [
    { id: 101, metric: "yen_deposit_account_balance" },
    { id: 102, metric: "yen_deposit_savings_balance" },
  ]),
  interpreted(row(103, undefined, undefined, undefined, "1000"), undefined, true),
  interpreted(
    row(104, undefined, undefined, "yen_deposit_savings_balance", "2000"),
    undefined,
    true,
  ),
  interpreted(
    row(
      105,
      "myjcb",
      "myjcb-credit-past-month-balances",
      "credit_statement_payment_amount",
      "5000",
    ),
  ),
  interpreted(row(106, "sony-bank", "sony-bank-gross-balance", "gross_loan_balance", "7000")),
  row(107, "unknown-provider", "future-parser", "future_metric"),
  row(108, "smbc-bank", "smbc-direct-balance", "account_balance"),
  {
    ...row(109, "v-point", "v-point-smfg-point", "displayed_point_balance", "88"),
    instrument: "V_POINT",
    as_of: null,
  },
];
const history = [row(101), row(102, undefined, undefined, "yen_deposit_savings_balance")].map(
  (value) => ({ ...value, superseded_by_parse_run_id: null, parse_status: "succeeded" }),
);

describe.if(runnable)("balance meaning and evidence display", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let large = false;
  let zeroCase = false;
  beforeAll(async () => {
    if (process.env["BALANCE_REVIEW_SCREENSHOTS"])
      mkdirSync(process.env["BALANCE_REVIEW_SCREENSHOTS"], { recursive: true });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "synthetic" },
            capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
          });
        if (path === "/api/filter-options")
          return Response.json({ sources: [], accounts: [], instruments: [], metrics: [] });
        if (path === "/api/balances")
          return Response.json({
            latest: zeroCase
              ? [
                  row(301, undefined, undefined, undefined, "0"),
                  row(302, undefined, undefined, undefined, "-1"),
                  { ...row(303), amount_minor: null, amount_text: "unknown" },
                  { ...row(306), instrument: "EUR", amount_minor: null, amount_text: "0.00" },
                  { ...row(307), instrument: "BTC", amount_minor: null, amount_text: "0.00000000" },
                  { ...row(308), instrument: "BTC", amount_minor: null, amount_text: "0.00000001" },
                ]
              : large
                ? Array.from({ length: 60 }, (_, i) =>
                    i % 2
                      ? row(1000 + i, "sony-bank", "sony-bank-gross-balance", "gross_asset_balance")
                      : row(1000 + i),
                  )
                : latest,
            history: zeroCase
              ? [
                  { ...history[0], id: 304, amount_minor: "0" },
                  { ...history[1], id: 305, amount_minor: null },
                  {
                    ...history[0],
                    id: 309,
                    instrument: "CAD",
                    amount_minor: null,
                    amount_text: "0.00",
                  },
                ]
              : history,
          });
        if (path.startsWith("/api/"))
          return Response.json({ error: "synthetic_not_found" }, { status: 404 });
        return new Response(
          Bun.file(path.startsWith("/assets/") ? join(client, path) : join(client, "index.html")),
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  for (const width of [390, 1280])
    test(`separates statement/reference amounts and preserves evidence/history at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(origin + "/balances");
        const assets = page.locator('section[aria-labelledby="balance-assets"]');
        const statements = page.locator('section[aria-labelledby="balance-statements"]');
        const reference = page.locator('section[aria-labelledby="balance-reference"]');
        await assets.waitFor();
        expect(await statements.count()).toBe(0);
        expect(await assets.innerText()).not.toContain("myjcb");
        expect(await reference.innerText()).toContain("借入区分集計");
        expect(await reference.innerText()).toContain("その他の観測額");
        expect(await page.locator('section[aria-labelledby="balance-liabilities"]').count()).toBe(
          0,
        );
        expect(await assets.locator("tbody tr").count()).toBe(4);
        expect(await assets.innerText()).toContain("smbc-bank:synthetic");
        await assets.getByText("同じ残高の根拠2件", { exact: true }).click();
        expect(
          await assets.getByRole("link", { name: "記録 #101", exact: true }).getAttribute("href"),
        ).toBe("/observations/balance/101");
        expect(
          await assets.getByRole("link", { name: "記録 #102", exact: true }).getAttribute("href"),
        ).toBe("/observations/balance/102");
        expect(
          await assets
            .getByText(
              "同じ残高の候補で金額・根拠が一致していません。各記録を別々に表示しています。",
              { exact: true },
            )
            .count(),
        ).toBe(2);
        expect(await assets.locator("tbody .col-amount").allTextContents()).toEqual([
          "1,234 JPY",
          "1,000 JPY",
          "2,000 JPY",
          "1,234 JPY",
        ]);
        await page.getByText("過去の残高・再解析の履歴", { exact: true }).click();
        const past = page.locator('section[aria-labelledby="balance-history"]');
        expect(await past.locator("tbody tr").count()).toBe(2);
        expect(await past.locator("tbody .col-amount").allTextContents()).toEqual([
          "1,234 JPY",
          "1,234 JPY",
        ]);
        expect(await past.locator(".balance-evidence").count()).toBe(0);
        expect(await reference.locator(".balance-evidence").count()).toBe(0);
        await page.getByRole("link", { name: "期間実績・請求を見る", exact: true }).click();
        await statements.waitFor();
        expect(await assets.count()).toBe(0);
        expect(await statements.innerText()).toContain("請求額（未払残高ではありません）");
        expect(await statements.locator("tbody .col-amount").innerText()).toBe("5,000 JPY");
        expect(
          await statements
            .locator("tbody .amount")
            .evaluate((element) => getComputedStyle(element).color),
        ).toBe("rgb(37, 43, 41)");
        const earned = page.locator('section[aria-labelledby="balance-period-totals"]');
        expect(await earned.innerText()).toContain("先月の獲得ポイント");
        expect(await earned.innerText()).toContain("先月分（対象年月は未特定）");
        expect(await earned.locator("tbody .col-amount").innerText()).toBe(
          "88 V_POINT (minor units)",
        );
        if (process.env["BALANCE_REVIEW_SCREENSHOTS"])
          await page.screenshot({
            path: join(process.env["BALANCE_REVIEW_SCREENSHOTS"], `balance-semantics-${width}.png`),
            fullPage: true,
          });
      } finally {
        await page.close();
      }
    });

  test("one shared 50-row pager spans all semantic panels", async () => {
    const page = await browser.newPage();
    try {
      large = true;
      await page.goto(origin + "/balances");
      const current = page.getByRole("region", { name: "項目ごとの最新の記録", exact: true });
      await current.locator("tbody tr").first().waitFor();
      expect(await current.locator("tbody tr").count()).toBe(50);
      expect(await current.locator(".pagination").count()).toBe(1);
      expect(await current.innerText()).toContain("60件中 1–50件");
      await current.getByRole("button", { name: "次へ", exact: true }).click();
      expect(await current.locator("tbody tr").count()).toBe(10);
      expect(await current.innerText()).toContain("60件中 51–60件");
    } finally {
      large = false;
      await page.close();
    }
  });
  test("zero toggle preserves unknown and negative amounts and applies to history", async () => {
    const page = await browser.newPage();
    try {
      zeroCase = true;
      await page.goto(origin + "/balances");
      const current = page.getByRole("region", { name: "項目ごとの最新の記録", exact: true });
      await current.locator("tbody tr").first().waitFor();
      expect(await current.locator("tbody tr").count()).toBe(6);
      await page.getByLabel("残高0を除外", { exact: true }).check();
      expect(await current.locator("tbody tr").count()).toBe(3);
      expect(await current.locator('a[href="/observations/balance/301"]').count()).toBe(0);
      expect(await current.locator('a[href="/observations/balance/302"]').count()).toBe(1);
      expect(await current.locator('a[href="/observations/balance/303"]').count()).toBe(1);
      expect(await current.locator('a[href="/observations/balance/306"]').count()).toBe(0);
      expect(await current.locator('a[href="/observations/balance/307"]').count()).toBe(0);
      expect(await current.locator('a[href="/observations/balance/308"]').count()).toBe(1);
      await page.getByText("過去の残高・再解析の履歴", { exact: true }).click();
      expect(await page.locator('a[href="/observations/balance/304"]').count()).toBe(0);
      expect(await page.locator('a[href="/observations/balance/305"]').count()).toBe(1);
      expect(await page.locator('a[href="/observations/balance/309"]').count()).toBe(0);
      await page.getByLabel("残高0を除外", { exact: true }).uncheck();
      expect(await current.locator("tbody tr").count()).toBe(6);
    } finally {
      zeroCase = false;
      await page.close();
    }
  });
});
