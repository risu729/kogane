import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { secureResponse } from "../../../services/evidence-browser/src/http.ts";
import type {
  EvidenceArtifactDetail,
  EvidenceMeta,
} from "../../../packages/observation-shared/src/evidence-contract.ts";

const CLIENT = join(import.meta.dir, "..", "dist-evidence");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(CLIENT, "index.html")) && existsSync(executablePath);
if (!runnable && process.env["CI"] === "true") process.exitCode = 1;
async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env["EVIDENCE_SCREENSHOT_DIR"];
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}
const route = "/api/evidence/v1/runs/r_2/artifacts/a_1";
const html =
  '<!doctype html>\n<p>日本語の原本</p><script>window.__rawExecuted=true</script><img src="/raw-beacon" onerror="window.__rawExecuted=true">';
const json =
  '{"金額":9007199254740993123456789,"説明":"原本の文字列","html":"<script>bad()</script>"}\n';
const meta: EvidenceMeta = {
  apiVersion: "evidence-v1",
  source: { kind: "central-raw-store", classification: "financial" },
  capabilities: {
    readOnly: true,
    rawEvidence: true,
    parsedObservations: false,
    liveCollectors: false,
  },
  sources: [{ id: "sony-bank", label: "合成テスト" }],
};
function fixture(
  text: string,
  mediaType: string,
  byteSize = Buffer.byteLength(text),
): EvidenceArtifactDetail {
  return {
    apiVersion: "evidence-v1",
    run: {
      id: "r_2",
      sourceId: "sony-bank",
      producerId: "synthetic-collector",
      recordedAt: "2026-09-05T01:02:03.000Z",
      sealedAt: "2026-09-05T01:02:04.000Z",
      outcome: "success",
      startedAt: null,
      startedAtBasis: null,
      completedAt: null,
      completedAtBasis: null,
      artifactCount: 1,
    },
    artifact: {
      id: "a_1",
      runId: "r_2",
      artifactKey: "synthetic-response",
      role: "provider_response",
      payloadFidelity: "exact",
      dataset: "合成プレビューテスト",
      sha256: createHash("sha256").update(text).digest("hex"),
      descriptorSha256: "b".repeat(64),
      byteSize,
      recordedAt: "2026-09-05T01:02:03.000Z",
      containerKind: "single",
      lineageDisposition: "not_applicable",
      formatId: "synthetic",
      formatVersion: "1",
      declaredMediaType: mediaType,
    },
  };
}

describe.if(runnable)("inline original preview under production CSP", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;
  let origin: string;
  let body = html;
  let detail = fixture(body, "text/html; charset=utf-8");
  let rawStatus = 200;
  let rawRequests = 0;
  let beaconRequests = 0;
  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        let response: Response;
        if (path === "/api/evidence/v1/meta") response = Response.json(meta);
        else if (path === route) response = Response.json(detail);
        else if (path === `${route}/raw`) {
          rawRequests++;
          response = new Response(rawStatus === 200 ? body : "PRIVATE_AUTH_RESPONSE", {
            status: rawStatus,
            headers: {
              "content-type": detail.artifact.declaredMediaType!,
              "content-disposition": 'attachment; filename="synthetic-original.html"',
            },
          });
        } else if (path === "/raw-beacon") {
          beaconRequests++;
          response = new Response("beacon");
        } else if (path.startsWith("/api/"))
          response = new Response("unexpected API", { status: 404 });
        else if (path.startsWith("/assets/") && (await Bun.file(join(CLIENT, path)).exists()))
          response = new Response(Bun.file(join(CLIENT, path)));
        else response = new Response(Bun.file(join(CLIENT, "index.html")));
        return secureResponse(response, request, "synthetic-preview-test");
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });
  async function open(text: string, mediaType: string, byteSize?: number): Promise<Page> {
    body = text;
    detail = fixture(text, mediaType, byteSize);
    rawStatus = 200;
    rawRequests = 0;
    beaconRequests = 0;
    const page = await browser.newPage();
    await page.goto(`${origin}/runs/r_2/artifacts/a_1`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "保存ファイルをダウンロード", exact: true }).waitFor();
    return page;
  }
  test("HTML is highlighted text, never executes, and closes without retaining bytes", async () => {
    const page = await open(html, "text/html; charset=utf-8");
    let downloads = 0;
    page.on("download", () => downloads++);
    await page.evaluate(() => {
      (window as Window & { __cspViolations?: string[] }).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        (window as Window & { __cspViolations?: string[] }).__cspViolations?.push(
          event.violatedDirective,
        ),
      );
    });
    expect(rawRequests).toBe(0);
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await page.locator(".preview-code span[class]").first().waitFor();
    expect(await page.locator(".preview-code").textContent()).toBe(html);
    await screenshot(page, "preview-html-desktop");
    expect(await page.locator(".preview-code img, .preview-code script, iframe").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as Window & { __rawExecuted?: boolean }).__rawExecuted),
    ).toBeUndefined();
    expect(
      await page.evaluate(
        () => (window as Window & { __cspViolations?: string[] }).__cspViolations,
      ),
    ).toEqual([]);
    expect(beaconRequests).toBe(0);
    expect(downloads).toBe(0);
    expect(rawRequests).toBe(1);
    await page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
    expect(await page.locator(".preview-code").count()).toBe(0);
    expect(await page.locator("body").textContent()).not.toContain("日本語の原本");
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await page.locator(".preview-code").waitFor();
    expect(rawRequests).toBe(2);
    await page.close();
  }, 30_000);
  test("JSON preserves large integer and original whitespace during highlighting", async () => {
    const page = await open(json, "application/json");
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await page.locator(".preview-code span[class]").first().waitFor();
    const formatted = await page.locator(".preview-code").textContent();
    expect(formatted).toContain('\n  "');
    expect(formatted).toContain("9007199254740993123456789");
    await page.getByLabel("JSONを整形して表示").uncheck();
    expect(await page.locator(".preview-code").textContent()).toBe(json);
    await page.getByLabel("JSONを整形して表示").check();
    expect(await page.locator(".preview-code").textContent()).toBe(formatted);
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "preview-json-mobile");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await page.locator(".preview-code [style]").count()).toBe(0);
    await page.close();
  }, 30_000);
  test("authorization loss discards preview even if subsequent retry fails transiently", async () => {
    const page = await open(json, "application/json");
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await page.locator(".preview-code").waitFor();
    rawStatus = 401;
    await page.getByRole("button", { name: "表示を更新", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.locator(".preview-code").count()).toBe(0);
    rawStatus = 503;
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await page
      .getByText("ファイルを表示できませんでした。再試行してください。", { exact: false })
      .waitFor();
    expect(await page.locator(".preview-code").count()).toBe(0);
    expect(await page.locator("body").textContent()).not.toContain("9007199254740993123456789");
    expect(await page.locator("body").textContent()).not.toContain("PRIVATE_AUTH_RESPONSE");
    await page.close();
  }, 30_000);
  test("unsupported and oversized originals remain downloadable without fetching bytes", async () => {
    for (const [type, size, message] of [
      ["application/pdf", 100, "この形式はプレビューに対応していません。"],
      ["text/html", 512 * 1024 + 1, "プレビューできるのは512 KiBまでです。"],
    ] as const) {
      const page = await open(html, type, size);
      await page.getByText(message, { exact: false }).waitFor();
      expect(await page.getByRole("button", { name: "内容を表示", exact: true }).count()).toBe(0);
      expect(rawRequests).toBe(0);
      await page.close();
    }
  });
});
