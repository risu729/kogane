// U09 (G1-01, G1-02, G1-08, G1-09, G1-15, G3-07, G3-08, G3-10, G3-11): the
// shared DATA-bucket write path of the SMBC Direct backfill collector.
//
// Synthetic data only: the "provider bytes" are short synthetic strings and the
// ranges are synthetic months. Nothing here contacts a provider.
import { describe, expect, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  parseTerminalKey,
  readTerminal,
  terminalKey,
} from "../../../packages/collection/src/index";
import {
  baseMediaType,
  buildSharedRunPlan,
  manifestBytes,
  MAX_SHARED_RUN_BYTES,
  persistSharedRun,
  progressWaitingForHuman,
  readStagedArtifacts,
  relativeArtifactKey,
  sharedOutcome,
  waitingForHuman,
} from "../src/shared-collection";
import { runPrefix, sha256Hex, storeManifest } from "../src/storage";
import type { BackfillManifest, BackfillProgress, StoredArtifact } from "../src/types";

const RUN_ID = "00000000-0000-4000-8000-000000000000";
const STARTED_AT = "2026-09-01T00:00:00.000Z";
const PREFIX = runPrefix(STARTED_AT, RUN_ID);
const SESSION_REF = "session-11111111-1111-4111-8111-111111111111";
const IDENTITY = { attemptId: "attempt-0000", acquisitionSessionRef: SESSION_REF };
const encoder = new TextEncoder();

const BODIES = new Map<string, Uint8Array>();

async function artifactOf(options: {
  dataset: StoredArtifact["dataset"];
  name: string;
  text: string;
  mediaType: string;
  range?: { start: string; end: string };
}): Promise<StoredArtifact> {
  const bytes = encoder.encode(options.text);
  const key = `${PREFIX}/${options.name}`;
  BODIES.set(key, bytes);
  return {
    dataset: options.dataset,
    key,
    mediaType: options.mediaType,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    ...(options.range ? { range: options.range } : {}),
  };
}

async function artifacts(): Promise<StoredArtifact[]> {
  return [
    await artifactOf({
      dataset: "balance-raw",
      name: "balance.raw.json.sjis",
      text: '{"balance":"1"}',
      mediaType: "application/json; charset=Shift_JIS",
    }),
    await artifactOf({
      dataset: "balance-normalized",
      name: "balance.normalized.json",
      text: '{"amount":"1"}\n',
      mediaType: "application/json; charset=utf-8",
    }),
    await artifactOf({
      dataset: "transactions-raw",
      name: "transactions/20990101-20990131.raw.json.sjis",
      text: '{"rows":[]}',
      mediaType: "application/json; charset=Shift_JIS",
      range: { start: "2099-01-01", end: "2099-01-31" },
    }),
    await artifactOf({
      dataset: "transactions-normalized",
      name: "transactions/20990101-20990131.normalized.json",
      text: '{"transactions":[]}\n',
      mediaType: "application/json; charset=utf-8",
      range: { start: "2099-01-01", end: "2099-01-31" },
    }),
  ];
}

async function manifestOf(overrides: Partial<BackfillManifest> = {}): Promise<BackfillManifest> {
  return {
    schemaVersion: "smbc-direct-backfill-worker-poc-v1",
    source: "smbc-direct",
    runId: RUN_ID,
    startedAt: STARTED_AT,
    completedAt: "2026-09-01T00:10:00.000Z",
    status: "success",
    requestedRange: { start: "2099-01-01", end: "2099-01-31" },
    completedChunks: 1,
    totalChunks: 1,
    transactionCount: 0,
    artifacts: await artifacts(),
    failureCodes: [],
    logoutSucceeded: true,
    ...overrides,
  };
}

function inputOf(manifest: BackfillManifest) {
  return {
    manifest,
    manifestBytes: manifestBytes(manifest),
    prefix: PREFIX,
    bytesByKey: new Map(manifest.artifacts.map((entry) => [entry.key, BODIES.get(entry.key)!])),
    identity: IDENTITY,
  };
}

describe("terminal field derivation", () => {
  test("a media type loses its charset parameter, never its identity", () => {
    expect(baseMediaType("application/json; charset=Shift_JIS")).toBe("application/json");
    expect(baseMediaType("application/json")).toBe("application/json");
    expect(() => baseMediaType("not a media type")).toThrow();
  });

  test("an artifact key is relative to its own run prefix", () => {
    expect(relativeArtifactKey(`${PREFIX}/balance.raw.json.sjis`, PREFIX)).toBe(
      "balance.raw.json.sjis",
    );
    expect(() => relativeArtifactKey("raw/other/run/x.json", PREFIX)).toThrow();
  });
});

