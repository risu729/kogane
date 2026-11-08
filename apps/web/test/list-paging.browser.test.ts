import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type {
  PositionWithValuations,
  TransactionRow,
} from "../../../packages/observation-shared/src/api-contract.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

// Synthetic rows only: invented sources, accounts, amounts and dates.
const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;

function transaction(id: number): TransactionRow {
  return {
    id,
    source_id: "synthetic-bank",
    source_account: "synthetic-account",
    parser: "synthetic-parser@1",
    amount_minor: "100",
    amount_text: "100",
    currency: "JPY",
    as_of: "2026-09-08",
    description: `Synthetic row ${String(id)}`,
    counterparty: null,
    external_id: null,
    status: "posted",
  };
}

function position(id: number): PositionWithValuations {
  return {
    position: {
      id,
      source_id: "synthetic-broker",
      source_account: "synthetic-account",
      security_code: `SYN${String(id)}`,
      security_name: null,
      market: null,
      quantity_text: "1",
      quantity_scale: 0,
      currency: "JPY",
      as_of: "2026-09-08",
      parser: "synthetic-parser@1",
    },
    valuations: [],
  };
}

/** Two server windows: the first is truncated with a next offset, the second is not. */
function window<T>(offset: string | null, make: (id: number) => T) {
  const first = offset === null;
  const ids = first
    ? Array.from({ length: 500 }, (_, index) => index + 1)
    : Array.from({ length: 120 }, (_, index) => index + 501);
  return {
    rows: ids.map(make),
    coverage: { limit: 500, truncated: first, nextOffset: first ? 500 : null },
  };
}

describe.if(runnable)("in-memory pages follow the server window", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const offset = url.searchParams.get("offset");
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        if (url.pathname === "/api/filter-options")
          return Response.json({ sources: [], accounts: [], instruments: [], metrics: [] });
        if (url.pathname === "/api/transactions") {
          const { rows, coverage } = window(offset, transaction);
          return Response.json({ transactions: rows, coverage });
        }
        if (url.pathname === "/api/positions") {
          const { rows, coverage } = window(offset, position);
          return Response.json({ positions: rows, coverage });
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        return new Response(
          Bun.file(
            url.pathname.startsWith("/assets/")
              ? join(client, url.pathname)
              : join(client, "index.html"),
          ),
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function status(page: Page, text: string): Promise<void> {
    await page
      .getByRole("status")
      .filter({ hasText: /件中/u })
      .filter({ hasText: text })
      .waitFor({ timeout: 10_000 });
  }

  for (const [path, label] of [
    ["/transactions", "取引"],
    ["/positions", "保有資産"],
  ] as const)
    test(`${label}: the next server window opens at its first page`, async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}${path}`);
        await status(page, "500件中 1–50件");
        await page.getByRole("button", { name: "次へ", exact: true }).click();
        await status(page, "500件中 51–100件");
        await page.getByRole("link", { name: "次の500件", exact: true }).click();
        // The window that starts at offset 500 is shown from its own first row,
        // not from the in-memory page the previous window was on.
        await status(page, "120件中 1–50件");
        expect(await page.getByText("1 / 3", { exact: true }).count()).toBe(1);
        // Visiting a record and coming back keeps the page within one window.
        await page.getByRole("button", { name: "次へ", exact: true }).click();
        await status(page, "120件中 51–100件");
        await page
          .getByRole("link", { name: path === "/transactions" ? "詳細" : "詳細・原本を確認" })
          .first()
          .click();
        await page.waitForURL(/\/observations\//u);
        await page.goBack();
        await status(page, "120件中 51–100件");
      } finally {
        await page.close();
      }
    }, 30_000);
});
