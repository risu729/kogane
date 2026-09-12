// U09 for MyJCB: the shared DATA target. Synthetic fixtures only — no
// provider is contacted and no value here is real.
//
// Acceptance rows: G1-01 (a failed put writes no terminal), G1-02 (the
// terminal follows every put and its references match what is stored), G1-08
// (a partial run states its coverage gap), G1-09 (a failed run persists no
// artifact), G1-15 (shared mode never calls the legacy importer or bucket),
// G1-16 (one connection stays one unit), G3-08 (codes only, never upstream
// text), G3-10/G3-11 (a connection that needs a human is a reported state).
import { describe, expect, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import { redactedStatementHtml } from "../src/parsers";
import { assertRedactedHtml } from "../src/redaction";
import {
  artifactRole,
  myJcbRunPlan,
  persistSharedRun,
  sharedRunDiagnostic,
  type SharedRunInput,
} from "../src/shared-collection";
import worker from "../src/worker";

const runId = "7d8f4b16-6d5c-4f0f-9a3e-0a1b2c3d4e5f";
const schemaVersion = "myjcb-worker-poc-v1";
const statementHtml = redactedStatementHtml(
  '<html><body><h1>MyJCB synthetic</h1><input name="token" value="secret"><script>alert(1)</script>' +
    "<p>1234 5678 9012 3456</p></body></html>",
);

function connection(connectionId: string, status: "success" | "human-required" = "success") {
  return {
    summary: {
      connectionId,
      bootstrapMode: "password" as const,
      status,
      cardCount: status === "success" ? 1 : 0,
      periodCount: status === "success" ? 2 : 0,
      artifactCount: status === "success" ? 3 : 0,
      ...(status === "success" ? {} : { blocker: "human-required:synthetic-reason" }),
    },
    artifacts:
      status === "success"
        ? [
            {
              dataset: "credit-menu",
              filename: "credit-menu.html",
              body: statementHtml,
              mediaType: "text/html; charset=utf-8",
            },
            {
              dataset: "credit-past-months",
              filename: "credit-past-months.json",
              body: '{"jsonrpc":"2.0"}',
              mediaType: "application/json",
              period: "detailMonth-1",
            },
            {
              dataset: "discovery",
              filename: "discovery.json",
              body: '{"schemaVersion":1}',
              mediaType: "application/json",
            },
          ]
        : [],
  };
}

function input(overrides: Partial<SharedRunInput> = {}): SharedRunInput {
  return {
    schemaVersion,
    runId,
    startedAt: "2026-09-11T21:00:00.000Z",
    completedAt: "2026-09-11T21:06:00.000Z",
    status: "success",
    trigger: "scheduled",
    connections: [connection("account-one")],
    failures: [],
    ...overrides,
  };
}

describe("G1-02/G1-16 shared mode persists each connection's pages and then the terminal", () => {
  test("objects, units and the terminal describe what is stored", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistSharedRun(
      bucket,
      input({ connections: [connection("account-one"), connection("account-two")] }),
    );
    expect(outcome.result.outcome).toBe("persisted");
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("myjcb", runId));

    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const manifest = read.manifest;
    expect(manifest.producer).toBe("myjcb-worker");
    expect(manifest.providerOutcome).toBe("success");
    // A card exposes a rolling set of statement periods, so a finished run is
    // not a claim about the card's whole history.
    expect(manifest.coverageStatus).toBe("partial");
    expect(manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "partial",
      },
      {
        unitKey: "account-two",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "partial",
      },
    ]);
    // G1-16: the connections stay separate units of one run, never merged.
    expect(
      manifest.artifacts.map(
        (artifact) => [artifact.artifactKey, artifact.role, artifact.unitKey] as const,
      ),
    ).toEqual([
      ["account-one/credit-menu.html", "sanitized_provider_capture", "account-one"],
      ["account-one/credit-past-months.json", "provider_response", "account-one"],
      ["account-one/discovery.json", "collector_derived", "account-one"],
      ["account-two/credit-menu.html", "sanitized_provider_capture", "account-two"],
      ["account-two/credit-past-months.json", "provider_response", "account-two"],
      ["account-two/discovery.json", "collector_derived", "account-two"],
      ["manifest.json", "collector_manifest", undefined],
    ]);
    expect(manifest.transformations.map((entry) => entry.transformationId)).toEqual([
      "redacted:account-one:credit-menu.html",
      "redacted:account-two:credit-menu.html",
    ]);
    expect(manifest.transformations[0]).toMatchObject({
      stepKind: "redacted",
      transformerId: "myjcb-sanitizer",
      transformerVersion: "v1",
      inputArtifactKeys: [],
    });
    // Statement period labels are provider text; they stay in the manifest
    // artifact instead of becoming terminal ranges.
    expect(manifest.ranges).toEqual([]);
    expect(await verifyReferencedObjects(bucket, manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    // The two connections share identical synthetic bytes, so the
    // content-addressed store keeps one object per distinct body.
    const objects = new Set(manifest.artifacts.map((artifact) => artifact.storageRef.key));
    expect(objects.size).toBe(4);
  });

  test("the role of each dataset matches the central contract's vocabulary", () => {
    const base = { filename: "x", body: "{}", dataset: "credit-ledger" };
    expect(artifactRole({ ...base, mediaType: "text/html; charset=utf-8" })).toBe(
      "sanitized_provider_capture",
    );
    expect(
      artifactRole({ ...base, dataset: "credit-past-months", mediaType: "application/json" }),
    ).toBe("provider_response");
    expect(artifactRole({ ...base, dataset: "credit-csv", mediaType: "text/csv" })).toBe(
      "provider_export",
    );
    expect(artifactRole({ ...base, mediaType: "application/json" })).toBe("collector_derived");
  });
});

