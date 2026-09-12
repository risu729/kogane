// U09 for Sony Bank: the shared DATA target. Synthetic fixtures only — no
// provider is contacted and no value here is real.
//
// Acceptance rows: G1-01 (a failed put writes no terminal), G1-02 (the
// terminal follows every put and its references match what is stored), G1-08
// (a partial run states its coverage gap), G1-09 (a failed run persists no
// artifact), G1-15 (shared mode never calls the legacy importer or bucket),
// G3-07/G3-08 (no credential or provider text in what is written or logged,
// and the importer's central-safety invariants are re-checked before a byte
// is planned).
import { describe, expect, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import {
  artifactRole,
  assertCentralSafe,
  persistSharedRun,
  sharedRunDiagnostic,
  sonyBankRunPlan,
  type SharedRunInput,
} from "../src/shared-collection";
import worker from "../src/worker";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const schemaVersion = "sony-bank-worker-poc-v2";

function input(overrides: Partial<SharedRunInput> = {}): SharedRunInput {
  return {
    schemaVersion,
    runId,
    startedAt: "2026-09-11T21:00:00.000Z",
    completedAt: "2026-09-11T21:02:00.000Z",
    status: "success",
    window: { from: "2026-09-01", to: "2026-09-11" },
    transactionCount: 2,
    artifacts: [
      {
        dataset: "gross-balance",
        filename: "gross-balance.json",
        mediaType: "application/json",
        body: '{"synthetic":"balance"}',
      },
      {
        dataset: "yen-history-page-0001",
        filename: "yen-history-page-0001.json",
        mediaType: "application/json",
        body: '{"synthetic":"page"}',
      },
      {
        dataset: "yen-history-csv",
        filename: "yen-history.csv",
        mediaType: "text/csv; charset=Shift_JIS",
        body: "synthetic,csv\n",
      },
      {
        dataset: "wallet-history-202609",
        filename: "wallet-history-2026-09.html",
        mediaType: "text/html; charset=UTF-8",
        body: "<html><body>synthetic</body></html>",
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: '{"schemaVersion":"sony-bank-collection-summary-v2"}',
      },
    ],
    failures: [],
    ...overrides,
  };
}

describe("G1-02 shared mode persists every artifact and then the terminal", () => {
  test("objects, roles and the terminal describe what is stored", async () => {
    const bucket = new FakeR2Bucket();
    const run = input();
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("persisted");
    if (outcome.result.outcome !== "persisted") throw new Error("unreachable");

    // The terminal is the last object written.
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("sony-bank", runId));
    expect(bucket.putKeys.filter((key) => key.startsWith("runs/"))).toEqual([
      terminalKey("sony-bank", runId),
    ]);

    const read = await readTerminal(bucket, "sony-bank", runId);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    const manifest = read.manifest;
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("complete");
    expect(manifest.safeErrorCode).toBeUndefined();
    expect(manifest.producer).toBe("sony-bank-worker");
    expect(manifest.producerVersion).toBe(schemaVersion);
    expect(manifest.requestedScope).toEqual({
      scopeKind: "date_range",
      startValue: "2026-09-01",
      endValue: "2026-09-11",
      unitKeys: ["account"],
    });
    expect(manifest.units).toEqual([
      { unitKey: "account", unitKind: "account", artifactCount: 6, coverageStatus: "complete" },
    ]);
    expect(manifest.ranges.map((range) => range.rangeKey)).toEqual([
      "request-window",
      "wallet-months",
    ]);
    expect(manifest.reports).toEqual([
      { reportRef: "terminal", reportKind: "terminal", scope: "run", outcome: "success" },
    ]);
    expect(
      manifest.artifacts.map((artifact) => [artifact.artifactKey, artifact.role] as const),
    ).toEqual([
      ["collection-summary.json", "collector_summary"],
      ["gross-balance.json", "provider_response"],
      ["manifest.json", "collector_manifest"],
      ["wallet-history-2026-09.html", "sanitized_provider_capture"],
      ["yen-history-page-0001.json", "provider_response"],
      ["yen-history.csv", "provider_export"],
    ]);
    // The wallet statement was redacted by the collector and the provider
    // bytes were not retained, which the terminal records rather than implies.
    expect(manifest.transformations).toEqual([
      {
        transformationId: "redacted:wallet-history-2026-09.html",
        stepKind: "redacted",
        transformerId: "sony-bank-worker",
        transformerVersion: schemaVersion,
        inputArtifactKeys: [],
        outputArtifactKey: "wallet-history-2026-09.html",
      },
    ]);

    // Every reference resolves to bytes of the declared size and digest.
    expect(await verifyReferencedObjects(bucket, manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });
    for (const artifact of manifest.artifacts) {
      expect(artifact.storageRef).toEqual({ store: "DATA", key: objectKey(artifact.sha256) });
    }

    // The collector manifest names the content-addressed keys, not a bucket
    // path that was never written.
    const stored = manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await bucket.get(stored.storageRef.key);
    const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer())));
    expect(decoded.source).toBe("sony-bank");
    expect(decoded.artifacts.map((entry: { key: string }) => entry.key).sort()).toEqual(
      manifest.artifacts
        .filter((entry) => entry.artifactKey !== "manifest.json")
        .map((entry) => entry.storageRef.key)
        .sort(),
    );
  });

  test("the role of each dataset matches the central contract's vocabulary", () => {
    expect(artifactRole("collection-summary")).toBe("collector_summary");
    expect(artifactRole("wallet-history-202609")).toBe("sanitized_provider_capture");
    expect(artifactRole("foreign-history-usd-csv")).toBe("provider_export");
    expect(artifactRole("foreign-history-usd-page-0001")).toBe("provider_response");
  });

  test("the same run written twice is a resend, not a second run", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(bucket, input());
    const objects = bucket.entries.size;
    const again = await persistSharedRun(bucket, input());
    expect(again.result.outcome).toBe("already_persisted");
    expect(bucket.entries.size).toBe(objects);
  });
});

