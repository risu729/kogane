// Sanitization parity between the two storage targets (unified plan U09, D12).
//
// What `COLLECTION_TARGET=shared` persists must be, byte for byte, what the
// legacy path writes to the per-source bucket — which is also what the central
// importer forwards unchanged today (`readVerifiedArtifact` and
// `readVerifiedPair` in `services/collector-r2-importer`). Both paths run here
// on one synthetic fixture: the real collector with a fake fetcher, so the
// artifact bytes are what the collector produces rather than hand-written
// ones; then the legacy `storeArtifact` / `storeVPointPayEmail` into a memory
// bucket and the shared `persistRun` into the contract's fake bucket. The
// stored bytes are compared by digest, and the synthetic secrets the collector
// was given are searched for in every object and in the terminal (G3-07,
// G3-08). Nothing here is a real account, cookie or message.
import { describe, expect, test } from "bun:test";
import { readTerminal, sha256Hex, terminalKey } from "../../../packages/collection/src/index";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { persistVPointPayEmailRun, persistVPointRun } from "../src/shared-run";
import { storeArtifact } from "../src/storage";
import { collectVPoint } from "../src/vpoint";
import {
  parseVPointPayEmail,
  prepareVPointPayEmail,
  storeVPointPayEmail,
} from "../src/vpoint-pay-email";

const PRODUCER_VERSION = "vpoint-worker-poc-v2";
const COOKIE_SECRET = "synthetic-session-cookie-secret-value";
const OUTER_TOKEN_SECRET = "synthetic-outer-message-token-secret";
const ENVELOPE = {
  envelopeTo: "vpointpay@takuk.me",
  expectedRecipient: "vpointpay@takuk.me",
};

interface LegacyPut {
  key: string;
  bytes: Uint8Array;
}

