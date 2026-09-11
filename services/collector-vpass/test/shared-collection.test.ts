// U09 for Vpass: the shared DATA target. Synthetic fixtures only — every
// value below is invented and no provider is contacted.
//
// Acceptance rows: G1-01 (a failed put writes no terminal), G1-02 (the
// terminal follows every put and its references match what is stored), G1-08
// (coverage stays partial for a rolling statement window), G1-09 (a failed run
// persists no artifact), G1-15 (shared mode never calls the legacy importer or
// bucket), G1-16 (one session, one run per card, provenance kept),
// G3-07/G3-08 (no cookie, auth blob, card reference or provider text is
// stored or logged).
import { describe, expect, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import { collectionTarget } from "../src/collection-target";
import { sanitizedEnvelopeBytes, VpassSanitizeError } from "../src/sanitize";
import {
  persistCardRun,
  persistFailedRun,
  sharedRunDiagnostic,
  vpassCardRunPlan,
  type VpassCardRun,
} from "../src/shared-collection";
import worker from "../src/worker";

const sessionRunId = "2026-09-11T21-00-00-000Z";
const secret = "synthetic-session-material";

function envelope(content: Record<string, unknown>): string {
  return JSON.stringify({
    header: { resultCode: 0, requestHash: 1, requestTimestamp: 1 },
    body: { content },
  });
}

const cardListRawJson = envelope({
  DropdownListInitDisplayServiceBean: {
    multiCardInfoList: [
      { name: "SYNTHETIC CARD NAME", value: "synthetic-card-identify-key" },
      { name: "SECOND SYNTHETIC CARD", value: "second-synthetic-key" },
    ],
  },
});
const selectCardRawJson = envelope({
  MultiCardUpdateBean: { cardIdentifyKey: "synthetic-card-identify-key", sessionToken: secret },
});
const webMeisaiTopRawJson = envelope({
  WebMeisaiTopDisplayServiceBean: {
    seikyuYMList: [{ value: "202609" }, { value: "202608" }],
    authToken: secret,
  },
});
const pageRawJson = envelope({
  WebMeisaiTopDisplayServiceBean: {
    meisaiList: [{ amount: 1234, shop: "SYNTHETIC SHOP" }],
    webMeisaiTopK3Vo: { allCnt: 1, nextPageRow: 2 },
  },
});

function run(overrides: Partial<VpassCardRun> = {}): VpassCardRun {
  return {
    sessionRunId,
    cardLabel: "card-001",
    startedAt: "2026-09-11T21:00:00.000Z",
    completedAt: "2026-09-11T21:04:00.000Z",
    cardListRawJson,
    selectCardRawJson,
    webMeisaiTopRawJson,
    months: {
      "202609": { pages: [{ kind: "top", index: 0, rawJson: pageRawJson }], transactionCount: 1 },
      "202608": { pages: [{ kind: "top", index: 0, rawJson: pageRawJson }], transactionCount: 1 },
    },
    ...overrides,
  };
}

describe("COLLECTION_TARGET selects the store", () => {
  test("only the exact string 'shared' leaves the legacy path", () => {
    expect(collectionTarget(undefined)).toBe("legacy");
    expect(collectionTarget("legacy")).toBe("legacy");
    expect(collectionTarget("Shared")).toBe("legacy");
    expect(collectionTarget("shared")).toBe("shared");
  });
});

describe("G3-07/G3-08 the sanitizer runs before anything is stored", () => {
  test("session material and card references never reach the stored bytes", () => {
    const bytes = sanitizedEnvelopeBytes(selectCardRawJson, "card_selection_json_invalid");
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(secret);
    expect(text).toContain("<redacted-vpass-sensitive>");
    // Canonical encoding with the trailing newline central storage holds.
    expect(text.endsWith("\n")).toBe(true);
    expect(text.startsWith('{"body":')).toBe(true);
  });

  test("the card inventory keeps ordinal labels instead of names and references", () => {
    const text = new TextDecoder().decode(
      sanitizedEnvelopeBytes(cardListRawJson, "card_list_json_invalid", true),
    );
    expect(text).not.toContain("SYNTHETIC CARD NAME");
    expect(text).not.toContain("synthetic-card-identify-key");
    expect(text).toContain("card-001");
    expect(text).toContain("<redacted-card-reference>");
  });

  test("a response that is not a successful envelope is refused, not stored", () => {
    expect(() => sanitizedEnvelopeBytes("{", "statement_page_json_invalid")).toThrow(
      VpassSanitizeError,
    );
    expect(() =>
      sanitizedEnvelopeBytes(
        JSON.stringify({ header: { resultCode: "9" }, body: {} }),
        "statement_page_json_invalid",
      ),
    ).toThrow("statement_page_json_invalid");
  });
});

describe("G1-02/G1-08/G1-16 a card run persists its sanitized set and then the terminal", () => {
  test("objects, roles and the terminal describe what is stored", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistCardRun(bucket, run());
    expect(outcome.result.outcome).toBe("persisted");

    const runId = `${sessionRunId}-card-001`;
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("vpass", runId));
    const read = await readTerminal(bucket, "vpass", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const manifest = read.manifest;
    expect(manifest.producer).toBe("vpass-json");
    expect(manifest.producerVersion).toBe("vpass-worker-card-v1");
    // G1-16: the card is its own run and keeps the session it came from.
    expect(manifest.runId).toBe(runId);
    expect(manifest.acquisitionSessionRef).toBe(sessionRunId);
    expect(manifest.providerOutcome).toBe("success");
    // G1-08: a card exposes a rolling window of months, so a finished run is
    // not a claim about the card's whole history.
    expect(manifest.coverageStatus).toBe("partial");
    expect(
      manifest.artifacts.map((artifact) => [artifact.artifactKey, artifact.role] as const),
    ).toEqual([
      ["card-list.json", "sanitized_provider_capture"],
      ["manifest.json", "collector_manifest"],
      ["months/202608/top-000.json", "provider_response"],
      ["months/202609/top-000.json", "provider_response"],
      ["select-card.json", "sanitized_provider_capture"],
      ["web-meisai-top.json", "sanitized_provider_capture"],
    ]);
    expect(manifest.units).toEqual([
      { unitKey: "card-001", unitKind: "card", artifactCount: 6, coverageStatus: "partial" },
    ]);
    expect(manifest.ranges).toEqual([
      {
        rangeKey: "statement-months",
        rangeKind: "declared_coverage",
        precision: "month",
        basis: "manifest",
        startValue: "2026-08",
        endValue: "2026-09",
        unitKey: "card-001",
      },
    ]);
    // Every stored object is the sanitizer's output and the provider bytes
    // were deliberately not retained.
    expect(manifest.transformations).toHaveLength(5);
    expect(manifest.transformations[0]).toEqual({
      transformationId: "redacted:card-list.json",
      stepKind: "redacted",
      transformerId: "vpass-json-sanitizer",
      transformerVersion: "v1",
      inputArtifactKeys: [],
      outputArtifactKey: "card-list.json",
    });
    expect(await verifyReferencedObjects(bucket, manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    // Nothing raw was stored anywhere in the bucket.
    for (const entry of bucket.entries.values()) {
      expect(new TextDecoder().decode(entry.bytes)).not.toContain(secret);
    }
    const summary = manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await bucket.get(summary.storageRef.key);
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer())))).toEqual(
      {
        schemaVersion: "vpass-worker-card-v1",
        source: "vpass",
        runId: sessionRunId,
        card: "card-001",
        startedAt: "2026-09-11T21:00:00.000Z",
        completedAt: "2026-09-11T21:04:00.000Z",
        status: "success",
        monthCount: 2,
        pageCount: 2,
        transactionCount: 2,
        months: {
          "202608": { pages: 1, transactions: 1 },
          "202609": { pages: 1, transactions: 1 },
        },
      },
    );
  });

  test("two cards of one session are two runs that share the session ref", async () => {
    const bucket = new FakeR2Bucket();
    await persistCardRun(bucket, run());
    await persistCardRun(bucket, run({ cardLabel: "card-002" }));
    const terminals = [...bucket.entries.keys()].filter((key) => key.startsWith("runs/vpass/"));
    expect(terminals.sort()).toEqual([
      terminalKey("vpass", `${sessionRunId}-card-001`),
      terminalKey("vpass", `${sessionRunId}-card-002`),
    ]);
    for (const card of ["card-001", "card-002"]) {
      const read = await readTerminal(bucket, "vpass", `${sessionRunId}-${card}`);
      if (read.outcome !== "found") throw new Error("unreachable");
      expect(read.manifest.acquisitionSessionRef).toBe(sessionRunId);
      expect(read.manifest.units[0]?.unitKey).toBe(card);
    }
  });

  test("the same card written twice is a resend, not a second run", async () => {
    const bucket = new FakeR2Bucket();
    await persistCardRun(bucket, run());
    const objects = bucket.entries.size;
    const again = await persistCardRun(bucket, run());
    expect(again.result.outcome).toBe("already_persisted");
    expect(bucket.entries.size).toBe(objects);
  });
});

