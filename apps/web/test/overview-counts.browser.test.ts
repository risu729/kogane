import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { Overview } from "../../../packages/observation-shared/src/api-contract.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

// Synthetic sources and runs only. The overview's run list is the newest
// window, not the whole history, so its length is not the run count.
const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;

const overview: Overview = {
  counts: [],
  sources: [
    { id: "synthetic-bank", provider: "Synthetic Bank", ingestion: "synthetic", artifact_count: 2 },
  ],
  fetchRuns: [1, 2, 3].map((id) => ({
    id,
    source_id: "synthetic-bank",
    tool: "synthetic-collector",
    external_run_id: null,
    status: "ok",
    started_at: "2026-09-08T00:00:00Z",
    completed_at: null,
  })),
  parseRuns: [],
};

describe.if(runnable)("overview summary counts from the shared query service", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let release!: () => void;
  let held: Promise<void>;
  beforeAll(async () => {
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
        if (url.pathname === "/api/overview") return Response.json(overview);
        if (url.pathname === "/api/v2/query") {
          await held;
          return Response.json({ error: "unavailable" }, { status: 503 });
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
    release?.();
    await browser?.close();
    server?.stop(true);
  });

  test("an advertised service that has not answered never yields page-local counts", async () => {
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      await page.getByRole("heading", { name: "最近の収集履歴", exact: true }).waitFor();
      // Still waiting for the service: no figure, in particular not the
      // length of the newest-runs window.
      expect(await page.locator(".overview-stat-value").count()).toBe(0);
      release();
      await page
        .getByRole("alert")
        .filter({ hasText: "件数の集計を読み込めませんでした" })
        .waitFor({ timeout: 10_000 });
      expect(await page.locator(".overview-stat-value").count()).toBe(0);
      // The rest of the overview stays readable.
      expect(await page.getByRole("cell", { name: "synthetic-bank" }).count()).toBe(3);
    } finally {
      release();
      await page.close();
    }
  }, 30_000);
});
