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
import type { CollectionFailure, ConnectionStopCode } from "../src/types";
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
      ...(status === "success"
        ? {}
        : { stopCode: "human_required" as const, capturedMonthCount: 0 }),
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
    expect(manifest.producer).toBe("collector-myjcb");
    expect(manifest.providerOutcome).toBe("success");
    // A card exposes a rolling set of statement periods, so a finished run is
    // not a claim about the card's whole history.
    expect(manifest.coverageStatus).toBe("partial");
    // ADR 0026: each connection that finished kept everything the run set out
    // to collect, so its unit is `complete` — the claim registration turns
    // into the unit outcome `success`.
    expect(manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "complete",
      },
      {
        unitKey: "account-two",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "complete",
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
      "extracted:account-one:discovery.json",
      "extracted:account-two:discovery.json",
      "redacted:account-one:credit-menu.html",
      "redacted:account-two:credit-menu.html",
    ]);
    // ADR 0021: a derived artifact states what it was derived from. Discovery
    // is extracted from login and mypage responses nobody keeps.
    expect(manifest.transformations[0]).toMatchObject({
      stepKind: "extracted",
      transformerId: "collector-myjcb",
      transformerVersion: schemaVersion,
      inputArtifactKeys: [],
      outputArtifactKey: "account-one/discovery.json",
    });
    expect(manifest.transformations[2]).toMatchObject({
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
    // A regression that let free text into a summary or a failure (the fields
    // the Worker used to fill with error text) is not carried into the
    // manifest: every entry is rebuilt from its closed fields.
    const blocked = connection("account-two", "human-required");
    const leaky = {
      ...blocked,
      summary: { ...blocked.summary, blocker: "synthetic-reason", message: "synthetic-reason" },
    };
    await persistSharedRun(
      bucket,
      input({
        status: "partial",
        connections: [connection("account-one"), leaky],
        failures: [
          {
            connectionId: "account-two",
            operation: "collect",
            code: "human_required" as const,
            errorType: "HumanRequiredError",
            message: "human-required:synthetic-reason",
          } as CollectionFailure,
        ],
      }),
    );
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const stored = read.manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await bucket.get(stored.storageRef.key);
    const text = new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer()));
    expect(text).not.toContain("synthetic-reason");
    expect(text).not.toContain("HumanRequiredError");
    expect(JSON.parse(text).connections[1]).toEqual({
      connectionId: "account-two",
      bootstrapMode: "password",
      status: "human-required",
      cardCount: 0,
      periodCount: 0,
      artifactCount: 0,
      stopCode: "human_required",
      capturedMonthCount: 0,
    });
    expect(JSON.parse(text).failures).toEqual([
      { connectionId: "account-two", operation: "collect", code: "human_required" },
    ]);
  });

  test("a stop code outside the closed list refuses the plan", async () => {
    const blocked = connection("account-two", "human-required");
    const invented = {
      ...blocked,
      summary: { ...blocked.summary, stopCode: "upstream said no" as ConnectionStopCode },
    };
    await expect(
      myJcbRunPlan(
        input({ status: "partial", connections: [connection("account-one"), invented] }),
      ),
    ).rejects.toThrow("manifest_stop_code_invalid");
    await expect(
      myJcbRunPlan(
        input({
          status: "partial",
          connections: [connection("account-one"), blocked],
          failures: [
            {
              connectionId: "account-two",
              operation: "collect",
              code: "month_fetch",
              position: 1.5,
            },
          ],
        }),
      ),
    ).rejects.toThrow("manifest_stop_position_invalid");
  });
});

/**
 * A connection that stopped at credit month `position` after keeping the
 * months before it, as `collectConnection` reports it (ADR 0005's
 * amendment): its menu, past-months response, the pages and ledgers of the
 * months it kept, and its discovery record.
 */
