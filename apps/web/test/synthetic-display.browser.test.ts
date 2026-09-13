import { expect, test } from "bun:test";
import { join } from "node:path";
import { chromium } from "playwright";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

test("synthetic sources never mount financial, evidence or command views", async () => {
  const client = join(import.meta.dir, "../dist-production");
  const dataRequests: string[] = [];
  let metadataRequests = 0;
  let heldRefresh: Promise<void> | undefined;
  let releaseRefresh: (() => void) | undefined;
  const refreshReceived = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/meta") {
        metadataRequests++;
        if (heldRefresh) {
          refreshReceived.resolve();
          await heldRefresh;
        }
        return Response.json({
          apiVersion: 1,
          source: { kind: "central-store", classification: "synthetic" },
          capabilities: { ...CENTRAL_STORE_CAPABILITIES, commands: true },
        });
      }
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
    const requestsBeforeRefresh = metadataRequests;
    heldRefresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshButton = page.locator(".refresh-button");
    await refreshButton.click();
    await refreshReceived.promise;
    await page.getByRole("button", { name: "更新中…" }).waitFor();
    expect(await refreshButton.getAttribute("aria-disabled")).toBe("true");
    expect(await refreshButton.evaluate((button) => document.activeElement === button)).toBe(true);
    // ARIA keeps the button focusable; the handler must suppress repeated
    // keyboard activation while the metadata request is still in flight.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    releaseRefresh?.();
    await page.getByRole("button", { name: "表示を更新" }).waitFor();
    expect(await refreshButton.getAttribute("aria-disabled")).toBe("false");
    expect(await refreshButton.evaluate((button) => document.activeElement === button)).toBe(true);
    expect(metadataRequests).toBe(requestsBeforeRefresh + 1);
    expect(dataRequests).toEqual([]);
  } finally {
    releaseRefresh?.();
    await browser.close();
    server.stop(true);
  }
}, 30_000);
