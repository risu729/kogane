import { describe, expect, test } from "bun:test";
import { IMPORT_ADAPTERS, type ImportSource } from "../src/adapters";
import { ImportError } from "../src/error";
import { importMoneyForwardRun, moneyForwardTransferOffset } from "../src/moneyforward";
import { importMyJcbRun } from "../src/myjcb";
import { processReconcilerMessage, type ImportMessage } from "../src/reconciler";
import { importVpassRun } from "../src/vpass";
import { importVpassCardBinding } from "../src/vpass-identity";
import worker, { reconcilerDependencies } from "../src/worker";
import * as moneyforward from "./synthetic/moneyforward";
import * as myjcb from "./synthetic/myjcb";
import * as vpass from "./synthetic/vpass";

/*
 * Parity between the previous per-source HTTP branches (copied below as
 * `legacy*`), the adapter-routed HTTP entry, and the Queue reconciler.
 * Each path drives the same synthetic run against its own recording central
 * and must produce identical central calls, outcomes, and continuations.
 */

const ACCOUNT = "59ea63cc00914b30ca410b062ae2bb7f";
const ORIGIN = "https://importer.internal";
const TEST_STARTED_AT = Date.now() - 60_000;

type JsonObject = Record<string, unknown>;
type CentralCall = { path: string; method: string; body: string };
type Handler = (request: Request) => Promise<Response>;

interface HttpStep {
  status: number;
  body: JsonObject;
}

interface Fixture {
  env: Env;
  central: { requests: CentralCall[] };
  reads: string[];
}

