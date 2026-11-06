// 口座・銘柄の整理 in the production client: the per-source coverage read
// (`/api/identity/coverage`) next to the organized account and instrument
// lists, against synthetic answers the shared validator accepts. The page
// shows each source's counts as served, derives only 未処理 (eligible minus
// organized) per row, adds no row across sources, and refuses a coverage
// answer whose status counts do not add up instead of showing its numbers.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import type {
  IdentityAccountRow,
  IdentityCoverageRow,
  IdentityInstrumentRow,
} from "../../../packages/observation-shared/src/identity-contract.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

const COVERAGE: IdentityCoverageRow[] = [
  {
    source: "synthetic-bank",
    eligible: 7,
    organized: 5,
    identified: 2,
    providerLocal: 1,
    aggregate: 0,
    unresolved: 2,
  },
  {
    source: "synthetic-broker",
    eligible: 3,
    organized: 3,
    identified: 0,
    providerLocal: 3,
    aggregate: 0,
    unresolved: 0,
  },
];
const ACCOUNTS: IdentityAccountRow[] = [
  {
    referenceId: "synthetic-ref-1",
    targetId: "synthetic-account-1",
    label: "合成口座A",
    role: "deposit",
    status: "identified",
    source: "synthetic-bank",
    reference: '["synthetic-a"]',
    reason: "synthetic-rule",
    revision: 1,
    observedCount: 3,
    origin: { kind: "balance", id: 11 },
  },
  {
    referenceId: "synthetic-ref-2",
    targetId: "synthetic-account-2",
    label: "合成口座B",
    role: "deposit",
    status: "unresolved",
    source: "synthetic-bank",
    reference: '["synthetic-b"]',
    reason: "synthetic-unresolved",
    revision: 2,
    observedCount: 2,
    origin: { kind: "transaction", id: 12 },
  },
];
const INSTRUMENTS: IdentityInstrumentRow[] = [
  {
    referenceId: "synthetic-identifier-1",
    targetId: "synthetic-instrument-1",
    label: "合成銘柄",
    kind: "security",
    status: "unresolved",
    source: "synthetic-broker",
    namespace: "synthetic-code",
    scope: "synthetic-market",
    value: "0000",
    reason: "synthetic-unresolved",
    revision: 1,
    observedCount: 3,
    origin: { kind: "position", id: 13 },
  },
];
const page = <T>(rows: T[]) => ({
  rows,
  coverage: { limit: 100, nextOffset: null, truncated: false },
});

