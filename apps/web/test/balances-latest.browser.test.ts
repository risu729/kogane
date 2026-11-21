// The latest-balance read model's paging controls. Local synthetic responses
// only; exercises the production bundle without live accounts. What is proved
// here: "最新の状態に更新" reads the newest snapshot again from the first page
// too, where the cursor it resets to is the one already shown; every pager
// button waits while a read is in flight; and the page,
// which then holds the read model's pager beside the record list's, passes the
// accessibility audit on both measure views.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  CENTRAL_STORE_CAPABILITIES,
  withBalancesV2,
} from "../../../packages/observation-shared/src/api-schema.ts";
import { auditView } from "./a11y-audit.ts";
import { settledTest } from "./settle.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("latest balances browser: production build and Chromium required");
  process.exitCode = 1;
}

/**
 * One empty page of a snapshot; `complete` says whether anything is
 * unresolved, `more` whether a further page follows.
 */
function snapshotPage(snapshot: number, complete: boolean, more = false) {
  return {
    schemaVersion: "snapshot-page-v1",
    items: [],
    page: {
      limit: 50,
      hasMore: more,
      nextCursor: more ? "synthetic-cursor-2" : null,
      snapshotId: `snapshot-synthetic-${String(snapshot)}`,
      paginationVersion: "keyset-v2",
    },
    dataCoverage: {
      completeness: complete ? "complete" : "partial",
      stale: false,
      reasons: [],
    },
    subtotals: {
      policyRelease: "synthetic-policy",
      knownAssetsSubtotal: null,
      liabilitiesCoverage: "unknown",
      reasonCode: "synthetic_reason",
    },
    interpretationContext: {
      mode: "latest",
      snapshotId: null,
      identityRelease: "synthetic",
      productCatalogueRelease: "synthetic",
      productResolverRelease: "synthetic",
      measurePolicyRelease: "synthetic",
      decimalPolicyRelease: "synthetic",
    },
  };
}

// Launched while the module loads, and only for a suite that runs: a timeout
// kills a browser a hook launched (test/settle.ts).
let browser: Browser;
if (runnable) browser = await chromium.launch({ executablePath });
const test = settledTest();

describe.if(runnable)("latest balance read model paging", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  /** Each read of the first page is a newer snapshot: the first is partial, later ones complete. */
  let latestReads = 0;
  /** Whether the first page says another follows. */
  let more = false;
  /** While set, every read of the read model waits for it. */
  let held: Promise<void> | null = null;
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
            capabilities: withBalancesV2(CENTRAL_STORE_CAPABILITIES, true),
          });
        if (url.pathname === "/api/filter-options")
          return Response.json({ sources: [], accounts: [], instruments: [], metrics: [] });
        if (url.pathname === "/api/balances") return Response.json({ latest: [], history: [] });
        if (url.pathname === "/api/v2/balances/latest") {
          // The page reads each row in full; the route's default is the summary (ADR 0123).
          if (url.searchParams.get("detail") !== "full")
            return Response.json({ error: "synthetic_summary_not_served" }, { status: 400 });
          latestReads += 1;
          if (held !== null) await held;
          const first = !url.searchParams.has("cursor");
          return Response.json(snapshotPage(latestReads, latestReads > 1, more && first));
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "synthetic_not_found" }, { status: 404 });
        return new Response(
          Bun.file(
            url.pathname.startsWith("/assets/")
              ? join(client, url.pathname)
              : join(client, "index.html"),
          ),
        );
      },
    });
    origin = `http://127.0.0.1:${String(server.port)}`;
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("refreshing from the first page reads the newest snapshot again", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/balances`);
      await page.getByText("未解決または更新のない記録があります").waitFor();
      const before = latestReads;
      await page.getByRole("button", { name: "最新の状態に更新" }).click();
      // The newer snapshot replaces the one shown; nothing else changed on the page.
      await page.getByText("この範囲で未解決の記録はありません").waitFor({ timeout: 10_000 });
      expect(latestReads).toBe(before + 1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("every pager button waits while a read is in flight", async () => {
    more = true;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/balances`);
      const pager = page.getByRole("group", { name: "項目ごとの最新の残高のページ", exact: true });
      const button = (name: string, disabled: boolean) =>
        pager.getByRole("button", { name, exact: true, disabled });
      await pager.getByText("続きがあります", { exact: false }).waitFor();
      await button("次のページ", false).waitFor();
      await button("前のページ", true).waitFor();
      let release = (): void => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const before = latestReads;
      // Pressed from the keyboard, so the focus it keeps is checked too.
      await button("最新の状態に更新", false).focus();
      await page.keyboard.press("Enter");
      await page.getByText("最新の残高を更新中…", { exact: false }).waitFor();
      // The read is held on the server: the earlier page stays, and no button pages from it.
      expect(latestReads).toBe(before + 1);
      for (const name of ["前のページ", "次のページ", "最新の状態に更新"])
        expect(await pager.getByRole("button", { name, exact: true }).isDisabled()).toBe(true);
      // Waiting never takes the focus away from the button the owner pressed.
      const focused = () => page.evaluate(() => document.activeElement?.textContent ?? null);
      expect(await focused()).toBe("最新の状態に更新");
      // A waiting button ignores a press: no second read starts, and no page turns.
      await page.keyboard.press("Enter");
      await pager.getByRole("button", { name: "次のページ", exact: true }).click({ force: true });
      expect(latestReads).toBe(before + 1);
      held = null;
      release();
      await button("次のページ", false).waitFor();
      await pager.getByText("続きがあります", { exact: false }).waitFor();
      expect(latestReads).toBe(before + 1);
      await button("次のページ", false).click();
      await pager.getByText("最後のページです", { exact: false }).waitFor();
      await button("次のページ", true).waitFor();
      await button("前のページ", false).click();
      await pager.getByText("続きがあります", { exact: false }).waitFor();
    } finally {
      held = null;
      more = false;
      await page.close();
    }
  }, 30_000);

  for (const [path, heading] of [
    ["/balances", "項目ごとの最新の残高"],
    ["/summaries", "項目ごとの最新の期間実績・請求"],
  ] as const)
    test(`${path} with the read model passes the accessibility audit`, async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}${path}`);
        await page.getByRole("heading", { level: 2, name: heading }).waitFor();
        // Two pagers on one page: each is named by the list it pages.
        expect(await auditView(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);
});