/** The per-source bucket as the legacy path sees it: every put is captured. */
function legacyBucket(): { bucket: R2Bucket; puts: LegacyPut[] } {
  const puts: LegacyPut[] = [];
  const bucket = {
    head: async () => null,
    put: async (key: string, body: string | ArrayBuffer | ArrayBufferView) => {
      puts.push({ key, bytes: toBytes(body) });
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function toBytes(body: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function filename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** ASCII secrets are found whatever the object's text encoding is. */
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("v-point: the shared target persists the legacy bytes (U09 parity, G1-02)", () => {
  test("every artifact the collector produced has the same digest on both targets", async () => {
    const cookiesSeen: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      cookiesSeen.push(new Headers(init?.headers).get("cookie") ?? "");
      const path = new URL(String(input)).pathname;
      if (path === "/api/balance_info") {
        return jsonResponse({ status: { code: "0000" }, results: { common: [], store: [] } });
      }
      if (path === "/api/smfg_point") {
        return jsonResponse({
          status: { code: "0000" },
          results: { get_point: { point_smbc: 0, point_smcc: 0 } },
        });
      }
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("expected FormData");
      const page = String(form.get("page"));
      if (path === "/api/tmoney_history") {
        return jsonResponse({
          status: { code: "0000" },
          results: { total: 1, history: [{ money: 1, note: "合成データ" }] },
        });
      }
      return jsonResponse({
        status: { code: "0000" },
        results: {
          total: 31,
          history: Array.from({ length: page === "2" ? 1 : 30 }, () => ({ point: 1 })),
          graph: {},
        },
      });
    };
    const collection = await collectVPoint({ sessionCookie: `session=${COOKIE_SECRET}`, fetcher });
    // The secret really was in play: the collector sent it on every request.
    expect(cookiesSeen.length).toBeGreaterThan(0);
    expect(cookiesSeen.every((cookie) => cookie.includes(COOKIE_SECRET))).toBe(true);

    const runId = crypto.randomUUID();
    const legacy = legacyBucket();
    const legacyStored = [];
    for (const artifact of collection.artifacts) {
      legacyStored.push(
        await storeArtifact({
          bucket: legacy.bucket,
          prefix: `raw/v-point/2026/09/11/${runId}`,
          artifact,
        }),
      );
    }

    const shared = new FakeR2Bucket();
    const result = await persistVPointRun(shared, {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:01:00.000Z",
      status: "success",
      artifacts: collection.artifacts,
      failureCodes: [],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;

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
      assertAbsent(persisted, [COOKIE_SECRET], entry.artifactKey);
    }
    const terminal = await sharedBytes(shared, terminalKey("v-point", runId));
    assertAbsent(terminal, [COOKIE_SECRET], "the terminal");
    expect((await readTerminal(shared, "v-point", runId)).outcome).toBe("found");
  });
});

describe("v-point-pay-email: the shared target keeps the stored message, not more", () => {
  function notification(text: string, subject = "【VポイントPay】ご利用のお知らせ"): Uint8Array {
    return new TextEncoder().encode(
      [
        "From: V Point Pay <info@prepaid.smbc-card.com>",
        "To: owner@example.invalid",
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        "Date: Sun, 31 Aug 2026 12:00:00 +0900",
        "Message-ID: <synthetic@example.invalid>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        text,
      ].join("\r\n"),
    );
  }

  /** A forwarded copy whose outer headers carry a value that must not be kept. */
  function forwarded(inner: Uint8Array): Uint8Array {
    const boundary = "forwarded-message";
    return new TextEncoder().encode(
      [
        "From: owner@example.invalid",
        "To: vpointpay@takuk.me",
        "Subject: Fwd: notification",
        `X-Synthetic-Session-Token: ${OUTER_TOKEN_SECRET}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary=${boundary}`,
        "",
        `--${boundary}`,
        "Content-Type: message/rfc822",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(inner).toString("base64"),
        `--${boundary}--`,
      ].join("\r\n"),
    );
  }

  async function compare(raw: Uint8Array, envelopeFrom: string) {
    const parsed = await parseVPointPayEmail(raw);
    if (!parsed) throw new Error("fixture_not_parsed");
    const legacy = legacyBucket();
    const stored = await storeVPointPayEmail({
      bucket: legacy.bucket,
      parsed,
      envelopeFrom,
      ...ENVELOPE,
    });
    const legacyEml = legacy.puts.find((put) => put.key === stored.rawKey)!.bytes;
    const legacyJson = legacy.puts.find((put) => put.key === stored.normalizedKey)!.bytes;
    expect(legacy.puts).toHaveLength(2);

    const prepared = await prepareVPointPayEmail({ parsed, envelopeFrom, ...ENVELOPE });
    const shared = new FakeR2Bucket();
    const result = await persistVPointPayEmailRun(shared, prepared, PRODUCER_VERSION);
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") throw new Error(result.outcome);
    const byKey = new Map(result.manifest.artifacts.map((entry) => [entry.artifactKey, entry]));
    const eml = byKey.get("notification.eml")!;
    const json = byKey.get("normalized-event.json")!;
    const sharedEml = await sharedBytes(shared, eml.storageRef.key);
    const sharedJson = await sharedBytes(shared, json.storageRef.key);
    expect(sharedEml).toEqual(legacyEml);
    expect(sharedJson).toEqual(legacyJson);
    expect(await sha256Hex(legacyEml)).toBe(eml.sha256);
    expect(await sha256Hex(legacyJson)).toBe(json.sha256);
    expect(result.manifest.runId).toBe(stored.event.id);
    const terminal = await sharedBytes(shared, terminalKey("v-point-pay-email", stored.event.id));
    return { legacyEml, sharedEml, sharedJson, terminal, prepared };
  }

  test("a directly delivered notification is stored identically on both targets", async () => {
    const raw = notification("◇利用金額：1円");
    const { legacyEml } = await compare(raw, "info@prepaid.smbc-card.com");
    expect(legacyEml).toEqual(raw);
  });

  test("a forwarded notification keeps only the inner message the legacy path keeps", async () => {
    const inner = notification(
      "◇取引内容：Vポイントからチャージ\r\n◇チャージ金額：500円",
      "【VポイントPay】チャージ受付のお知らせ",
    );
    const outer = forwarded(inner);
    const { legacyEml, sharedEml, sharedJson, terminal, prepared } = await compare(
      outer,
      "owner@example.invalid",
    );
    // Legacy strips the wrapper; shared persists exactly that stripped form.
    expect(prepared.delivery).toBe("forwarded-rfc822");
    expect(legacyEml).toEqual(inner);
    expect(legacyEml.byteLength).toBeLessThan(outer.byteLength);
    for (const [where, bytes] of [
      ["notification.eml", sharedEml],
      ["normalized-event.json", sharedJson],
      ["the terminal", terminal],
    ] as const) {
      assertAbsent(bytes, [OUTER_TOKEN_SECRET], where);
    }
  });
});
