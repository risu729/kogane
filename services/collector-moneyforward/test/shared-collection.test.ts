// U09 for Money Forward ME: the shared DATA target. Synthetic fixtures only —
// no provider is contacted and no value here is real.
//
// Acceptance rows: G1-01 (a failed put writes no terminal), G1-02 (the
// terminal follows every put and its references match what is stored), G1-08
// (a partial run states its coverage gap), G1-09 (a failed run persists no
// artifact), G1-15 (shared mode never calls the legacy importer or bucket),
// G3-07/G3-08 (no credential or provider text in what is written or logged).
import { describe, expect, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import { collectionTarget } from "../src/collection-target";
import {
  artifactUnitKey,
  moneyForwardRunPlan,
  persistSharedRun,
  sharedRunDiagnostic,
  type SharedRunInput,
} from "../src/shared-collection";
import worker from "../src/worker";

const runId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const schemaVersion = "moneyforward-worker-poc-v1";

function page(dataset: string, filename: string, body: string) {
  return { dataset, filename, mediaType: "text/html; charset=utf-8", body };
}

function input(overrides: Partial<SharedRunInput> = {}): SharedRunInput {
  return {
    schemaVersion,
    runId,
    startedAt: "2026-09-11T21:15:00.000Z",
    completedAt: "2026-09-11T21:17:00.000Z",
    status: "success",
    accountDetailCount: 2,
    monthlyFragmentCount: 3,
    artifacts: [
      page("accounts-index", "accounts.html", "<html>synthetic index</html>"),
      page("account-detail", "account-detail-01.html", "<html>synthetic detail 1</html>"),
      page("account-detail", "account-detail-02.html", "<html>synthetic detail 2</html>"),
      page(
        "monthly-transactions",
        "account-01-month-2026-08.html",
        "<div>synthetic fragment a</div>",
      ),
      page(
        "monthly-transactions",
        "account-01-month-2026-09.html",
        "<div>synthetic fragment b</div>",
      ),
      page(
        "monthly-transactions",
        "account-02-month-2026-09.html",
        "<div>synthetic fragment c</div>",
      ),
    ],
    failures: [],
    ...overrides,
  };
}

describe("COLLECTION_TARGET selects the store", () => {
  test("only the exact string 'shared' leaves the legacy path", () => {
    expect(collectionTarget(undefined)).toBe("legacy");
    expect(collectionTarget("legacy")).toBe("legacy");
    expect(collectionTarget("SHARED")).toBe("legacy");
    expect(collectionTarget("shared")).toBe("shared");
  });
});

describe("G1-02 shared mode persists every page and then the terminal", () => {
  test("objects, units and the terminal describe what is stored", async () => {
    const bucket = new FakeR2Bucket();
    const run = input();
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("persisted");

    expect(bucket.putKeys.at(-1)).toBe(terminalKey("moneyforward-me", runId));
    const read = await readTerminal(bucket, "moneyforward-me", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const manifest = read.manifest;
    expect(manifest.source).toBe("moneyforward-me");
    expect(manifest.producer).toBe("moneyforward-worker");
    expect(manifest.producerVersion).toBe(schemaVersion);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("complete");
    expect(manifest.requestedScope).toEqual({
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: ["account-01", "account-02"],
    });
    // Every captured page is a provider response; the run-wide index belongs
    // to no single account.
    expect(
      manifest.artifacts.map(
        (artifact) => [artifact.artifactKey, artifact.role, artifact.unitKey] as const,
      ),
    ).toEqual([
      ["account-01-month-2026-08.html", "provider_response", "account-01"],
      ["account-01-month-2026-09.html", "provider_response", "account-01"],
      ["account-02-month-2026-09.html", "provider_response", "account-02"],
      ["account-detail-01.html", "provider_response", "account-01"],
      ["account-detail-02.html", "provider_response", "account-02"],
      ["accounts.html", "provider_response", undefined],
      ["manifest.json", "collector_manifest", undefined],
    ]);
    expect(manifest.units).toEqual([
      { unitKey: "account-01", unitKind: "account", artifactCount: 3, coverageStatus: "complete" },
      { unitKey: "account-02", unitKind: "account", artifactCount: 2, coverageStatus: "complete" },
    ]);
    // The months a unit actually returned, not a claim about the provider.
    expect(manifest.ranges).toEqual([
      {
        rangeKey: "months-account-01",
        rangeKind: "declared_coverage",
        precision: "month",
        basis: "manifest",
        startValue: "2026-08",
        endValue: "2026-09",
        unitKey: "account-01",
      },
      {
        rangeKey: "months-account-02",
        rangeKind: "declared_coverage",
        precision: "month",
        basis: "manifest",
        startValue: "2026-09",
        endValue: "2026-09",
        unitKey: "account-02",
      },
    ]);
    expect(manifest.transformations).toEqual([]);
    expect(await verifyReferencedObjects(bucket, manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    // The stored bytes are the collector's own, unchanged.
    const index = manifest.artifacts.find((entry) => entry.artifactKey === "accounts.html")!;
    const body = await bucket.get(index.storageRef.key);
    expect(new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer()))).toBe(
      "<html>synthetic index</html>",
    );
    expect(index.mediaType).toBe("text/html");
  });

  test("the unit of a page comes from the collector's own filename grammar", () => {
    expect(artifactUnitKey("accounts.html")).toBeNull();
    expect(artifactUnitKey("account-detail-07.html")).toBe("account-07");
    expect(artifactUnitKey("account-12-month-2026-01.html")).toBe("account-12");
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
    const outcome = await persistSharedRun(
      bucket,
      input({
        status: "partial",
        failures: [
          {
            operation: "collect",
            errorType: "Error",
            message: "account_detail_failed",
            failureCode: "account_detail_failed",
            stage: "account-detail",
          },
        ],
      }),
    );
    expect(outcome.result.outcome).toBe("persisted");
    const read = await readTerminal(bucket, "moneyforward-me", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("collector_partial");
    expect(read.manifest.units.every((unit) => unit.coverageStatus === "partial")).toBe(true);
  });

  test("a failed run persists no artifact and stays a failure", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistSharedRun(
      bucket,
      input({
        status: "failed",
        artifacts: [],
        accountDetailCount: 0,
        monthlyFragmentCount: 0,
        failures: [
          {
            operation: "collect",
            errorType: "Error",
            message: "credential_configuration_required",
            failureCode: "credential_configuration_required",
          },
        ],
      }),
    );
    expect(outcome.artifactCount).toBe(0);
    const read = await readTerminal(bucket, "moneyforward-me", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("collector_failed");
    expect(read.manifest.artifacts).toEqual([]);
    expect([...bucket.entries.keys()]).toEqual([terminalKey("moneyforward-me", runId)]);
  });
});

describe("G1-01 a failed put leaves no terminal", () => {
  test("the run reports incomplete and logs codes and counts only", async () => {
    const run = input();
    const plan = await moneyForwardRunPlan(run);
    const failing = plan.artifacts[2]!;
    const bucket = new FakeR2Bucket({ failPut: new Set([objectKey(failing.sha256)]) });
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("incomplete");
    if (outcome.result.outcome !== "incomplete") throw new Error("unreachable");
    expect((await readTerminal(bucket, "moneyforward-me", runId)).outcome).toBe("missing");
    expect(outcome.result.checkpoint.pendingArtifactKeys).toContain(failing.artifactKey);

    const diagnostic = sharedRunDiagnostic(run, outcome);
    expect(diagnostic).toEqual({
      event: "moneyforward-shared-collection",
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
      expect(JSON.stringify(records)).not.toContain("MONEYFORWARD_CREDENTIAL_JSON");
      expect(records.some((record) => record.event === "moneyforward-shared-collection")).toBe(
        true,
      );
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
