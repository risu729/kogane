import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { auditView } from "./a11y-audit.ts";
import jobs from "../../../config/alarm-jobs.json";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema";
import type {
  MaintenanceRule,
  ScheduleSnapshot,
} from "../../../packages/collection/src/schedule-model";
import { settledTest } from "./settle.ts";
const client = join(import.meta.dir, "../dist-production"),
  executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
// Launched while the module loads, and only for a suite that runs: a timeout
// kills a browser a hook launched (test/settle.ts).
let browser: Browser;
if (runnable) browser = await chromium.launch({ executablePath });
const test = settledTest();
describe.if(runnable)("operator schedule administration", () => {
  let server: ReturnType<typeof Bun.serve>, origin: string, snapshot: ScheduleSnapshot;
  let snapshotReads = 0,
    snapshotStatus = 200,
    leaseResponse: (() => Promise<Response>) | null = null,
    readAfterWrite: (() => Promise<void>) | null = null,
    collectionResponse: (() => Promise<Response>) | null = null,
    // A settings write's answer, replaced: `before` answers instead of the
    // write and stores nothing; `after` answers once the write is stored, as
    // a relay that lost the Processor's answer does (`503
    // scheduling_unavailable`). `reservation` is what a stored write answers.
    writeAnswer: { before?: () => Response; after?: () => Response } | null = null,
    reservation: "armed" | "pending" = "armed";
  let collections: { body: Record<string, unknown>; origin: string | null; type: string | null }[] =
    [];
  let writes: {
    path: string;
    body: Record<string, unknown>;
    origin: string | null;
    marker: string | null;
  }[] = [];
  beforeEach(() => {
    writes = [];
    collections = [];
    collectionResponse = null;
    snapshotReads = 0;
    snapshotStatus = 200;
    leaseResponse = null;
    readAfterWrite = null;
    writeAnswer = null;
    reservation = "armed";
    snapshot = {
      schedules: jobs.map((job) => ({
        ...job,
        revision: 1,
        nextNominalAt: job.enabled ? "2026-10-05T21:00:00.000Z" : null,
        nextRunAt: job.enabled ? "2026-10-05T21:00:00.000Z" : null,
        actualAlarmAt: job.enabled ? "2026-10-05T21:00:00.000Z" : null,
        reservation: job.enabled ? "armed" : "disabled",
        maintenance: {
          status: "not-found",
          referenceUrl: "https://example.test/maintenance",
          verifiedAt: "2026-10-04T14:40:00.000Z",
        },
        latest:
          job.id === "sony-bank"
            ? {
                id: "synthetic",
                scheduleId: job.id,
                nominalAt: "2026-10-04T21:00:00.000Z",
                startedAt: "2026-10-04T21:00:00.000Z",
                finishedAt: "2026-10-04T21:01:00.000Z",
                status: "completed",
                runIds: ["synthetic-sony"],
                runLinks: [{ runId: "synthetic-sony", evidenceId: "r_123" }],
                failureCode: null,
              }
            : null,
        collectionRequest:
          job.id === "sony-bank"
            ? { source: "sony-bank", dispatch: "enabled" }
            : job.id === "prestia-globalpass"
              ? { source: "global-pass", dispatch: "connection_disabled" }
              : job.id === "sbi-vc-keepalive"
                ? null
                : undefined,
      })),
      maintenance: [],
      occurrences: [],
      leases: [],
    } as ScheduleSnapshot;
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
            capabilities: CENTRAL_STORE_CAPABILITIES,
          });
        if (url.pathname === "/api/ops/v1/schedules") {
          // The page reads the full snapshot; the route's default is the summary (ADR 0123).
          if (url.searchParams.get("detail") !== "full")
            return Response.json({ error: "synthetic_summary_not_served" }, { status: 400 });
          snapshotReads++;
          if (writes.length && readAfterWrite) await readAfterWrite();
          if (snapshotStatus !== 200)
            return Response.json({ error: "scheduling_unavailable" }, { status: snapshotStatus });
          return Response.json(snapshot);
        }
        if (url.pathname === "/api/ops/v1/collections" && request.method === "POST") {
          collections.push({
            body: (await request.json()) as Record<string, unknown>,
            origin: request.headers.get("origin"),
            type: request.headers.get("content-type"),
          });
          if (collectionResponse) return collectionResponse();
          return Response.json(
            { operationId: `op_${"a".repeat(64)}`, status: "accepted" },
            { status: 202 },
          );
        }
        if (url.pathname.startsWith("/api/ops/v1/schedules/") && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          writes.push({
            path: url.pathname,
            body,
            origin: request.headers.get("origin"),
            marker: request.headers.get("x-kogane-settings"),
          });
          if (url.pathname.startsWith("/api/ops/v1/schedules/leases/") && leaseResponse)
            return leaseResponse();
          const refused = writeAnswer?.before?.();
          if (refused) return refused;
          const stored = settingsWrite(url.pathname.slice("/api/ops/v1/schedules".length), body);
          return stored.ok && writeAnswer?.after ? writeAnswer.after() : stored;
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname === "/" ? "index.html" : url.pathname));
        return new Response((await file.exists()) ? file : Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });
  /**
   * One settings write as the Processor answers it (services/processor
   * schedule-store.ts and maintenance-survey/decisions.ts): each write is
   * checked against the revision it names and refused with `409` when that
   * moved; a stored write answers what the real route answers.
   */
  function settingsWrite(path: string, body: Record<string, unknown>): Response {
    const refuse = (error: string, status: number) => Response.json({ error }, { status });
    const lease = /^\/leases\/([a-z0-9-]+)$/u.exec(path);
    if (lease) {
      const held = snapshot.leases.find((l) => l.source === lease[1]);
      if (held && held.leaseRef !== body["leaseRef"]) return refuse("lease_conflict", 409);
      snapshot.leases = snapshot.leases.filter((l) => l.source !== lease[1]);
      return Response.json({ released: true });
    }
    if (path === "/maintenance") {
      const current = snapshot.maintenance.find((r) => r.id === body["id"]);
      if ((current?.revision ?? 0) !== body["revision"]) return refuse("revision_conflict", 409);
      const { revision, ...fields } = body as unknown as MaintenanceRule;
      snapshot.maintenance = [
        ...snapshot.maintenance.filter((r) => r.id !== fields.id),
        { ...fields, revision: revision + 1 },
      ];
      return Response.json({ saved: true, revision: revision + 1, reservation });
    }
    const decision = /^\/proposals\/([0-9]+)$/u.exec(path);
    if (decision) {
      const survey = snapshot.survey!;
      const proposal = survey.proposals.find((p) => p.id === Number(decision[1]));
      if (!proposal) return refuse("proposal_already_decided", 409);
      if (body["decision"] === "accept") {
        const ruleId = proposal.ruleId ?? `${proposal.source}-survey-${proposal.id}`;
        const current = snapshot.maintenance.find((r) => r.id === ruleId);
        if ((current?.revision ?? 0) !== proposal.baseRevision)
          return refuse("revision_conflict", 409);
        snapshot.maintenance = [
          ...snapshot.maintenance.filter((r) => r.id !== ruleId),
          {
            id: ruleId,
            source: proposal.source,
            timezone: proposal.timezone,
            pattern: proposal.pattern,
            enabled: proposal.enabled,
            scope: proposal.scope,
            referenceUrl: proposal.referenceUrl,
            verifiedAt: proposal.fetchedAt,
            revision: proposal.baseRevision + 1,
          },
        ];
      }
      survey.proposals = survey.proposals.filter((p) => p !== proposal);
      survey.attention = survey.proposals.length;
      return body["decision"] === "accept"
        ? Response.json({
            decided: "accepted",
            ruleId: proposal.ruleId ?? `${proposal.source}-survey-${proposal.id}`,
            revision: proposal.baseRevision + 1,
            reservation,
          })
        : Response.json({ decided: "rejected" });
    }
    const row = snapshot.schedules.find((s) => `/${s.id}` === path);
    if (!row) return refuse("not_found", 404);
    if (body["revision"] !== row.revision) return refuse("revision_conflict", 409);
    const { revision: _from, ...change } = body;
    Object.assign(row, change, {
      revision: row.revision + 1,
      reservation: reservation === "pending" ? "pending" : body["enabled"] ? "armed" : "disabled",
    });
    return Response.json({
      saved: true,
      reservation: row.reservation,
      actualAlarmAt: row.actualAlarmAt,
      revision: row.revision,
    });
  }
  function stoppedLease(leaseRef = "12345678-1234-4234-8234-123456789abc") {
    snapshot.leases = [{ source: "vpass", leaseRef, startedAt: "2026-10-01T00:00:00.000Z" }];
  }
  test("release takes a synchronous guard before confirmation and stays disabled through readback", async () => {
    stoppedLease();
    let finishWrite!: () => void,
      finishRead!: () => void,
      readEntered!: () => void,
      writeEntered!: () => void;
    const writing = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      writeEntered = resolve;
    });
    leaseResponse = async () => {
      writeEntered();
      await writing;
      snapshot.leases = [];
      return Response.json({ released: true });
    };
    readAfterWrite = () => {
      readEntered();
      return reading;
    };
    const page = await browser.newPage();
    // Re-enter the button before confirmation returns: a state-only pending
    // flag cannot protect this gap. This is a synthetic dialog, not a login.
    await page.addInitScript(() => {
      let confirmations = 0;
      window.confirm = () => {
        confirmations++;
        if (confirmations === 1)
          [...document.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent === "停止した実行を解除")
            ?.click();
        document.documentElement.dataset.leaseConfirmations = String(confirmations);
        return true;
      };
    });
    try {
      await page.goto(`${origin}/schedules`);
      await page.getByRole("button", { name: "停止した実行を解除", exact: true }).click();
      const pending = page.getByRole("button", { name: "解除中…", exact: true });
      await pending.waitFor();
      expect(await pending.isDisabled()).toBe(true);
      expect(await page.locator("html").getAttribute("data-lease-confirmations")).toBe("1");
      // The pending label renders when the request starts, not when the server
      // has it. Wait on the server's write boundary; the response is still held.
      await writeStarted;
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path: "/api/ops/v1/schedules/leases/vpass",
        origin,
        marker: "1",
        body: {
          leaseRef: "12345678-1234-4234-8234-123456789abc",
          confirmedStopped: true,
        },
      });
      const readsBefore = snapshotReads;
      finishWrite();
      // Wait on the server's read boundary; the read response is still held.
      await readStarted;
      expect(snapshotReads).toBeGreaterThan(readsBefore);
      expect(await pending.isDisabled()).toBe(true);
      finishRead();
      await page
        .getByText("対象の停止した実行は解除済みです。現在の実行状態を確認してください。", {
          exact: true,
        })
        .waitFor();
      expect(await page.getByRole("button", { name: "停止した実行を解除" }).count()).toBe(0);
      expect(writes).toHaveLength(1);
    } finally {
      finishWrite();
      finishRead();
      await page.close();
    }
  }, 30000);

  test("cancelled confirmation sends no write and allows a later confirmed release", async () => {
    stoppedLease();
    leaseResponse = async () => {
      snapshot.leases = [];
      return Response.json({ released: true });
    };
    const page = await browser.newPage();
    await page.goto(`${origin}/schedules`);
    const button = page.getByRole("button", { name: "停止した実行を解除", exact: true });
    page.once("dialog", (dialog) => dialog.dismiss());
    await button.click();
    expect(writes).toHaveLength(0);
    expect(await button.isEnabled()).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await button.click();
    await page
      .getByText("対象の停止した実行は解除済みです。現在の実行状態を確認してください。", {
        exact: true,
      })
      .waitFor();
    expect(writes).toHaveLength(1);
    await page.close();
  }, 30000);

  test("a conflicting release refreshes the new lease and retries only its new reference", async () => {
    stoppedLease();
    const newRef = "87654321-4321-4321-8321-cba987654321";
    leaseResponse = async () => {
      stoppedLease(newRef);
      return Response.json({ error: "lease_conflict" }, { status: 409 });
    };
    const page = await browser.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${origin}/schedules`);
    const button = page.getByRole("button", { name: "停止した実行を解除", exact: true });
    await button.click();
    await page
      .getByText("他の変更が先に保存されました。表示を更新して再度変更してください。", {
        exact: true,
      })
      .waitFor();
    expect(snapshotReads).toBeGreaterThan(1);
    expect(await button.isEnabled()).toBe(true);
    leaseResponse = async () => {
      snapshot.leases = [];
      return Response.json({ released: true });
    };
    await button.click();
    await page
      .getByText("対象の停止した実行は解除済みです。現在の実行状態を確認してください。", {
        exact: true,
      })
      .waitFor();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body.leaseRef).toBe(newRef);
    await page.close();
  }, 30000);

  test("a failed response still reads back a completed release and retains its result", async () => {
    stoppedLease();
    leaseResponse = async () => {
      snapshot.leases = [];
      return Response.json({ error: "unavailable" }, { status: 503 });
    };
    const page = await browser.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${origin}/schedules`);
    await page.getByRole("button", { name: "停止した実行を解除", exact: true }).click();
    await page
      .getByText("設定を確認できません。表示を更新して保存状態を確認してください。", {
        exact: true,
      })
      .waitFor();
    expect(snapshotReads).toBeGreaterThan(1);
    expect(await page.getByRole("button", { name: "停止した実行を解除" }).count()).toBe(0);
    expect(writes).toHaveLength(1);
    await page.close();
  }, 30000);
  test("failed readback releases the UI guard and permits a safe retry", async () => {
    stoppedLease();
    leaseResponse = async () => {
      snapshotStatus = 503;
      return Response.json({ released: true });
    };
    const page = await browser.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${origin}/schedules`);
    const button = page.getByRole("button", { name: "停止した実行を解除", exact: true });
    await button.click();
    await page
      .getByText("解除結果を確認できません。表示を更新して現在の実行状態を確認してください。", {
        exact: true,
      })
      .waitFor();
    expect(await button.isEnabled()).toBe(true);
    expect(snapshotReads).toBeGreaterThan(1);
    leaseResponse = async () => {
      snapshotStatus = 200;
      snapshot.leases = [];
      return Response.json({ released: true });
    };
    await button.click();
    await page
      .getByText("対象の停止した実行は解除済みです。現在の実行状態を確認してください。", {
        exact: true,
      })
      .waitFor();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body.leaseRef).toBe(writes[0]!.body.leaseRef);
    await page.close();
  }, 30000);

  test("a pending release only blocks its own source", async () => {
    stoppedLease();
    snapshot.leases.push({
      source: "myjcb",
      leaseRef: "87654321-4321-4321-8321-cba987654321",
      startedAt: "2026-10-01T00:00:00.000Z",
    });
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Each held write resolves the next arrival, in the order the server saw them.
    const entered: (() => void)[] = [];
    const firstWrite = new Promise<void>((resolve) => {
      entered.push(resolve);
    });
    const secondWrite = new Promise<void>((resolve) => {
      entered.push(resolve);
    });
    leaseResponse = async () => {
      entered.shift()?.();
      await writing;
      snapshot.leases = [];
      return Response.json({ released: true });
    };
    const page = await browser.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    try {
      await page.goto(`${origin}/schedules`);
      await page.getByRole("button", { name: "停止した実行を解除", exact: true }).first().click();
      await page.getByRole("button", { name: "解除中…", exact: true }).waitFor();
      // The pending label renders when the request starts; wait until the
      // server holds the first write before starting the second.
      await firstWrite;
      const second = page.getByRole("button", { name: "停止した実行を解除", exact: true });
      expect(await second.isEnabled()).toBe(true);
      await second.click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("button")].filter(
            (button) => button.textContent === "解除中…",
          ).length === 2,
      );
      await secondWrite;
      expect(writes.map((write) => write.path)).toEqual([
        "/api/ops/v1/schedules/leases/vpass",
        "/api/ops/v1/schedules/leases/myjcb",
      ]);
      finish();
      await page
        .getByText("対象の停止した実行は解除済みです。現在の実行状態を確認してください。", {
          exact: true,
        })
        .waitFor();
      expect(writes).toHaveLength(2);
    } finally {
      finish();
      await page.close();
    }
  }, 30000);

  test("one trailing slash opens the same schedules page with its own caption", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    try {
      await page.goto(`${origin}/schedules/`);
      await page.getByRole("heading", { name: "収集スケジュール", exact: true }).waitFor();
      expect(await page.getByText("管理者による設定変更", { exact: true }).count()).toBe(1);
      expect(await page.getByText("閲覧専用", { exact: true }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  for (const width of [1280, 390])
    test(`daily time edits persist and exact evidence links remain visible at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      // Closed even on failure: a page left open can deliver its write after
      // the next test's beforeEach has reset `writes`.
      try {
        await page.goto(`${origin}/schedules`);
        await page.getByRole("heading", { name: "収集スケジュール", exact: true }).waitFor();
        const card = page
          .locator(".schedule-card")
          .filter({ has: page.getByRole("heading", { name: "ソニー銀行", exact: true }) });
        await card.getByRole("link", { name: "取得記録を見る", exact: true }).waitFor();
        expect(
          await card
            .getByRole("link", { name: "取得記録を見る", exact: true })
            .getAttribute("href"),
        ).toBe("/runs/r_123");
        expect(await page.getByText("管理者による設定変更", { exact: true }).count()).toBe(1);
        await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
        // `fill` has already set the input, so its value says nothing about the
        // save. Wait for the save request itself to settle before counting the
        // writes the server received.
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/ops/v1/schedules/sony-bank" &&
            response.request().method() === "POST",
        );
        await card.getByRole("button", { name: "設定を保存", exact: true }).click();
        await saved;
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
          path: "/api/ops/v1/schedules/sony-bank",
          origin,
          marker: "1",
          body: {
            revision: 1,
            enabled: true,
            timezone: "Asia/Tokyo",
            pattern: { kind: "daily", time: "06:40", weekdays: [0, 1, 2, 3, 4, 5, 6] },
          },
        });
        await page.reload();
        await page.getByLabel("ソニー銀行の実行時刻").waitFor();
        expect(await page.getByLabel("ソニー銀行の実行時刻").inputValue()).toBe("06:40");
        const manual = page
          .locator(".schedule-card")
          .filter({ has: page.getByRole("heading", { name: "SMBCダイレクト", exact: true }) });
        expect(await manual.getByRole("button", { name: "設定を保存" }).count()).toBe(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (process.env["ALARM_SCREENSHOT_DIRECTORY"])
          await page.screenshot({
            path: `${process.env["ALARM_SCREENSHOT_DIRECTORY"]}/alarms-admin-${width}.png`,
          });
      } finally {
        await page.close();
      }
    }, 30000);
  test("a dated maintenance change uses Japan time and retains provenance", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/schedules`);
    await page.getByRole("button", { name: "停止時間を追加", exact: true }).click();
    const form = page.locator(".maintenance-editor");
    await form.getByLabel("設定名（半角英数字・ハイフン）").fill("synthetic-outage");
    await form.getByLabel("取得元", { exact: true }).selectOption("sony-bank");
    await form.getByLabel("開始（日本時間）", { exact: true }).fill("2026-10-06T01:00");
    await form.getByLabel("終了（日本時間）", { exact: true }).fill("2026-10-06T05:00");
    await form
      .getByLabel("公式案内のURL", { exact: true })
      .fill("https://example.test/maintenance");
    await form
      .getByLabel("公式案内を確認した日時（日本時間）", { exact: true })
      .fill("2026-10-04T23:00");
    await form.getByRole("button", { name: "停止時間を保存", exact: true }).click();
    await form.getByRole("status").getByText("停止時間を保存しました。", { exact: true }).waitFor();
    await form.getByRole("button", { name: "閉じる", exact: true }).click();
    await form.waitFor({ state: "detached" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      id: "synthetic-outage",
      source: "sony-bank",
      revision: 0,
      referenceUrl: "https://example.test/maintenance",
      verifiedAt: "2026-10-04T14:00:00.000Z",
      pattern: { kind: "once", from: "2026-10-05T16:00:00.000Z", to: "2026-10-05T20:00:00.000Z" },
    });
    await page.close();
  }, 30000);
  test("a saved schedule keeps its result message after the new revision is read back", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page
        .locator(".schedule-card")
        .filter({ has: page.getByRole("heading", { name: "ソニー銀行", exact: true }) });
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
      const reads = snapshotReads;
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card.getByRole("button", { name: "設定を保存", exact: true }).waitFor();
      expect(writes).toHaveLength(1);
      expect(snapshotReads).toBeGreaterThan(reads);
      // The card re-reads revision 2; the status announced for the save stays.
      expect(await card.getByRole("status").innerText()).toBe("保存しました。");
    } finally {
      await page.close();
    }
  }, 30000);
  test("a save's result message is not shown over a later change read back from elsewhere", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page
        .locator(".schedule-card")
        .filter({ has: page.getByRole("heading", { name: "ソニー銀行", exact: true }) });
      const time = card.getByLabel("ソニー銀行の実行時刻");
      await time.fill("06:40");
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card.getByRole("status").getByText("保存しました。", { exact: true }).waitFor();
      // Another tab then stores revision 3 with its own time, and this page
      // reads it back: the card shows values this save never wrote.
      const row = snapshot.schedules.find((schedule) => schedule.id === "sony-bank")!;
      expect(row.revision).toBe(2);
      Object.assign(row, {
        revision: 3,
        pattern: { ...row.pattern, time: "07:15" },
      });
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await page.waitForFunction(
        () =>
          (document.querySelector('input[aria-label="ソニー銀行の実行時刻"]') as HTMLInputElement)
            ?.value === "07:15",
      );
      expect(await card.getByRole("status").innerText()).toBe("");
    } finally {
      await page.close();
    }
  }, 30000);
  test("a save whose read back fails still says it was saved", async () => {
    // The write lands; every read after it fails, so the card keeps showing
    // the revision the save was made from.
    readAfterWrite = async () => {
      snapshotStatus = 503;
    };
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page
        .locator(".schedule-card")
        .filter({ has: page.getByRole("heading", { name: "ソニー銀行", exact: true }) });
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await page
        .getByRole("alert")
        .getByText("更新できませんでした。前回読み込んだ収集スケジュールを表示しています。", {
          exact: true,
        })
        .waitFor();
      await card.getByRole("button", { name: "設定を保存", exact: true }).waitFor();
      expect(writes).toHaveLength(1);
      expect(await card.getByRole("status").innerText()).toBe("保存しました。");
      // Reads recover after another tab stored revision 3: the card skips the
      // revision this save wrote, and the message is not shown over values
      // the save never wrote.
      readAfterWrite = null;
      snapshotStatus = 200;
      const row = snapshot.schedules.find((schedule) => schedule.id === "sony-bank")!;
      expect(row.revision).toBe(2);
      Object.assign(row, { revision: 3, pattern: { ...row.pattern, time: "07:15" } });
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await page.waitForFunction(
        () =>
          (document.querySelector('input[aria-label="ソニー銀行の実行時刻"]') as HTMLInputElement)
            ?.value === "07:15",
      );
      expect(await card.getByRole("status").innerText()).toBe("");
    } finally {
      await page.close();
    }
  }, 30000);
  test("reopening a maintenance rule after it changed edits the stored revision, not the earlier form", async () => {
    // Synthetic rule and page; no provider page is read.
    const rule = {
      id: "synthetic-weekly",
      source: "sony-bank",
      timezone: "Asia/Tokyo",
      pattern: { kind: "weekly" as const, weekdays: [0], start: "01:00", end: "04:00" },
      enabled: true,
      referenceUrl: "https://example.test/maintenance",
      verifiedAt: "2026-10-04T14:00:00.000Z",
      scope: "collection" as const,
      revision: 1,
    };
    snapshot.maintenance = [rule];
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const item = page.locator(".maintenance-list li").filter({ hasText: "毎週 日 01:00" });
      await item.getByRole("button", { name: "変更", exact: true }).click();
      const form = page.locator(".maintenance-editor");
      expect(await form.getByLabel("開始時刻", { exact: true }).inputValue()).toBe("01:00");
      // An edit in progress in the open form.
      await form.getByLabel("開始時刻", { exact: true }).fill("01:30");
      // Another change is stored while the editor is open, and the page reads it back.
      snapshot.maintenance = [
        { ...rule, pattern: { ...rule.pattern, start: "02:00" }, revision: 2 },
      ];
      const reads = snapshotReads;
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      const current = page.locator(".maintenance-list li").filter({ hasText: "毎週 日 02:00" });
      await current.waitFor();
      expect(snapshotReads).toBeGreaterThan(reads);
      // The read-back alone leaves the open form as the operator left it: it
      // it still carries revision 1, which the server's version check refuses.
      expect(await form.getByLabel("開始時刻", { exact: true }).inputValue()).toBe("01:30");
      // Opening the rule again shows what revision 2 stores; saving it without
      // a change must not write revision 1's times under revision 2.
      await current.getByRole("button", { name: "変更", exact: true }).click();
      expect(await form.getByLabel("開始時刻", { exact: true }).inputValue()).toBe("02:00");
      await form.getByRole("button", { name: "停止時間を保存", exact: true }).click();
      await form
        .getByRole("status")
        .getByText("停止時間を保存しました。", { exact: true })
        .waitFor();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toMatchObject({
        id: "synthetic-weekly",
        revision: 2,
        pattern: { kind: "weekly", start: "02:00", end: "04:00" },
      });
    } finally {
      await page.close();
    }
  }, 30000);
  test("the official-site re-survey shows freshness and failures, and changes nothing until a decision", async () => {
    // Synthetic: invented pages, times and proposals; no provider page is read.
    snapshot.survey = {
      enabled: true,
      attention: 2,
      targets: [
        {
          id: "sony-bank",
          source: "sony-bank",
          url: "https://example.test/sony-maintenance",
          scope: "collection",
          cadenceHours: 24,
          fetch: "enabled",
          terms: "confirmed",
          freshness: "fresh",
          nextDueAt: "2026-10-06T00:00:00.000Z",
          lastAttemptAt: "2026-10-05T00:00:00.000Z",
          lastSuccessAt: "2026-10-05T00:00:00.000Z",
          lastFailureAt: null,
          lastFailureCode: null,
          consecutiveFailures: 0,
          lastChangedAt: "2026-10-05T00:00:00.000Z",
        },
        {
          id: "mizuho-bank",
          source: "mizuho-bank",
          url: "https://example.test/mizuho-maintenance",
          scope: "collection",
          cadenceHours: 24,
          fetch: "enabled",
          terms: "confirmed",
          freshness: "stale",
          nextDueAt: "2026-10-05T02:00:00.000Z",
          lastAttemptAt: "2026-10-05T00:00:00.000Z",
          lastSuccessAt: "2026-10-01T00:00:00.000Z",
          lastFailureAt: "2026-10-05T00:00:00.000Z",
          lastFailureCode: "empty_body",
          consecutiveFailures: 3,
          lastChangedAt: null,
        },
      ],
      proposals: [
        {
          id: 1,
          targetId: "sony-bank",
          source: "sony-bank",
          kind: "changed",
          ruleId: "synthetic-weekly",
          baseRevision: 1,
          current: true,
          timezone: "Asia/Tokyo",
          pattern: { kind: "weekly", weekdays: [0], start: "01:00", end: "04:00" },
          enabled: true,
          scope: "collection",
          status: "proposed",
          reasons: [],
          referenceUrl: "https://example.test/sony-maintenance",
          fetchedAt: "2026-10-05T00:00:00.000Z",
          sha256: "a".repeat(64),
          createdAt: "2026-10-05T00:00:00.000Z",
        },
        {
          id: 2,
          targetId: "sony-bank",
          source: "sony-bank",
          kind: "new",
          ruleId: null,
          baseRevision: 0,
          current: false,
          timezone: "Asia/Tokyo",
          pattern: {
            kind: "once",
            from: "2026-10-10T12:00:00.000Z",
            to: "2026-10-10T21:00:00.000Z",
          },
          enabled: true,
          scope: "collection",
          status: "review_pending",
          reasons: ["year_inferred"],
          referenceUrl: "https://example.test/sony-maintenance",
          fetchedAt: "2026-10-05T00:00:00.000Z",
          sha256: "b".repeat(64),
          createdAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    };
    // The rule proposal 1 revises, at the revision it was read against: the
    // Processor refuses an acceptance whose base revision moved.
    snapshot.maintenance = [
      {
        id: "synthetic-weekly",
        source: "sony-bank",
        timezone: "Asia/Tokyo",
        pattern: { kind: "weekly", weekdays: [0], start: "00:30", end: "03:00" },
        enabled: true,
        referenceUrl: "https://example.test/sony-maintenance",
        verifiedAt: "2026-10-01T00:00:00.000Z",
        scope: "collection",
        revision: 1,
      },
    ];
    const page = await browser.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`${origin}/schedules`);
    await page.getByRole("heading", { name: "公式サイトの再調査", exact: true }).waitFor();
    await page.getByText("2件の提案を確認してください。", { exact: false }).waitFor();
    const section = page.locator('section[aria-labelledby="maintenance-survey"]');
    expect(await section.getByText("古い情報（再調査が成功していません）").count()).toBe(1);
    expect(await section.getByText("ページが空でした", { exact: false }).count()).toBe(1);
    expect(await section.getByText("年の記載がありません", { exact: false }).count()).toBe(1);
    // Showing a proposal writes nothing.
    expect(writes).toEqual([]);
    const outdated = section.locator("li").filter({ hasText: "新しい停止時間" });
    expect(await outdated.getByRole("button", { name: "採用", exact: true }).isDisabled()).toBe(
      true,
    );
    // The server records each write as it arrives; wait for each decision's
    // request to settle rather than polling the record for a bounded time.
    const decided = (id: number) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/ops/v1/schedules/proposals/${id}` &&
          response.request().method() === "POST",
      );
    const rejected = decided(2);
    await outdated.getByRole("button", { name: "却下", exact: true }).click();
    await rejected;
    const current = section.locator("li").filter({ hasText: "停止時間の変更" });
    const accepted = decided(1);
    await current.getByRole("button", { name: "採用", exact: true }).click();
    await accepted;
    // The decided proposals leave the list; the section says what was decided.
    await section
      .getByRole("status")
      .getByText("ソニー銀行の停止時間の変更：採用し、メンテナンス時間に反映しました。", {
        exact: true,
      })
      .waitFor();
    expect(writes.map((w) => [w.path, w.body, w.marker])).toEqual([
      ["/api/ops/v1/schedules/proposals/2", { decision: "reject" }, "1"],
      ["/api/ops/v1/schedules/proposals/1", { decision: "accept" }, "1"],
    ]);
    await page.close();
  }, 30000);

  // A write whose answer does not say what is stored (no answer, an
  // unreadable 2xx, a 5xx) or a 409 is read back, and the page says how the
  // stored state compares with the change (docs/schedules.md).
  const sonyCard = (page: Page) =>
    page
      .locator(".schedule-card")
      .filter({ has: page.getByRole("heading", { name: "ソニー銀行", exact: true }) });
  const lost = () => Response.json({ error: "scheduling_unavailable" }, { status: 503 });
  const focusedStatus = (page: Page) =>
    page.waitForFunction(() =>
      document.activeElement?.getAttribute("role") === "status"
        ? document.activeElement.textContent
        : null,
    );
  test("a save whose answer is lost after it was stored reads the job back and says it is saved", async () => {
    const page = await browser.newPage();
    try {
      // The server stores the write; the browser never receives its answer.
      await page.route("**/api/ops/v1/schedules/sony-bank", async (route) => {
        await route.fetch();
        await route.abort("failed");
      });
      await page.goto(`${origin}/schedules`);
      const card = sonyCard(page);
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
      const reads = snapshotReads;
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card
        .getByRole("status")
        .getByText(
          "応答を受け取れませんでしたが、読み直した設定はこの変更と同じで、保存されています。",
          { exact: true },
        )
        .waitFor();
      expect(snapshotReads).toBeGreaterThan(reads);
      expect(writes.map((w) => w.body["revision"])).toEqual([1]);
      // The card now edits the stored revision: the next save is not refused.
      await page.unroute("**/api/ops/v1/schedules/sony-bank");
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:50");
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card.getByRole("status").getByText("保存しました。", { exact: true }).waitFor();
      expect(writes.map((w) => w.body["revision"])).toEqual([1, 2]);
    } finally {
      await page.close();
    }
  }, 30000);
  test("a save refused with 409 because this very change is stored says so, not that another change won", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = sonyCard(page);
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
      // An earlier attempt of the same change was stored after this page read revision 1.
      const row = snapshot.schedules.find((schedule) => schedule.id === "sony-bank")!;
      Object.assign(row, { revision: 2, pattern: { ...row.pattern, time: "06:40" } });
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card
        .getByRole("status")
        .getByText("この変更はすでに保存されています。読み直した設定はこの変更と同じです。", {
          exact: true,
        })
        .waitFor();
      expect(writes.map((w) => w.body["revision"])).toEqual([1]);
      // A different stored change is still another change that came first,
      // and the card shows it.
      Object.assign(row, { revision: 3, pattern: { ...row.pattern, time: "07:15" } });
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:50");
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card
        .getByRole("status")
        .getByText(
          "他の変更が先に保存されました。読み直した設定を表示しています。必要なら再度変更してください。",
          { exact: true },
        )
        .waitFor();
      expect(await card.getByLabel("ソニー銀行の実行時刻").inputValue()).toBe("07:15");
    } finally {
      await page.close();
    }
  }, 30000);
  test("a save answered 503 before anything was stored keeps the edit and says it can be saved again", async () => {
    writeAnswer = { before: lost };
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = sonyCard(page);
      await card.getByLabel("ソニー銀行の実行時刻").fill("06:40");
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card
        .getByRole("status")
        .getByText("読み直した時点では保存されていません。もう一度保存できます。", { exact: true })
        .waitFor();
      expect(await card.getByLabel("ソニー銀行の実行時刻").inputValue()).toBe("06:40");
      writeAnswer = null;
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card.getByRole("status").getByText("保存しました。", { exact: true }).waitFor();
      expect(writes.map((w) => w.body["revision"])).toEqual([1, 1]);
    } finally {
      await page.close();
    }
  }, 30000);
  async function addOutage(page: Page) {
    await page.goto(`${origin}/schedules`);
    await page.getByRole("button", { name: "停止時間を追加", exact: true }).click();
    const form = page.locator(".maintenance-editor");
    await form.getByLabel("設定名（半角英数字・ハイフン）").fill("synthetic-outage");
    await form.getByLabel("取得元", { exact: true }).selectOption("sony-bank");
    await form.getByLabel("開始（日本時間）", { exact: true }).fill("2026-10-06T01:00");
    await form.getByLabel("終了（日本時間）", { exact: true }).fill("2026-10-06T05:00");
    await form
      .getByLabel("公式案内のURL", { exact: true })
      .fill("https://example.test/maintenance");
    await form
      .getByLabel("公式案内を確認した日時（日本時間）", { exact: true })
      .fill("2026-10-04T23:00");
    await form.getByRole("button", { name: "停止時間を保存", exact: true }).click();
    return form;
  }
  test("a maintenance save says it is saved, with a pending reservation, and moves focus to that result", async () => {
    reservation = "pending";
    const page = await browser.newPage();
    try {
      const form = await addOutage(page);
      expect(await focusedStatus(page).then((text) => text.jsonValue())).toBe(
        "停止時間を保存しました。実行予約の反映を待っています。",
      );
      await form.getByRole("button", { name: "閉じる", exact: true }).click();
      await form.waitFor({ state: "detached" });
      expect(writes).toHaveLength(1);
    } finally {
      await page.close();
    }
  }, 30000);
  test("a maintenance save whose 2xx cannot be read reads the rule back and says it is saved", async () => {
    writeAnswer = {
      after: () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    };
    const page = await browser.newPage();
    try {
      await addOutage(page);
      expect(await focusedStatus(page).then((text) => text.jsonValue())).toBe(
        "応答を受け取れませんでしたが、読み直した設定はこの変更と同じで、保存されています。",
      );
      expect(snapshot.maintenance.map((r) => [r.id, r.revision])).toEqual([
        ["synthetic-outage", 1],
      ]);
      expect(writes).toHaveLength(1);
    } finally {
      await page.close();
    }
  }, 30000);
  /** One undecided proposal revising a stored rule at the revision it was read against. */
  function oneProposal() {
    snapshot.maintenance = [
      {
        id: "synthetic-weekly",
        source: "sony-bank",
        timezone: "Asia/Tokyo",
        pattern: { kind: "weekly", weekdays: [0], start: "00:30", end: "03:00" },
        enabled: true,
        referenceUrl: "https://example.test/sony-maintenance",
        verifiedAt: "2026-10-01T00:00:00.000Z",
        scope: "collection",
        revision: 1,
      },
    ];
    snapshot.survey = {
      enabled: true,
      attention: 1,
      targets: [],
      proposals: [
        {
          id: 1,
          targetId: "sony-bank",
          source: "sony-bank",
          kind: "changed",
          ruleId: "synthetic-weekly",
          baseRevision: 1,
          current: true,
          timezone: "Asia/Tokyo",
          pattern: { kind: "weekly", weekdays: [0], start: "01:00", end: "04:00" },
          enabled: true,
          scope: "collection",
          status: "proposed",
          reasons: [],
          referenceUrl: "https://example.test/sony-maintenance",
          fetchedAt: "2026-10-05T00:00:00.000Z",
          sha256: "a".repeat(64),
          createdAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    };
  }
  test("a survey decision whose answer is lost is read back: undecided stays offered, accepted is said", async () => {
    oneProposal();
    const page = await browser.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    try {
      await page.goto(`${origin}/schedules`);
      const section = page.locator('section[aria-labelledby="maintenance-survey"]');
      const proposal = section.locator("li").filter({ hasText: "停止時間の変更" });
      // Refused before anything was stored: the read back still lists it.
      writeAnswer = { before: lost };
      await proposal.getByRole("button", { name: "却下", exact: true }).click();
      await proposal
        .getByRole("alert")
        .getByText("読み直した時点では決定されていません。もう一度選べます。", { exact: true })
        .waitFor();
      // Stored, and the answer lost: the read back shows the accepted revision.
      writeAnswer = { after: lost };
      await proposal.getByRole("button", { name: "採用", exact: true }).click();
      expect(await focusedStatus(page).then((text) => text.jsonValue())).toBe(
        "ソニー銀行の停止時間の変更：この提案は採用済みで、メンテナンス時間に反映されています。",
      );
      await proposal.waitFor({ state: "detached" });
      expect(writes.map((w) => w.body)).toEqual([{ decision: "reject" }, { decision: "accept" }]);
    } finally {
      await page.close();
    }
  }, 30000);
  test("a decision the read back cannot place, past the shown bound, says so in the section", async () => {
    oneProposal();
    const page = await browser.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    try {
      await page.goto(`${origin}/schedules`);
      const section = page.locator('section[aria-labelledby="maintenance-survey"]');
      const proposal = section.locator("li").filter({ hasText: "停止時間の変更" });
      // Stored, the answer lost, and the read back shows none of the
      // undecided proposals it still counts: this one may be among them.
      writeAnswer = { after: lost };
      readAfterWrite = async () => {
        snapshot.survey!.attention = 250;
      };
      await proposal.getByRole("button", { name: "採用", exact: true }).click();
      expect(await focusedStatus(page).then((text) => text.jsonValue())).toBe(
        "ソニー銀行の停止時間の変更：決定されたか確認できません。表示を更新して確認してください。",
      );
      await proposal.waitFor({ state: "detached" });
      expect(writes.map((w) => w.body)).toEqual([{ decision: "accept" }]);
    } finally {
      await page.close();
    }
  }, 30000);

  test("収集を依頼 shows the history first and posts one stored request only after confirmation", async () => {
    snapshot.leases = [
      { source: "sony-bank", leaseRef: "synthetic-lease", startedAt: "2026-10-05T00:00:00.000Z" },
    ];
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      const confirm = card.getByRole("group", { name: "ソニー銀行の収集依頼の確認" });
      await confirm.waitFor();
      // What to read before sending: the last run, a running collection, the
      // next scheduled run and the maintenance status.
      expect(await confirm.textContent()).toContain("前回の実行");
      expect(await confirm.textContent()).toContain("完了");
      expect(await confirm.textContent()).toContain("終わるまで依頼は待機します");
      expect(await confirm.textContent()).toContain("定例停止時間が見つかりません");
      expect(collections).toEqual([]);
      // Backing out sends nothing.
      await confirm.getByRole("button", { name: "やめる", exact: true }).click();
      expect(await card.getByRole("group", { name: "ソニー銀行の収集依頼の確認" }).count()).toBe(0);
      expect(collections).toEqual([]);

      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText(`依頼ID op_${"a".repeat(64)}`, { exact: false }).waitFor();
      expect(await card.getByRole("link", { name: "依頼の経過を見る" }).getAttribute("href")).toBe(
        `/operations/op_${"a".repeat(64)}`,
      );
      expect(collections).toHaveLength(1);
      const sent = collections[0]!;
      expect(sent.origin).toBe(origin);
      expect(sent.type).toBe("application/json");
      expect(Object.keys(sent.body).sort()).toEqual(["idempotencyKey", "requestedScope", "source"]);
      expect(sent.body["source"]).toBe("sony-bank");
      const scope = sent.body["requestedScope"] as { from: string; to: string };
      expect(scope.from).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(scope.to).toBe(scope.from);
      expect(sent.body["idempotencyKey"]).toMatch(/^ui-collect-[0-9a-f-]{36}$/u);
      // The confirmation closes; another request needs another confirmation.
      expect(await card.getByRole("button", { name: "依頼を送信" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  test("a retry after a failed answer is the same request; a new confirmation is a new one", async () => {
    let fail = true;
    collectionResponse = async () =>
      fail
        ? Response.json({ error: "commit_failed" }, { status: 503 })
        : Response.json(
            { operationId: `op_${"b".repeat(64)}`, status: "accepted" },
            { status: 202 },
          );
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText("同じ依頼として扱われます", { exact: false }).waitFor();
      expect(await card.getByRole("link", { name: "依頼の経過を見る" }).count()).toBe(0);
      fail = false;
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText(`依頼ID op_${"b".repeat(64)}`, { exact: false }).waitFor();
      expect(collections).toHaveLength(2);
      expect(collections[1]!.body["idempotencyKey"]).toBe(collections[0]!.body["idempotencyKey"]);
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      expect(await card.getByRole("link", { name: "依頼の経過を見る" }).count()).toBe(0);
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await page.waitForFunction(() => document.body.textContent?.includes("依頼ID"));
      await card.getByRole("button", { name: "収集を依頼", exact: true }).waitFor();
      expect(collections).toHaveLength(3);
      expect(collections[2]!.body["idempotencyKey"]).not.toBe(
        collections[0]!.body["idempotencyKey"],
      );
    } finally {
      await page.close();
    }
  }, 30000);

  test("a retry after JST midnight re-sends the first send's window under the same key", async () => {
    let fail = true;
    collectionResponse = async () =>
      fail
        ? Response.json({ error: "commit_failed" }, { status: 503 })
        : Response.json(
            { operationId: `op_${"c".repeat(64)}`, status: "accepted" },
            { status: 202 },
          );
    const page = await browser.newPage();
    try {
      // 23:59 JST on 2026-11-08.
      await page.clock.setFixedTime(new Date("2026-11-08T14:59:00Z"));
      await page.goto(`${origin}/schedules`);
      const card = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText("同じ依頼として扱われます", { exact: false }).waitFor();
      // 00:01 JST on 2026-11-09: the retry is still the same payload.
      await page.clock.setFixedTime(new Date("2026-11-08T15:01:00Z"));
      fail = false;
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText(`依頼ID op_${"c".repeat(64)}`, { exact: false }).waitFor();
      expect(collections).toHaveLength(2);
      expect(collections[0]!.body["requestedScope"]).toEqual({
        from: "2026-11-08",
        to: "2026-11-08",
      });
      expect(collections[1]!.body).toEqual(collections[0]!.body);
    } finally {
      await page.close();
    }
  }, 30000);

  test("a refused request says it was not stored instead of offering a retry", async () => {
    collectionResponse = async () =>
      Response.json({ error: "method_not_allowed" }, { status: 405 });
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText("保存されていません（method_not_allowed）", { exact: false }).waitFor();
      expect(await card.getByText("同じ依頼として扱われます", { exact: false }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  test("a request's result and pending key survive the card's new revision", async () => {
    let fail = true;
    collectionResponse = async () =>
      fail
        ? Response.json({ error: "commit_failed" }, { status: 503 })
        : Response.json(
            { operationId: `op_${"c".repeat(64)}`, status: "accepted" },
            { status: 202 },
          );
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const card = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText("同じ依頼として扱われます", { exact: false }).waitFor();
      // Saving the job's settings bumps its revision, which remounts the card.
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card.getByText("保存しました。", { exact: true }).waitFor();
      fail = false;
      await card.getByRole("button", { name: "依頼を送信", exact: true }).click();
      await card.getByText(`依頼ID op_${"c".repeat(64)}`, { exact: false }).waitFor();
      expect(collections).toHaveLength(2);
      expect(collections[1]!.body["idempotencyKey"]).toBe(collections[0]!.body["idempotencyKey"]);
      await card.getByRole("button", { name: "設定を保存", exact: true }).click();
      await card.getByText(`依頼ID op_${"c".repeat(64)}`, { exact: false }).waitFor();
      expect(writes.filter((w) => w.path === "/api/ops/v1/schedules/sony-bank")).toHaveLength(2);
      expect(await card.getByRole("link", { name: "依頼の経過を見る" }).getAttribute("href")).toBe(
        `/operations/op_${"c".repeat(64)}`,
      );
    } finally {
      await page.close();
    }
  }, 30000);

  test("a connection the Processor would not start offers no request", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const disabled = page.locator(".schedule-card").filter({ hasText: "GLOBAL PASS" });
      await disabled.getByText("24時間後に期限切れ", { exact: false }).waitFor();
      expect(await disabled.getByRole("button", { name: "収集を依頼" }).count()).toBe(0);
      // No target at all (absent, or null): no section.
      const vpass = page.locator(".schedule-card").filter({ hasText: "Vpass" });
      expect(await vpass.getByRole("heading", { name: "収集を依頼" }).count()).toBe(0);
      expect(collections).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);

  test("a proven pre-call stop and an uncertain call explain their different replay policies", async () => {
    const sony = snapshot.schedules.find((job) => job.id === "sony-bank")!;
    sony.latest = {
      ...sony.latest!,
      status: "not_dispatched",
      finishedAt: null,
      runIds: [],
      runLinks: [],
      failureCode: "not_dispatched",
    };
    snapshot.schedules.find((job) => job.id === "vpass")!.latest = {
      ...sony.latest,
      id: "synthetic-uncertain",
      scheduleId: "vpass",
      status: "uncertain",
      failureCode: "dispatch_uncertain",
    };
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const preCall = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await preCall
        .getByText("収集先は呼び出されていません。自動再実行は一度までです。", { exact: true })
        .waitFor();
      expect(await preCall.getByText("収集の呼び出し前に停止", { exact: false }).count()).toBe(1);
      const uncertain = page.locator(".schedule-card").filter({ hasText: "Vpass" });
      await uncertain
        .getByText("同じ予定の自動再実行は行いません。取得履歴を確認してください。", {
          exact: true,
        })
        .waitFor();
      expect(writes).toEqual([]);
      expect(collections).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);

  test("a failed refresh labels the earlier answer, holds the decisions read from it, and clears on recovery", async () => {
    // Synthetic: an invented page, proposal and lease; no provider page is read.
    stoppedLease();
    snapshot.survey = {
      enabled: true,
      attention: 1,
      targets: [],
      proposals: [
        {
          id: 7,
          targetId: "sony-bank",
          source: "sony-bank",
          kind: "new",
          ruleId: null,
          baseRevision: 0,
          current: true,
          timezone: "Asia/Tokyo",
          pattern: { kind: "weekly", weekdays: [0], start: "01:00", end: "04:00" },
          enabled: true,
          scope: "collection",
          status: "proposed",
          reasons: [],
          referenceUrl: "https://example.test/sony-maintenance",
          fetchedAt: "2026-10-05T00:00:00.000Z",
          sha256: "c".repeat(64),
          createdAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    };
    const warning = "更新できませんでした。前回読み込んだ収集スケジュールを表示しています。";
    const requestHeld = "前回読み込んだ状態です。更新できるまで依頼は送信できません。";
    const decisionHeld = "前回読み込んだ提案です。更新できるまで採用・却下はできません。";
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    try {
      await page.goto(`${origin}/schedules`);
      await page.getByText("1件の提案を確認してください。", { exact: false }).waitFor();
      const card = page.locator(".schedule-card").filter({ hasText: "ソニー銀行" });
      await card.getByRole("button", { name: "収集を依頼", exact: true }).click();
      const send = card.getByRole("button", { name: "依頼を送信", exact: true });
      const section = page.locator('section[aria-labelledby="maintenance-survey"]');
      const accept = section.getByRole("button", { name: "採用", exact: true });
      const reject = section.getByRole("button", { name: "却下", exact: true });
      const release = page.getByRole("button", { name: "停止した実行を解除", exact: true });
      const save = card.getByRole("button", { name: "設定を保存", exact: true });
      expect(await send.isEnabled()).toBe(true);
      expect(await accept.isEnabled()).toBe(true);
      expect(await page.getByText(warning, { exact: true }).count()).toBe(0);

      // Every read now fails; a refocus refetches, and the earlier answer stays.
      snapshotStatus = 503;
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await page.getByRole("alert").getByText(warning, { exact: true }).waitFor();
      // The earlier answer, its proposal count included, is shown only under the warning.
      expect(
        await page.evaluate(
          ([text, count]) => {
            const nodes = [...document.querySelectorAll("main *")];
            const label = nodes.find((node) => node.textContent === text);
            const shown = nodes.find(
              (node) => node.children.length === 0 && node.textContent?.includes(count!),
            );
            return (
              label !== undefined &&
              shown !== undefined &&
              (label.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            );
          },
          [warning, "件の提案を確認してください。"],
        ),
      ).toBe(true);
      expect(await page.getByText("1件の提案を確認してください。", { exact: false }).count()).toBe(
        1,
      );
      // Decisions read from the earlier answer are held, each saying why.
      expect(await send.isDisabled()).toBe(true);
      expect(await card.getByText(requestHeld, { exact: true }).count()).toBe(1);
      expect(await accept.isDisabled()).toBe(true);
      expect(await reject.isDisabled()).toBe(true);
      expect(await section.getByText(decisionHeld, { exact: true }).count()).toBe(1);
      // Writes the server checks against the revision or lease shown stay available.
      expect(await save.isEnabled()).toBe(true);
      expect(await release.isEnabled()).toBe(true);
      expect(await auditView(page)).toEqual([]);
      expect(writes).toEqual([]);
      expect(collections).toEqual([]);

      // Reads recover: the warning and the holds go, and the actions return.
      snapshotStatus = 200;
      const reads = snapshotReads;
      await page.getByRole("button", { name: "収集スケジュールを再試行", exact: true }).click();
      await page.getByText(warning, { exact: true }).waitFor({ state: "detached" });
      expect(snapshotReads).toBeGreaterThan(reads);
      expect(await send.isEnabled()).toBe(true);
      expect(await accept.isEnabled()).toBe(true);
      expect(await reject.isEnabled()).toBe(true);
      expect(await page.getByText(requestHeld, { exact: true }).count()).toBe(0);
      expect(await page.getByText(decisionHeld, { exact: true }).count()).toBe(0);
      expect(writes).toEqual([]);
      expect(collections).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a first read that fails shows a fixed load error and no schedules", async () => {
    snapshotStatus = 503;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/schedules`);
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "収集スケジュールを読み込めませんでした" });
      await alert.waitFor();
      expect(await alert.innerText()).toContain(
        "設定を確認できません。表示を更新して保存状態を確認してください。",
      );
      expect(await page.locator(".schedule-card").count()).toBe(0);
      expect(await page.getByText("schedule_request_failed").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  test("the schedules and the maintenance editor pass the accessibility audit", async () => {
    snapshot.leases = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    await page.goto(`${origin}/schedules`);
    await page.getByRole("heading", { name: "収集スケジュール", exact: true }).waitFor();
    await page.locator(".schedule-card").first().waitFor();
    expect(await auditView(page)).toEqual([]);
    await page.getByRole("button", { name: "停止時間を追加", exact: true }).click();
    await page.locator(".maintenance-editor").waitFor();
    expect(await auditView(page)).toEqual([]);
    await page
      .locator(".schedule-card")
      .filter({ hasText: "ソニー銀行" })
      .getByRole("button", { name: "収集を依頼", exact: true })
      .click();
    await page.getByRole("group", { name: "ソニー銀行の収集依頼の確認" }).waitFor();
    expect(await auditView(page)).toEqual([]);
    await page.close();
  }, 60_000);
});
