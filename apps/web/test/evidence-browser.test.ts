// Synthetic production-contract responses only. No collector, store or raw
// financial body is opened by this browser suite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type {
  EvidenceArtifactDetail,
  EvidenceArtifactList,
  EvidenceMeta,
  EvidenceRun,
  EvidenceRunList,
} from "../../../packages/observation-shared/src/evidence-contract.ts";

const CLIENT = join(import.meta.dir, "..", "dist-evidence");
const configuredBrowser = process.env["CHROMIUM_PATH"];
const executablePath =
  configuredBrowser && existsSync(configuredBrowser)
    ? configuredBrowser
    : chromium.executablePath();
const built = existsSync(join(CLIENT, "index.html"));
const runnable = built && existsSync(executablePath);
async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env["EVIDENCE_SCREENSHOT_DIR"];
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}
if (!runnable) {
  console.log(
    `production evidence browser tests skipped: ${built ? "Chromium missing" : "run build:evidence first"}`,
  );
  if (!built || process.env["CI"] === "true") process.exitCode = 1;
}

const stamp = "2026-09-05T01:02:03.000Z";
const run: EvidenceRun = {
  id: "r_2",
  sourceId: "sony-bank",
  producerId: "synthetic-collector",
  recordedAt: stamp,
  sealedAt: "2026-09-05T01:02:04.000Z",
  outcome: "partial",
  startedAt: "2026-09-04T22:00:00.000Z",
  startedAtBasis: "manifest",
  completedAt: null,
  completedAtBasis: null,
  artifactCount: 2,
};
const meta: EvidenceMeta = {
  apiVersion: "evidence-v1",
  source: { kind: "central-raw-store", classification: "financial" },
  capabilities: {
    readOnly: true,
    rawEvidence: true,
    parsedObservations: false,
    liveCollectors: false,
  },
  sources: [
    { id: "sony-bank", label: "ソニー銀行（テスト）" },
    { id: "empty-bank", label: "空の取得元（テスト）" },
  ],
};
const detail: EvidenceArtifactDetail = {
  apiVersion: "evidence-v1",
  run,
  artifact: {
    id: "a_1",
    runId: run.id,
    artifactKey: "fixture-response",
    role: "provider_response",
    payloadFidelity: "exact",
    dataset: "SYNTHETIC <script>window.__evidenceXss=true</script>",
    sha256: "a".repeat(64),
    descriptorSha256: "b".repeat(64),
    byteSize: 123,
    recordedAt: stamp,
    containerKind: "single",
    lineageDisposition: "not_applicable",
    formatId: "fixture-html",
    formatVersion: "1",
    declaredMediaType: "text/html",
  },
};

