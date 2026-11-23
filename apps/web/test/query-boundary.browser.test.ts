// QueryBoundary's retry button against a synthetic server: pressing it keeps
// the keyboard focus on it while the read it repeats is in flight and after
// that read fails again, both on a page that has no answer yet and on one
// that keeps an earlier answer under its 前回読み込んだ warning
// (docs/frontend.md, docs/ui-guidelines.md#accessibility). The ホーム page
// is the subject: one read, labelled ホーム. Every value is synthetic.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { Overview } from "../../../packages/observation-shared/src/api-contract.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { auditPage } from "./a11y-audit.ts";
import { settledTest } from "./settle.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;

const overview: Overview = {
  counts: [{ table: "fetch_runs", rows: 7 }],
  sources: [],
  fetchRuns: [],
  parseRuns: [],
};

let browser: Browser;
if (runnable) browser = await chromium.launch({ executablePath });
const test = settledTest();

describe.if(runnable)("QueryBoundary's retry keeps the focus", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  // Whether the next overview read fails, as the App fails an unexpected one.
  let failing = false;
  let requested = 0;
  // While set, an overview read waits for it before it answers.
  let held: Promise<void> | null = null;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, sharedQuery: false },
          });
        if (url.pathname === "/api/overview") {
          requested += 1;
          if (held !== null) await held;
          return failing
            ? Response.json(
                { error: "internal_error", requestId: "req_synthetic" },
                { status: 500 },
              )
            : Response.json(overview);
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
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  /** Hold the next overview read; the returned function lets it answer. */
  const hold = (): (() => void) => {
    let release = (): void => {};
    held = new Promise((resolve) => (release = resolve));
    return () => {
      held = null;
      release();
    };
  };
  const waitForRead = async (before: number): Promise<void> => {
    const asked = (): boolean => requested > before;
    while (!asked()) await Bun.sleep(10);
  };
  const focusedName = (page: Page): Promise<string | null> =>
    page.evaluate(() =>
      document.activeElement instanceof HTMLButtonElement
        ? document.activeElement.getAttribute("aria-label")
        : (document.activeElement?.tagName ?? null),
    );

  test("a first load that failed: the alert and its focused button stay through a retry that fails again", async () => {
    failing = true;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      const alert = page.locator("main").getByRole("alert");
      const button = alert.getByRole("button", { name: "ホームを再試行", exact: true });
      await button.waitFor();
      await button.focus();
      const release = hold();
      const before = requested;
      await page.keyboard.press("Enter");
      await waitForRead(before);
      // In flight: the alert still stands, its button says it is waiting and
      // still holds the focus, and nothing else on the page is a loading state.
      await alert
        .getByRole("button", { name: "ホームを再試行中…", exact: true })
        .waitFor({ timeout: 2_000 });
      expect(await alert.getByRole("button").getAttribute("aria-disabled")).toBe("true");
      expect(await focusedName(page)).toBe("ホームを再試行中…");
      expect(await auditPage(page)).toEqual([]);
      // It fails again (after the client's one automatic retry): the focus
      // is still on the button, which can be pressed again.
      release();
      await alert.getByRole("button", { name: "ホームを再試行", exact: true }).waitFor();
      expect(await alert.getByRole("button").getAttribute("aria-disabled")).toBeNull();
      expect(await focusedName(page)).toBe("ホームを再試行");
      // The next press succeeds and the page shows the answer.
      failing = false;
      await page.keyboard.press("Enter");
      await page.getByText("収集の実行").first().waitFor();
      expect(await alert.count()).toBe(0);
    } finally {
      held = null;
      failing = false;
      await page.close();
    }
  }, 30_000);

  test("an earlier answer under its warning: the focused button stays through a retry that fails again", async () => {
    failing = false;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      await page.getByText("収集の実行").first().waitFor();
      failing = true;
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      const alert = page.locator("main").getByRole("alert");
      await alert
        .getByText("更新できませんでした。前回読み込んだホームを表示しています。")
        .waitFor();
      const button = alert.getByRole("button", { name: "ホームを再試行", exact: true });
      await button.focus();
      const release = hold();
      const before = requested;
      await page.keyboard.press("Enter");
      await waitForRead(before);
      await alert
        .getByRole("button", { name: "ホームを再試行中…", exact: true })
        .waitFor({ timeout: 2_000 });
      expect(await alert.getByRole("button").getAttribute("aria-disabled")).toBe("true");
      expect(await focusedName(page)).toBe("ホームを再試行中…");
      release();
      await alert.getByRole("button", { name: "ホームを再試行", exact: true }).waitFor();
      expect(await focusedName(page)).toBe("ホームを再試行");
      expect(await page.getByText("収集の実行").count()).toBeGreaterThan(0);
    } finally {
      held = null;
      failing = false;
      await page.close();
    }
  }, 30_000);
});