function stoppedConnection(
  connectionId: string,
  code: ConnectionStopCode,
  keptMonths: readonly number[],
  position: number,
) {
  const base = connection(connectionId);
  const months = keptMonths.flatMap((month) => {
    const nn = String(month).padStart(2, "0");
    return [
      {
        dataset: "credit-detail",
        filename: `credit-detail-${nn}.html`,
        body: statementHtml.replace("MyJCB synthetic", `MyJCB synthetic ${nn}`),
        mediaType: "text/html; charset=utf-8",
        statementState: "unconfirmed" as const,
        period: `detailMonth-${month}`,
      },
      {
        dataset: "credit-ledger",
        filename: `credit-ledger-${nn}.json`,
        body: `{"schemaVersion":1,"detailMonth":${month}}`,
        mediaType: "application/json",
        statementState: "unconfirmed" as const,
        period: `detailMonth-${month}`,
      },
    ];
  });
  const artifacts = [base.artifacts[0]!, base.artifacts[1]!, ...months, base.artifacts[2]!];
  return {
    summary: {
      ...base.summary,
      status: "partial" as const,
      periodCount: keptMonths.length + 2,
      artifactCount: artifacts.length,
      stopCode: code,
      stopPosition: position,
      capturedMonthCount: keptMonths.length,
    },
    artifacts,
  };
}