describe("import entry point parity", () => {
  test("MyJCB: legacy HTTP, adapter HTTP, and Queue produce identical central calls and continuations", async () => {
    const legacyFixture = await myJcbFixture();
    const legacy = await driveHttp(
      (request) => legacyMyJcbImportRun(legacyFixture.env, request),
      "/v1/myjcb/import-run",
      "manifestKey",
      myjcb.MANIFEST_KEY,
    );
    const routedFixture = await myJcbFixture();
    const routed = await driveHttp(
      (request) => worker.fetch(request as never, routedFixture.env),
      "/v1/myjcb/import-run",
      "manifestKey",
      myjcb.MANIFEST_KEY,
    );
    const queuedFixture = await myJcbFixture();
    const queued = await driveQueue(
      queuedFixture.env,
      "kogane-myjcb-collector-poc",
      myjcb.MANIFEST_KEY,
    );

    expect(legacy.map((step) => step.status)).toEqual([202, 200]);
    expect(routed).toEqual(legacy);
    expect(normalizeCalls(routedFixture.central.requests)).toEqual(
      normalizeCalls(legacyFixture.central.requests),
    );
    expect(normalizeCalls(queuedFixture.central.requests)).toEqual(
      normalizeCalls(legacyFixture.central.requests),
    );
    expect(queued.outcomes).toEqual(["deferred", "sealed"]);
    expect(queued.messages).toHaveLength(1);
    expect(queued.messages[0]).toMatchObject({
      kind: "import",
      source: "myjcb",
      terminalKey: myjcb.MANIFEST_KEY,
      step: 1,
      progress: legacy[0]!.body.nextOffset,
      resume: legacy[0]!.body.continuation,
    });
    expect(legacyFixture.central.requests.length).toBeGreaterThan(10);
  });

  test("MoneyForward: the three paths agree on central calls and decoded continuation offsets", async () => {
    const legacyFixture = await moneyForwardFixture();
    const legacy = await driveHttp(
      (request) => legacyMoneyForwardImportRun(legacyFixture.env, request),
      "/v1/moneyforward/import-run",
      "manifestKey",
      moneyforward.MANIFEST_KEY,
    );
    const routedFixture = await moneyForwardFixture();
    const routed = await driveHttp(
      (request) => worker.fetch(request as never, routedFixture.env),
      "/v1/moneyforward/import-run",
      "manifestKey",
      moneyforward.MANIFEST_KEY,
    );
    const queuedFixture = await moneyForwardFixture();
    const queued = await driveQueue(
      queuedFixture.env,
      "kogane-moneyforward-collector-poc",
      moneyforward.MANIFEST_KEY,
    );

    // The continuation is AES-GCM with a random IV, so compare the decoded offset.
    const decoded = async (steps: HttpStep[]) =>
      Promise.all(
        steps.map(async (step) => ({
          status: step.status,
          body: {
            ...step.body,
            ...(typeof step.body.continuation === "string"
              ? {
                  continuation: await moneyForwardTransferOffset(
                    step.body.continuation,
                    moneyforward.FINGERPRINT_KEY,
                  ),
                }
              : {}),
          } as JsonObject,
        })),
      );
    expect(legacy.length).toBeGreaterThan(2);
    expect(legacy.at(-1)!.status).toBe(200);
    expect(await decoded(routed)).toEqual(await decoded(legacy));
    expect(normalizeCalls(routedFixture.central.requests)).toEqual(
      normalizeCalls(legacyFixture.central.requests),
    );
    expect(normalizeCalls(queuedFixture.central.requests)).toEqual(
      normalizeCalls(legacyFixture.central.requests),
    );
    expect(queued.outcomes).toEqual([...legacy.slice(0, -1).map(() => "deferred"), "sealed"]);
    const deferredSteps = (await decoded(legacy)).filter((step) => step.status === 202);
    expect(deferredSteps.map((step) => step.body.continuation)).toEqual(
      await Promise.all(
        queued.messages.map((message) =>
          moneyForwardTransferOffset(message.resume as string, moneyforward.FINGERPRINT_KEY),
        ),
      ),
    );
    expect(deferredSteps.map((step) => step.body.nextOffset)).toEqual(
      queued.messages.map((message) => message.progress),
    );
  });

  test("Vpass: the three paths agree, including the sealed-run identity sidecar", async () => {
    const legacyFixture = vpassFixture();
    const legacy = await driveHttp(
      (request) => legacyVpassImportRun(legacyFixture.env, request),
      "/v1/vpass/import-run",
      "recordKey",
      vpass.CARD_RECORD,
    );
    const routedFixture = vpassFixture();
    const routed = await driveHttp(
      (request) => worker.fetch(request as never, routedFixture.env),
      "/v1/vpass/import-run",
      "recordKey",
      vpass.CARD_RECORD,
    );
    const queuedFixture = vpassFixture();
    const queued = await driveQueue(
      queuedFixture.env,
      "kogane-vpass-collector-poc",
      vpass.CARD_RECORD,
    );

    expect(legacy.map((step) => step.status)).toEqual([202, 200]);
    expect(routed).toEqual(legacy);
    expect(normalizeCalls(routedFixture.central.requests)).toEqual(
      normalizeCalls(legacyFixture.central.requests),
    );
    expect(normalizeCalls(queuedFixture.central.requests)).toEqual(
      normalizeCalls(legacyFixture.central.requests),
    );
    expect(queued.outcomes).toEqual(["deferred", "sealed"]);
    expect([legacy[0]!.body.continuation]).toEqual(
      queued.messages.map((message) => message.resume),
    );
    // The identity sidecar creates its own central run exactly once per path, after the seal.
    const runCreates = (calls: CentralCall[]) =>
      calls.map((call, index) => ({ call, index })).filter(({ call }) => call.path === "/v1/runs");
    const sealIndex = (calls: CentralCall[]) =>
      calls.findIndex((call) => /\/seal$/u.test(call.path));
    for (const fixture of [legacyFixture, routedFixture, queuedFixture]) {
      const creates = runCreates(fixture.central.requests);
      expect(creates).toHaveLength(2);
      expect(creates[1]!.index).toBeGreaterThan(sealIndex(fixture.central.requests));
    }
    // Every path reads the same source objects in the same order.
    expect(routedFixture.reads).toEqual(legacyFixture.reads);
    expect(queuedFixture.reads).toEqual(legacyFixture.reads);
  });

  test("import-run request validation answers the same status and code for every source", async () => {
    const env = {} as Env;
    for (const [source, legacy] of Object.entries(LEGACY_IMPORT_RUN) as Array<
      [ImportSource, LegacyImportRoute]
    >) {
      const key = "k".repeat(10);
      const cases: ValidationCase[] = [
        { body: {}, code: legacy.keyCode, status: 400 },
        { body: { [legacy.key]: "" }, code: legacy.keyCode, status: 400 },
        { body: { [legacy.key]: "k".repeat(501) }, code: legacy.keyCode, status: 400 },
        { body: { [legacy.key]: 5 }, code: legacy.keyCode, status: 400 },
        { body: { [legacy.key]: key, extra: 1 }, code: "unknown_field", status: 400 },
        {
          body: { manifestKey: key, recordKey: key, normalizedKey: key },
          code: "unknown_field",
          status: 400,
        },
        { body: "nope", code: "json_invalid", status: 400 },
        { body: "", code: "json_invalid", status: 400 },
        { body: "[]", code: "json_shape_invalid", status: 400 },
        { body: "null", code: "json_shape_invalid", status: 400 },
        {
          body: "{}",
          headers: { "content-length": String(65 * 1024) },
          code: "json_too_large",
          status: 413,
        },
        {
          body: JSON.stringify({ [legacy.key]: "k".repeat(70 * 1024) }),
          code: "json_too_large",
          status: 413,
        },
        ...(legacy.continuationBudget === undefined
          ? [
              {
                body: { [legacy.key]: key, continuation: "c" },
                code: "unknown_field",
                status: 400,
              },
            ]
          : [
              {
                body: { [legacy.key]: key, continuation: 5 },
                code: "continuation_invalid",
                status: 400,
              },
              {
                body: { [legacy.key]: key, continuation: null },
                code: "continuation_invalid",
                status: 400,
              },
              {
                body: { [legacy.key]: key, continuation: "" },
                code: "continuation_invalid",
                status: 400,
              },
              {
                body: {
                  [legacy.key]: key,
                  continuation: "c".repeat(legacy.continuationBudget + 1),
                },
                code: "continuation_invalid",
                status: 400,
              },
            ]),
      ];
      for (const item of cases) {
        const request = () =>
          new Request(`${ORIGIN}${legacy.path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(item.headers ?? {}) },
            body: typeof item.body === "string" ? item.body : JSON.stringify(item.body),
          });
        const before = await legacyValidateImportRun(legacy, request());
        const after = await worker.fetch(request() as never, env);
        const expected = { source, status: item.status, body: { error: item.code } };
        expect({ source, status: before.status, body: await before.json() }).toEqual(expected);
        expect({ source, status: after.status, body: await after.json() }).toEqual(expected);
      }
    }
  });

  test("backfill-page request validation answers the same status and code for every source", async () => {
    const env = {} as Env;
    for (const [source, legacy] of Object.entries(LEGACY_BACKFILL) as Array<
      [ImportSource, LegacyBackfillRoute]
    >) {
      const cases: Array<{ body: JsonObject; code: string }> = [
        { body: { limit: 2 }, code: "backfill_limit_must_be_one" },
        { body: { limit: "1" }, code: "backfill_limit_must_be_one" },
        { body: { cursor: 5, limit: 1 }, code: "cursor_invalid" },
        { body: { cursor: "", limit: 1 }, code: "cursor_invalid" },
        { body: { cursor: "c".repeat(legacy.cursorBudget + 1), limit: 1 }, code: "cursor_invalid" },
        {
          body: { cursor: "c".repeat(legacy.cursorBudget), limit: 2 },
          code: "backfill_limit_must_be_one",
        },
        { body: { cursor: "c", limit: 1, extra: true }, code: "unknown_field" },
      ];
      for (const item of cases) {
        const request = () =>
          new Request(`${ORIGIN}${legacy.path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(item.body),
          });
        const before = await legacyValidateBackfill(legacy, request());
        const after = await worker.fetch(request() as never, env);
        const expected = { source, status: 400, body: { error: item.code } };
        expect({ source, status: before.status, body: await before.json() }).toEqual(expected);
        expect({ source, status: after.status, body: await after.json() }).toEqual(expected);
      }
    }
  });

  test("every parity source is a registered adapter", () => {
    for (const source of ["myjcb", "moneyforward", "vpass"]) {
      expect(Object.keys(IMPORT_ADAPTERS)).toContain(source);
    }
  });
});

