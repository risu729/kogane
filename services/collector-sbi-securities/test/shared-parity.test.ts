// Sanitization parity between the two storage targets (unified plan U09, D12).
//
// What `COLLECTION_TARGET=shared` persists must be, byte for byte, what the
// legacy path writes to the per-source bucket — which the central importer
// forwards unchanged today. The SBI collectors need a passkey ceremony to run,
// so the fixture is the `Artifact[]` shape they hand back, with non-ASCII
// provider text so the two encoders (`Buffer.byteLength`/`createHash` over a
// string in `storeArtifact`, `TextEncoder` in the shared plan) are compared on
// bytes that could differ. A failure is then pushed through `safeFailureCode`
// and the terminal is searched for the exception text (G3-08).
import { describe, expect, test } from "bun:test";
import { sha256Hex, terminalKey } from "../../../packages/collection/src/index";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { persistSbiRun, safeFailureCode } from "../src/shared-run";
import { storeArtifact } from "../src/storage";
import type { Artifact } from "../src/types";

const PRODUCER_VERSION = "sbi-worker-poc-v1";
const FAILURE_SECRET = "synthetic-session-id-and-account-number-in-message";
const WINDOW = { from: "2026-06-14", to: "2026-09-11" };

interface LegacyPut {
  key: string;
  bytes: Uint8Array;
}

function legacyBucket(): { bucket: R2Bucket; puts: LegacyPut[] } {
  const puts: LegacyPut[] = [];
  const bucket = {
    put: async (key: string, body: string) => {
      puts.push({ key, bytes: new TextEncoder().encode(body) });
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function filename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

async function sharedBytes(bucket: FakeR2Bucket, key: string): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`shared object missing: ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

function artifact(dataset: string, body: unknown, window?: { from: string; to: string }): Artifact {
  return { dataset, mediaType: "application/json", body, ...(window ? { window } : {}) };
}

/** Every dataset the two scopes produce, with the provider text they carry. */
function collected(): Artifact[] {
  return [
    artifact("domestic-cash-positions", { format: "synthetic", positions: [{ name: "合成銘柄" }] }),
    artifact("account-assets-current", { summary: { label: "口座合計", value: "0" } }),
    artifact("yen-detail-history", { pages: [{ dispAbstract: "合成 取引" }] }, WINDOW),
    artifact("domestic-trade-records", { rows: [{ note: "約定 ✓" }] }, WINDOW),
    artifact("foreign-cash-positions", { rows: [{ ccy: "USD", name: "Synthetic" }] }),
    artifact("foreign-cash-balances", { rows: [] }),
    artifact("foreign-trade-records", { rows: [] }, WINDOW),
  ];
}

describe("sbi-securities: the shared target persists the legacy bytes (U09 parity, G1-02)", () => {
  test("every dataset has the same digest and byte count on both targets", async () => {
    const artifacts = collected();
    const runId = crypto.randomUUID();
    const legacy = legacyBucket();
    const legacyStored = [];
    for (const entry of artifacts) {
      legacyStored.push(
        await storeArtifact({
          bucket: legacy.bucket,
          prefix: `raw/sbi-securities/2026/09/11/${runId}`,
          artifact: entry,
        }),
      );
    }

    const shared = new FakeR2Bucket();
    const result = await persistSbiRun(shared, {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:05:00.000Z",
      status: "success",
      scope: "all",
      window: WINDOW,
      artifacts,
      failures: [],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;

    const legacyByName = new Map(legacy.puts.map((put) => [filename(put.key), put.bytes]));
    expect([...legacyByName.keys()].sort()).toEqual(
      result.manifest.artifacts.map((entry) => entry.artifactKey).sort(),
    );
    expect(legacyByName.size).toBe(artifacts.length);
    for (const entry of result.manifest.artifacts) {
      const legacyBytes = legacyByName.get(entry.artifactKey)!;
      const stored = legacyStored.find((item) => filename(item.key) === entry.artifactKey)!;
      expect(await sha256Hex(legacyBytes)).toBe(entry.sha256);
      expect(stored.sha256).toBe(entry.sha256);
      expect(stored.bytes).toBe(entry.byteSize);
      expect(await sharedBytes(shared, entry.storageRef.key)).toEqual(legacyBytes);
    }
  });

  test("a failure reaches the terminal as a code, never as the exception text", async () => {
    const runId = crypto.randomUUID();
    const shared = new FakeR2Bucket();
    const result = await persistSbiRun(shared, {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:05:00.000Z",
      status: "partial",
      scope: "all",
      artifacts: collected().filter((entry) => !entry.dataset.startsWith("foreign-")),
      failures: [{ scope: "foreign", code: safeFailureCode(new Error(FAILURE_SECRET)) }],
    });
    expect(result.outcome).toBe("persisted");
    const terminal = Buffer.from(
      await sharedBytes(shared, terminalKey("sbi-securities", runId)),
    ).toString("latin1");
    expect(terminal.includes(FAILURE_SECRET)).toBe(false);
    expect(terminal).toContain('"safeErrorCode":"operation_failed"');
  });
});