describe.if(runnable)("identity coverage page", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let broken = false;
  const requests: { method: string; url: URL }[] = [];
  const bodies: Record<string, unknown> = {};

  beforeEach(() => {
    broken = false;
    requests.length = 0;
  });
  beforeAll(async () => {
    bodies["/api/identity/connections"] = { connections: [] };
    bodies["/api/identity/coverage"] = page(COVERAGE);
    bodies["/api/identity/accounts"] = page(ACCOUNTS);
    bodies["/api/identity/instruments"] = page(INSTRUMENTS);
    // The fixtures are answers the client's own validator accepts.
    for (const [path, body] of Object.entries(bodies))
      if (!validApiResponse(path, body)) throw new Error(`invalid fixture: ${path}`);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        if (url.pathname.startsWith("/api/identity/")) {
          requests.push({ method: request.method, url });
          if (url.pathname === "/api/identity/coverage") {
            const source = url.searchParams.get("source");
            const rows = COVERAGE.filter((row) => source === null || row.source === source);
            // organized no longer equals the sum of its status counts.
            if (broken) return Response.json(page(rows.map((row) => ({ ...row, organized: 4 }))));
            return Response.json(page(rows));
          }
          const body = bodies[url.pathname];
          return body
            ? Response.json(body)
            : Response.json({ error: "not_found" }, { status: 404 });
        }
        if (url.pathname.startsWith("/api/")) {
          requests.push({ method: request.method, url });
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        const file = Bun.file(join(client, url.pathname === "/" ? "/index.html" : url.pathname));
        return (await file.exists())
          ? new Response(file)
          : new Response(Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function open(width = 1280) {
    const tab = await browser.newPage({ viewport: { width, height: 1000 } });
    await tab.goto(`${origin}/identities`);
    await tab.getByRole("heading", { name: "口座・銘柄の整理", exact: true }).waitFor();
    await tab.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    return tab;
  }
  const coverageRegion = (tab: Awaited<ReturnType<typeof open>>) =>
    tab.getByRole("region", { name: "口座の整理状況" });

  test("the navigation reaches the page and each source shows its served counts", async () => {
    const tab = await open();
    expect(
      await tab.getByRole("link", { name: "口座・銘柄", exact: true }).getAttribute("href"),
    ).toBe("/identities");
    await coverageRegion(tab).waitFor();
    const rows = coverageRegion(tab).locator("tbody tr");
    expect(await rows.count()).toBe(2);
    const cells = async (index: number) =>
      (await rows.nth(index).locator("td").allInnerTexts()).map((text) => text.trim());
    // 取得元, 対象記録, 整理済み, 識別済み, 取得元内, 集計, 要確認, 未処理 (eligible - organized).
    expect(await cells(0)).toEqual(["synthetic-bank", "7", "5", "2", "1", "0", "2", "2"]);
    expect(await cells(1)).toEqual(["synthetic-broker", "3", "3", "0", "3", "0", "0", "0"]);
    // No row adds sources together.
    expect(await coverageRegion(tab).locator("tfoot").count()).toBe(0);
    expect(await coverageRegion(tab).innerText()).not.toContain("10");
    const note = await tab.getByRole("region", { name: "整理状況", exact: true }).innerText();
    expect(note).toContain("銘柄の照合率ではありません");
    // Every request is a GET of an identity read; nothing else is asked.
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(requests.every((entry) => entry.url.pathname.startsWith("/api/identity/"))).toBe(true);
    await tab.close();
  }, 30_000);

  test("unresolved accounts and instruments are marked, not counted as identified", async () => {
    const tab = await open();
    const accounts = tab
      .getByRole("region", { name: "整理済みの口座", exact: true })
      .locator(".identity-card");
    await accounts.first().waitFor();
    expect(await accounts.count()).toBe(2);
    expect(await accounts.nth(0).innerText()).toContain("識別済み");
    expect(await accounts.nth(1).innerText()).toContain("要確認");
    await tab.getByRole("button", { name: "通貨・銘柄", exact: true }).click();
    await tab.getByRole("heading", { name: "整理済みの通貨・銘柄", exact: true }).waitFor();
    const instrument = tab
      .getByRole("region", { name: "整理済みの通貨・銘柄", exact: true })
      .locator(".identity-card")
      .first();
    await instrument.getByText("合成銘柄").waitFor();
    expect(await instrument.innerText()).toContain("要確認");
    await tab.close();
  }, 30_000);

  test("filtering by source narrows the coverage read and the list", async () => {
    const tab = await open();
    await coverageRegion(tab).waitFor();
    await tab.getByRole("textbox", { name: "取得元", exact: true }).fill("synthetic-broker");
    await tab.getByRole("button", { name: "絞り込む", exact: true }).click();
    await coverageRegion(tab).locator("tbody tr").nth(1).waitFor({ state: "detached" });
    expect(await coverageRegion(tab).locator("tbody tr").count()).toBe(1);
    const coverage = requests.filter((entry) => entry.url.pathname === "/api/identity/coverage");
    expect(coverage.at(-1)?.url.searchParams.get("source")).toBe("synthetic-broker");
    expect(coverage.at(-1)?.url.searchParams.get("offset")).toBe("0");
    await tab.close();
  }, 30_000);

  test("counts that do not add up are refused instead of shown", async () => {
    broken = true;
    const tab = await open();
    await tab.getByText("整理状況を読み込めませんでした", { exact: false }).waitFor();
    expect(await tab.getByRole("region", { name: "口座の整理状況" }).count()).toBe(0);
    await tab.close();
  }, 30_000);

  test("the page fits a phone width without sideways page scroll", async () => {
    const tab = await open(390);
    await coverageRegion(tab).waitFor();
    await tab.locator(".identity-card").first().waitFor();
    expect(
      await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    // The wide table scrolls inside its own region instead.
    expect(await coverageRegion(tab).getAttribute("tabindex")).toBe("0");
    await tab.close();
  }, 30_000);
});