describe("G1-09 a card that collected nothing stays a failure", () => {
  test("the failed terminal carries a code and no artifact", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistFailedRun(bucket, {
      sessionRunId,
      unitKey: "card-001",
      startedAt: "2026-09-11T21:00:00.000Z",
      failedAt: "2026-09-11T21:00:30.000Z",
    });
    expect(outcome.artifactCount).toBe(0);
    const read = await readTerminal(bucket, "vpass", `${sessionRunId}-card-001`);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("collector_failed");
    expect(read.manifest.artifacts).toEqual([]);
    expect([...bucket.entries.keys()]).toEqual([terminalKey("vpass", `${sessionRunId}-card-001`)]);
  });

  test("a session that failed before a card was selected is its own unit", async () => {
    const bucket = new FakeR2Bucket();
    await persistFailedRun(bucket, {
      sessionRunId,
      unitKey: "run",
      startedAt: "2026-09-11T21:00:00.000Z",
      failedAt: "2026-09-11T21:00:10.000Z",
    });
    const read = await readTerminal(bucket, "vpass", `${sessionRunId}-run`);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.units).toEqual([
      {
        unitKey: "run",
        unitKind: "session",
        artifactCount: 0,
        coverageStatus: "unknown",
        safeErrorCode: "collector_failed",
      },
    ]);
  });
});