describe("G3-08 nothing unredacted or free-text reaches the shared bucket", () => {
  test("the collector's redaction is re-checked before a page is stored", async () => {
    expect(() => assertRedactedHtml(statementHtml)).not.toThrow();
    expect(statementHtml).not.toContain("1234 5678 9012 3456");
    expect(statementHtml).not.toContain("<script");
    // A page that lost its redaction fails the run instead of being stored.
    const leaked = connection("account-one");
    const broken = {
      ...leaked,
      artifacts: [
        { ...leaked.artifacts[0]!, body: '<html><body><input value="secret"></body></html>' },
      ],
    };
    await expect(myJcbRunPlan(input({ connections: [broken] }))).rejects.toThrow(
      "artifact_html_redaction_invalid",
    );
  });

  test("a dataset the central path has never accepted is refused, not stored", async () => {
    const base = connection("account-one");
    const debit = {
      ...base,
      artifacts: [
        ...base.artifacts,
        {
          dataset: "debit-menu",
          filename: "debit-menu.html",
          body: statementHtml,
          mediaType: "text/html; charset=utf-8",
          statementState: "debit" as const,
        },
      ],
    };
    await expect(myJcbRunPlan(input({ connections: [debit] }))).rejects.toThrow(
      "artifact_dataset_unobserved",
    );
  });

  test("a connection blocker is stored as a code, not as upstream text", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(
      bucket,
      input({
        status: "partial",
        connections: [connection("account-one"), connection("account-two", "human-required")],
        failures: [
          {
            connectionId: "account-two",
            operation: "collect",
            errorType: "HumanRequiredError",
            message: "human-required:synthetic-reason",
          },
        ],
      }),
    );
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const stored = read.manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await bucket.get(stored.storageRef.key);
    const text = new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer()));
    expect(text).not.toContain("synthetic-reason");
    expect(JSON.parse(text).connections[1].blocker).toBe("human-required");
    expect(JSON.parse(text).failures[0].message).toBe("human-required");
  });
});