describe.if(runnable)("production evidence navigation", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  let origin: string;
  let runStatus = 200;
  let metadataStatus = 200;
  let rawRequests = 0;
  let loginRequests = 0;
  const requests: string[] = [];

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/")) requests.push(url.pathname + url.search);
        if (url.pathname === "/private-login") loginRequests++;
        if (url.pathname === "/api/evidence/v1/meta") {
          return metadataStatus === 200
            ? Response.json(meta)
            : new Response("PRIVATE_AUTH_RESPONSE", { status: metadataStatus });
        }
        if (url.pathname.endsWith("/raw")) {
          rawRequests++;
          return new Response("Raw bodies must not be fetched by this suite", { status: 418 });
        }
        if (
          url.pathname.startsWith("/api/evidence/v1/sources/") &&
          url.pathname.endsWith("/runs")
        ) {
          if (runStatus === 302)
            return new Response(null, { status: 302, headers: { location: "/private-login" } });
          if (runStatus !== 200) return new Response("PRIVATE_RUN_RESPONSE", { status: runStatus });
          const sourceId = url.pathname.split("/")[5]!;
          const nextPage = url.searchParams.get("cursor") === "runs_next";
          const value: EvidenceRunList = {
            apiVersion: "evidence-v1",
            sourceId,
            coverage: "sealed-only",
            items:
              sourceId === "empty-bank"
                ? []
                : [
                    {
                      ...run,
                      ...(nextPage ? { id: "r_1" as const, outcome: "failed" as const } : {}),
                    },
                  ],
            nextCursor: sourceId === "sony-bank" && !nextPage ? "runs_next" : null,
          };
          return Response.json(value);
        }
        if (url.pathname === "/api/evidence/v1/runs/r_2/artifacts") {
          const nextPage = url.searchParams.get("cursor") === "artifacts_next";
          const value: EvidenceArtifactList = {
            apiVersion: "evidence-v1",
            run,
            items: [
              nextPage
                ? {
                    ...detail.artifact,
                    id: "a_2",
                    role: "collector_manifest",
                    payloadFidelity: "generated",
                    dataset: "収集内容一覧（テスト）",
                  }
                : detail.artifact,
            ],
            nextCursor: nextPage ? null : "artifacts_next",
          };
          return Response.json(value);
        }
        if (url.pathname === "/api/evidence/v1/runs/r_2/artifacts/a_1")
          return Response.json(detail);
        if (url.pathname.startsWith("/api/"))
          return new Response("Unexpected API", { status: 404 });
        const candidate = join(CLIENT, url.pathname);
        if (
          url.pathname.startsWith("/assets/") &&
          candidate.startsWith(CLIENT) &&
          (await Bun.file(candidate).exists())
        )
          return new Response(Bun.file(candidate));
        return new Response(Bun.file(join(CLIENT, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("server pages, source filter and provenance walk keep raw bytes as download-only links", async () => {
    runStatus = metadataStatus = 200;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin, { waitUntil: "networkidle" });
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toBe("取得履歴と原本");
    expect(await page.locator("body").innerText()).toContain("解析結果はまだ提供していません");
    expect(await page.locator("tbody").innerText()).toContain("一部取得");
    expect(await page.locator("tbody").innerText()).toContain("保存済み");
    expect(await page.locator("tbody").innerText()).toContain("日時の根拠：収集記録");
    await screenshot(page, "evidence-desktop-history");
    await page.getByRole("button", { name: "次のページ", exact: true }).click();
    await page.getByText("収集失敗", { exact: true }).waitFor();
    expect(requests).toContain("/api/evidence/v1/sources/sony-bank/runs?cursor=runs_next");
    expect(await page.getByRole("button", { name: "次のページ", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.getByRole("button", { name: "前のページ", exact: true }).click();
    await page.getByText("一部取得", { exact: true }).waitFor();
    await page.getByLabel("取得元", { exact: true }).selectOption("empty-bank");
    await page.getByText("このページに保存済みの記録はありません。", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "前のページ", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.getByLabel("取得元", { exact: true }).selectOption("sony-bank");
    await page.getByRole("link", { name: /保存ファイルを見る/u }).click();
    await page.getByRole("heading", { name: "保存ファイル", exact: true }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    expect(await page.locator("body").innerText()).toContain("収集完了の記録");
    await page.getByRole("button", { name: "次のページ", exact: true }).click();
    await page.getByText("収集内容一覧（テスト）", { exact: true }).waitFor();
    expect(await page.locator("tbody").innerText()).toContain("生成された記録");
    expect(requests).toContain("/api/evidence/v1/runs/r_2/artifacts?cursor=artifacts_next");
    await page.getByRole("button", { name: "前のページ", exact: true }).click();
    await page.getByRole("link", { name: /ファイルの詳細/u }).click();
    const download = page.getByRole("link", { name: "保存ファイルをダウンロード", exact: true });
    await download.waitFor();
    await screenshot(page, "evidence-desktop-detail");
    expect(await download.getAttribute("href")).toBe("/api/evidence/v1/runs/r_2/artifacts/a_1/raw");
    expect(await download.getAttribute("download")).not.toBeNull();
    expect(await page.locator("body").innerText()).toContain(detail.artifact.dataset!);
    expect(
      await page.evaluate(() => (window as Window & { __evidenceXss?: boolean }).__evidenceXss),
    ).toBeUndefined();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(rawRequests).toBe(0);
    expect(requests.every((request) => request.startsWith("/api/evidence/v1/"))).toBe(true);
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("authentication failures hide cached records and retry restores the same view", async () => {
    runStatus = metadataStatus = 200;
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    runStatus = 401;
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.locator("tbody").count()).toBe(0);
    expect(await page.getByRole("alert").innerText()).toContain("認証が必要");
    expect(await page.locator("body").innerText()).not.toContain("PRIVATE_RUN_RESPONSE");
    runStatus = 200;
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await page.getByText("一部取得", { exact: true }).waitFor();
    metadataStatus = 403;
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.locator("tbody").count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toContain("PRIVATE_AUTH_RESPONSE");
    expect(await page.getByRole("alert").innerText()).toContain("権限がありません");
    metadataStatus = 200;
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await page.getByText("一部取得", { exact: true }).waitFor();
    await page.close();
  }, 60_000);

  test("login redirects are handled safely and a mobile deep link remains navigable", async () => {
    runStatus = metadataStatus = 200;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(origin, { waitUntil: "networkidle" });
    expect(await page.locator("tbody").innerText()).toContain("一部取得");
    runStatus = 302;
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").innerText()).toContain("認証が必要");
    expect(await page.locator("tbody").count()).toBe(0);
    expect(loginRequests).toBe(0);
    expect(new URL(page.url()).pathname).toBe("/");
    runStatus = 200;
    await page.goto(`${origin}/runs/r_2/artifacts/a_1`, { waitUntil: "networkidle" });
    await screenshot(page, "evidence-mobile-detail");
    expect(
      await page.getByRole("link", { name: "保存ファイルをダウンロード", exact: true }).isVisible(),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole("link", { name: "収集記録", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "収集記録の詳細", exact: true }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    expect(rawRequests).toBe(0);
    await page.close();
  }, 60_000);

  test("temporary server failures preserve records with an explicit refresh warning", async () => {
    runStatus = metadataStatus = 200;
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    runStatus = 503;
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").innerText()).toContain("前回読み込んだ取得履歴");
    expect(await page.locator("tbody").innerText()).toContain("一部取得");
    expect(await page.locator("body").innerText()).not.toContain("PRIVATE_RUN_RESPONSE");
    runStatus = 200;
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "detached" });
    expect(await page.locator("tbody").innerText()).toContain("一部取得");
    await page.close();
  }, 60_000);
});
