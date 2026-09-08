// Synthetic local server only; production bundle, no live browser or account.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApi } from "../src/api.ts";
import { buildFixture, HOSTILE_DESCRIPTION } from "./fixture.ts";
import type { ObservationOrganization } from "../shared/organization-contract.ts";

const client = join(import.meta.dir, "../web/dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("organization browser: build:production and Chromium required");
  if (!existsSync(join(client, "index.html")) || process.env["CI"] === "true") process.exitCode = 1;
}
const accountLabel = "整理済みの証券口座";
const securityLabel = '日本語銘柄 <img src=x onerror="alert(1)">';
const organization: ObservationOrganization = {
  state: "organized",
  lineage: "current",
  account: {
    referenceId: "account-reference",
    targetId: "account-target",
    label: accountLabel,
    status: "provider-local",
    revision: 2,
    method: "manual",
    reason: "synthetic-manual-evidence",
  },
  instruments: [
    {
      referenceId: "security-reference",
      targetId: "security-target",
      label: securityLabel,
      status: "provider-local",
      revision: 3,
      method: "rule",
      reason: "synthetic-security-evidence",
      role: "security",
      namespace: "ric",
      scope: "global",
      value: "EXAMPLE.N",
      nameEvidence: { reason: "observed-japanese-script", origin: { kind: "position", id: 1 } },
    },
    {
      referenceId: "unit-reference",
      targetId: "unit-target",
      label: "日本円",
      status: "identified",
      revision: 1,
      method: "rule",
      reason: "synthetic-unit-evidence",
      role: "unit",
      namespace: "iso4217",
      scope: "global",
      value: "JPY",
    },
  ],
};

