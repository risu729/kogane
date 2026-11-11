import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";
import { encryptJson } from "../src/crypto";
import * as smbc from "../src/smbc";
import { runPrefix, storeBytes, storeJson } from "../src/storage";
import { buildSharedRunPlan, manifestBytes } from "../src/shared-collection";
import type { BackfillManifest, BackfillProgress, DateRange, StoredArtifact } from "../src/types";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Env,
    ) {}
  },
}));
const { SmbcBackfillSession } = await import("../src/session");
const { default: worker } = await import("../src/worker");
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  setSystemTime();
});

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const encoder = new TextEncoder();

async function harness(
  saved?: Partial<BackfillProgress>,
  foreignFailure?: string,
  yenBalanceFailure?: string,
) {
  const bucket = new FakeR2Bucket();
  const values = new Map<string, unknown>();
  const alarms: number[] = [];
  const requested: DateRange[] = [];
  const foreignRequested: DateRange[] = [];
  const artifacts: StoredArtifact[] = [];
  if (saved) {
    const prefix = runPrefix(saved.startedAt!, saved.runId!);
    // A previously finished January chunk is retained byte-for-byte on resume.
    if (saved.completedChunks === 1) {
      const range = { start: "2099-01-01", end: "2099-01-31" };
      artifacts.push(
        await storeBytes({
          bucket: bucket as unknown as R2Bucket,
          key: `${prefix}/transactions/20990101-20990131.raw.json.sjis`,
          bytes: encoder.encode('{"rows":[]}'),
          mediaType: "application/json",
          artifact: { dataset: "transactions-raw", range },
        }),
        await storeJson({
          bucket: bucket as unknown as R2Bucket,
          key: `${prefix}/transactions/20990101-20990131.normalized.json`,
          value: { range, transactions: [] },
          artifact: { dataset: "transactions-normalized", range },
        }),
      );
    }
    values.set("progress", { phase: "partial", transactionCount: 0, ...saved });
    values.set("artifacts", artifacts);
  }
  const challenge = await encryptJson({ expiresAt: "2099-04-01T00:00:00Z" }, KEY);
  values.set("challenge", challenge);
  const profile = {
    continueSession: async () => undefined,
    getBalance: async () => {
      if (yenBalanceFailure) throw new Error(yenBalanceFailure);
      return {
        rawBytes: encoder.encode('{"balance":0}'),
        rawContentType: "application/json",
        currency: "JPY",
        amount: 0,
      };
    },
    getTransactions: async (range: DateRange) => {
      requested.push(range);
      return {
        rawBytes: encoder.encode('{"rows":[]}'),
        rawContentType: "application/json",
        transactions: [],
        depositsTotal: 0,
        withdrawalsTotal: 0,
      };
    },
    getForeignBalance: async () => ({
      currency: "AUD",
      amount: "123.45",
      yenEquivalent: "12000",
      referenceRate: "97.205",
    }),
    getForeignHistory: async (range: DateRange) => {
      foreignRequested.push(range);
      if (foreignFailure) throw new Error(foreignFailure);
      return { currency: "AUD", range, emptyCode: "PC-AIFDDT1-00134-E", transactions: [] };
    },
    export: () => ({}),
    logout: async () => undefined,
  } as unknown as smbc.DirectProfile;
  const login = spyOn(smbc, "finishLogin").mockResolvedValue(profile);
  const imported = spyOn(smbc.DirectProfile, "import").mockReturnValue(profile);
  restores.push(
    () => login.mockRestore(),
    () => imported.mockRestore(),
  );
  const state = {
    storage: {
      get: async (name: string) => values.get(name),
      put: async (name: string | Record<string, unknown>, value?: unknown) => {
        if (typeof name === "string") values.set(name, value);
        else for (const [field, item] of Object.entries(name)) values.set(field, item);
      },
      delete: async (name: string) => values.delete(name),
      setAlarm: async (time: number) => {
        alarms.push(time);
      },
      deleteAlarm: async () => undefined,
    },
  } as unknown as DurableObjectState;
  const session = new SmbcBackfillSession(state, {
    DEFAULT_BACKFILL_FROM: "2099-03-01",
    SESSION_ENCRYPTION_KEY: KEY,
    SMBC_CREDENTIAL_JSON: JSON.stringify({ user: "1234567-12345", password: "synthetic-only" }),
    COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v2",
    DATA: bucket,
  } as unknown as Env);
  return { session, values, bucket, requested, foreignRequested, artifacts, alarms, challenge };
}

