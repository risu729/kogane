import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/sony-layer-b-audit-worker";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sony-bank/2026/09/07/${RUN_ID}/`;
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const WINDOW = { from: "2026-09-01", to: "2026-09-30" };
const FIXTURES = new URL(
  "../../../tests/fixtures/observation-pipeline/sony-bank-parser-boundaries/",
  import.meta.url,
);
const FOREIGN_CURRENCIES = [
  "usd",
  "eur",
  "gbp",
  "aud",
  "nzd",
  "cad",
  "chf",
  "hkd",
  "zar",
  "sek",
] as const;

describe("Sony Bank aggregate-only R2 Layer B audit", () => {
  test("strictly validates and parses a complete source run while returning aggregates only", async () => {
    const bucket = await completeBucket();
    const result = await auditWorker.fetch(auditRequest(), {
      SONY_SNAPSHOTS: bucket as unknown as R2Bucket,
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: "sony-bank-r2-layer-b-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "success",
      artifactCount: 15,
      expectedParserArtifactCount: 14,
      matchedArtifactCount: 14,
      parsedArtifactCount: 14,
      warningCount: 1,
      hasJsonCsvOverlap: true,
      hasEightDigitWalletOption: true,
      hasDefaultWalletSelection: true,
      hasAmbiguousWalletDirection: true,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("returns only a generic failure code when exact source metadata is tampered", async () => {
    const bucket = await completeBucket();
    const manifest = bucket.objects.get(MANIFEST_KEY)!;
    manifest.customMetadata.extra = "drift";
    const result = await auditWorker.fetch(auditRequest(), {
      SONY_SNAPSHOTS: bucket as unknown as R2Bucket,
    });
    const body = (await result.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      auditedManifestCount: 0,
      failedManifestCount: 1,
      failureCode: "contract_validation_failed",
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("the harness is local, remote-read-only, bounded, and never deploys or mutates R2", () => {
    const script = readFileSync(
      new URL("../scripts/audit-sony-layer-b-r2.sh", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-sony-layer-b.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).toContain("pages > 100000");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({
      account_id: "59ea63cc00914b30ca410b062ae2bb7f",
      workers_dev: false,
      preview_urls: false,
    });
    expect(config.r2_buckets).toEqual([
      {
        binding: "SONY_SNAPSHOTS",
        bucket_name: "kogane-sony-bank-collector-poc",
        remote: true,
      },
    ]);
  });
});

interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.body.byteLength,
      customMetadata: stored.customMetadata,
      httpMetadata: { contentType: stored.contentType },
      checksums: {},
      arrayBuffer: async () => stored.body.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    if (options.prefix === "raw/sony-bank/" && options.limit === 1) {
      return { objects: [{ key: MANIFEST_KEY }], truncated: false } as unknown as R2Objects;
    }
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort()
      .map((key) => ({ key }));
    return { objects, truncated: false } as unknown as R2Objects;
  }
}

async function completeBucket(): Promise<FakeBucket> {
  const bucket = new FakeBucket();
  const gross = new Uint8Array(readFileSync(new URL("gross-balance.json", FIXTURES)));
  const yen = new Uint8Array(readFileSync(new URL("yen-history-page-0001.json", FIXTURES)));
  const csv = new Uint8Array(readFileSync(new URL("yen-history.csv", FIXTURES)));
  const walletText = readFileSync(new URL("wallet-history-2026-09.html", FIXTURES), "utf8").replace(
    '<option value="20260831">前月</option>',
    "",
  );
  const wallet = encode(walletText);
  const emptyForeign = JSON.parse(new TextDecoder().decode(yen)) as Record<string, unknown>;
  emptyForeign.countCnt = 0;
  emptyForeign.returnCnt = 0;
  emptyForeign.transactionHistInfo = [];

  const entries: Array<{ dataset: string; filename: string; body: Uint8Array; mediaType: string }> =
    [
      {
        dataset: "gross-balance",
        filename: "gross-balance.json",
        body: gross,
        mediaType: "application/json",
      },
      {
        dataset: "yen-history-page-0001",
        filename: "yen-history-page-0001.json",
        body: yen,
        mediaType: "application/json",
      },
      { dataset: "yen-history-csv", filename: "yen-history.csv", body: csv, mediaType: "text/csv" },
      ...FOREIGN_CURRENCIES.map((currency) => ({
        dataset: `foreign-history-${currency}-page-0001`,
        filename: `foreign-history-${currency}-page-0001.json`,
        body: encode(JSON.stringify(emptyForeign)),
        mediaType: "application/json",
      })),
      {
        dataset: "wallet-history-202609",
        filename: "wallet-history-2026-09.html",
        body: wallet,
        mediaType: "text/html; charset=UTF-8",
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        body: encode(
          JSON.stringify({
            schemaVersion: "sony-bank-collection-summary-v2",
            window: WINDOW,
            transactionCount: 2,
            pageCount: 1,
            foreignCurrencyCount: 10,
            foreignTransactionCount: 0,
            foreignPageCount: 10,
            walletMonthCount: 1,
            cookieNames: ["SESSION"],
          }),
        ),
        mediaType: "application/json",
      },
    ];
  const artifacts = [];
  for (const entry of entries) {
    const sha256 = await digest(entry.body);
    const key = `${PREFIX}${entry.filename}`;
    bucket.objects.set(key, {
      body: entry.body,
      contentType: entry.mediaType,
      customMetadata: { dataset: entry.dataset, sha256 },
    });
    artifacts.push({
      dataset: entry.dataset,
      key,
      mediaType: entry.mediaType,
      sha256,
      bytes: entry.body.byteLength,
    });
  }
  const manifest = {
    schemaVersion: "sony-bank-worker-poc-v2",
    source: "sony-bank",
    runId: RUN_ID,
    startedAt: "2026-09-07T00:00:00.000Z",
    completedAt: "2026-09-07T00:01:00.000Z",
    status: "success",
    window: WINDOW,
    transactionCount: 2,
    artifacts,
    failures: [],
  };
  const manifestBody = encode(JSON.stringify(manifest));
  const manifestSha256 = await digest(manifestBody);
  bucket.objects.set(MANIFEST_KEY, {
    body: manifestBody,
    contentType: "application/json",
    customMetadata: {
      source: "sony-bank",
      status: "success",
      runId: RUN_ID,
      sha256: manifestSha256,
    },
  });
  return bucket;
}

function auditRequest(): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function digest(body: Uint8Array): Promise<string> {
  const copy = new Uint8Array(body);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function forbiddenFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => forbiddenFields(child, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const forbidden = /(?:^|_)(?:key|hash|sha256|body|value|amount|balance)(?:$|_)/iu;
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenFields(child, `${path}.${key}`),
  ]);
}