describe("G1-01 a failed put leaves no terminal", () => {
  test("the run reports incomplete and logs codes and counts only", async () => {
    const card = run();
    const plan = await vpassCardRunPlan(card);
    const failing = plan.artifacts.at(-1)!;
    const bucket = new FakeR2Bucket({ failPut: new Set([objectKey(failing.sha256)]) });
    const outcome = await persistCardRun(bucket, card);
    expect(outcome.result.outcome).toBe("incomplete");
    if (outcome.result.outcome !== "incomplete") throw new Error("unreachable");
    expect((await readTerminal(bucket, "vpass", `${sessionRunId}-card-001`)).outcome).toBe(
      "missing",
    );
    expect(outcome.result.checkpoint.pendingArtifactKeys).toContain(failing.artifactKey);

    const diagnostic = sharedRunDiagnostic(`${sessionRunId}-card-001`, "card-001", outcome);
    expect(diagnostic).toEqual({
      event: "vpass-shared-collection",
      runId: `${sessionRunId}-card-001`,
      unitKey: "card-001",
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
  test("a shared-target session touches neither the legacy bucket nor the queue", async () => {
    const data = new FakeR2Bucket();
    let legacyWrites = 0;
    let enqueued = 0;
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
    const env = {
      COLLECTION_TARGET: "shared",
      DATA: data,
      // Missing secrets deliberately fail the session before any provider
      // request, which is the failed-run path.
      SNAPSHOTS: {
        put: async () => {
          legacyWrites += 1;
          throw new Error("the legacy bucket must not be written in shared mode");
        },
      },
      RAW_EVIDENCE_QUEUE: {
        send: async () => {
          enqueued += 1;
        },
      },
      RAW_EVIDENCE_IMPORTER: {
        fetch: async () => {
          imports += 1;
          return Response.json({ status: "sealed" });
        },
      },
    } as unknown as Parameters<typeof worker.scheduled>[1];
    try {
      await expect(
        worker.scheduled(
          { scheduledTime: Date.parse("2026-09-05T00:00:00Z") } as ScheduledController,
          env,
        ),
      ).rejects.toThrow("Missing Worker secret");
      expect(legacyWrites).toBe(0);
      expect(enqueued).toBe(0);
      expect(imports).toBe(0);
      // The session failure is recorded as a failed run with no artifact.
      expect([...data.entries.keys()]).toEqual([
        terminalKey("vpass", "2026-09-05T00-00-00-000Z-run"),
      ]);
      const persisted = records.find((record) => record.event === "vpass-shared-collection");
      expect(persisted).toMatchObject({ persistence: "persisted", artifactCount: 0 });
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
