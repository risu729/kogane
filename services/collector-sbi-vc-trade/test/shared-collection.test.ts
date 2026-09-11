// U09 (G1-01, G1-02, G1-08, G1-09, G1-15, G3-07, G3-08, G3-09, G3-10, G3-11):
// the shared DATA-bucket write path of the SBI VC Trade collector.
//
// Synthetic data only: the gateway bodies are the shape `collectSbiVcTrade`
// produces after it strips `secureKey`, with synthetic numbers.
import { describe, expect, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  parseTerminalKey,
  readTerminal,
  terminalKey,
} from "../../../packages/collection/src/index";
import { collectionTarget, sharedCollectionEnabled } from "../src/collection-target";
import {
  blockedErrorCode,
  blockedRunManifest,
  buildSharedRunPlan,
  persistSharedRun,
  sharedOutcome,
  waitingForHuman,
} from "../src/shared-collection";
import { describeArtifact, storeArtifact } from "../src/storage";
import type { CollectionManifest, HealthState, StoredArtifact } from "../src/types";

const RUN_ID = "00000000-0000-4000-8000-000000000000";
const SESSION_REF = "session-11111111-1111-4111-8111-111111111111";
const IDENTITY = { attemptId: "attempt-0000", acquisitionSessionRef: SESSION_REF };
const BODY = JSON.stringify({ meta: { status: "OK" }, body: { list: [], totalSize: "0" } });

const HEALTHY: HealthState = {
  initializedAt: "2026-09-01T00:00:00.000Z",
  lastAttemptAt: "2026-09-01T00:00:00.000Z",
  lastSuccessAt: "2026-09-01T00:00:00.000Z",
  lastHttpStatus: 200,
  lastGatewayStatus: "OK",
  lastCookieUpdateCount: 1,
  consecutiveFailures: 0,
  lastErrorCode: null,
  lastReauthAttemptAt: null,
  lastReauthSuccessAt: null,
  lastReauthErrorCode: null,
};

function storedArtifact(dataset: string): StoredArtifact {
  return {
    dataset,
    key: `raw/sbi-vc-trade/2026/09/01/${RUN_ID}/${dataset}.json`,
    sha256: "a".repeat(64),
    bytes: BODY.length,
  };
}

function manifestOf(overrides: Partial<CollectionManifest> = {}): CollectionManifest {
  return {
    schemaVersion: "sbi-vc-trade-worker-poc-v1",
    source: "sbi-vc-trade",
    runId: RUN_ID,
    startedAt: "2026-09-01T21:05:00.000Z",
    completedAt: "2026-09-01T21:06:00.000Z",
    status: "success",
    artifacts: [storedArtifact("cash-balances"), storedArtifact("account-margin")],
    failures: [],
    ...overrides,
  };
}

function inputOf(manifest: CollectionManifest) {
  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    captures: manifest.artifacts.map((artifact) => ({ dataset: artifact.dataset, body: BODY })),
    identity: IDENTITY,
  };
}

describe("COLLECTION_TARGET", () => {
  test("defaults to legacy and only the exact string selects shared", () => {
    expect(collectionTarget(undefined)).toBe("legacy");
    expect(collectionTarget("shared")).toBe("shared");
    for (const value of ["Shared", " shared", "legacy", ""]) {
      expect(collectionTarget(value)).toBe("legacy");
      expect(sharedCollectionEnabled(value)).toBe(false);
    }
  });
});

