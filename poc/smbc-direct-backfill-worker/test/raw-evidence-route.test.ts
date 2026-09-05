import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: DurableObjectState, readonly env: Env) {}
  },
}));

const { default: worker } = await import("../src/worker");

describe("SMBC Direct raw evidence backfill route", () => {
  test("requires the dedicated bearer before calling the service binding", async () => {
    let calls = 0;
    const env = environment(async () => {
      calls += 1;
      return Response.json({});
    });
    const response = await fetchRoute(env);
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("forwards exactly one page and preserves the opaque cursor", async () => {
    let captured: Request | undefined;
    const env = environment(async (request) => {
      captured = request;
      return Response.json({
        source: "smbc-direct",
        scannedObjectCount: 1,
        importedManifestCount: 0,
        skippedManifestCount: 1,
        deferredManifestCount: 0,
        failedManifestCount: 0,
        nextCursor: null,
        truncated: false,
      });
    });
    const response = await fetchRoute(env, {
      authorization: "Bearer " + env.ADMIN_TRIGGER_TOKEN,
    }, "?limit=1&cursor=opaque-cursor");
    expect(response.status).toBe(200);
    expect(captured).toBeDefined();
    expect(new URL(captured!.url).pathname).toBe("/v1/smbc-direct/backfill-page");
    expect(await captured!.json() as unknown).toEqual({
      cursor: "opaque-cursor",
      limit: 1,
    });
  });

  test("rejects duplicate, oversized, and control-character cursor inputs", async () => {
    const env = environment(async () => {
      throw new Error("must_not_call");
    });
    for (const suffix of [
      "?limit=1&limit=1",
      "?limit=2",
      "?limit=1&cursor=" + "a".repeat(12_001),
      "?limit=1&cursor=has%20space",
    ]) {
      const response = await fetchRoute(env, {
        authorization: "Bearer " + env.ADMIN_TRIGGER_TOKEN,
      }, suffix);
      expect(response.status).toBe(400);
    }
  });
});

function fetchRoute(
  env: Env,
  headers: Record<string, string> = {},
  suffix = "?limit=1",
): Promise<Response> {
  return worker.fetch(
    new Request("https://collector.example/backfill-raw-evidence" + suffix, {
      method: "POST",
      headers,
    }) as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext<unknown>,
  );
}

function environment(fetcher: (request: Request) => Promise<Response>): Env {
  return {
    ADMIN_TRIGGER_TOKEN: "a".repeat(48),
    RAW_EVIDENCE_IMPORTER: { fetch: fetcher } as Fetcher,
    BACKFILL_SESSION: {} as unknown as Env["BACKFILL_SESSION"],
    SNAPSHOTS: {} as R2Bucket,
    TAMIA: {} as Fetcher,
    COLLECTOR_SCHEMA_VERSION: "smbc-direct-backfill-worker-poc-v1",
    SMBC_DIRECT_BASE_URL: "https://direct3.smbc.co.jp",
    SMBC_DIRECT_LOGIN_BASE_URL: "https://direct.smbc.co.jp",
    DEFAULT_BACKFILL_FROM: "2019-01-01",
    SMBC_CREDENTIAL_JSON: "{}",
    SESSION_ENCRYPTION_KEY: "",
  };
}
