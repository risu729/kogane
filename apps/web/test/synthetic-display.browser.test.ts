import { expect, test } from "bun:test";
import { join } from "node:path";
import { chromium } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

test("synthetic sources never mount financial, evidence or command views", async () => {
  const client = join(import.meta.dir, "../dist-production");
  const dataRequests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/meta")
        return Response.json({
          apiVersion: 1,
          source: { kind: "central-store", classification: "synthetic" },
          capabilities: { ...CENTRAL_STORE_CAPABILITIES, commands: true },
        });
      if (path.startsWith("/api/")) {
        dataRequests.push(path);
        return Response.json({ error: "unexpected_fixture_request" }, { status: 500 });
      }
      return new Response(
        Bun.file(path.startsWith("/assets/") ? join(client, path) : join(client, "index.html")),
      );
    },
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  });
  try {
    const page = await browser.newPage();
    for (const path of [
      "/",
      "/transactions",
      "/balances",
      "/summaries",
      "/positions",
      "/artifacts",
      "/artifacts/1",
      "/observations/transaction/1",
      "/identities",
      "/rewards",
      "/evidence",
      "/runs/fixture",
      `/confirm/${"a".repeat(64)}`,
    ]) {
      await page.goto(`http://127.0.0.1:${server.port}${path}`);
      await page.getByRole("heading", { name: "表示対象の記録がありません" }).waitFor();
      expect(await page.locator("main table, main form, main .parsing-health-notice").count()).toBe(
        0,
      );
      expect(await page.locator("main").innerText()).toBe(
        "表示対象の記録がありません\n\n接続先を確認してください。",
      );
    }
    await page.getByRole("link", { name: "取引", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.tagName === "H1");
    expect(await page.title()).toBe("表示対象の記録がありません | kogane");
    await page.getByRole("button", { name: "表示を更新" }).click();
    await page.getByRole("button", { name: "表示を更新" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");
    expect(dataRequests).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30_000);