describe("G3-10/G3-11 a session only a person can fix", () => {
  test("a failed re-authentication is human-required, not a retry", () => {
    const health: HealthState = { ...HEALTHY, lastReauthErrorCode: "missing_passkey_credential" };
    expect(waitingForHuman(health)).toBe(true);
    expect(blockedErrorCode(health)).toBe("human_required_reauth");
  });

  test("a refused session that has never re-authenticated is human-required", () => {
    const health: HealthState = { ...HEALTHY, lastHttpStatus: 401, lastErrorCode: "http_rejected" };
    expect(waitingForHuman(health)).toBe(true);
  });

  test("a healthy session and a recoverable failure are not human-required", () => {
    expect(waitingForHuman(HEALTHY)).toBe(false);
    expect(blockedErrorCode({ ...HEALTHY, lastErrorCode: "gateway_rejected" })).toBe(
      "session_unhealthy",
    );
    expect(
      waitingForHuman({
        ...HEALTHY,
        lastHttpStatus: 401,
        lastReauthSuccessAt: "2026-09-01T00:10:00.000Z",
      }),
    ).toBe(false);
  });

  test("a blocked collection is a failed run with no artifact but its own manifest", async () => {
    const bucket = new FakeR2Bucket();
    const manifest = blockedRunManifest({
      schemaVersion: "sbi-vc-trade-worker-poc-v1",
      runId: RUN_ID,
      startedAt: "2026-09-01T21:05:00.000Z",
      completedAt: "2026-09-01T21:05:00.000Z",
      errorCode: "human_required_reauth",
    });
    const summary = await persistSharedRun(
      bucket,
      { manifest, manifestJson: JSON.stringify(manifest), captures: [], identity: IDENTITY },
      { waitingForHuman: true },
    );
    expect(summary.outcome).toBe("persisted");
    expect(summary.waitingForHuman).toBe(true);
    const read = await readTerminal(bucket, "sbi-vc-trade", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("human_required_reauth");
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual(["manifest.json"]);
  });
});

describe("G1-08/G1-09 run outcome", () => {
  test("a successful run declares complete coverage of the requested snapshot", () => {
    expect(sharedOutcome(manifestOf())).toEqual({
      providerOutcome: "success",
      coverageStatus: "complete",
    });
  });

  test("a partial run stays partial and carries its own safe code", () => {
    expect(
      sharedOutcome(
        manifestOf({
          status: "partial",
          failures: [{ operation: "collect", errorCode: "collector_gateway_rejected" }],
        }),
      ),
    ).toEqual({
      providerOutcome: "partial",
      coverageStatus: "partial",
      safeErrorCode: "collector_gateway_rejected",
    });
  });

  test("a failed run never claims coverage", () => {
    expect(
      sharedOutcome(
        manifestOf({
          status: "failed",
          artifacts: [],
          failures: [{ operation: "load_session", errorCode: "missing_session_seed" }],
        }),
      ),
    ).toEqual({
      providerOutcome: "failed",
      coverageStatus: "unknown",
      safeErrorCode: "missing_session_seed",
    });
  });
});

describe("G1-01/G1-02 persisting a run", () => {
  test("writes every object, then the terminal last, with the session generation", async () => {
    const bucket = new FakeR2Bucket();
    const summary = await persistSharedRun(bucket, inputOf(manifestOf()));
    expect(summary.outcome).toBe("persisted");
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("sbi-vc-trade", RUN_ID));
    expect(parseTerminalKey(summary.terminalKey)).toEqual({
      source: "sbi-vc-trade",
      runId: RUN_ID,
    });

    const read = await readTerminal(bucket, "sbi-vc-trade", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.acquisitionSessionRef).toBe(SESSION_REF);
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual([
      "account-margin.json",
      "cash-balances.json",
      "manifest.json",
    ]);
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account",
        unitKind: "collection",
        artifactCount: 2,
        coverageStatus: "complete",
      },
    ]);
  });

  test("nothing stored in DATA carries session or credential material", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(bucket, inputOf(manifestOf()));
    const everything = [...bucket.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    for (const forbidden of [
      "secureKey",
      "vctBffSid",
      "jSessionId",
      "AWSALB",
      "Cookie",
      "cookie",
      "passkey",
      "credentialId",
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    // Only the opaque generation id, never the session it names.
    expect(everything).toContain(SESSION_REF);
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

describe("one copy: shared mode names what legacy mode would have staged", () => {
  test("the manifest entry is the same whether or not the staging put happens", async () => {
    const prefix = `raw/sbi-vc-trade/2026/09/01/${RUN_ID}`;
    const artifact = { dataset: "cash-balances", body: BODY };
    const described = await describeArtifact({ prefix, artifact });
    const staging = new FakeR2Bucket();
    const stored = await storeArtifact({
      bucket: staging as unknown as R2Bucket,
      prefix,
      runId: RUN_ID,
      artifact,
    });
    expect(described.record).toEqual(stored);
    // The staged bytes and the DATA bytes are the same encoding of the same
    // sanitized body, so the importer's verbatim forward and the shared path
    // store identical bytes.
    const staged = await staging.get(stored.key);
    expect([...new Uint8Array(await staged!.arrayBuffer())]).toEqual([...described.encoded]);
    const data = new FakeR2Bucket();
    await persistSharedRun(data, inputOf(manifestOf({ artifacts: [stored] })));
    const shared = await data.get(`objects/${stored.sha256.slice(0, 2)}/${stored.sha256}`);
    expect([...new Uint8Array(await shared!.arrayBuffer())]).toEqual([...described.encoded]);
  });
});
