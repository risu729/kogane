// Sanitization parity between the two storage targets (unified plan U09, D12).
//
// The Mobile Suica history page is the one artifact a sanitizer rewrites
// before storage, so parity has three legs here, all on one synthetic page:
//
//   1. the real `collectMobileSuica` with a stubbed `fetch`, so the bytes are
//      what the collector produces, not hand-written ones;
//   2. the legacy `storeArtifact` into a memory bucket against the shared
//      `persistRun` into the contract's fake bucket, compared by digest;
//   3. the central importer's own `sanitizeHistoryHtml` (schema v2) over the
//      legacy bytes — what reaches the central store today — which must hand
//      back exactly the bytes the shared target persisted.
//
// The session cookies and the hidden `baseVariable` the collector was given are
// then searched for in every object and in the terminal (G3-07, G3-08).
import { describe, expect, test } from "bun:test";
import { encode } from "iconv-lite";
import { sha256Hex, terminalKey } from "../../../packages/collection/src/index";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { sanitizeHistoryHtml as importerSanitizeHistoryHtml } from "../../collector-r2-importer/src/mobile-suica";
import { collectMobileSuica } from "../src/mobile-suica";
import { REDACTED_BASE_VARIABLE } from "../src/sanitize";
import { persistMobileSuicaRun } from "../src/shared-run";
import { storeArtifact } from "../src/storage";

const PRODUCER_VERSION = "mobile-suica-worker-poc-v2";
const BASE_VARIABLE_SECRET = "synthetic-base-variable-session-secret";
const COOKIE_SECRETS = [
  "synthetic-aspnet-session-secret",
  "synthetic-sc-auth-secret",
  "synthetic-ts-cookie-secret",
];

interface LegacyPut {
  key: string;
  bytes: Uint8Array;
}

function legacyBucket(): { bucket: R2Bucket; puts: LegacyPut[] } {
  const puts: LegacyPut[] = [];
  const bucket = {
    put: async (key: string, body: string | Uint8Array) => {
      puts.push({ key, bytes: typeof body === "string" ? new TextEncoder().encode(body) : body });
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

/** A CP932 history page with the hidden session field and one synthetic row. */
function historyPage(): Uint8Array {
  const html = [
    "<html><body>利用履歴<form>",
    `<input type="hidden" name="baseVariable" value="${BASE_VARIABLE_SECRET}">`,
    '<input type="hidden" name="specifyYearMonth" value="2026/09">',
    "<table><tr><td></td><td>月日</td><td>種別</td><td>利用場所</td><td>種別</td><td>利用場所</td><td>残高</td><td>入金・利用額</td></tr>",
    '<tr><td><input name="printCheck"></td><td>09/10</td><td>物販</td><td>東京駅</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr>',
    "</table></form></body></html>",
  ].join("");
  return new Uint8Array(encode(html, "shift_jis"));
}

describe("mobile-suica: the shared target persists the legacy bytes (U09 parity, G1-02)", () => {
  test("the redacted page, its rows and the summary match on both targets and at the importer", async () => {
    const cookiesSeen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      cookiesSeen.push(new Headers(init?.headers).get("cookie") ?? "");
      // `historyPage()` is an exact-length copy, so its buffer is the page.
      return new Response(historyPage().buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "text/html; charset=shift_jis" },
      });
    }) as typeof fetch;
    let collection;
    try {
      collection = await collectMobileSuica({
        session: {
          cookieHeader: `ASP.NET_SessionId=${COOKIE_SECRETS[0]}; sc_auth=${COOKIE_SECRETS[1]}; TS0184138d=${COOKIE_SECRETS[2]}`,
          formBody: `baseVariable=${BASE_VARIABLE_SECRET}&specifyYearMonth=2026%2F09`,
          userAgent: "synthetic-agent",
          capturedAt: "2026-09-11T00:00:00.000Z",
        },
        asOfDateJst: "2026-09-11",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The secrets really were in play.
    expect(cookiesSeen).toHaveLength(1);
    expect(COOKIE_SECRETS.every((secret) => cookiesSeen[0]!.includes(secret))).toBe(true);
    expect(collection.rows).toHaveLength(1);
    expect(collection.complete).toBe(true);

    const runId = crypto.randomUUID();
    const legacy = legacyBucket();
    const legacyStored = [];
    for (const artifact of collection.artifacts) {
      legacyStored.push(
        await storeArtifact({
          bucket: legacy.bucket,
          prefix: `raw/mobile-suica/2026/09/11/${runId}`,
          runId,
          artifact,
        }),
      );
    }

    const shared = new FakeR2Bucket();
    const result = await persistMobileSuicaRun(shared, {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:30.000Z",
      status: "success",
      asOfDateJst: "2026-09-11",
      complete: collection.complete,
      artifacts: collection.artifacts,
      failureCodes: [],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;

    const secrets = [BASE_VARIABLE_SECRET, ...COOKIE_SECRETS];
    const legacyByName = new Map(legacy.puts.map((put) => [filename(put.key), put.bytes]));
    expect([...legacyByName.keys()].sort()).toEqual(
      result.manifest.artifacts.map((entry) => entry.artifactKey).sort(),
    );
    expect(legacyByName.size).toBe(3);
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
    assertAbsent(
      await sharedBytes(shared, terminalKey("mobile-suica", runId)),
      secrets,
      "the terminal",
    );

    // Leg 3: the importer's v2 sanitizer accepts the legacy page and forwards
    // it unchanged, so the central bytes today are the shared bytes tomorrow.
    const html = result.manifest.artifacts.find(
      (entry) => entry.artifactKey === "sf-history-page-0001.html",
    )!;
    const central = importerSanitizeHistoryHtml(
      legacyByName.get(html.artifactKey)!,
      "mobile-suica-worker-poc-v2",
    );
    expect(await sha256Hex(central)).toBe(html.sha256);
    expect(Buffer.from(central).toString("latin1")).toContain(REDACTED_BASE_VARIABLE);
    expect(html.role).toBe("sanitized_provider_capture");
  });
});
