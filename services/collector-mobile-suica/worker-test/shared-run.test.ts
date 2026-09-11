// `COLLECTION_TARGET=shared` against a real R2 binding (unified plan U09).
//
// Synthetic bytes only: the HTML fixture is a hand-written page with the same
// hidden session field the real one has, so the redaction can be checked
// without a provider response. No account, balance or session value from a
// real site appears here.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import { REDACTED_BASE_VARIABLE, sanitizeHistoryHtml } from "../src/sanitize";
import { persistMobileSuicaRun, type MobileSuicaSharedRun } from "../src/shared-run";
import type { RawArtifact } from "../src/types";

const PRODUCER_VERSION = "mobile-suica-worker-poc-v2";
const SESSION_VALUE = "synthetic-session-state-value";

function historyHtml(runId: string): Uint8Array {
  return sanitizeHistoryHtml(
    [
      "<html><body><form>",
      `<input type="hidden" name="baseVariable" value="${SESSION_VALUE}">`,
      `<table><tr><td>${runId}</td></tr></table>`,
      "</form></body></html>",
    ].join(""),
  );
}

function jsonArtifact(dataset: string, body: unknown): RawArtifact {
  return {
    dataset,
    filename: `${dataset === "sf-history" ? "sf-history" : dataset}.json`,
    mediaType: "application/json",
    body: JSON.stringify(body),
  };
}

function run(overrides: Partial<MobileSuicaSharedRun> = {}): MobileSuicaSharedRun {
  const runId = overrides.runId ?? crypto.randomUUID();
  return {
    runId,
    producerVersion: PRODUCER_VERSION,
    attemptId: `attempt-${runId}`,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:30.000Z",
    status: "success",
    asOfDateJst: "2026-09-11",
    complete: true,
    failureCodes: [],
    artifacts: [
      {
        dataset: "sf-history-html",
        filename: "sf-history-page-0001.html",
        mediaType: "text/html; charset=shift_jis",
        body: historyHtml(runId),
      },
      jsonArtifact("sf-history", { transactionCount: 0, rows: [], runId }),
      jsonArtifact("collection-summary", { transactionCount: 0, complete: true, runId }),
    ],
    ...overrides,
  };
}

/** `env.DATA` with one object key that refuses to be written. */
function bucketFailingOn(key: string): R2BucketLike {
  const data = env.DATA as unknown as R2BucketLike;
  return {
    head: (target) => data.head(target),
    get: (target) => data.get(target),
    put: async (target, value, options) => {
      if (target === key) throw new Error("synthetic_put_failure");
      return await data.put(target, value, options);
    },
    list: (options) => data.list(options),
    createMultipartUpload: (target, options) => data.createMultipartUpload(target, options),
  };
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("G1-02/G1-15 the Mobile Suica run is written to the shared bucket, terminal last", () => {
  it("stores the sanitized page and states the as-of selector and the sanitizer", async () => {
    const input = run();
    expect((await persistMobileSuicaRun(env.DATA, input)).outcome).toBe("persisted");

    const read = await readTerminal(env.DATA, "mobile-suica", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    const manifest = read.manifest;
    expect(manifest.source).toBe("mobile-suica");
    expect(manifest.producer).toBe("collector-mobile-suica");
    expect(manifest.producerVersion).toBe(PRODUCER_VERSION);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("complete");
    expect(
      manifest.artifacts.map((entry) => [entry.artifactKey, entry.role, entry.mediaType]),
    ).toEqual([
      ["collection-summary.json", "collector_summary", "application/json"],
      ["sf-history-page-0001.html", "sanitized_provider_capture", "text/html"],
      ["sf-history.json", "collector_derived", "application/json"],
    ]);
    expect(manifest.ranges).toEqual([
      {
        rangeKey: "as-of-selector",
        rangeKind: "selector",
        precision: "date",
        basis: "request",
        startValue: "2026-09-11",
        endValue: "2026-09-11",
        unitKey: "account",
      },
    ]);
    expect(manifest.transformations).toEqual([
      {
        transformationId: "sf-history-extracted",
        stepKind: "extracted",
        transformerId: "mobile-suica-history-normalizer",
        transformerVersion: "v1",
        inputArtifactKeys: ["sf-history-page-0001.html"],
        outputArtifactKey: "sf-history.json",
      },
      {
        transformationId: "sf-history-html-redacted",
        stepKind: "redacted",
        transformerId: "mobile-suica-history-sanitizer",
        transformerVersion: "v1",
        inputArtifactKeys: [],
        outputArtifactKey: "sf-history-page-0001.html",
      },
    ]);
    expect(await verifyReferencedObjects(env.DATA, manifest, { streamHash: true })).toMatchObject({
      outcome: "ok",
      checked: 3,
      problems: [],
    });

    // The stored page is the redacted one: the session field never reaches R2.
    const html = manifest.artifacts.find(
      (entry) => entry.artifactKey === "sf-history-page-0001.html",
    )!;
    expect(html.storageRef).toEqual({ store: "DATA", key: objectKey(html.sha256) });
    const stored = await env.DATA.get(html.storageRef.key);
    const text = new TextDecoder("shift_jis").decode(await stored!.arrayBuffer());
    expect(text).toContain(REDACTED_BASE_VARIABLE);
    expect(text).not.toContain(SESSION_VALUE);
    // Nothing was written under the legacy per-source layout (G1-15).
    expect((await env.DATA.list({ prefix: `raw/mobile-suica/${input.runId}` })).objects).toEqual(
      [],
    );
  });
});

describe("G1-08/G1-09 an incomplete acquisition stays incomplete", () => {
  it("refuses complete coverage when the history boundary was not proven", async () => {
    const input = run({
      status: "partial",
      complete: false,
      failureCodes: ["history_boundary_unproven"],
    });
    expect((await persistMobileSuicaRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "mobile-suica", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("history_boundary_unproven");
    expect(read.manifest.units[0]?.coverageStatus).toBe("partial");
  });

  it("keeps a failed run with no artifact a failure, not an observation of zero", async () => {
    const input = run({ status: "failed", failureCodes: ["collection_failed"], artifacts: [] });
    expect((await persistMobileSuicaRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "mobile-suica", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("collection_failed");
    expect(read.manifest.artifacts).toEqual([]);
    expect(read.manifest.transformations).toEqual([]);
  });
});

describe("G1-01 a failed object write writes no terminal", () => {
  it("reports incomplete with a resumable checkpoint and leaves the terminal absent", async () => {
    const input = run();
    const html = input.artifacts[0]!.body as Uint8Array;
    const result = await persistMobileSuicaRun(
      bucketFailingOn(objectKey(await digestOf(html))),
      input,
    );
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") return;
    expect(result.failedArtifactKey).toBe("sf-history-page-0001.html");
    expect(await env.DATA.head(terminalKey("mobile-suica", input.runId))).toBeNull();
  });
});