describe("G1-08/G1-09/G3-10/G3-11 run outcome", () => {
  test("a completed backfill covers the range it was asked for", async () => {
    expect(sharedOutcome(await manifestOf())).toEqual({
      providerOutcome: "success",
      coverageStatus: "complete",
    });
  });

  test("a partial run stays partial and needs a person to resume", async () => {
    const manifest = await manifestOf({
      status: "partial",
      failureCodes: ["transactions_http_503"],
    });
    expect(sharedOutcome(manifest)).toEqual({
      providerOutcome: "partial",
      coverageStatus: "partial",
      safeErrorCode: "transactions_http_503",
    });
    // This source has no unattended re-authentication: continuing needs a new
    // approved challenge, so the run reports that a person must act.
    expect(waitingForHuman(manifest)).toBe(true);
  });

  test("a lost session is human-required, not a retry", async () => {
    const manifest = await manifestOf({
      status: "failed",
      artifacts: [],
      failureCodes: ["session_missing"],
    });
    expect(sharedOutcome(manifest)).toEqual({
      providerOutcome: "failed",
      coverageStatus: "unknown",
      safeErrorCode: "human_required_approval",
    });
    expect(waitingForHuman(manifest)).toBe(true);
  });

  test("the status route reports when the person still has to act", () => {
    const idle = { phase: "idle", lastErrorCode: null } as unknown as BackfillProgress;
    const waiting = { phase: "waiting_for_approval", lastErrorCode: null } as BackfillProgress;
    const unapproved = {
      phase: "idle",
      lastErrorCode: "approval_not_completed_generate_new_qr",
    } as unknown as BackfillProgress;
    expect(progressWaitingForHuman(idle)).toBe(false);
    expect(progressWaitingForHuman(waiting)).toBe(true);
    expect(progressWaitingForHuman(unapproved)).toBe(true);
  });
});

