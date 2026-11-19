// The collection quality status view (src/query/collection-quality-status.ts,
// ADR 0045 amendment 2026-11-19): one line per configured job, its closed
// state, the owner's recovered rule (#1414), the bounded failure count, the
// datasets that do not publish, the wire contract and the answer's size, over
// the synthetic CORE store of packages/read-model. Every job is a configured
// job; every run id, unit, key and time is invented, and no amount or provider
// text is written.
import type { SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import {
  validCollectionStatus,
  type CollectionStatus,
  type CollectionStatusRow,
} from "../../observation-shared/src/collection-quality-contract.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { STATUS_OCCURRENCE_WINDOW } from "../../read-model/src/collection-quality.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import {
  jobCoreSources,
  queryCollectionQualityStatus,
  recoveryOf,
} from "../src/query/collection-quality-status.ts";

const AS_OF = "2099-01-20T00:00:00.000Z";
const DAY = 86_400_000;
const at = (day: number, time = "21:00:00.000") =>
  `2099-01-${String(day).padStart(2, "0")}T${time}Z`;

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

async function status(store: QualityStore): Promise<CollectionStatus> {
  const answer = await queryCollectionQualityStatus(executor(store), { asOf: AS_OF });
  // Every answer meets the wire contract, on the path the route serves it.
  expect(validCollectionStatus(answer)).toBe(true);
  expect(validApiResponse("/api/collection-quality", answer)).toBe(true);
  return answer;
}

async function row(store: QualityStore, job: string): Promise<CollectionStatusRow> {
  return (await status(store)).sources.find((entry) => entry.job === job)!;
}

/** A V Point run that succeeded, with a published parse unless `publish` is false. */
function vpointRun(store: QualityStore, time: string, publish = true, outcome = "success") {
  const run = store.run({
    source: "v-point",
    at: time,
    outcome: outcome as "success",
    artifacts: publish ? [{ key: "balance-info.json", dataset: "balance-info" }] : [],
  });
  if (publish) store.parse(run.artifacts[0]!, "v-point-balance-info", { kind: "published" });
  return run;
}

describe("one line per configured job", () => {
  test("lists every configured job, by id, and a job with no receipt has no last run", async () => {
    const store = new QualityStore();
    const answer = await status(store);
    const jobs = store.all<{ id: string }>("SELECT id FROM collection_schedules ORDER BY id");
    expect(answer.sources.map((entry) => entry.job)).toEqual(jobs.map((job) => job.id));
    expect(answer).toMatchObject({ apiVersion: 1, view: "status", asOf: AS_OF });
    expect(await row(store, "myjcb")).toEqual({
      job: "myjcb",
      source: "myjcb",
      enabled: true,
      lastRun: null,
      lastSuccessAt: null,
      failuresSinceSuccess: 0,
      failureCode: null,
      state: "ok",
      notPublishing: [],
    });
    // A job that is not enabled is `disabled`, whatever its history.
    for (const job of ["prestia-bank", "smbc-direct", "vpoint-pay"])
      expect((await row(store, job)).state).toBe("disabled");
    expect((await row(store, "processor-tick")).source).toBeNull();
  });

  test("the CORE sources a job collects: its collectors', none for a keepalive or the tick", () => {
    expect(jobCoreSources({ kind: "collection", source: "vpoint" })).toEqual(["v-point"]);
    expect(jobCoreSources({ kind: "collection", source: "prestia-globalpass" })).toEqual([
      "global-pass",
    ]);
    expect(jobCoreSources({ kind: "keepalive", source: "sbi-vc-trade" })).toEqual([]);
    expect(jobCoreSources({ kind: "processor", source: null })).toEqual([]);
  });
});

describe("failures since the newest success", () => {
  test("a completed receipt is ok and is the last success", async () => {
    const store = new QualityStore();
    store.occurrence("myjcb", {
      nominalAt: at(10),
      startedAt: at(10, "21:00:01.000"),
      finishedAt: at(10, "21:03:00.000"),
      status: "completed",
    });
    expect(await row(store, "myjcb")).toMatchObject({
      lastRun: { at: at(10, "21:00:01.000"), status: "completed" },
      lastSuccessAt: at(10, "21:03:00.000"),
      failuresSinceSuccess: 0,
      failureCode: null,
      state: "ok",
    });
  });

  test("failed, uncertain and not dispatched receipts after it count; a running one does not", async () => {
    const store = new QualityStore();
    store.occurrence("myjcb", { nominalAt: at(10), status: "completed" });
    store.occurrence("myjcb", {
      nominalAt: at(11),
      status: "failed",
      failureCode: "collection_failed",
    });
    store.occurrence("myjcb", {
      nominalAt: at(12),
      status: "uncertain",
      failureCode: "dispatch_uncertain",
    });
    store.occurrence("myjcb", {
      nominalAt: at(13),
      status: "failed",
      failureCode: "collection_busy",
    });
    store.occurrence("myjcb", { nominalAt: at(14), status: "started" });
    const line = await row(store, "myjcb");
    expect(line).toMatchObject({
      lastRun: { at: at(14), status: "started" },
      lastSuccessAt: at(10),
      failuresSinceSuccess: 3,
      // The newest unrecovered failure's code.
      failureCode: "collection_busy",
      state: "failing",
    });
    expect(line.lastRun).not.toHaveProperty("failureCode");
  });

  test(`past ${STATUS_OCCURRENCE_WINDOW} receipts with no success the count is "100+"`, async () => {
    for (const [count, expected] of [
      [STATUS_OCCURRENCE_WINDOW, STATUS_OCCURRENCE_WINDOW],
      [STATUS_OCCURRENCE_WINDOW + 1, "100+"],
      [STATUS_OCCURRENCE_WINDOW + 40, "100+"],
    ] as const) {
      const store = new QualityStore();
      for (let index = 0; index < count; index += 1)
        store.occurrence("st-george", {
          nominalAt: new Date(Date.parse("2098-06-01T20:35:00.000Z") + index * DAY).toISOString(),
          status: "failed",
          failureCode: "collection_failed",
        });
      expect(await row(store, "st-george"), String(count)).toMatchObject({
        failuresSinceSuccess: expected,
        failureCode: "collection_failed",
        state: "failing",
        lastSuccessAt: null,
      });
    }
    // A success inside the window bounds the count, however many receipts the job holds.
    const store = new QualityStore();
    for (let index = 0; index < STATUS_OCCURRENCE_WINDOW + 10; index += 1)
      store.occurrence("st-george", {
        nominalAt: new Date(Date.parse("2098-06-01T20:35:00.000Z") + index * DAY).toISOString(),
        status: index === STATUS_OCCURRENCE_WINDOW + 6 ? "completed" : "failed",
        failureCode: index === STATUS_OCCURRENCE_WINDOW + 6 ? undefined : "collection_failed",
      });
    expect((await row(store, "st-george")).failuresSinceSuccess).toBe(3);
  });

  test("a failure code of the owner's kind is needs-owner", async () => {
    const store = new QualityStore();
    store.occurrence("myjcb", {
      nominalAt: at(11),
      status: "failed",
      failureCode: "human_required",
    });
    expect(await row(store, "myjcb")).toMatchObject({
      failuresSinceSuccess: 1,
      failureCode: "human_required",
      state: "needs-owner",
    });
    const sbi = new QualityStore();
    sbi.occurrence("sbi-vc-trade", {
      nominalAt: at(11),
      status: "failed",
      failureCode: "manual_agreement_required",
    });
    expect((await row(sbi, "sbi-vc-trade")).state).toBe("needs-owner");
  });
});

describe("the recovered rule (#1414)", () => {
  const failed = (store: QualityStore, day: number) =>
    store.occurrence("vpoint", {
      nominalAt: at(day, "21:15:00.000"),
      startedAt: at(day, "21:15:00.500"),
      finishedAt: at(day, "21:15:05.000"),
      status: "failed",
      failureCode: "reauthentication_pending",
    });

  test("a failure followed by a succeeded, published run before the next receipt is recovered and ok", async () => {
    const store = new QualityStore();
    failed(store, 18);
    vpointRun(store, at(18, "21:15:25.000"));
    const line = await row(store, "vpoint");
    expect(line).toEqual({
      job: "vpoint",
      source: "vpoint",
      enabled: true,
      lastRun: {
        at: at(18, "21:15:00.500"),
        status: "failed",
        failureCode: "reauthentication_pending",
        recovered: { at: at(18, "21:15:25.000"), by: "fetch_run" },
      },
      lastSuccessAt: at(18, "21:15:25.000"),
      failuresSinceSuccess: 0,
      failureCode: null,
      state: "ok",
      notPublishing: [],
    });
  });

  test("a daily failure that recovers every day stays ok", async () => {
    const store = new QualityStore();
    for (const day of [15, 16, 17, 18]) {
      failed(store, day);
      vpointRun(store, at(day, "21:15:25.000"));
    }
    expect(await row(store, "vpoint")).toMatchObject({ failuresSinceSuccess: 0, state: "ok" });
  });

  test("a failure with no success after it is not recovered: V Point's session waits on the owner", async () => {
    const store = new QualityStore();
    failed(store, 18);
    expect(await row(store, "vpoint")).toMatchObject({
      lastRun: { status: "failed", failureCode: "reauthentication_pending" },
      failuresSinceSuccess: 1,
      failureCode: "reauthentication_pending",
      state: "needs-owner",
    });
  });

  test("a run that publishes nothing, a partial run, or one at the failure's finish does not recover it", async () => {
    for (const make of [
      (store: QualityStore) => vpointRun(store, at(18, "21:15:25.000"), false),
      (store: QualityStore) => vpointRun(store, at(18, "21:15:25.000"), true, "partial"),
      (store: QualityStore) => vpointRun(store, at(18, "21:15:05.000")),
      (store: QualityStore) => vpointRun(store, at(18, "21:15:01.000")),
    ]) {
      const store = new QualityStore();
      failed(store, 18);
      make(store);
      const line = await row(store, "vpoint");
      expect(line.lastRun).not.toHaveProperty("recovered");
      expect(line.failuresSinceSuccess).toBe(1);
    }
  });

  test("a success after the next receipt started recovers that one, not the earlier failure", async () => {
    // Day 17 fails with no success before day 18 starts; day 18 recovers.
    const store = new QualityStore();
    failed(store, 17);
    failed(store, 18);
    vpointRun(store, at(18, "21:16:00.000"));
    expect(await row(store, "vpoint")).toMatchObject({
      lastRun: { recovered: { at: at(18, "21:16:00.000") } },
      failuresSinceSuccess: 0,
      state: "ok",
    });
    // Day 17 recovers before day 18 starts; day 18 does not: one failure since that success.
    const later = new QualityStore();
    failed(later, 17);
    vpointRun(later, at(17, "21:16:00.000"));
    failed(later, 18);
    expect(await row(later, "vpoint")).toMatchObject({
      failuresSinceSuccess: 1,
      lastSuccessAt: at(17, "21:16:00.000"),
    });
  });

  test("an uncertain receipt with no finish is anchored at its start; nominal time decides nothing", () => {
    const success = (time: string) => ({ at: time, time: Date.parse(time) });
    const receipt = { status: "uncertain", started_at: at(18, "21:15:00.500"), finished_at: null };
    expect(recoveryOf(receipt, null, [success(at(18, "21:15:00.600"))])).not.toBeNull();
    expect(recoveryOf(receipt, null, [success(at(18, "21:15:00.400"))])).toBeNull();
    // The earliest qualifying run is the one that recovered it.
    expect(
      recoveryOf(receipt, at(19, "21:15:00.000"), [
        success(at(19, "01:00:00.000")),
        success(at(18, "22:00:00.000")),
        success(at(19, "22:00:00.000")),
      ])?.at,
    ).toBe(at(18, "22:00:00.000"));
    expect(
      recoveryOf({ ...receipt, status: "completed" }, null, [success(at(19, "01:00:00.000"))]),
    ).toBeNull();
  });

  test("the last success is the newer of a completed receipt and a recovering run", async () => {
    const store = new QualityStore();
    store.occurrence("vpoint", {
      nominalAt: at(16, "21:15:00.000"),
      finishedAt: at(16, "21:20:00.000"),
      status: "completed",
    });
    failed(store, 18);
    vpointRun(store, at(18, "21:15:25.000"));
    expect((await row(store, "vpoint")).lastSuccessAt).toBe(at(18, "21:15:25.000"));
  });
});

describe("datasets that do not publish", () => {
  /** A Vpass card month captured `day`, from a successful or a partial run. */
  function vpassCapture(store: QualityStore, day: number, partial: boolean, unit = "card-a") {
    const run = store.run({
      source: "vpass",
      at: at(day),
      outcome: partial ? "partial" : "success",
      units: {
        [unit]: partial
          ? { outcome: "partial", code: "stated_total_mismatch" }
          : { outcome: "success" },
      },
      artifacts: [{ key: "months/209901/top-001.json", dataset: "statement-page", unit }],
    });
    if (!partial) store.parse(run.artifacts[0]!, "vpass-statement-page", { kind: "published" });
    return run;
  }

  test("a newest capture with no published parse, older than three Tokyo days since the last parsed one, is degraded", async () => {
    const store = new QualityStore();
    vpassCapture(store, 5, false);
    vpassCapture(store, 18, true);
    store.occurrence("vpass", { nominalAt: at(18), status: "completed" });
    const line = await row(store, "vpass");
    expect(line).toMatchObject({ failuresSinceSuccess: 0, state: "degraded" });
    expect(line.notPublishing).toHaveLength(1);
    const [entry] = line.notPublishing;
    expect(entry).toMatchObject({
      dataset: "statement-page",
      units: 1,
      newestParsedCapture: at(5),
      // 2099-01-06 (Tokyo) to 2099-01-20.
      ageDays: 14,
    });
    expect(entry!.reasons).toEqual(expect.arrayContaining(["run_not_successful", "unit_failed"]));
    expect(entry!.reasons).not.toContain("retention_not_assessed");
  });

  test("a recent unpublished capture is listed but not degraded; a dataset never parsed is aged from its capture", async () => {
    const store = new QualityStore();
    vpassCapture(store, 17, false);
    vpassCapture(store, 19, true);
    store.occurrence("vpass", { nominalAt: at(19), status: "completed" });
    const recent = await row(store, "vpass");
    expect(recent.state).toBe("ok");
    expect(recent.notPublishing).toMatchObject([{ newestParsedCapture: at(17), ageDays: 2 }]);
    // Captures whose parses failed name the parser; none was ever published.
    const never = new QualityStore();
    for (const [day, unit] of [
      [2, "card-a"],
      [19, "card-b"],
    ] as const) {
      const run = never.run({
        source: "vpass",
        at: at(day),
        units: { [unit]: { outcome: "success" } },
        artifacts: [{ key: "months/209901/top-001.json", dataset: "statement-page", unit }],
      });
      never.parse(run.artifacts[0]!, "vpass-statement-page", {
        kind: "failed",
        code: "parse_error",
      });
    }
    never.occurrence("vpass", { nominalAt: at(19), status: "completed" });
    expect(await row(never, "vpass")).toMatchObject({
      state: "degraded",
      notPublishing: [
        { dataset: "statement-page", units: 2, newestParsedCapture: null, ageDays: 17 },
      ],
    });
  });

  test("a unit that waits on the owner makes the job needs-owner while its receipts complete", async () => {
    const store = new QualityStore();
    vpassCapture(store, 17, false);
    const run = store.run({
      source: "vpass",
      at: at(18),
      outcome: "partial",
      units: { "card-a": { outcome: "human_required", code: "human_required_reauth" } },
      artifacts: [{ key: "months/209901/top-001.json", dataset: "statement-page", unit: "card-a" }],
    });
    expect(run.artifacts).toHaveLength(1);
    store.occurrence("vpass", { nominalAt: at(18), status: "completed" });
    const line = await row(store, "vpass");
    expect(line.state).toBe("needs-owner");
    expect(line.notPublishing[0]!.reasons).toContain("user_action_required");
  });

  test("a disabled job reads no cells", async () => {
    const store = new QualityStore();
    store.run({
      source: "prestia",
      at: at(2),
      outcome: "partial",
      artifacts: [{ key: "synthetic.json", dataset: "synthetic-dataset" }],
    });
    expect(await row(store, "prestia-bank")).toMatchObject({
      state: "disabled",
      notPublishing: [],
    });
  });
});

describe("the answer stays small", () => {
  test("every configured job with history and not-publishing datasets stays under 8 KB, envelope included", async () => {
    const store = new QualityStore();
    const jobs = store.all<{ id: string }>(
      "SELECT id FROM collection_schedules WHERE kind <> 'processor' ORDER BY id",
    );
    for (const { id } of jobs)
      for (let day = 1; day <= 19; day += 1)
        store.occurrence(id, {
          nominalAt: at(day),
          startedAt: at(day, "21:00:00.587"),
          finishedAt: at(day, "21:04:11.123"),
          status: day % 3 === 0 ? "failed" : "completed",
          failureCode: day % 3 === 0 ? "human_required_session_refresh" : undefined,
        });
    // Three Vpass card units and two GLOBAL PASS months that stopped publishing.
    for (const unit of ["card-a", "card-b", "card-c"]) {
      const good = store.run({
        source: "vpass",
        at: at(2),
        units: { [unit]: { outcome: "success" } },
        artifacts: [{ key: "months/209901/top-001.json", dataset: "statement-page", unit }],
      });
      store.parse(good.artifacts[0]!, "vpass-statement-page", { kind: "published" });
      store.run({
        source: "vpass",
        at: at(19),
        outcome: "partial",
        units: { [unit]: { outcome: "partial", code: "stated_total_mismatch" } },
        artifacts: [
          { key: "months/209901/top-001.json", dataset: "statement-page", unit },
          { key: "credit/authori.json", dataset: "credit-authori", unit },
        ],
      });
    }
    const months = store.run({
      source: "global-pass",
      at: at(3),
      artifacts: ["2099-01", "2098-12"].map((month) => ({
        key: `activity-${month}.html`,
        dataset: "globalpass-activity",
      })),
    });
    for (const artifact of months.artifacts)
      store.parse(artifact, "global-pass-activity", { kind: "published" });
    store.run({
      source: "global-pass",
      at: at(19),
      outcome: "partial",
      artifacts: ["2099-01", "2098-12"].map((month) => ({
        key: `activity-${month}.html`,
        dataset: "globalpass-activity",
      })),
    });
    const answer = await status(store);
    expect(answer.sources.length).toBeGreaterThanOrEqual(17);
    expect(answer.sources.some((entry) => entry.notPublishing.length > 0)).toBe(true);
    const bytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: "kogane-page-read-v1", data: answer }),
    ).length;
    console.log(`status view: ${answer.sources.length} jobs, ${bytes} bytes`);
    expect(bytes).toBeLessThan(8 * 1024);
  });

  test("reads only: the store is unchanged", async () => {
    const store = new QualityStore();
    store.occurrence("myjcb", {
      nominalAt: at(11),
      status: "failed",
      failureCode: "collection_failed",
    });
    const before = store.all("SELECT count(*) AS n FROM collection_schedule_occurrences");
    await status(store);
    expect(store.all("SELECT count(*) AS n FROM collection_schedule_occurrences")).toEqual(before);
    expect(store.all("SELECT status, failure_code FROM collection_schedule_occurrences")).toEqual([
      { status: "failed", failure_code: "collection_failed" },
    ]);
  });
});