describe("G1-08/G1-09/G3-11 the outcome of the run survives persistence", () => {
  test("a connection that needs a human is a reported state on its own unit", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(
      bucket,
      input({
        status: "partial",
        connections: [connection("account-one"), connection("account-two", "human-required")],
        failures: [
          {
            connectionId: "account-two",
            operation: "collect",
            errorType: "HumanRequiredError",
            message: "human-required:synthetic-reason",
          },
        ],
      }),
    );
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("human_required");
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "partial",
      },
      {
        unitKey: "account-two",
        unitKind: "connection",
        artifactCount: 0,
        coverageStatus: "unknown",
        safeErrorCode: "human_required",
      },
    ]);
  });

  test("a failed run persists no artifact and stays a failure", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistSharedRun(
      bucket,
      input({
        status: "failed",
        connections: [connection("account-one", "human-required")],
        failures: [
          {
            connectionId: "account-one",
            operation: "collect",
            errorType: "HumanRequiredError",
            message: "human-required:synthetic-reason",
          },
        ],
      }),
    );
    expect(outcome.artifactCount).toBe(0);
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("human_required");
    expect(read.manifest.artifacts).toEqual([]);
    expect([...bucket.entries.keys()]).toEqual([terminalKey("myjcb", runId)]);
  });
});

describe("G1-01 a failed put leaves no terminal", () => {
  test("the run reports incomplete and logs codes and counts only", async () => {
    const run = input();
    const plan = await myJcbRunPlan(run);
    const failing = plan.artifacts[1]!;
    const bucket = new FakeR2Bucket({ failPut: new Set([objectKey(failing.sha256)]) });
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("incomplete");
    if (outcome.result.outcome !== "incomplete") throw new Error("unreachable");
    expect((await readTerminal(bucket, "myjcb", runId)).outcome).toBe("missing");

    const diagnostic = sharedRunDiagnostic(run, outcome);
    expect(diagnostic).toEqual({
      event: "myjcb-shared-collection",
      runId,
      status: "success",
      persistence: "incomplete",
      connectionCount: 1,
      artifactCount: plan.artifacts.length,
      reasonCode: "object_put_failed",
      persistedCount: outcome.result.checkpoint.persistedArtifactKeys.length,
      pendingCount: outcome.result.checkpoint.pendingArtifactKeys.length,
    });
  });
});

describe("G1-15 shared mode writes once", () => {
  test("a shared-target run touches neither the legacy bucket nor the importer", async () => {
    const data = new FakeR2Bucket();
    let legacyWrites = 0;
    let imports = 0;
    const records: Record<string, unknown>[] = [];
    const spies = [
      spyOn(console, "log").mockImplementation((value) => {
        try {
          records.push(JSON.parse(String(value)) as Record<string, unknown>);
        } catch {
          records.push({ raw: String(value) });
        }
      }),
      spyOn(console, "error").mockImplementation(() => {}),
    ];
    const env = {
      COLLECTOR_SCHEMA_VERSION: schemaVersion,
      COLLECTION_TARGET: "shared",
      MYJCB_CONNECTIONS_JSON: JSON.stringify([
        {
          connectionId: "account-one",
          bootstrapMode: "password",
          userId: "synthetic-user",
          password: "synthetic-password",
        },
      ]),
      DATA: data,
      // No browser binding: the connection fails before any provider request,
      // which is the failed-run path.
      BROWSER: undefined,
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
    } as unknown as Env;
    try {
      // A failed run is not a completed run, so the cron invocation throws
      // (G1-01) — after the terminal that records the failure was written.
      await expect(
        worker.scheduled?.(
          { scheduledTime: Date.now(), cron: "0 21 * * *", noRetry: () => {} },
          env,
          { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
        ),
      ).rejects.toThrow("MyJCB shared collection did not complete");
      expect(legacyWrites).toBe(0);
      expect(imports).toBe(0);
      const terminals = [...data.entries.keys()].filter((key) => key.startsWith("runs/myjcb/"));
      expect(terminals).toHaveLength(1);
      // The failure is recorded, and nothing else is stored (G1-09).
      expect([...data.entries.keys()]).toEqual(terminals);
      const persisted = records.find((record) => record.event === "myjcb-shared-collection");
      expect(persisted).toMatchObject({ status: "failed", persistence: "persisted" });
      expect(JSON.stringify(records)).not.toContain("synthetic-password");
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