describe("ADR 0005 amendment: a stopped connection keeps the months it captured", () => {
  test("a connection stopped at month position k keeps positions < k as a partial unit", async () => {
    const bucket = new FakeR2Bucket();
    const stopped = stoppedConnection("account-one", "month_fetch", [0, 1], 2);
    const outcome = await persistSharedRun(
      bucket,
      input({
        status: "partial",
        connections: [stopped],
        failures: [
          { connectionId: "account-one", operation: "collect", code: "month_fetch", position: 2 },
        ],
      }),
    );
    expect(outcome.result.outcome).toBe("persisted");
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    // The run carries the one stage its only blocked connection stopped at.
    expect(read.manifest.safeErrorCode).toBe("month_fetch");
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 7,
        coverageStatus: "partial",
        safeErrorCode: "month_fetch",
      },
    ]);
    expect(
      read.manifest.artifacts
        .filter((entry) => entry.unitKey === "account-one")
        .map((entry) => entry.artifactKey),
    ).toEqual([
      "account-one/credit-detail-00.html",
      "account-one/credit-detail-01.html",
      "account-one/credit-ledger-00.json",
      "account-one/credit-ledger-01.json",
      "account-one/credit-menu.html",
      "account-one/credit-past-months.json",
      "account-one/discovery.json",
    ]);
    expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });
    const stored = read.manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await bucket.get(stored.storageRef.key);
    const manifest = JSON.parse(
      new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer())),
    );
    // The stage, the position and the count of months kept are the record.
    expect(manifest.connections[0]).toMatchObject({
      status: "partial",
      stopCode: "month_fetch",
      stopPosition: 2,
      capturedMonthCount: 2,
    });
    expect(manifest.failures).toEqual([
      { connectionId: "account-one", operation: "collect", code: "month_fetch", position: 2 },
    ]);
    expect(Object.keys(manifest.failures[0]).sort()).toEqual([
      "code",
      "connectionId",
      "operation",
      "position",
    ]);
  });

  test("each stage keeps its own code, and a withheld month stays collector_partial", async () => {
    const plan = await myJcbRunPlan(
      input({
        status: "partial",
        connections: [
          stoppedConnection("account-one", "credit_statement_state", [0], 1),
          stoppedConnection("account-two", "export_fetch", [0, 1], 3),
          {
            ...connection("account-three"),
            summary: { ...connection("account-three").summary, status: "partial" as const },
          },
        ],
        failures: [
          {
            connectionId: "account-one",
            operation: "collect",
            code: "credit_statement_state",
            position: 1,
          },
          { connectionId: "account-two", operation: "collect", code: "export_fetch", position: 3 },
        ],
      }),
    );
    expect(plan.run.safeErrorCode).toBe("collector_partial");
    expect(
      plan.run.units.map((unit) => [unit.unitKey, unit.coverageStatus, unit.safeErrorCode]),
    ).toEqual([
      ["account-one", "partial", "credit_statement_state"],
      ["account-two", "partial", "export_fetch"],
      ["account-three", "partial", "collector_partial"],
    ]);
  });

  test("a connection that stopped before its first month keeps nothing and is unknown", async () => {
    // The Worker's failed-connection summary: no artifact, the stage, no
    // position. The only connection of the run, so the run is failed.
    const bucket = new FakeR2Bucket();
    const outcome = await persistSharedRun(
      bucket,
      input({
        status: "failed",
        connections: [
          {
            summary: {
              connectionId: "account-one",
              bootstrapMode: "password",
              status: "failed",
              cardCount: 0,
              periodCount: 0,
              artifactCount: 0,
              stopCode: "credit_past_months",
              capturedMonthCount: 0,
            },
            artifacts: [],
          },
        ],
        failures: [
          { connectionId: "account-one", operation: "collect", code: "credit_past_months" },
        ],
      }),
    );
    expect(outcome.artifactCount).toBe(0);
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.artifacts).toEqual([]);
    // The terminal says where the connection stopped (G1-09 still holds:
    // nothing but the terminal is written).
    expect(read.manifest.safeErrorCode).toBe("credit_past_months");
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 0,
        coverageStatus: "unknown",
        safeErrorCode: "credit_past_months",
      },
    ]);
    expect([...bucket.entries.keys()]).toEqual([terminalKey("myjcb", runId)]);
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
            code: "human_required" as const,
          },
        ],
      }),
    );
    const read = await readTerminal(bucket, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("human_required");
    // The connection that finished is still whole: a sibling's failure makes
    // the run partial, not this unit (ADR 0026).
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "complete",
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

  test("ADR 0026: a connection that reports itself partial keeps a partial unit", async () => {
    // `collectConnection` reports `partial` when a month's page shows rows it
    // does not state the state of: the page is kept, its rows reach no
    // parser. There is no failure entry, and the Worker makes the run partial.
    const whole = connection("account-one");
    const partial = {
      ...connection("account-two"),
      summary: { ...connection("account-two").summary, status: "partial" as const },
    };
    const plan = await myJcbRunPlan(
      input({
        status: "partial",
        connections: [whole, partial],
        failures: [],
      }),
    );
    expect(plan.run.providerOutcome).toBe("partial");
    expect(plan.run.coverageStatus).toBe("partial");
    expect(
      plan.run.units.map((unit) => [unit.unitKey, unit.coverageStatus, unit.safeErrorCode]),
    ).toEqual([
      ["account-one", "complete", undefined],
      ["account-two", "partial", "collector_partial"],
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
            code: "human_required" as const,
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
      // The login never happened, so the connection stopped at `login`, kept
      // nothing, and the terminal says so (ADR 0005's amendment).
      const read = await readTerminal(data, "myjcb", String(persisted?.runId));
      if (read.outcome !== "found") throw new Error("unreachable");
      expect(read.manifest.safeErrorCode).toBe("login");
      expect(read.manifest.units).toEqual([
        {
          unitKey: "account-one",
          unitKind: "connection",
          artifactCount: 0,
          coverageStatus: "unknown",
          safeErrorCode: "login",
        },
      ]);
      expect(JSON.stringify(records)).not.toContain("synthetic-password");
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe("ADR 0021: a derived artifact states its lineage", () => {
  test("a ledger names no input: the page it was parsed from is not kept", async () => {
    const ledger = (month: string) => ({
      dataset: "credit-ledger",
      filename: `credit-ledger-${month}.json`,
      body: `{"schemaVersion":1,"detailMonth":${Number(month)}}`,
      mediaType: "application/json",
    });
    const plan = await myJcbRunPlan(
      input({
        connections: [
          {
            summary: { ...connection("account-one").summary, artifactCount: 3 },
            artifacts: [
              {
                dataset: "credit-detail",
                filename: "credit-detail-00.html",
                body: statementHtml,
                mediaType: "text/html; charset=utf-8",
              },
              ledger("00"),
              ledger("01"),
            ],
          },
        ],
      }),
    );
    const extracted = plan.run.transformations.filter((step) => step.stepKind === "extracted");
    expect(
      extracted.map((step) => [step.outputArtifactKey, step.inputArtifactKeys] as const),
    ).toEqual([
      // The ledger is parsed from the page before redaction. The redacted
      // capture kept beside it is not that input, so it is not named, whether
      // or not the run holds it.
      ["account-one/credit-ledger-00.json", []],
      ["account-one/credit-ledger-01.json", []],
    ]);
    // Every collector_derived artifact has exactly one step naming it.
    for (const artifact of plan.artifacts.filter((entry) => entry.role === "collector_derived")) {
      expect(
        plan.run.transformations.filter((step) => step.outputArtifactKey === artifact.artifactKey),
      ).toHaveLength(1);
    }
  });
});

describe("ADR 0005 second amendment: unread months and export offers in the manifest", () => {
  /** A connection that ran to the end with the given unread months and offers. */
  function unreadConnection(
    connectionId: string,
    unreadMonths: readonly { position: number; code: string }[],
    exportOffers: readonly { position: number; kinds: readonly string[] }[] = [],
  ) {
    const base = connection(connectionId);
    return {
      ...base,
      summary: {
        ...base.summary,
        status: "partial" as const,
        unreadMonths: unreadMonths as never,
        ...(exportOffers.length === 0 ? {} : { exportOffers: exportOffers as never }),
      },
    };
  }

  async function storedManifest(plan: Awaited<ReturnType<typeof myJcbRunPlan>>) {
    const entry = plan.artifacts.find((artifact) => artifact.artifactKey === "manifest.json")!;
    return JSON.parse(new TextDecoder().decode((entry.body as { bytes: Uint8Array }).bytes)) as {
      connections: Record<string, unknown>[];
      failures: unknown[];
    };
  }

  test("a connection whose only unread months are third-header months carries scheduled_payments_page", async () => {
    const plan = await myJcbRunPlan(
      input({
        status: "partial",
        connections: [
          unreadConnection(
            "account-one",
            [{ position: 2, code: "scheduled_payments_page" }],
            [{ position: 1, kinds: ["pdf", "csv", "ofx"] }],
          ),
        ],
      }),
    );
    expect(plan.run.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 3,
        coverageStatus: "partial",
        safeErrorCode: "scheduled_payments_page",
      },
    ]);
    expect(plan.run.safeErrorCode).toBe("scheduled_payments_page");
    const manifest = await storedManifest(plan);
    expect(manifest.connections[0]).toEqual({
      connectionId: "account-one",
      bootstrapMode: "password",
      status: "partial",
      cardCount: 1,
      periodCount: 2,
      artifactCount: 3,
      unreadMonths: [{ position: 2, code: "scheduled_payments_page" }],
      exportOffers: [{ position: 1, kinds: ["pdf", "csv", "ofx"] }],
    });
    // Not a stop: nothing is recorded as a failure.
    expect(manifest.failures).toEqual([]);
  });

  test("unread months of another reason, or mixed, stay collector_partial", async () => {
    const plan = await myJcbRunPlan(
      input({
        status: "partial",
        connections: [
          unreadConnection("account-one", [{ position: 7, code: "rows_unstated" }]),
          unreadConnection("account-two", [
            { position: 2, code: "scheduled_payments_page" },
            { position: 7, code: "rows_unstated" },
          ]),
          unreadConnection("account-three", [{ position: 2, code: "scheduled_payments_page" }]),
        ],
      }),
    );
    expect(plan.run.units.map((unit) => [unit.unitKey, unit.safeErrorCode])).toEqual([
      ["account-one", "collector_partial"],
      ["account-two", "collector_partial"],
      ["account-three", "scheduled_payments_page"],
    ]);
    // The connections do not agree, so the run keeps the coarse code.
    expect(plan.run.safeErrorCode).toBe("collector_partial");
  });

  test("an unread code, a position or an export kind outside the closed values refuses the plan", async () => {
    const plan = (connections: SharedRunInput["connections"]) =>
      myJcbRunPlan(input({ status: "partial", connections }));
    await expect(
      plan([unreadConnection("account-one", [{ position: 2, code: "upstream said no" }])]),
    ).rejects.toThrow("manifest_unread_code_invalid");
    await expect(
      plan([unreadConnection("account-one", [{ position: 18, code: "scheduled_payments_page" }])]),
    ).rejects.toThrow("manifest_stop_position_invalid");
    await expect(
      plan([
        unreadConnection(
          "account-one",
          [{ position: 2, code: "scheduled_payments_page" }],
          [{ position: 1, kinds: ["xlsx"] }],
        ),
      ]),
    ).rejects.toThrow("manifest_export_kind_invalid");
  });

  test("an export offer on a whole connection is recorded and the unit stays complete", async () => {
    const base = connection("account-one");
    const plan = await myJcbRunPlan(
      input({
        connections: [
          {
            ...base,
            summary: { ...base.summary, exportOffers: [{ position: 1, kinds: ["csv"] }] },
          },
        ],
      }),
    );
    expect(plan.run.units[0]).toMatchObject({ coverageStatus: "complete" });
    expect(plan.run.units[0]).not.toHaveProperty("safeErrorCode");
    expect((await storedManifest(plan)).connections[0]).toMatchObject({
      status: "success",
      exportOffers: [{ position: 1, kinds: ["csv"] }],
    });
  });
});

describe("ADR 0005 amendment (c): schedule pages beside the months", () => {
  /** A whole connection that also stored or failed the given schedule pages. */
  function withSchedules(
    schedulePages: readonly { position: number; code: string }[],
    schedulePageCount: number | undefined,
  ) {
    const base = connection("account-one");
    const stored = schedulePages.filter((page) => page.code === "scheduled_payments_page");
    const artifacts = [
      ...base.artifacts,
      ...stored.map((page) => ({
        dataset: "credit-schedule",
        filename: `credit-schedule-0${page.position}.html`,
        body: statementHtml.replace("MyJCB synthetic", `MyJCB synthetic ${page.position}`),
        mediaType: "text/html; charset=utf-8",
        statementState: "unknown" as const,
        period: `detailMonth-${page.position}`,
      })),
    ];
    return {
      summary: {
        ...base.summary,
        artifactCount: artifacts.length,
        schedulePages: schedulePages as never,
        ...(schedulePageCount === undefined ? {} : { schedulePageCount }),
      },
      artifacts,
    };
  }

  test("stored and failed schedule pages keep the unit complete and are named in the manifest", async () => {
    const plan = await myJcbRunPlan(
      input({
        connections: [
          withSchedules(
            [
              { position: 7, code: "schedule_page_fetch" },
              { position: 8, code: "scheduled_payments_page" },
            ],
            1,
          ),
        ],
      }),
    );
    expect(plan.run.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 4,
        coverageStatus: "complete",
      },
    ]);
    expect(plan.run.providerOutcome).toBe("success");
    expect(plan.run).not.toHaveProperty("safeErrorCode");
    // A sanitized capture like any page, redacted and re-checked.
    expect(
      plan.artifacts
        .filter((artifact) => artifact.artifactKey.includes("credit-schedule"))
        .map((artifact) => [artifact.artifactKey, artifact.role]),
    ).toEqual([["account-one/credit-schedule-08.html", "sanitized_provider_capture"]]);
    const entry = plan.artifacts.find((artifact) => artifact.artifactKey === "manifest.json")!;
    const manifest = JSON.parse(
      new TextDecoder().decode((entry.body as { bytes: Uint8Array }).bytes),
    ) as { connections: Record<string, unknown>[]; failures: unknown[]; artifacts: unknown[] };
    expect(manifest.connections[0]).toMatchObject({
      status: "success",
      periodCount: 2,
      schedulePages: [
        { position: 7, code: "schedule_page_fetch" },
        { position: 8, code: "scheduled_payments_page" },
      ],
      schedulePageCount: 1,
    });
    expect(manifest.connections[0]).not.toHaveProperty("unreadMonths");
    expect(manifest.failures).toEqual([]);
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        dataset: "credit-schedule",
        statementState: "unknown",
        period: "detailMonth-8",
      }),
    );
  });

  test("a schedule code, position or count outside the closed values refuses the plan", async () => {
    const plan = (pages: readonly { position: number; code: string }[], count?: number) =>
      myJcbRunPlan(input({ connections: [withSchedules(pages, count)] }));
    await expect(plan([{ position: 8, code: "upstream said no" }], 0)).rejects.toThrow(
      "manifest_schedule_code_invalid",
    );
    await expect(plan([{ position: 18, code: "scheduled_payments_page" }], 1)).rejects.toThrow(
      "manifest_stop_position_invalid",
    );
    await expect(plan([{ position: 8, code: "scheduled_payments_page" }], 2)).rejects.toThrow(
      "manifest_schedule_count_invalid",
    );
    await expect(plan([{ position: 8, code: "scheduled_payments_page" }])).rejects.toThrow(
      "manifest_schedule_count_invalid",
    );
  });
});
