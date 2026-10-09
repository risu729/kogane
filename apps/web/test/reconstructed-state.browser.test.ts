// 残高の再構成 in the production client against a server whose answers the
// application service itself produces (packages/application/test/reconstructed-state-world.ts),
// refusals included. One answer is reshaped by hand to the form the fold gives
// once coverage is declared (a complete cell with an unexplained difference),
// which no store can produce today: the page must show it as unexplained, with
// its figure, never as an adjustment or a zero. Every value is invented.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { RECONSTRUCTED_STATE_REFUSALS } from "../../../packages/application/src/query/reconstructed-state-read.ts";
import { reportedStateBody } from "../../../packages/application/test/reported-state-world.ts";
import {
  reconstructedStateOutcome,
  reconstructedStateWorlds,
  WORLD_BANK,
  WORLD_CARD,
  WORLD_EMPTY_LOG,
  WORLD_FROM,
  WORLD_NO_GUARD,
  WORLD_TO,
} from "../../../packages/application/test/reconstructed-state-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;

/** Not a world: the bank answer reshaped to a complete cell with an unexplained difference. */
const UNEXPLAINED = "acct-unexplained";

describe.if(runnable)("reconstructed state", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let advertised = true;
  let tooMany = false;
  const requests: URL[] = [];
  const worlds = reconstructedStateWorlds();
  beforeEach(() => {
    advertised = true;
    tooMany = false;
    requests.length = 0;
  });
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
            capabilities: {
              ...CENTRAL_STORE_CAPABILITIES,
              reportedStateOnDate: true,
              reconstructedStateOnDate: advertised,
            },
          });
        if (url.pathname === "/api/v2/reported-state")
          return Response.json(
            await reportedStateBody(worlds.get(WORLD_BANK)!.store, url.searchParams.get("date")!),
          );
        if (url.pathname === "/api/v2/reconstructed-state") {
          requests.push(url);
          if (tooMany) return Response.json({ error: "result_limit_exceeded" }, { status: 413 });
          const params = new URLSearchParams(url.searchParams);
          const unexplained = params.get("account") === UNEXPLAINED;
          if (unexplained) params.set("account", WORLD_BANK);
          const outcome = await reconstructedStateOutcome(worlds, params);
          if (!outcome.ok)
            return Response.json(
              { error: outcome.refusal, requestId: "synthetic" },
              { status: RECONSTRUCTED_STATE_REFUSALS[outcome.refusal].status },
            );
          if (!unexplained) return Response.json(outcome.body);
          const body = structuredClone(outcome.body);
          const cell = body.reconstruction!.cells[0]!;
          cell.gaps = [];
          cell.partition = "complete";
          cell.explanation.status = "difference_unexplained";
          cell.explanation.reasonCode = null;
          return Response.json({ ...body, account: UNEXPLAINED, status: "complete", reasons: [] });
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
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

  async function open(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${origin}/reconstruction`);
    await page.getByRole("heading", { name: "残高の再構成", exact: true }).waitFor();
    return page;
  }
  async function ask(
    page: Page,
    account: string,
    fields: { from?: string; to?: string } = {},
  ): Promise<void> {
    await page.getByLabel("口座 ID", { exact: true }).fill(account);
    await page.getByLabel("開始日", { exact: true }).fill(fields.from ?? WORLD_FROM);
    await page.getByLabel("終了日", { exact: true }).fill(fields.to ?? WORLD_TO);
    await page.getByRole("button", { name: "表示する", exact: true }).click();
  }
  async function answered(page: Page): Promise<string> {
    await page
      .getByRole("heading", { name: `${WORLD_FROM} → ${WORLD_TO} の再構成`, exact: true })
      .waitFor();
    return page.locator("main").innerText();
  }

  test("an unadvertised feature has no navigation entry and requests nothing", async () => {
    advertised = false;
    const page = await open();
    expect(await page.getByRole("link", { name: "残高の再構成", exact: true }).count()).toBe(0);
    await page.getByText("この接続先は残高の再構成を提供していません。").waitFor();
    expect(requests).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("nothing is asked until an account and a range are chosen", async () => {
    const page = await open();
    expect(
      await page.getByRole("link", { name: "残高の再構成", exact: true }).getAttribute("href"),
    ).toBe("/reconstruction");
    await page.getByText("口座と期間を選ぶと、報告値と再構成値を並べて表示します。").waitFor();
    // The accounts reported on the end date are offered; any id may be typed.
    await page.getByLabel("終了日", { exact: true }).fill(WORLD_TO);
    await page.locator("#reconstructed-accounts option").first().waitFor({ state: "attached" });
    expect(
      await page
        .locator("#reconstructed-accounts option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toContain(WORLD_BANK);
    expect(requests).toHaveLength(0);
    await page.close();
  }, 30_000);

  test("reported, reconstructed and reported side by side, the difference kept as it is", async () => {
    const page = await open();
    await ask(page, WORLD_BANK);
    const main = await answered(page);
    const table = await page.getByRole("region", { name: "残高ごとの比較" }).innerText();
    expect(table).toContain("10000 JPY");
    expect(table).toContain("9000 JPY");
    expect(table).toContain("8500 JPY");
    // reported − reconstructed, exact; not a zero and not an adjustment.
    expect(table).toContain("-500 JPY");
    expect(table).toContain("比較できない");
    expect(table).toContain("reconstruction_incomplete");
    expect(table).toContain("適用 1 件 -1000 JPY");
    // The status and every reason as closed codes.
    expect(main).toContain("一部のみ");
    expect(main).toContain("family_not_evented");
    expect(main).toContain("history_coverage_unknown");
    // The knowledge the answer used.
    const knowledge = await page.getByRole("region", { name: "使用した採用知識" }).innerText();
    expect(knowledge).toContain("使用したコミット");
    expect(knowledge).toContain("2 番");
    expect(knowledge).toContain("確定");
    expect(knowledge).toContain("core-epoch-1");
    expect(knowledge).toContain("口座対応の世代");
    expect(knowledge).toContain("採用知識の版");
    // The card purchase on the card account is another basis, listed as such.
    const dispositions = await page
      .getByRole("region", { name: "イベントの扱いの一覧" })
      .innerText();
    expect(dispositions).toContain("ev-settle@1#0");
    expect(requests.at(-1)?.searchParams.get("account")).toBe(WORLD_BANK);
    await page.close();
  }, 30_000);

  test("an answer can be pinned to its commit and asked again by sequence", async () => {
    const page = await open();
    await ask(page, WORLD_BANK);
    await answered(page);
    await page.getByRole("button", { name: "このコミットに固定して表示する" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("コミット 2"));
    const pinned = requests.at(-1)!;
    expect(pinned.searchParams.get("commitSeq")).toBe("2");
    expect(pinned.searchParams.get("coreEpoch")).toBe("core-epoch-1");
    await page.close();
  }, 30_000);

  test("an unexplained difference is shown as unexplained, with its figure", async () => {
    const page = await open();
    await ask(page, UNEXPLAINED);
    await answered(page);
    const table = await page.getByRole("region", { name: "残高ごとの比較" }).innerText();
    expect(table).toContain("説明できない差");
    expect(table).toContain("-500 JPY");
    expect(table).not.toContain("一致");
    await page.close();
  }, 30_000);

  test("refusals are shown as refusals with their codes", async () => {
    const page = await open();
    await ask(page, "acct-nowhere");
    await page.getByText("この口座 ID は登録されていません。").waitFor();
    expect(await page.locator("main").innerText()).toContain("unknown_account");
    // A cut past the log's end, asked by sequence.
    await page.getByLabel("口座 ID", { exact: true }).fill(WORLD_BANK);
    await page.locator('select[name="reconstructed-cut"]').selectOption("sequence");
    await page.getByLabel("コミット記録の世代", { exact: true }).fill("core-epoch-1");
    await page.getByLabel("コミット番号", { exact: true }).fill("99");
    await page.getByRole("button", { name: "表示する", exact: true }).click();
    await page.getByText("指定したコミット番号はまだ記録されていません。").waitFor();
    // A range the route would refuse is not sent at all.
    const sent = requests.length;
    await page.locator('select[name="reconstructed-cut"]').selectOption("latest");
    await page.getByLabel("開始日", { exact: true }).fill("2025-01-01");
    await page.getByText("期間は366日以内にしてください。").waitFor();
    expect(await page.getByRole("button", { name: "表示する", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(requests).toHaveLength(sent);
    await page.close();
  }, 30_000);

  test("a store without CORE 0070 and a card account are refused as statuses, never as zero", async () => {
    const page = await open();
    await ask(page, WORLD_NO_GUARD);
    let main = await answered(page);
    expect(main).toContain("再構成できません。");
    expect(main).toContain("economic_guard_missing");
    expect(await page.getByRole("region", { name: "残高ごとの比較" }).count()).toBe(0);
    await ask(page, WORLD_CARD);
    await page.waitForFunction(() => document.body.innerText.includes("no_reported_container"));
    main = await page.locator("main").innerText();
    expect(main).toContain("再構成の対象外");
    expect(main).toContain("0 という意味ではありません");
    await page.close();
  }, 30_000);

  test("a cut at or after the log's last commit is marked provisional", async () => {
    const page = await open();
    await ask(page, WORLD_EMPTY_LOG);
    await answered(page);
    const knowledge = await page.getByRole("region", { name: "使用した採用知識" }).innerText();
    expect(knowledge).toContain("暫定");
    expect(await page.locator("main").innerText()).toContain("log_empty");
    await page.close();
  }, 30_000);

  test("an account past the bounds says so instead of a partial answer", async () => {
    tooMany = true;
    const page = await open();
    await ask(page, WORLD_BANK);
    await page.getByText("一部だけの再構成はしません。", { exact: false }).waitFor();
    await page.close();
  }, 30_000);

  test("the page fits a phone width without sideways page scroll", async () => {
    const page = await open();
    await ask(page, WORLD_BANK);
    await answered(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    const prefix = process.env["RECONSTRUCTED_STATE_SCREENSHOT_PREFIX"];
    if (prefix) {
      await page.screenshot({ path: `${prefix}-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.screenshot({ path: `${prefix}-desktop.png`, fullPage: true });
    }
    await page.close();
  }, 30_000);
});
