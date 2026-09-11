// U09 (G1-01, G1-02, G1-08, G1-09, G1-15, G3-07, G3-08): the shared DATA-bucket
// write path of the GLOBAL PASS collector.
//
// Synthetic data only: the activity pages are the same synthetic fixture shape
// the existing collection suite builds, never a real statement.
import { describe, expect, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  parseTerminalKey,
  readTerminal,
  terminalKey,
} from "../../../packages/collection/src/index";
import { collectionTarget, sharedCollectionEnabled } from "../src/collection-target";
import {
  buildSharedRunPlan,
  persistSharedRun,
  sharedOutcome,
  waitingForHuman,
} from "../src/shared-collection";
import {
  GLOBALPASS_DATASET,
  GLOBALPASS_MEDIA_TYPE,
  GLOBALPASS_PAGINATION_STATUS,
  GLOBALPASS_SCHEMA_VERSION,
  type CollectionManifest,
  type StoredArtifact,
} from "../src/model";
import { NABLARCH_HIDDEN_SENTINEL } from "../src/sanitize";

const RUN_ID = "00000000-0000-4000-8000-000000000000";
const IDENTITY = { attemptId: "attempt-0000" };
const SANITIZED_HTML = `<!doctype html><html><body>ご利用明細<input type="hidden" name="nablarch_hidden" value="${NABLARCH_HIDDEN_SENTINEL}"></body></html>`;

function storedArtifact(month: string): StoredArtifact {
  return {
    dataset: GLOBALPASS_DATASET,
    month,
    key: `raw/prestia-globalpass/2099/02/01/${RUN_ID}/activity-${month}.html`,
    mediaType: GLOBALPASS_MEDIA_TYPE,
    bytes: SANITIZED_HTML.length,
    sha256: "a".repeat(64),
  };
}

function manifestOf(overrides: Partial<CollectionManifest> = {}): CollectionManifest {
  return {
    schemaVersion: GLOBALPASS_SCHEMA_VERSION,
    source: "prestia-globalpass",
    runId: RUN_ID,
    mode: "daily",
    startedAt: "2099-02-01T18:17:00.000Z",
    completedAt: "2099-02-01T18:18:00.000Z",
    status: "success",
    availableMonths: ["2099-02", "2099-01"],
    selectedMonths: ["2099-02", "2099-01"],
    captureComplete: true,
    paginationStatus: GLOBALPASS_PAGINATION_STATUS,
    artifacts: [storedArtifact("2099-02"), storedArtifact("2099-01")],
    failures: [],
    ...overrides,
  };
}

function inputOf(manifest: CollectionManifest) {
  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    captures: manifest.artifacts.map((artifact) => ({
      month: artifact.month,
      sanitizedHtml: SANITIZED_HTML,
    })),
    identity: IDENTITY,
  };
}

describe("COLLECTION_TARGET", () => {
  test("defaults to legacy and only the exact string selects shared", () => {
    expect(collectionTarget(undefined)).toBe("legacy");
    expect(collectionTarget("shared")).toBe("shared");
    for (const value of ["Shared", " shared", "shared ", "legacy", ""]) {
      expect(collectionTarget(value)).toBe("legacy");
      expect(sharedCollectionEnabled(value)).toBe(false);
    }
  });
});

describe("G1-08/G1-09 run outcome", () => {
  test("a successful run still declares partial coverage", () => {
    // A rolling window with unproven pagination is never complete coverage.
    expect(sharedOutcome(manifestOf())).toEqual({
      providerOutcome: "success",
      coverageStatus: "partial",
    });
  });

  test("a partial run stays partial and carries its own safe code", () => {
    expect(
      sharedOutcome(
        manifestOf({
          status: "partial",
          captureComplete: false,
          failures: [
            {
              operation: "sanitization",
              errorType: "Error",
              errorCode: "html_sanitization_failed",
              artifactKey: "activity-2099-01.html",
            },
          ],
        }),
      ),
    ).toEqual({
      providerOutcome: "partial",
      coverageStatus: "partial",
      safeErrorCode: "html_sanitization_failed",
    });
  });

  test("a failed run never claims coverage", () => {
    expect(
      sharedOutcome(
        manifestOf({
          status: "failed",
          captureComplete: false,
          artifacts: [],
          failures: [
            {
              operation: "browser-collection",
              errorType: "Error",
              errorCode: "browser_collection_failed",
            },
          ],
        }),
      ),
    ).toEqual({
      providerOutcome: "failed",
      coverageStatus: "unknown",
      safeErrorCode: "browser_collection_failed",
    });
  });

  test("this source reports no human-required state to the operations API", () => {
    // The container reports every login failure as the same generic code, so
    // the collector does not claim a person must act. It also never retries a
    // login: one attempt per run, and the cron is the only re-attempt.
    expect(waitingForHuman(manifestOf({ status: "failed" }))).toBe(false);
  });
});

