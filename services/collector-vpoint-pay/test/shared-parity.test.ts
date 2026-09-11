// Sanitization parity between the two storage targets (unified plan U09, D12).
//
// What `COLLECTION_TARGET=shared` persists must be, byte for byte, what the
// legacy path writes to the per-source bucket. Both paths run here on one
// synthetic fixture: the real `collectVPointPay` with a fake fetcher, so the
// artifact bytes are what the collector produces; then the legacy
// `storeArtifact` into a memory bucket and the shared `persistRun` into the
// contract's fake bucket. The stored bytes are compared by digest, and the
// synthetic refresh token, access token and device UUID the collector was
// given are searched for in every object and in the terminal (G3-07, G3-08).
import { describe, expect, test } from "bun:test";
import { sha256Hex, terminalKey } from "../../../packages/collection/src/index";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { persistVPointPayRun } from "../src/shared-run";
import { storeArtifact } from "../src/storage";
import { collectVPointPay } from "../src/vpoint-pay";

const PRODUCER_VERSION = "vpoint-pay-worker-poc-v1";
const DEVICE_UUID = "00112233-4455-6677-8899-aabbccddeeff";
const REFRESH_SECRET = "synthetic-old-refresh-token-secret";
const ROTATED_SECRET = "synthetic-new-refresh-token-secret";
const ACCESS_SECRET = "synthetic-access-token-secret";

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

function assertAbsent(bytes: Uint8Array, secrets: readonly string[], where: string): void {
  const text = Buffer.from(bytes).toString("latin1");
  for (const secret of secrets) {
    expect(text.includes(secret), `${secret} must not survive into ${where}`).toBe(false);
  }
}

async function sharedBytes(bucket: FakeR2Bucket, key: string): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`shared object missing: ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

describe("v-point-pay: the shared target persists the legacy bytes (U09 parity, G1-02)", () => {
  test("every artifact the collector produced has the same digest on both targets", async () => {
    const tokensSeen: Array<string | null> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      tokensSeen.push(new Headers(init?.headers).get("x-vapp-access-token"));
      if (url.pathname.endsWith("/token")) {
        return Response.json({
          access_token: ACCESS_SECRET,
          refresh_token: ROTATED_SECRET,
          created_at: 1,
          expires_in: 3600,
        });
      }
      if (url.pathname.endsWith("/balance")) {
        return Response.json({
          currency_code: "JPY",
          account_balance: "100",
          charge_limit: {},
          inquiry_period: "202607",
        });
      }
      const month = url.searchParams.get("target_month");
      return Response.json({
        tran_month: month,
        agr_num: "masked-in-test",
        crd_num_last_4_digits: "0000",
        tran_list: month === "202608" ? [{ tran_amt: "10", shop_name: "合成店舗" }] : [],
      });
    };
    let rotated = "";
    const collection = await collectVPointPay({
      credential: { refreshToken: REFRESH_SECRET, deviceUuid: DEVICE_UUID },
      saveRotatedRefreshToken: async (value) => {
        rotated = value;
      },
      fetcher,
      now: new Date("2026-08-31T00:00:00Z"),
    });
    // The secrets really were in play.
    expect(rotated).toBe(ROTATED_SECRET);
    expect(tokensSeen.slice(1).every((token) => token === ACCESS_SECRET)).toBe(true);

    const runId = crypto.randomUUID();
    const legacy = legacyBucket();
    const legacyStored = [];
    for (const artifact of collection.artifacts) {
      legacyStored.push(
        await storeArtifact({
          bucket: legacy.bucket,
          prefix: `raw/v-point-pay/2026/08/31/${runId}`,
          artifact,
        }),
      );
    }

    const shared = new FakeR2Bucket();
    const result = await persistVPointPayRun(shared, {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-08-31T00:00:00.000Z",
      completedAt: "2026-08-31T00:01:00.000Z",
      status: "success",
      artifacts: collection.artifacts,
      earliestMonth: collection.earliestMonth,
      latestMonth: collection.latestMonth,
      failureCodes: [],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;

    const secrets = [REFRESH_SECRET, ROTATED_SECRET, ACCESS_SECRET, DEVICE_UUID];
    const legacyByName = new Map(legacy.puts.map((put) => [filename(put.key), put.bytes]));
    expect([...legacyByName.keys()].sort()).toEqual(
      result.manifest.artifacts.map((entry) => entry.artifactKey).sort(),
    );
    expect(legacyByName.size).toBe(collection.artifacts.length);
    for (const entry of result.manifest.artifacts) {
      const legacyBytes = legacyByName.get(entry.artifactKey)!;
      const stored = legacyStored.find((item) => filename(item.key) === entry.artifactKey)!;
      const persisted = await sharedBytes(shared, entry.storageRef.key);
      expect(await sha256Hex(legacyBytes)).toBe(entry.sha256);
      expect(stored.sha256).toBe(entry.sha256);
      expect(stored.bytes).toBe(entry.byteSize);
      expect(persisted).toEqual(legacyBytes);
      assertAbsent(persisted, secrets, entry.artifactKey);
    }
    expect(result.manifest.requestedScope).toMatchObject({
      scopeKind: "month_range",
      startValue: "202607",
      endValue: "202608",
    });
    assertAbsent(
      await sharedBytes(shared, terminalKey("v-point-pay", runId)),
      secrets,
      "the terminal",
    );
  });
});