describe.if(runnable)("organized observation labels", () => {
  const fixture = buildFixture();
  const current = fixture.store.db
    .query("SELECT id FROM transaction_observations WHERE description=?")
    .get(HOSTILE_DESCRIPTION) as { id: number };
  const position = fixture.store.db.query("SELECT id FROM position_observations LIMIT 1").get() as {
    id: number;
  };
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let detailMode: "organized" | "missing" | "unavailable" = "organized";
  beforeAll(async () => {
    const api = createApi(fixture.store);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "synthetic" },
            capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
          });
        if (url.pathname === "/api/filter-options")
          return Response.json({ sources: [], accounts: [], instruments: [], metrics: [] });
        if (url.pathname.startsWith("/api/")) {
          const response = await api.fetch(request);
          if (!response.ok || !response.headers.get("content-type")?.includes("json"))
            return response;
          const data = (await response.json()) as Record<string, any>;
          if (url.pathname === "/api/transactions")
            data.transactions = data.transactions.map((row: Record<string, unknown>) =>
              row.id === current.id ? { ...row, organization } : row,
            );
          if (url.pathname === "/api/balances") {
            data.latest = data.latest.map((row: Record<string, unknown>) => ({
              ...row,
              organization,
            }));
            data.history = data.history.map((row: Record<string, unknown>) => ({
              ...row,
              organization: { ...organization, lineage: "historical" },
            }));
          }
          if (url.pathname === "/api/positions")
            data.positions = data.positions.map((entry: Record<string, any>) => ({
              position: { ...entry.position, organization },
              valuations: entry.valuations.map((row: Record<string, unknown>) => ({
                ...row,
                organization,
              })),
            }));
          if (url.pathname.startsWith("/api/observations/")) {
            if (detailMode === "organized")
              data.organization = {
                ...organization,
                lineage:
                  data.provenance?.superseded_by_parse_run_id == null ? "current" : "historical",
              };
            if (detailMode === "unavailable")
              data.organization = {
                state: "unavailable",
                lineage: null,
                account: null,
                instruments: [],
              };
          }
          return Response.json(data);
        }
        return new Response(
          Bun.file(
            url.pathname.startsWith("/assets/")
              ? join(client, url.pathname)
              : join(client, "index.html"),
          ),
          {
            headers: {
              "content-security-policy":
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            },
          },
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    fixture.store.db.close();
  });

  test("all lists show organized names while preserving raw values and merchant text at both widths", async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => {
        errors.push(dialog.message());
        void dialog.dismiss();
      });
      await page.goto(origin + "/transactions");
      await page.getByText(accountLabel).first().waitFor({ timeout: 5000 });
      const row = page.locator("tbody tr").filter({ hasText: HOSTILE_DESCRIPTION });
      expect(await row.innerText()).toContain(securityLabel);
      expect(await row.innerText()).toContain("demo-bank:main");
      expect(await row.innerText()).toContain("取得元内で識別");
      const missing = page.locator("tbody tr").filter({ hasText: "Inbound transfer" });
      expect(await missing.innerText()).not.toContain(accountLabel);
      expect(await missing.innerText()).not.toContain("識別済み");
      await row.getByRole("link", { name: "詳細", exact: true }).click();
      await page.locator("#organization").waitFor();
      expect(await page.locator('section[aria-labelledby="organization"]').innerText()).toContain(
        securityLabel,
      );
      expect(await page.locator('section[aria-labelledby="stored-row"]').innerText()).toContain(
        HOSTILE_DESCRIPTION,
      );
      const facts = page.locator('section[aria-labelledby="organization"] .panel-body > .kv');
      expect(await facts.locator(":scope > dt").count()).toBe(3);
      expect(await facts.locator(":scope > dd").count()).toBe(3);
      for (let index = 0; index < 3; index++) {
        const label = await facts.locator(":scope > dt").nth(index).boundingBox();
        const value = await facts.locator(":scope > dd").nth(index).boundingBox();
        if (width === 390) {
          expect(value!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
          expect(Math.abs(label!.x - value!.x)).toBeLessThan(1);
        } else {
          expect(Math.abs(label!.y - value!.y)).toBeLessThan(1);
          expect(value!.x).toBeGreaterThan(label!.x);
        }
      }
      await page.goto(origin + "/balances");
      await page.getByText(accountLabel).first().waitFor({ timeout: 5000 });
      expect(await page.locator("main").innerText()).toContain("日本円");
      expect(await page.locator("main").innerText()).toContain("248,820");
      await page.goto(origin + "/positions");
      await page.locator("h2.security-name").first().waitFor();
      expect(await page.locator("h2.security-name").first().textContent()).toBe(securityLabel);
      expect(await page.locator(".position-facts").first().innerText()).toContain("Example <Fund>");
      expect(await page.locator(".position-valuations").first().innerText()).toContain(
        accountLabel,
      );
      expect(await page.locator(".position-valuations").first().innerText()).toContain(
        securityLabel,
      );
      expect(await page.locator("main img").count()).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 30000);

  test("detail exposes manual revision and name evidence without overwriting the stored row", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/observations/position/${position.id}`);
    await page.locator("#organization").waitFor();
    const panel = page.locator('section[aria-labelledby="organization"]');
    expect(await panel.innerText()).toContain("手動で整理 · 改訂 2");
    expect(await panel.innerText()).toContain("保存記録にある日本語表記");
    expect(await panel.getByRole("link", { name: "根拠の記録" }).getAttribute("href")).toBe(
      "/observations/position/1",
    );
    await panel.getByText("対応の根拠", { exact: true }).first().click();
    expect(await panel.innerText()).toContain("synthetic-manual-evidence");
    expect(await panel.innerText()).toContain("account-target");
    expect(await page.locator('section[aria-labelledby="stored-row"]').innerText()).toContain(
      "Example <Fund>",
    );
    expect(await page.locator('section[aria-labelledby="stored-row"]').innerText()).not.toContain(
      securityLabel,
    );
    await page.goto(`${origin}/observations/transaction/${fixture.retiredObservationId}`);
    await page.locator("#organization").waitFor();
    expect(await page.locator('section[aria-labelledby="organization"]').innerText()).toContain(
      "履歴の整理情報（現在の値ではありません）",
    );
    expect(await page.locator("main").innerText()).toContain("これは旧解析の記録です");
    await page.close();
  });

  test("missing and unavailable interpretations retain raw detail and make no identity claim", async () => {
    const page = await browser.newPage();
    try {
      for (const mode of ["missing", "unavailable"] as const) {
        detailMode = mode;
        await page.goto(`${origin}/observations/transaction/${current.id}`);
        await page.locator("#organization").waitFor();
        expect(await page.locator('section[aria-labelledby="organization"]').innerText()).toContain(
          "整理情報は利用できません",
        );
        expect(
          await page.locator('section[aria-labelledby="organization"]').innerText(),
        ).not.toContain("識別済み");
        expect(await page.locator('section[aria-labelledby="stored-row"]').innerText()).toContain(
          HOSTILE_DESCRIPTION,
        );
      }
    } finally {
      detailMode = "organized";
      await page.close();
    }
  });
});