describe("G1-01/G1-02 persisting a run", () => {
  test("writes every month, then the terminal last, with the months it covers", async () => {
    const bucket = new FakeR2Bucket();
    const summary = await persistSharedRun(bucket, inputOf(manifestOf()));
    expect(summary.outcome).toBe("persisted");
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("prestia-globalpass", RUN_ID));
    expect(parseTerminalKey(summary.terminalKey)).toEqual({
      source: "prestia-globalpass",
      runId: RUN_ID,
    });

    const read = await readTerminal(bucket, "prestia-globalpass", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual([
      "activity-2099-01.html",
      "activity-2099-02.html",
      "manifest.json",
    ]);
    expect(read.manifest.requestedScope).toEqual({
      scopeKind: "month_range",
      startValue: "2099-01",
      endValue: "2099-02",
      unitKeys: ["account"],
    });
    expect(read.manifest.ranges.map((range) => range.rangeKey)).toEqual([
      "month-2099-01",
      "month-2099-02",
      "requested",
    ]);
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account",
        unitKind: "collection",
        artifactCount: 2,
        coverageStatus: "partial",
      },
    ]);
    // Two identical pages share one content-addressed object.
    expect(new Set(read.manifest.artifacts.map((entry) => entry.storageRef.key)).size).toBe(2);
  });

  test("nothing stored in DATA carries session or credential material", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(bucket, inputOf(manifestOf()));
    const everything = [...bucket.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    for (const forbidden of [
      "jsessionid",
      "Cookie",
      "cookie",
      "password",
      "usrId",
      "relayToken",
      "turnstile",
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    // The encrypted Nablarch state is present only as the redaction sentinel.
    expect(everything).toContain(NABLARCH_HIDDEN_SENTINEL);
  });

  test("a failed object put leaves no terminal", async () => {
    const input = inputOf(manifestOf());
    const plan = await buildSharedRunPlan(input);
    const digest = plan.artifacts[0]!.sha256;
    const bucket = new FakeR2Bucket({
      failPut: new Set([`objects/${digest.slice(0, 2)}/${digest}`]),
    });
    const summary = await persistSharedRun(bucket, input);
    expect(summary.outcome).toBe("incomplete");
    expect(await bucket.head(summary.terminalKey)).toBeNull();
  });

  test("a failed run with no months still writes a failed terminal", async () => {
    const bucket = new FakeR2Bucket();
    const manifest = manifestOf({
      status: "failed",
      captureComplete: false,
      artifacts: [],
      failures: [
        {
          operation: "browser-collection",
          errorType: "Error",
          errorCode: "browser_collection_failed",
        },
      ],
    });
    const summary = await persistSharedRun(bucket, inputOf(manifest));
    expect(summary.outcome).toBe("persisted");
    const read = await readTerminal(bucket, "prestia-globalpass", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("browser_collection_failed");
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual(["manifest.json"]);
  });

  test("re-persisting the same run is a no-op, not a second run", async () => {
    const bucket = new FakeR2Bucket();
    const input = inputOf(manifestOf());
    const first = await persistSharedRun(bucket, input);
    const putCount = bucket.putKeys.length;
    const second = await persistSharedRun(bucket, input);
    expect(second.outcome).toBe("already_persisted");
    expect(second.terminalDigest).toBe(first.terminalDigest);
    expect(bucket.putKeys.length).toBe(putCount);
  });
});