describe("G1-08/G1-09 the outcome of the run survives persistence", () => {
  test("a partial run states the coverage gap with a safe code", async () => {
    const bucket = new FakeR2Bucket();
    const run = input({
      status: "partial",
      failures: [
        { operation: "collect", errorType: "SonyBankError", message: "collector_request_failed" },
      ],
    });
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("persisted");
    const read = await readTerminal(bucket, "sony-bank", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("collector_partial");
    expect(read.manifest.units[0]?.safeErrorCode).toBe("collector_partial");
  });

  test("a failed run persists no artifact and stays a failure", async () => {
    const bucket = new FakeR2Bucket();
    const run = input({
      status: "failed",
      artifacts: [],
      transactionCount: 0,
      failures: [{ operation: "collect", errorType: "Error", message: "collector_request_failed" }],
    });
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("persisted");
    expect(outcome.artifactCount).toBe(0);
    const read = await readTerminal(bucket, "sony-bank", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("collector_failed");
    expect(read.manifest.artifacts).toEqual([]);
    expect([...bucket.entries.keys()]).toEqual([terminalKey("sony-bank", runId)]);
  });

  test("a run whose artifacts were collected never claims a failure", async () => {
    const plan = await sonyBankRunPlan(input({ status: "failed" }));
    // The failure mapping is what drops the artifacts; the manifest says so.
    expect(plan.artifacts).toEqual([]);
    expect(plan.run.providerOutcome).toBe("failed");
  });
});

describe("G3-08 the central-safety invariants are re-checked before a byte is planned", () => {
  const wallet = (body: string) => ({
    dataset: "wallet-history-202609",
    filename: "wallet-history-2026-09.html",
    mediaType: "text/html; charset=UTF-8",
    body,
  });

  test("the synthetic run passes the same checks the importer applies", () => {
    for (const artifact of input().artifacts) {
      expect(() =>
        assertCentralSafe(artifact, new TextEncoder().encode(artifact.body as string)),
      ).not.toThrow();
    }
  });

  test("a wallet page that kept a session id or a hidden value fails the run", async () => {
    await expect(
      sonyBankRunPlan(
        input({
          artifacts: [wallet('<html><a href="/wallet;jsessionid=synthetic-session">x</a></html>')],
        }),
      ),
    ).rejects.toThrow("artifact_html_redaction_invalid");
    await expect(
      sonyBankRunPlan(
        input({
          artifacts: [wallet('<html><input type="hidden" name="cc" value="synthetic"></html>')],
        }),
      ),
    ).rejects.toThrow("artifact_html_redaction_invalid");
    // The collector's own sanitizer output is what passes.
    expect(() =>
      assertCentralSafe(
        wallet('<html><input type="hidden" name="cc" value=""></html>'),
        new TextEncoder().encode('<html><input type="hidden" name="cc" value=""></html>'),
      ),
    ).not.toThrow();
  });

  test("a JSON payload with a credential field fails the run", async () => {
    await expect(
      sonyBankRunPlan(
        input({
          artifacts: [
            {
              dataset: "gross-balance",
              filename: "gross-balance.json",
              mediaType: "application/json",
              body: '{"balance":1,"nested":[{"loginPwd":"synthetic"}]}',
            },
          ],
        }),
      ),
    ).rejects.toThrow("artifact_secret_field_present");
  });
});

describe("G1-01 a failed put leaves no terminal", () => {
  test("the run reports incomplete with a resumable checkpoint", async () => {
    const run = input();
    const plan = await sonyBankRunPlan(run);
    const failing = plan.artifacts.at(-1)!;
    const bucket = new FakeR2Bucket({ failPut: new Set([objectKey(failing.sha256)]) });
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("incomplete");
    if (outcome.result.outcome !== "incomplete") throw new Error("unreachable");
    expect(outcome.result.reasonCode).toBe("object_put_failed");
    expect((await readTerminal(bucket, "sony-bank", runId)).outcome).toBe("missing");
    expect(outcome.result.checkpoint.pendingArtifactKeys).toContain(failing.artifactKey);

    // G3-08: the checkpoint that is logged carries codes and counts only.
    const diagnostic = sharedRunDiagnostic(run, outcome);
    expect(diagnostic).toEqual({
      event: "sony-bank-shared-collection",
      runId,
      status: "success",
      persistence: "incomplete",
      artifactCount: plan.artifacts.length,
      reasonCode: "object_put_failed",
      persistedCount: outcome.result.checkpoint.persistedArtifactKeys.length,
      pendingCount: outcome.result.checkpoint.pendingArtifactKeys.length,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic");
  });
});

describe("G1-15 shared mode writes once", () => {
  test("a shared-target run touches neither the legacy bucket nor the importer", async () => {
    const data = new FakeR2Bucket();
    let legacyWrites = 0;
    let imports = 0;
    const records: Record<string, unknown>[] = [];
    const spies = [
      spyOn(console, "log").mockImplementation((value) =>
        records.push(JSON.parse(String(value)) as Record<string, unknown>),
      ),
      spyOn(console, "error").mockImplementation((value) =>
        records.push(JSON.parse(String(value)) as Record<string, unknown>),
      ),
    ];
    try {
      const response = await worker.fetch(
        new Request("https://worker.invalid/trigger", {
          method: "POST",
          headers: { authorization: "Bearer synthetic-admin" },
        }) as Request<unknown, IncomingRequestCfProperties>,
        {
          ADMIN_TRIGGER_TOKEN: "synthetic-admin",
          COLLECTOR_SCHEMA_VERSION: schemaVersion,
          COLLECTION_TARGET: "shared",
          // Missing credential deliberately fails before any provider request.
          DATA: data,
          SNAPSHOTS: {
            put: async () => {
              legacyWrites += 1;
              throw new Error("the legacy bucket must not be written in shared mode");
            },
          },
          RAW_EVIDENCE_IMPORTER: {
            fetch: async () => {
              imports += 1;
              return Response.json({ status: "sealed" });
            },
          },
        } as unknown as Env,
      );
      const body = (await response.json()) as { status: string; persistence: string };
      expect(response.status).toBe(502);
      expect(body.status).toBe("failed");
      expect(body.persistence).toBe("persisted");
      expect(legacyWrites).toBe(0);
      expect(imports).toBe(0);
      expect([...data.entries.keys()].filter((key) => key.startsWith("runs/"))).toHaveLength(1);
      // G3-07/G3-08: nothing about the credential reaches the log.
      expect(JSON.stringify(records)).not.toContain("SONY_BANK_CREDENTIAL_JSON");
      expect(records.some((record) => record.event === "sony-bank-shared-collection")).toBe(true);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