test("10:00 JST approval completes only closed days, then the next backfill includes the newly closed day", async () => {
  setSystemTime(new Date("2099-03-02T01:00:00.000Z"));
  const h = await harness();
  const first = await h.session.finishAndStart();
  expect(first.progress).toMatchObject({ to: "2099-03-01", totalChunks: 1 });
  expect(h.foreignRequested).toEqual([
    { start: "2098-12-01", end: "2098-12-31" },
    { start: "2099-01-01", end: "2099-01-31" },
    { start: "2099-02-01", end: "2099-02-28" },
    { start: "2099-03-01", end: "2099-03-01" },
  ]);
  await h.session.alarm();
  expect(h.requested).toEqual([{ start: "2099-03-01", end: "2099-03-01" }]);
  const read = await readTerminal(h.bucket, "smbc-direct", first.progress.runId!);
  if (read.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(read.manifest.coverageStatus).toBe("complete");
  expect(read.manifest.requestedScope.endValue).toBe("2099-03-01");
  expect(
    read.manifest.ranges
      .filter((range) => range.rangeKind === "declared_coverage" && range.unitKey === "account")
      .map((range) => range.endValue),
  ).toEqual(["2099-03-01"]);
  expect(await h.session.getStatus()).toMatchObject({
    phase: "success",
    publicationStatus: "persisted",
  });

  setSystemTime(new Date("2099-03-03T01:00:00.000Z"));
  h.values.set("challenge", h.challenge);
  const second = await h.session.finishAndStart();
  expect(second.progress.to).toBe("2099-03-02");
  expect(second.progress.runId).not.toBe(first.progress.runId);
  await h.session.alarm();
  expect(h.requested.at(-1)).toEqual({ start: "2099-03-01", end: "2099-03-02" });
  const next = await readTerminal(h.bucket, "smbc-direct", second.progress.runId!);
  if (next.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(next.manifest.coverageStatus).toBe("complete");
  expect(next.manifest.requestedScope.endValue).toBe("2099-03-02");
});

test("an unreviewed nonempty AUD response keeps the run partial and never turns missing movements into zero", async () => {
  setSystemTime(new Date("2099-03-02T01:00:00.000Z"));
  const h = await harness(undefined, "foreign_nonempty_unreviewed");
  const started = await h.session.finishAndStart();
  await h.session.alarm();
  expect(await h.session.getStatus()).toMatchObject({
    phase: "partial",
    lastErrorCode: "foreign_nonempty_unreviewed",
    foreignOrdinary: {
      balance: { status: "success" },
      history: { status: "partial", failureCode: "foreign_nonempty_unreviewed" },
    },
  });
  const terminal = await readTerminal(h.bucket, "smbc-direct", started.progress.runId!);
  if (terminal.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(terminal.manifest.units).toContainEqual(
    expect.objectContaining({
      unitKey: "foreign-ordinary-aud-history",
      coverageStatus: "partial",
      safeErrorCode: "foreign_nonempty_unreviewed",
    }),
  );
  expect(
    terminal.manifest.artifacts.filter((artifact) =>
      artifact.artifactKey.startsWith("foreign-ordinary-aud/history/"),
    ),
  ).toHaveLength(0);
});

test("a yen balance failure preserves independently complete AUD balance and history units", async () => {
  setSystemTime(new Date("2099-03-02T01:00:00.000Z"));
  const h = await harness(undefined, undefined, "balance_value_missing");
  await expect(h.session.finishAndStart()).rejects.toThrow("balance_value_missing");
  const progress = await h.session.getStatus();
  expect(progress.phase).toBe("partial");
  const terminal = await readTerminal(h.bucket, "smbc-direct", progress.runId!);
  if (terminal.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(terminal.manifest.units).toContainEqual(
    expect.objectContaining({
      unitKey: "account",
      coverageStatus: "partial",
      safeErrorCode: "balance_value_missing",
    }),
  );
  for (const unitKey of ["foreign-ordinary-aud-balance", "foreign-ordinary-aud-history"])
    expect(terminal.manifest.units).toContainEqual(
      expect.objectContaining({ unitKey, coverageStatus: "complete" }),
    );
});

for (const [name, end, total] of [
  ["closed-day", "2099-02-28", 2],
  ["legacy approval-day", "2099-03-01", 3],
] as const) {
  test(`a stopped ${name} run resumes the next JST day with its stored window and completed chunks`, async () => {
    setSystemTime(new Date("2099-03-02T01:00:00.000Z"));
    const h = await harness({
      runId: `synthetic-${name.replaceAll(" ", "-")}`,
      startedAt: "2099-03-01T01:00:00.000Z",
      from: "2099-01-01",
      to: end,
      completedChunks: 1,
      totalChunks: total,
    });
    const before = [...h.artifacts];
    const resumed = await h.session.finishAndStart();
    expect(resumed.progress).toMatchObject({
      from: "2099-01-01",
      to: end,
      completedChunks: 1,
      totalChunks: total,
      nextRange: { start: "2099-02-01", end: "2099-02-28" },
    });
    await h.session.alarm();
    expect(h.requested[0]).toEqual({ start: "2099-02-01", end: "2099-02-28" });
    expect(h.values.get("artifacts")).toEqual(expect.arrayContaining(before));
    expect(await h.session.getStatus()).toMatchObject({
      phase: "success",
      publicationStatus: "persisted",
    });
    const read = await readTerminal(h.bucket, "smbc-direct", resumed.progress.runId!);
    if (read.outcome !== "found") throw new Error("missing synthetic terminal");
    expect(read.manifest.coverageStatus).toBe("complete");
    expect(read.manifest.requestedScope.endValue).toBe(end);
  });
}

test("a legacy current-day chunk waits until JST midnight before acquisition", async () => {
  setSystemTime(new Date("2099-03-01T01:00:00.000Z"));
  const h = await harness({
    runId: "synthetic-midnight",
    startedAt: "2099-03-01T00:00:00.000Z",
    from: "2099-03-01",
    to: "2099-03-01",
    completedChunks: 0,
    totalChunks: 1,
  });
  await h.session.finishAndStart();
  await h.session.alarm();
  expect(h.requested).toEqual([]);
  expect(h.alarms.at(-1)).toBe(Date.parse("2099-03-01T15:00:00.000Z"));
  expect((await readTerminal(h.bucket, "smbc-direct", "synthetic-midnight")).outcome).toBe(
    "missing",
  );
  setSystemTime(new Date("2099-03-01T15:00:00.000Z"));
  await h.session.alarm();
  expect(h.requested).toEqual([{ start: "2099-03-01", end: "2099-03-01" }]);
  const read = await readTerminal(h.bucket, "smbc-direct", "synthetic-midnight");
  if (read.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(read.manifest.coverageStatus).toBe("complete");
});

test.each([true, false])(
  "publishing an old open-day success never upgrades coverage regardless of logout (logoutSucceeded=%s)",
  async (logoutSucceeded) => {
    const manifest: BackfillManifest = {
      schemaVersion: "smbc-direct-backfill-worker-poc-v2",
      source: "smbc-direct",
      runId: "synthetic-old-success",
      startedAt: "2099-03-01T01:00:00.000Z",
      completedAt: "2099-03-01T01:10:00.000Z",
      status: "success",
      requestedRange: { start: "2099-03-01", end: "2099-03-01" },
      completedChunks: 1,
      totalChunks: 1,
      transactionCount: 0,
      artifacts: [],
      failureCodes: [],
      logoutSucceeded,
    };
    for (const now of ["2099-03-01T01:00:00.000Z", "2099-03-02T01:00:00.000Z"]) {
      setSystemTime(new Date(now));
      const plan = await buildSharedRunPlan({
        manifest,
        manifestBytes: manifestBytes(manifest),
        prefix: "synthetic",
        bytesByKey: new Map(),
        identity: { attemptId: "synthetic-attempt" },
      });
      expect(plan.run).toMatchObject({
        providerOutcome: "success",
        coverageStatus: "partial",
        units: [
          expect.objectContaining({
            coverageStatus: "partial",
            safeErrorCode: "coverage_day_not_finished",
          }),
        ],
      });
      expect(plan.run.safeErrorCode).toBeUndefined();
      expect(plan.run.reports).toEqual(
        logoutSucceeded
          ? []
          : [
              {
                reportRef: "logout",
                reportKind: "logout",
                scope: "run",
                outcome: "failed",
                safeErrorCode: "logout_failed",
              },
            ],
      );
    }
  },
);

test("saved open-day success exposes recovery through progress and the status API until a fresh backfill", async () => {
  setSystemTime(new Date("2099-03-02T01:00:00.000Z"));
  const h = await harness({
    phase: "success",
    runId: "synthetic-saved-open-day",
    startedAt: "2099-03-01T01:00:00.000Z",
    completedAt: "2099-03-01T01:10:00.000Z",
    from: "2099-03-01",
    to: "2099-03-01",
    completedChunks: 0,
    totalChunks: 1,
    logoutSucceeded: true,
  });
  const prefix = runPrefix("2099-03-01T01:00:00.000Z", "synthetic-saved-open-day");
  const range = { start: "2099-03-01", end: "2099-03-01" };
  h.values.set("artifacts", [
    await storeBytes({
      bucket: h.bucket as unknown as R2Bucket,
      key: `${prefix}/transactions/20990301-20990301.raw.json.sjis`,
      bytes: encoder.encode('{"rows":[]}'),
      mediaType: "application/json",
      artifact: { dataset: "transactions-raw", range },
    }),
    await storeJson({
      bucket: h.bucket as unknown as R2Bucket,
      key: `${prefix}/transactions/20990301-20990301.normalized.json`,
      value: { range, transactions: [] },
      artifact: { dataset: "transactions-normalized", range },
    }),
  ]);
  h.values.set("progress", {
    ...(await h.session.getStatus()),
    completedChunks: 1,
    artifactCount: 2,
    manifestKey: `${prefix}/manifest.json`,
  });

  const published = await h.session.publishStoredRun();
  const recovery = {
    phase: "success",
    publicationStatus: "persisted",
    publicationErrorCode: null,
    coverageStatus: "partial",
    coverageErrorCode: "coverage_day_not_finished",
  };
  expect(published).toMatchObject(recovery);
  expect(await h.session.getStatus()).toMatchObject(recovery);
  const fetchStatus = worker.fetch as unknown as (
    request: Request,
    env: object,
    ctx: object,
  ) => Promise<Response>;
  const response = await fetchStatus(
    new Request("https://collector.invalid/api/status"),
    { BACKFILL_SESSION: { getByName: () => h.session } },
    { access: { getIdentity: async () => ({ user_uuid: "synthetic-human" }) } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ...recovery, waitingForHuman: true });
  const original = await readTerminal(h.bucket, "smbc-direct", "synthetic-saved-open-day");
  if (original.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(original.manifest).toMatchObject({
    providerOutcome: "success",
    coverageStatus: "partial",
    units: [
      expect.objectContaining({
        coverageStatus: "partial",
        safeErrorCode: "coverage_day_not_finished",
      }),
    ],
  });

  // A publication retry preserves the recovery reason; a fresh approved run clears it.
  expect(await h.session.publishStoredRun()).toMatchObject(recovery);
  h.values.set("challenge", h.challenge);
  const fresh = await h.session.finishAndStart();
  expect(fresh.progress).toMatchObject({
    phase: "running",
    coverageStatus: "unknown",
    coverageErrorCode: null,
  });
  await h.session.alarm();
  expect(await h.session.getStatus()).toMatchObject({
    phase: "success",
    coverageStatus: "complete",
    coverageErrorCode: null,
  });
  const unchanged = await readTerminal(h.bucket, "smbc-direct", "synthetic-saved-open-day");
  if (unchanged.outcome !== "found") throw new Error("missing synthetic terminal");
  expect(unchanged.terminalDigest).toBe(original.terminalDigest);
});