describe("G1-01/G1-02 one backfill run produces one terminal", () => {
  test("writes every object, then the terminal last, with the range it covered", async () => {
    const bucket = new FakeR2Bucket();
    const manifest = await manifestOf();
    const summary = await persistSharedRun(bucket, inputOf(manifest));
    expect(summary.outcome).toBe("persisted");
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("smbc-direct", RUN_ID));
    expect(parseTerminalKey(summary.terminalKey)).toEqual({ source: "smbc-direct", runId: RUN_ID });

    const read = await readTerminal(bucket, "smbc-direct", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.acquisitionSessionRef).toBe(SESSION_REF);
    expect(read.manifest.requestedScope).toEqual({
      scopeKind: "date_range",
      startValue: "2099-01-01",
      endValue: "2099-01-31",
      unitKeys: ["account"],
    });
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual([
      "balance.normalized.json",
      "balance.raw.json.sjis",
      "manifest.json",
      "transactions/20990101-20990131.normalized.json",
      "transactions/20990101-20990131.raw.json.sjis",
    ]);
    expect(read.manifest.artifacts.every((entry) => entry.mediaType === "application/json")).toBe(
      true,
    );
    // One declared range per month, plus the requested range; the raw and
    // normalized artifacts of a month share it.
    expect(read.manifest.ranges.map((range) => range.rangeKey)).toEqual([
      "chunk-2099-01-01-2099-01-31",
      "requested",
    ]);
    expect(read.manifest.transformations.map((step) => step.outputArtifactKey).sort()).toEqual([
      "balance.normalized.json",
      "transactions/20990101-20990131.normalized.json",
    ]);
  });

  test("a failed object put leaves no terminal", async () => {
    const input = inputOf(await manifestOf());
    const plan = await buildSharedRunPlan(input);
    const digest = plan.artifacts[0]!.sha256;
    const bucket = new FakeR2Bucket({
      failPut: new Set([`objects/${digest.slice(0, 2)}/${digest}`]),
    });
    const summary = await persistSharedRun(bucket, input);
    expect(summary.outcome).toBe("incomplete");
    expect(await bucket.head(summary.terminalKey)).toBeNull();
  });

  test("a failed run with nothing stored still writes a failed terminal", async () => {
    const bucket = new FakeR2Bucket();
    const manifest = await manifestOf({
      status: "failed",
      artifacts: [],
      failureCodes: ["balance_http_503"],
      completedChunks: 0,
    });
    const summary = await persistSharedRun(bucket, inputOf(manifest));
    expect(summary.outcome).toBe("persisted");
    expect(summary.waitingForHuman).toBe(true);
    const read = await readTerminal(bucket, "smbc-direct", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual(["manifest.json"]);
  });

  test("re-persisting the same run is a no-op, not a second run", async () => {
    const bucket = new FakeR2Bucket();
    const input = inputOf(await manifestOf());
    const first = await persistSharedRun(bucket, input);
    const putCount = bucket.putKeys.length;
    const second = await persistSharedRun(bucket, input);
    expect(second.outcome).toBe("already_persisted");
    expect(second.terminalDigest).toBe(first.terminalDigest);
    expect(bucket.putKeys.length).toBe(putCount);
  });

  test("nothing stored in DATA carries session or credential material", async () => {
    const bucket = new FakeR2Bucket();
    await persistSharedRun(bucket, inputOf(await manifestOf()));
    const everything = [...bucket.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    for (const forbidden of [
      "Cookie",
      "cookie",
      "password",
      "branchNo",
      "accountNo",
      "_TOKEN",
      "ciphertext",
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    expect(everything).toContain(SESSION_REF);
  });
});

describe("re-reading a run out of the staging bucket", () => {
  test("reads every artifact and refuses a run that no longer matches", async () => {
    const manifest = await manifestOf();
    const staging = new FakeR2Bucket();
    for (const artifact of manifest.artifacts) {
      await staging.seed(artifact.key, BODIES.get(artifact.key)!);
    }
    const bytesByKey = await readStagedArtifacts(staging, manifest);
    expect([...bytesByKey.keys()].sort()).toEqual(
      manifest.artifacts.map((entry) => entry.key).sort(),
    );

    // A byte that changed under the manifest stops the run without a terminal.
    const changed = new Map(bytesByKey);
    changed.set(manifest.artifacts[0]!.key, encoder.encode("different"));
    const bucket = new FakeR2Bucket();
    await expect(
      persistSharedRun(bucket, { ...inputOf(manifest), bytesByKey: changed }),
    ).rejects.toThrow("shared_artifact_changed");
    expect(bucket.putKeys).toEqual([]);
  });

  test("an implausibly large run is refused rather than read into memory", async () => {
    const manifest = await manifestOf();
    const oversized: BackfillManifest = {
      ...manifest,
      artifacts: manifest.artifacts.map((entry) => ({
        ...entry,
        bytes: MAX_SHARED_RUN_BYTES,
      })),
    };
    await expect(readStagedArtifacts(new FakeR2Bucket(), oversized)).rejects.toThrow(
      "shared_run_too_large",
    );
  });
});

// Parity with the legacy path: the importer forwards this source's staged bytes
// verbatim (it only checks the Shift_JIS round trip), so the shared path must
// store exactly the staged bytes — provider responses and the manifest alike.
describe("provider bytes are stored verbatim", () => {
  test("Shift_JIS provider bytes reach DATA unchanged, not re-encoded", async () => {
    // `{"k":"あ"}` in Shift_JIS: valid for the provider, not valid UTF-8, so
    // any decode/re-encode on the way would change it.
    const raw = Uint8Array.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x22, 0x82, 0xa0, 0x22, 0x7d]);
    const key = `${PREFIX}/balance.raw.json.sjis`;
    const manifest = await manifestOf({
      artifacts: [
        {
          dataset: "balance-raw",
          key,
          mediaType: "application/json; charset=Shift_JIS",
          bytes: raw.byteLength,
          sha256: await sha256Hex(raw),
        },
      ],
    });
    const staging = new FakeR2Bucket();
    await staging.seed(key, raw);
    const data = new FakeR2Bucket();
    const summary = await persistSharedRun(data, {
      ...inputOf(manifest),
      bytesByKey: await readStagedArtifacts(staging, manifest),
    });
    expect(summary.outcome).toBe("persisted");
    const read = await readTerminal(data, "smbc-direct", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    const stored = read.manifest.artifacts.find(
      (entry) => entry.artifactKey === "balance.raw.json.sjis",
    );
    expect(stored?.mediaType).toBe("application/json");
    expect(stored?.role).toBe("provider_response");
    const object = await data.get(stored!.storageRef.key);
    expect([...new Uint8Array(await object!.arrayBuffer())]).toEqual([...raw]);
  });

  test("the collector manifest in DATA is the exact bytes legacy mode stages", async () => {
    const manifest = await manifestOf();
    const staging = new FakeR2Bucket();
    const key = await storeManifest(staging as unknown as R2Bucket, PREFIX, manifest);
    const staged = await staging.get(key);
    expect([...new Uint8Array(await staged!.arrayBuffer())]).toEqual([...manifestBytes(manifest)]);
  });
});
