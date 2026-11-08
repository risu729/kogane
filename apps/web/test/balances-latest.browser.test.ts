// The latest-balance read model's paging controls. Local synthetic responses
// only; exercises the production bundle without live accounts. What is proved
// here: "最新の状態に更新" reads the newest snapshot again from the first page
// too, where the cursor it resets to is the one already shown; and the page,
// which then holds the read model's pager beside the record list's, passes the
// accessibility audit on both measure views.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  CENTRAL_STORE_CAPABILITIES,
  withBalancesV2,
} from "../../../packages/observation-shared/src/api-schema.ts";
import { auditView } from "./a11y-audit.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable) {
  console.log("latest balances browser: production build and Chromium required");
  process.exitCode = 1;
}

/** One empty page of a snapshot; `complete` says whether anything is unresolved. */
function snapshotPage(snapshot: number, complete: boolean) {
  return {
    schemaVersion: "snapshot-page-v1",
    items: [],
    page: {
      limit: 50,
      hasMore: false,
      nextCursor: null,
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

describe.if(runnable)("latest balance read model paging", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  /** Each read of the first page is a newer snapshot: the first is partial, later ones complete. */
  let latestReads = 0;
  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
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
          latestReads += 1;
          return Response.json(snapshotPage(latestReads, latestReads > 1));
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
    browser = await chromium.launch({ executablePath });
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
