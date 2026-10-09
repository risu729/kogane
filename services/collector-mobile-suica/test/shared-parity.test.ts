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

    const html = result.manifest.artifacts.find(
      (entry) => entry.artifactKey === "sf-history-page-0001.html",
    )!;
    expect(Buffer.from(legacyByName.get(html.artifactKey)!).toString("latin1")).toContain(
      REDACTED_BASE_VARIABLE,
    );
    expect(html.role).toBe("sanitized_provider_capture");
  });

  test("keeps a successful transport partial when the history boundary is unproven", async () => {
    const shared = new FakeR2Bucket();
    const runId = crypto.randomUUID();
    const result = await persistMobileSuicaRun(shared, {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:30.000Z",
      status: "success",
      asOfDateJst: "2026-09-11",
      complete: false,
      artifacts: [
        {
          dataset: "collection-summary",
          filename: "collection-summary.json",
          mediaType: "application/json",
          body: JSON.stringify({ transactionCount: 100, complete: false }),
        },
      ],
      failureCodes: [],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;
    expect(result.manifest.providerOutcome).toBe("success");
    expect(result.manifest.coverageStatus).toBe("partial");
    expect(result.manifest.safeErrorCode).toBeUndefined();
    expect(result.manifest.units.map((unit) => unit.coverageStatus)).toEqual(["partial"]);
  });

  test("persists a 99-row January page as a complete single page", async () => {
    const collection = await collectJanuaryBoundary(91);
    expect(collection.rows).toHaveLength(99);
    // complete is this page's row count under 100.
    expect(collection.complete).toBe(true);
    expect(collection.pageCount).toBe(1);
    expect(collection.artifacts).toHaveLength(3);
    expect(collection.artifacts.map((artifact) => artifact.filename)).toEqual([
      "sf-history-page-0001.html",
      "sf-history.json",
      "collection-summary.json",
    ]);
    const history = jsonObject(artifactBody(collection.artifacts, "sf-history.json"));
    const historyRows = rowDates(history.rows);
    expect(history.transactionCount).toBe(99);
    expect(historyRows).toHaveLength(99);
    expect(history.complete).toBe(true);
    expect(history.pageCount).toBe(1);
    expect(history.asOfDateJst).toBe("2026-01-15");
    expect(historyRows.filter((date) => date === "2026-01-14")).toHaveLength(2);
    expect(historyRows.filter((date) => date === "2025-12-31")).toHaveLength(2);
    expect(history.transactionCount).toBe(collection.rows.length);
    expect(history.complete).toBe(collection.complete);
    const summary = jsonObject(artifactBody(collection.artifacts, "collection-summary.json"));
    expect(summary.transactionCount).toBe(99);
    expect(summary.complete).toBe(true);
    expect(summary.pageCount).toBe(1);
    expect(summary.asOfDateJst).toBe("2026-01-15");
    expect(summary.transactionCount).toBe(collection.rows.length);
    expect(summary.complete).toBe(collection.complete);

    const runId = crypto.randomUUID();
    const result = await persistMobileSuicaRun(new FakeR2Bucket(), {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:30.000Z",
      status: "success",
      asOfDateJst: "2026-01-15",
      complete: true,
      artifacts: collection.artifacts,
      failureCodes: [],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;
    expect(result.manifest.providerOutcome).toBe("success");
    expect(result.manifest.coverageStatus).toBe("complete");
    expect(result.manifest.safeErrorCode).toBeUndefined();
    expect(result.manifest.artifacts).toHaveLength(3);
    expect(result.objects).toHaveLength(3);
    expect(result.manifest.units).toHaveLength(1);
    const unit = result.manifest.units[0]!;
    expect(unit.unitKey).toBe("account");
    expect(unit.artifactCount).toBe(3);
    expect(unit.coverageStatus).toBe("complete");
    expect(unit.safeErrorCode).toBeUndefined();
  });

  test("persists a 100-row January page as partial when the history boundary is unproven", async () => {
    const collection = await collectJanuaryBoundary(92);
    expect(collection.rows).toHaveLength(100);
    expect(collection.complete).toBe(false);
    expect(collection.pageCount).toBe(1);
    expect(collection.artifacts).toHaveLength(3);
    expect(collection.artifacts.map((artifact) => artifact.filename)).toEqual([
      "sf-history-page-0001.html",
      "sf-history.json",
      "collection-summary.json",
    ]);
    const history = jsonObject(artifactBody(collection.artifacts, "sf-history.json"));
    const historyRows = rowDates(history.rows);
    expect(history.transactionCount).toBe(100);
    expect(historyRows).toHaveLength(100);
    expect(history.complete).toBe(false);
    expect(history.pageCount).toBe(1);
    expect(history.asOfDateJst).toBe("2026-01-15");
    expect(historyRows.filter((date) => date === "2026-01-14")).toHaveLength(2);
    expect(historyRows.filter((date) => date === "2025-12-31")).toHaveLength(2);
    expect(history.transactionCount).toBe(collection.rows.length);
    expect(history.complete).toBe(collection.complete);
    const summary = jsonObject(artifactBody(collection.artifacts, "collection-summary.json"));
    expect(summary.transactionCount).toBe(100);
    expect(summary.complete).toBe(false);
    expect(summary.pageCount).toBe(1);
    expect(summary.asOfDateJst).toBe("2026-01-15");
    expect(summary.transactionCount).toBe(collection.rows.length);
    expect(summary.complete).toBe(collection.complete);

    const runId = crypto.randomUUID();
    const result = await persistMobileSuicaRun(new FakeR2Bucket(), {
      runId,
      producerVersion: PRODUCER_VERSION,
      attemptId: `attempt-${runId}`,
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:30.000Z",
      status: "partial",
      asOfDateJst: "2026-01-15",
      complete: false,
      artifacts: collection.artifacts,
      failureCodes: ["history_boundary_unproven"],
    });
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") return;
    expect(result.manifest.providerOutcome).toBe("partial");
    expect(result.manifest.coverageStatus).toBe("partial");
    expect(result.manifest.safeErrorCode).toBe("history_boundary_unproven");
    expect(result.manifest.artifacts).toHaveLength(3);
    expect(result.objects).toHaveLength(3);
    expect(result.manifest.units).toHaveLength(1);
    const unit = result.manifest.units[0]!;
    expect(unit.unitKey).toBe("account");
    expect(unit.artifactCount).toBe(3);
    expect(unit.coverageStatus).toBe("partial");
    expect(unit.safeErrorCode).toBe("history_boundary_unproven");
  });
});

function januaryBoundaryPage(julyCount: number): Uint8Array {
  const monthDays = [
    ...Array.from({ length: 2 }, () => "01/14"),
    ...Array.from({ length: 2 }, () => "01/01"),
    ...Array.from({ length: 2 }, () => "12/31"),
    ...Array.from({ length: 2 }, () => "12/01"),
    ...Array.from({ length: julyCount }, () => "07/20"),
  ];
  const rows = monthDays
    .map(
      (monthDay) =>
        `<tr><td><input name="printCheck"></td><td>${monthDay}</td><td>物販</td><td>店舗</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr>`,
    )
    .join("");
  const html = [
    "<html><body>利用履歴<form>",
    `<input type="hidden" name="baseVariable" value="${BASE_VARIABLE_SECRET}">`,
    '<input type="hidden" name="specifyYearMonth" value="2026/01">',
    "<table><tr><td></td><td>月日</td><td>種別</td><td>利用場所</td><td>種別</td><td>利用場所</td><td>残高</td><td>入金・利用額</td></tr>",
    rows,
    "</table></form></body></html>",
  ].join("");
  return new Uint8Array(encode(html, "shift_jis"));
}

async function collectJanuaryBoundary(julyCount: number) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(januaryBoundaryPage(julyCount).buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "text/html; charset=shift_jis" },
    })) as typeof fetch;
  try {
    return await collectMobileSuica({
      session: {
        cookieHeader: `ASP.NET_SessionId=${COOKIE_SECRETS[0]}; sc_auth=${COOKIE_SECRETS[1]}; TS0184138d=${COOKIE_SECRETS[2]}`,
        formBody: `baseVariable=${BASE_VARIABLE_SECRET}&specifyYearMonth=2026%2F09`,
        userAgent: "synthetic-agent",
        capturedAt: "2026-09-11T00:00:00.000Z",
      },
      asOfDateJst: "2026-01-15",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function artifactBody(
  artifacts: readonly { filename: string; body: string | Uint8Array }[],
  filename: string,
): string | Uint8Array {
  const artifact = artifacts.find((entry) => entry.filename === filename);
  if (!artifact) throw new Error(`missing artifact ${filename}`);
  return artifact.body;
}

function jsonObject(body: string | Uint8Array): {
  transactionCount: unknown;
  complete: unknown;
  pageCount: unknown;
  asOfDateJst: unknown;
  rows: unknown;
} {
  if (typeof body !== "string") throw new Error("expected a JSON string artifact");
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return {
    transactionCount: "transactionCount" in value ? value.transactionCount : undefined,
    complete: "complete" in value ? value.complete : undefined,
    pageCount: "pageCount" in value ? value.pageCount : undefined,
    asOfDateJst: "asOfDateJst" in value ? value.asOfDateJst : undefined,
    rows: "rows" in value ? value.rows : undefined,
  };
}

function rowDates(rows: unknown): string[] {
  if (!Array.isArray(rows)) throw new Error("sf-history rows are not an array");
  return rows.map((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("date" in row) ||
      typeof row.date !== "string"
    ) {
      throw new Error("sf-history row is missing date");
    }
    return row.date;
  });
}
