// U09 (G1-01, G1-02, G1-08, G1-09, G1-15, G3-07, G3-08, G3-11): the shared
// DATA-bucket write path of the SBI Shinsei collector.
//
// Synthetic data only: the fixtures are the same synthetic CORE responses the
// existing suites use, with a synthetic rotating CSRF token added so the test
// can prove the sanitizer removes it before anything reaches DATA.
import { describe, expect, mock, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  parseTerminalKey,
  readTerminal,
  terminalKey,
} from "../../../packages/collection/src/index";
import {
  buildSharedRunPlan,
  persistSharedRun,
  sanitizeProviderCapture,
  sharedManifestBytes,
  sharedOutcome,
  waitingForHuman,
} from "../src/shared-collection";
import type { CollectionFailure, CollectionManifest } from "../src/types";

const RUN_ID = "00000000-0000-4000-8000-000000000000";
const IDENTITY = { attemptId: "attempt-0000" };

function manifestOf(overrides: Partial<CollectionManifest> = {}): CollectionManifest {
  return {
    schemaVersion: "sbi-shinsei-worker-poc-v1",
    source: "sbi-shinsei",
    runId: RUN_ID,
    startedAt: "2026-08-31T21:00:00.000Z",
    completedAt: "2026-08-31T21:01:00.000Z",
    status: "success",
    liveReadsEnabled: true,
    artifacts: [],
    failures: [],
    ...overrides,
  };
}

const PROVIDER_BODY = JSON.stringify({
  header: { adapterResultCode: "0", newToken: "synthetic-next-csrf-token" },
  responseParam: { totalCreditBalance: "300000" },
});

describe("G3-07/G3-08 sanitization before DATA", () => {
  test("the rotating CSRF token never reaches a stored artifact", () => {
    const bytes = sanitizeProviderCapture(PROVIDER_BODY);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("newToken");
    expect(text).not.toContain("synthetic-next-csrf-token");
    expect(JSON.parse(text)).toEqual({
      header: { adapterResultCode: "0" },
      responseParam: { totalCreditBalance: "300000" },
    });
  });

  test("the stored collector manifest keeps only allowlisted failure codes", () => {
    const failure: CollectionFailure = {
      operation: "collect",
      errorType: "BrowserCollectionError",
      message: "collector_request_failed",
      diagnostics: { stage: "login-rejected", authenticationAttempted: true },
    };
    const text = new TextDecoder().decode(sharedManifestBytes(manifestOf({ failures: [failure] })));
    expect(JSON.parse(text).failures).toEqual([
      {
        operation: "collect",
        errorType: "BrowserCollectionError",
        message: "collector_request_failed",
      },
    ]);
    expect(text).not.toContain("diagnostics");
    expect(text).not.toContain("login-rejected");
  });
});

describe("G1-08/G1-09/G3-11 run outcome", () => {
  test("a partial run stays partial and carries a safe code", () => {
    expect(
      sharedOutcome(
        manifestOf({
          status: "partial",
          failures: [
            { operation: "read:exchange-rate", errorType: "ResponseSchemaError", message: "x" },
          ],
        }),
      ),
    ).toEqual({
      providerOutcome: "partial",
      coverageStatus: "partial",
      safeErrorCode: "provider_response_invalid",
    });
  });

  test("a failed run never claims coverage", () => {
    expect(sharedOutcome(manifestOf({ status: "failed" }))).toEqual({
      providerOutcome: "failed",
      coverageStatus: "unknown",
      safeErrorCode: "collector_run_incomplete",
    });
  });

  test("a login the collector may not retry ends as failed and waiting for a human", () => {
    const failures: CollectionFailure[] = [
      {
        operation: "collect",
        errorType: "BrowserCollectionError",
        message: "collector_request_failed",
        diagnostics: { stage: "login-rejected", authenticationAttempted: true },
      },
    ];
    expect(waitingForHuman(failures)).toBe(true);
    expect(sharedOutcome(manifestOf({ status: "failed", failures }))).toEqual({
      providerOutcome: "failed",
      coverageStatus: "unknown",
      safeErrorCode: "human_required_credentials",
    });
  });
});