interface ValidationCase {
  body: string | JsonObject;
  headers?: Record<string, string>;
  code: string;
  status: number;
}

// ---------------------------------------------------------------------------
// Legacy branches, copied from worker.ts before the adapter registry.
// ---------------------------------------------------------------------------

async function legacyMyJcbImportRun(env: Env, request: Request): Promise<Response> {
  try {
    const input = await readJson(request);
    exactKeys(input, ["manifestKey", "continuation"]);
    const manifestKey = requiredString(input.manifestKey, "manifest_key_invalid", 500);
    const continuation =
      input.continuation === undefined
        ? undefined
        : requiredString(input.continuation, "continuation_invalid", 8_000);
    const result = await importMyJcbRun({
      bucket: env.MYJCB_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_MYJCB,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey,
      ...(continuation ? { continuation } : {}),
    });
    return json(result, result.status === "deferred" ? 202 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

async function legacyMoneyForwardImportRun(env: Env, request: Request): Promise<Response> {
  try {
    const input = await readJson(request);
    exactKeys(input, ["manifestKey", "continuation"]);
    const manifestKey = requiredString(input.manifestKey, "manifest_key_invalid", 500);
    const continuation =
      input.continuation === undefined
        ? undefined
        : requiredString(input.continuation, "continuation_invalid", 8_000);
    const result = await importMoneyForwardRun({
      bucket: env.MONEYFORWARD_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_MONEYFORWARD,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey,
      ...(continuation ? { continuation } : {}),
    });
    return json(result, result.status === "deferred" ? 202 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

async function legacyVpassImportRun(env: Env, request: Request): Promise<Response> {
  try {
    const input = await readJson(request);
    exactKeys(input, ["recordKey", "continuation"]);
    const recordKey = requiredString(input.recordKey, "record_key_invalid", 500);
    const continuation =
      input.continuation === undefined
        ? undefined
        : requiredString(input.continuation, "continuation_invalid", 16_000);
    const result = await importVpassRun({
      bucket: env.VPASS_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_VPASS,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      recordKey,
      ...(continuation ? { continuation } : {}),
    });
    if (result.status === "sealed") {
      await importVpassCardBinding({
        bucket: env.VPASS_SNAPSHOTS,
        centralService: env.RAW_EVIDENCE,
        centralToken: env.RAW_EVIDENCE_TOKEN_VPASS,
        fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
        recordKey,
      });
    }
    return json(result, result.status === "deferred" ? 202 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}

interface LegacyImportRoute {
  path: string;
  key: "manifestKey" | "recordKey" | "normalizedKey";
  keyCode: string;
  continuationBudget?: number;
}

/** The per-source parameters of the previous import-run branches, transcribed verbatim. */
const LEGACY_IMPORT_RUN: Record<ImportSource, LegacyImportRoute> = {
  myjcb: {
    path: "/v1/myjcb/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
    continuationBudget: 8_000,
  },
  moneyforward: {
    path: "/v1/moneyforward/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
    continuationBudget: 8_000,
  },
  vpass: {
    path: "/v1/vpass/import-run",
    key: "recordKey",
    keyCode: "record_key_invalid",
    continuationBudget: 16_000,
  },
  "global-pass": {
    path: "/v1/prestia-globalpass/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
  "mobile-suica": {
    path: "/v1/mobile-suica/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
  "v-point": {
    path: "/v1/v-point/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
  "v-point-pay-email": {
    path: "/v1/v-point-pay-email/import-run",
    key: "normalizedKey",
    keyCode: "normalized_key_invalid",
  },
  "sbi-securities": {
    path: "/v1/sbi-securities/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
  "sbi-vc-trade": {
    path: "/v1/sbi-vc-trade/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
    continuationBudget: 8_000,
  },
  "sbi-shinsei": {
    path: "/v1/sbi-shinsei/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
  "sony-bank": {
    path: "/v1/sony-bank/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
  "smbc-direct": {
    path: "/v1/smbc-direct/import-run",
    key: "manifestKey",
    keyCode: "manifest_key_invalid",
  },
};

/** The validation prefix shared by every previous import-run branch, before the import call. */
async function legacyValidateImportRun(
  route: LegacyImportRoute,
  request: Request,
): Promise<Response> {
  try {
    const input = await readJson(request);
    exactKeys(input, [
      route.key,
      ...(route.continuationBudget === undefined ? [] : ["continuation"]),
    ]);
    requiredString(input[route.key], route.keyCode, 500);
    if (route.continuationBudget !== undefined && input.continuation !== undefined) {
      requiredString(input.continuation, "continuation_invalid", route.continuationBudget);
    }
    throw new Error("validation_passed_unexpectedly");
  } catch (error) {
    return errorResponse(error);
  }
}

interface LegacyBackfillRoute {
  path: string;
  cursorBudget: number;
}

/** The per-source cursor budgets of the previous backfill-page branches, transcribed verbatim. */
const LEGACY_BACKFILL: Record<ImportSource, LegacyBackfillRoute> = {
  moneyforward: { path: "/v1/moneyforward/backfill-page", cursorBudget: 12_000 },
  vpass: { path: "/v1/vpass/backfill-page", cursorBudget: 24_000 },
  myjcb: { path: "/v1/myjcb/backfill-page", cursorBudget: 16_000 },
  "global-pass": { path: "/v1/prestia-globalpass/backfill-page", cursorBudget: 12_000 },
  "v-point": { path: "/v1/v-point/backfill-page", cursorBudget: 12_000 },
  "v-point-pay-email": { path: "/v1/v-point-pay-email/backfill-page", cursorBudget: 4_096 },
  "mobile-suica": { path: "/v1/mobile-suica/backfill-page", cursorBudget: 4_096 },
  "sbi-securities": { path: "/v1/sbi-securities/backfill-page", cursorBudget: 4_096 },
  "sbi-shinsei": { path: "/v1/sbi-shinsei/backfill-page", cursorBudget: 4_096 },
  "sbi-vc-trade": { path: "/v1/sbi-vc-trade/backfill-page", cursorBudget: 4_096 },
  "sony-bank": { path: "/v1/sony-bank/backfill-page", cursorBudget: 12_000 },
  "smbc-direct": { path: "/v1/smbc-direct/backfill-page", cursorBudget: 12_000 },
};

async function legacyValidateBackfill(
  route: LegacyBackfillRoute,
  request: Request,
): Promise<Response> {
  try {
    const input = await readJson(request);
    exactKeys(input, ["cursor", "limit"]);
    if (input.cursor !== undefined) {
      requiredString(input.cursor, "cursor_invalid", route.cursorBudget);
    }
    if (input.limit !== undefined && input.limit !== 1) {
      throw new ImportError(400, "backfill_limit_must_be_one");
    }
    throw new Error("validation_passed_unexpectedly");
  } catch (error) {
    return errorResponse(error);
  }
}

async function readJson(request: Request): Promise<JsonObject> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 64 * 1024)) {
    throw new ImportError(413, "json_too_large");
  }
  if (!request.body) throw new ImportError(400, "json_invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 64 * 1024) {
      await reader.cancel("json_too_large");
      throw new ImportError(413, "json_too_large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new ImportError(400, "json_invalid");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new ImportError(400, "json_shape_invalid");
    }
    return value as JsonObject;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(400, "json_invalid");
  }
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new ImportError(400, "unknown_field");
  }
}

function requiredString(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ImportError(400, code);
  }
  return value;
}

function errorResponse(error: unknown): Response {
  return json({ error: safeCode(error) }, error instanceof ImportError ? error.status : 502);
}

function safeCode(error: unknown): string {
  const candidate =
    error instanceof ImportError
      ? error.code
      : error instanceof Error
        ? error.message
        : "request_failed";
  return /^[a-z0-9_-]{1,100}$/u.test(candidate) ? candidate : "request_failed";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Drivers and fixtures.
// ---------------------------------------------------------------------------

async function driveHttp(
  handler: Handler,
  path: string,
  keyField: string,
  key: string,
): Promise<HttpStep[]> {
  const steps: HttpStep[] = [];
  let continuation: string | undefined;
  for (let step = 0; step < 20; step += 1) {
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [keyField]: key, ...(continuation ? { continuation } : {}) }),
      }),
    );
    const body = (await response.json()) as JsonObject;
    steps.push({ status: response.status, body });
    if (response.status !== 202) return steps;
    if (typeof body.continuation !== "string") throw new Error("deferred without continuation");
    continuation = body.continuation;
  }
  throw new Error("import did not seal within the step bound");
}

/** Feeds an R2 create notification through the real reconciler until it terminates. */
async function driveQueue(
  env: Env,
  bucket: string,
  terminalKey: string,
): Promise<{ outcomes: string[]; messages: ImportMessage[] }> {
  const pending: unknown[] = [
    {
      account: ACCOUNT,
      action: "PutObject",
      bucket,
      object: { key: terminalKey, size: 1, eTag: "synthetic" },
      eventTime: "2026-09-07T12:34:56.789Z",
    },
  ];
  const messages: ImportMessage[] = [];
  const outcomes: string[] = [];
  env.OUTBOX_RECONCILER_QUEUE = {
    sendBatch: async (batch: Array<{ body: ImportMessage }>) => {
      for (const entry of batch) {
        expect(entry.body.kind).toBe("import");
        messages.push(entry.body);
        pending.push(entry.body);
      }
    },
  } as unknown as Queue;
  const dependencies = reconcilerDependencies(env);
  for (let step = 0; step < 20 && pending.length > 0; step += 1) {
    const result = await processReconcilerMessage(pending.shift(), dependencies);
    outcomes.push(result.outcome);
  }
  expect(pending).toEqual([]);
  return { outcomes, messages };
}

function baseEnv(overrides: Partial<Env>): Env {
  return {
    SBI_SNAPSHOTS: {} as R2Bucket,
    SBI_VC_SNAPSHOTS: {} as R2Bucket,
    SONY_SNAPSHOTS: {} as R2Bucket,
    SBI_SHINSEI_SNAPSHOTS: {} as R2Bucket,
    MOBILE_SUICA_SNAPSHOTS: {} as R2Bucket,
    GLOBAL_PASS_SNAPSHOTS: {} as R2Bucket,
    MYJCB_SNAPSHOTS: {} as R2Bucket,
    MONEYFORWARD_SNAPSHOTS: {} as R2Bucket,
    VPOINT_SNAPSHOTS: {} as R2Bucket,
    VPOINT_PAY_SNAPSHOTS: {} as R2Bucket,
    VPASS_SNAPSHOTS: {} as R2Bucket,
    SMBC_DIRECT_SNAPSHOTS: {} as R2Bucket,
    RAW_EVIDENCE: {} as Fetcher,
    OUTBOX_RECONCILER_QUEUE: {} as Queue,
    IMPORTER_VERSION: "collector-r2-importer-v20",
    RECONCILER_ACCOUNT_ID: ACCOUNT,
    RAW_EVIDENCE_TOKEN: `collector-r2-sbi.${"s".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SBI_VC: `collector-r2-sbi-vc.${"v".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SONY: `collector-r2-sony-bank.${"o".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SBI_SHINSEI: `collector-r2-sbi-shinsei.${"n".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_MOBILE_SUICA: `collector-r2-mobile-suica.${"m".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_GLOBAL_PASS: `collector-r2-global-pass.${"g".repeat(32)}`,
    GLOBAL_PASS_LEGACY_EMPTY_SHA256_ALLOWLIST: "a".repeat(64),
    RAW_EVIDENCE_TOKEN_MYJCB: myjcb.TOKEN,
    RAW_EVIDENCE_TOKEN_MONEYFORWARD: moneyforward.TOKEN,
    RAW_EVIDENCE_TOKEN_VPOINT: `collector-r2-v-point.${"p".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_VPASS: vpass.TOKEN,
    RAW_EVIDENCE_TOKEN_VPOINT_PAY_EMAIL: `collector-r2-v-point-pay-email.${"e".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SMBC_DIRECT: `collector-r2-smbc-direct.${"d".repeat(32)}`,
    ORIGIN_FINGERPRINT_KEY: myjcb.FINGERPRINT_KEY,
    ...overrides,
  };
}

async function myJcbFixture(): Promise<Fixture> {
  const bucket = new myjcb.FakeBucket();
  await myjcb.storeSuccessRun(bucket);
  const central = new myjcb.FakeCentral();
  return {
    env: baseEnv({
      MYJCB_SNAPSHOTS: bucket as unknown as R2Bucket,
      RAW_EVIDENCE: central as unknown as Fetcher,
    }),
    central,
    reads: [],
  };
}

async function moneyForwardFixture(): Promise<Fixture> {
  const bucket = new moneyforward.FakeBucket();
  await moneyforward.storeSuccessRun(bucket);
  const central = new moneyforward.FakeCentral();
  return {
    env: baseEnv({
      MONEYFORWARD_SNAPSHOTS: bucket as unknown as R2Bucket,
      RAW_EVIDENCE: central as unknown as Fetcher,
    }),
    central,
    reads: [],
  };
}

/** A synthetic card selection descriptor so the identity sidecar derives a binding. */
const VPASS_SELECTION = {
  externalId: "a".repeat(32),
  globalid: "b".repeat(32),
  cardCode: "1234567890123",
  cardName: "Card ending 1234",
};

function vpassFixture(): Fixture {
  const bucket = vpass.largeCardSnapshotBucket();
  const snapshotKey = `${vpass.CARD_PREFIX}snapshot.json`;
  const snapshot = JSON.parse(
    new TextDecoder().decode(bucket.values.get(snapshotKey)!.bytes),
  ) as JsonObject;
  const withSession = (raw: unknown, session: JsonObject) => {
    const parsed = JSON.parse(raw as string) as { header: JsonObject; body: unknown };
    return JSON.stringify({ ...parsed, header: { ...parsed.header, vpSessionBean: session } });
  };
  bucket.putJson(snapshotKey, {
    ...snapshot,
    selectCardRawJson: withSession(snapshot.selectCardRawJson, VPASS_SELECTION),
    webMeisaiTopRawJson: withSession(snapshot.webMeisaiTopRawJson, {
      cardCode: VPASS_SELECTION.cardCode,
      cardName: VPASS_SELECTION.cardName,
    }),
  });
  const reads: string[] = [];
  const get = bucket.get;
  bucket.get = async (key: string) => {
    reads.push(key);
    return get(key);
  };
  // The shared fake answers every unit create with the same id; the sidecar
  // needs its own unit so its terminal report cannot collide with the run's.
  const central = new vpass.FakeCentral();
  const inner = central.fetch;
  let nextUnitId = 10;
  central.fetch = async (request: Request): Promise<Response> => {
    const response = await inner(request);
    if (!/\/units$/u.test(new URL(request.url).pathname)) return response;
    nextUnitId += 1;
    return Response.json({ unitId: nextUnitId }, { status: 201 });
  };
  return {
    env: baseEnv({
      VPASS_SNAPSHOTS: bucket as unknown as R2Bucket,
      RAW_EVIDENCE: central as unknown as Fetcher,
    }),
    central,
    reads,
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu;

/** Strips per-attempt identifiers and wall-clock stamps; everything else must match exactly. */
function normalizeCalls(
  calls: CentralCall[],
): Array<{ path: string; method: string; body: unknown }> {
  return calls.map((call) => ({
    path: call.path,
    method: call.method,
    body: normalize(parseIfJson(call.body)),
  }));
}

function parseIfJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(UUID, "<uuid>");
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= TEST_STARTED_AT ? "<now>" : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}
