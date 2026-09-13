import { expect, test } from "bun:test";
import { join } from "node:path";
import { chromium } from "playwright";
import { classifyActivity } from "../../../packages/observation-shared/src/activity-semantics.ts";
import type { TransactionRow } from "../../../packages/observation-shared/src/api-contract.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
test("activity page distinguishes positive withdrawals, card payments, and quantity-only trades", async () => {
  const client = join(import.meta.dir, "../dist-production");
  const base: TransactionRow = {
    id: 1,
    source_id: "sbi-securities",
    source_account: "synthetic",
    parser: "sbi-yen-detail-history@1",
    amount_minor: "300",
    amount_text: "300",
    currency: "JPY",
    as_of: "2026-09-08",
    description: "Synthetic withdrawal",
    counterparty: null,
    external_id: null,
    status: "posted",
  };
  const rows: TransactionRow[] = [
    {
      ...base,
      interpretation: classifyActivity({
        sourceId: base.source_id,
        parserName: "sbi-yen-detail-history",
        status: "posted",
        extra: { _kogane: { direction: "debit" } },
      }),
    },
    {
      ...base,
      id: 2,
      source_id: "myjcb",
      parser: "myjcb-credit-ledger@1",
      amount_minor: "-300",
      status: "confirmed",
      interpretation: classifyActivity({
        sourceId: "myjcb",
        parserName: "myjcb-credit-ledger",
        status: "confirmed",
        extra: { _kogane: { amountBasis: "current-statement-payment", period: "2026-09" } },
      }),
    },
    {
      ...base,
      id: 3,
      source_id: "sbi-vc-trade",
      parser: "sbi-vc-executions@1",
      amount_minor: null,
      amount_text: null,
      status: null,
      interpretation: classifyActivity({
        sourceId: "sbi-vc-trade",
        parserName: "sbi-vc-executions",
        status: null,
        extra: {
          _kogane: {
            direction: "buy",
            quantity: { text: "0.0001", currency: "BTC" },
            price: { text: "9999999", currency: "JPY" },
          },
        },
      }),
    },
  ];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/meta")
        return Response.json({
          apiVersion: 1,
          source: { kind: "central-store", classification: "financial" },
          capabilities: CENTRAL_STORE_CAPABILITIES,
        });
      if (path === "/api/filter-options") return Response.json({ sources: [], accounts: [] });
      if (path === "/api/transactions") return Response.json({ transactions: rows });
      return new Response(
        Bun.file(path.startsWith("/assets/") ? join(client, path) : join(client, "index.html")),
      );
    },
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`http://127.0.0.1:${server.port}/transactions`);
      const table = page.locator(".transaction-table");
      await table.locator("tbody tr").first().waitFor();
      const body = await table.innerText();
      for (const label of [
        "出金",
        "今回の支払額",
        "利用日",
        "請求確定",
        "明細の期間表示",
        "0.0001 BTC",
        "9999999 JPY",
        "金額未記録",
      ])
        expect(body).toContain(label);
      expect(await table.locator(".amount-pos,.amount-neg").count()).toBe(0);
      expect(body).not.toContain("記帳済み");
      await page.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
});