describe("G1-01/G1-02 persisting a run", () => {
  const input = {
    manifest: manifestOf({
      artifacts: [
        {
          dataset: "top-accounts-balance-and-activity",
          key: `raw/sbi-shinsei/2026/08/31/${RUN_ID}/raw-top-accounts-balance-and-activity.json`,
          mediaType: "application/json",
          sha256: "a".repeat(64),
          bytes: 10,
        },
      ],
    }),
    artifacts: [
      {
        dataset: "top-accounts-balance-and-activity",
        filename: "raw-top-accounts-balance-and-activity.json",
        mediaType: "application/json",
        body: PROVIDER_BODY,
      },
    ],
    identity: IDENTITY,
  };

  test("writes every object, then the terminal last, and states the same digests", async () => {
    const bucket = new FakeR2Bucket();
    const summary = await persistSharedRun(bucket, input);
    expect(summary.outcome).toBe("persisted");
    expect(summary.waitingForHuman).toBe(false);
    expect(bucket.putKeys.at(-1)).toBe(summary.terminalKey);
    expect(parseTerminalKey(summary.terminalKey)).toEqual({ source: "sbi-shinsei", runId: RUN_ID });

    const read = await readTerminal(bucket, "sbi-shinsei", RUN_ID);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("success");
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey).sort()).toEqual([
      "manifest.json",
      "raw-top-accounts-balance-and-activity.json",
    ]);
    for (const artifact of read.manifest.artifacts) {
      const stored = await bucket.get(artifact.storageRef.key);
      expect(stored?.size).toBe(artifact.byteSize);
    }
  });

  test("nothing stored in DATA carries session or credential material", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(bucket, input);
    const everything = [...bucket.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    for (const forbidden of [
      "newToken",
      "synthetic-next-csrf-token",
      "cookie",
      "Cookie",
      "sessionId",
      "authorization",
      "csrf",
      "password",
      "relayToken",
    ]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  test("a failed object put leaves no terminal", async () => {
    const plan = await buildSharedRunPlan(input);
    const objectKey = plan.artifacts[0]!.sha256;
    const bucket = new FakeR2Bucket({
      failPut: new Set([`objects/${objectKey.slice(0, 2)}/${objectKey}`]),
    });
    const summary = await persistSharedRun(bucket, input);
    expect(summary.outcome).toBe("incomplete");
    expect(await bucket.head(summary.terminalKey)).toBeNull();
  });

  test("a failed run with nothing collected still writes a failed terminal", async () => {
    const bucket = new FakeR2Bucket();
    const summary = await persistSharedRun(bucket, {
      manifest: manifestOf({
        status: "failed",
        failures: [
          {
            operation: "collect",
            errorType: "BrowserCollectionError",
            message: "collector_request_failed",
            diagnostics: { stage: "container-start" },
          },
        ],
      }),
      artifacts: [],
      identity: IDENTITY,
    });
    expect(summary.outcome).toBe("persisted");
    const read = await readTerminal(bucket, "sbi-shinsei", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    // Only the collector manifest: a failure is not an observation of zero.
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual(["manifest.json"]);
  });

  test("re-persisting the same run is a no-op, not a second run", async () => {
    const bucket = new FakeR2Bucket();
    const first = await persistSharedRun(bucket, input);
    const putCount = bucket.putKeys.length;
    const second = await persistSharedRun(bucket, input);
    expect(second.outcome).toBe("already_persisted");
    expect(second.terminalDigest).toBe(first.terminalDigest);
    expect(bucket.putKeys.length).toBe(putCount);
  });
});

// The end-to-end path: the Worker decides, the container is mocked away.
let handoff = "";
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => ({
    startAndWaitForPorts: async () => {},
    fetch: async () => new Response(handoff, { status: 200 }),
    destroy: async () => {},
  }),
}));
const { default: worker } = await import("../src/worker");

async function trigger(target: string | undefined) {
  const fixtures = (await Bun.file(`${import.meta.dir}/fixtures/core-responses.json`).json()) as {
    topBalances: { header: Record<string, unknown> };
    balanceSummary: unknown;
    exchangeRate: unknown;
    yenDeposit: unknown;
  };
  // A rotating CSRF token as the provider really returns it.
  fixtures.topBalances.header.newToken = "synthetic-next-csrf-token";
  handoff = JSON.stringify({
    ok: true,
    responses: {
      topBalances: JSON.stringify(fixtures.topBalances),
      balanceSummary: JSON.stringify(fixtures.balanceSummary),
      exchangeRate: JSON.stringify(fixtures.exchangeRate),
      yenDeposit: JSON.stringify(fixtures.yenDeposit),
    },
  });
  const data = new FakeR2Bucket();
  const importerCalls: string[] = [];
  const staged: string[] = [];
  const spies = [
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "log").mockImplementation(() => {}),
  ];
  try {
    const response = await worker.fetch(
      new Request("https://worker.invalid/trigger", {
        method: "POST",
        headers: { authorization: "Bearer synthetic-admin" },
      }) as Request<unknown, IncomingRequestCfProperties>,
      {
        ADMIN_TRIGGER_TOKEN: "synthetic-admin",
        SBI_SHINSEI_CREDENTIAL_JSON: JSON.stringify({
          branchNumber: "012",
          accountNumber: "0345678",
          powerDirectPassword: "synthetic-secret",
        }),
        RELAY_TOKEN: "synthetic-relay",
        RELAY_PUBLIC_URL: "wss://worker.invalid/tcp",
        COLLECTOR_SCHEMA_VERSION: "sbi-shinsei-worker-poc-v1",
        ...(target === undefined ? {} : { COLLECTION_TARGET: target }),
        COLLECTOR_CONTAINER: {},
        DATA: data,
        SNAPSHOTS: {
          put: async (key: string, value: string | Uint8Array, options: R2PutOptions) => {
            const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
            staged.push(key);
            return {
              key,
              size: body.byteLength,
              checksums: { sha256: (options.sha256 as Uint8Array).slice().buffer },
            };
          },
        },
        RAW_EVIDENCE_IMPORTER: {
          fetch: async (request: Request) => {
            const body = (await request.json()) as { manifestKey: string };
            importerCalls.push(body.manifestKey);
            return Response.json({
              source: "sbi-shinsei",
              manifestKey: body.manifestKey,
              sealed: true,
            });
          },
        },
      } as unknown as Env,
      {} as ExecutionContext,
    );
    return {
      response,
      result: (await response.json()) as { runId: string; status: string; manifestKey: string },
      data,
      importerCalls,
      staged,
    };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

describe("G1-15 the collector writes the run where COLLECTION_TARGET says", () => {
  test("an unset retired target variable still writes only to DATA", async () => {
    const { response, result, data, importerCalls, staged } = await trigger(undefined);
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(importerCalls).toEqual([]);
    expect(staged).toEqual([]);
    expect(data.putKeys.length).toBeGreaterThan(0);
  });

  test("shared mode writes one copy: DATA only, no staging, no central upload", async () => {
    const { response, result, data, importerCalls, staged } = await trigger("shared");
    expect(response.status).toBe(200);
    expect(result.status).toBe("success");
    expect(importerCalls).toEqual([]);
    // Plan 00: the original is stored once. Nothing structural depends on a
    // staging object for this source, so shared mode never writes one.
    expect(staged).toEqual([]);
    const read = await readTerminal(data, "sbi-shinsei", result.runId);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("success");
    expect(read.manifest.attemptId.startsWith("attempt-")).toBe(true);
    expect(data.putKeys.at(-1)).toBe(terminalKey("sbi-shinsei", result.runId));
    // The manifest key the caller sees is the collector manifest's own
    // content-addressed object in DATA.
    const manifestArtifact = read.manifest.artifacts.find(
      (entry) => entry.artifactKey === "manifest.json",
    );
    expect(manifestArtifact?.storageRef.key).toBe(result.manifestKey);
    expect(result.manifestKey.startsWith("objects/")).toBe(true);
    // Every dataset the container returned is in the terminal even though no
    // staging put happened for it.
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey).sort()).toEqual([
      "manifest.json",
      "normalized.json",
      "raw-balance-summary-and-stage.json",
      "raw-exchange-rate.json",
      "raw-top-accounts-balance-and-activity.json",
      "raw-yen-deposit-account.json",
    ]);
    const everything = [...data.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    expect(everything).not.toContain("synthetic-next-csrf-token");
    expect(everything).not.toContain("newToken");
    expect(everything).not.toContain("synthetic-secret");
  });
});
