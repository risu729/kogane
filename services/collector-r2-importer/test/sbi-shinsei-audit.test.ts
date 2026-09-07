import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/sbi-shinsei-audit-worker";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sbi-shinsei/2026/09/07/${RUN_ID}/`;
const FIXTURE_ROOT = new URL(
  "../../../poc/observation-pipeline/fixtures/sbi-shinsei-parser-boundaries/",
  import.meta.url,
);
const FILENAMES = {
  "top-accounts-balance-and-activity": "raw-top-accounts-balance-and-activity.json",
  "balance-summary-and-stage": "raw-balance-summary-and-stage.json",
  "exchange-rate": "raw-exchange-rate.json",
  "yen-deposit-account": "raw-yen-deposit-account.json",
  normalized: "normalized.json",
} as const;

describe("SBI Shinsei aggregate-only R2 Layer B audit", () => {
  test("validates every success artifact, parses only semantic routes, and emits aggregates", async () => {
    const payloads: Record<keyof typeof FILENAMES, Uint8Array> = {
      "top-accounts-balance-and-activity": withToken("top-accounts-balance-and-activity"),
      "balance-summary-and-stage": encode({
        responseParam: {
          summary: { responseParam: {} },
          category: { responseParam: {} },
          branchFetch: { responseParam: {} },
        },
        header: { adapterResultCode: "0", newToken: "SYNTHETIC" },
      }),
      "exchange-rate": encode({
        responseParam: {
          exchangeRateInformation: { responseParam: { exchangeRates: [] } },
        },
        header: { adapterResultCode: "0", newToken: "SYNTHETIC" },
      }),
      "yen-deposit-account": withToken("yen-deposit-account"),
      normalized: encode({
        schemaVersion: "sbi-shinsei-v1",
        capturedAt: "2026-09-07T00:02:00.000Z",
        balances: [],
        transactions: [],
      }),
    };
    const objects = new Map<string, StoredObject>();
    const artifacts = [];
    for (const dataset of Object.keys(FILENAMES) as (keyof typeof FILENAMES)[]) {
      const bytes = payloads[dataset];
      const key = `${PREFIX}${FILENAMES[dataset]}`;
      objects.set(key, stored(bytes));
      artifacts.push({
        dataset,
        key,
        mediaType: "application/json",
        sha256: await digest(bytes),
        bytes: bytes.byteLength,
      });
    }
    const manifestKey = `${PREFIX}manifest.json`;
    objects.set(
      manifestKey,
      stored(
        encode({
          schemaVersion: "sbi-shinsei-worker-poc-v1",
          source: "sbi-shinsei",
          runId: RUN_ID,
          startedAt: "2026-09-07T00:00:00.000Z",
          completedAt: "2026-09-07T00:02:00.000Z",
          status: "success",
          liveReadsEnabled: true,
          artifacts,
          failures: [],
        }),
      ),
    );
    const response = await auditWorker.fetch(auditRequest(), {
      SBI_SHINSEI_SNAPSHOTS: fakeBucket(objects, manifestKey),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: "sbi-shinsei-r2-layer-b-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "success",
      artifactCount: 5,
      matchedArtifactCount: 2,
      parsedArtifactCount: 2,
      decisionCoveredArtifactCount: 5,
      hasNonEmptyTopAccounts: true,
      hasNonEmptyTopActivity: true,
      hasNonEmptyYenAccounts: true,
      hasMultipleCurrencies: true,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("the harness is local, remote-read-only, and never deploys or mutates R2", () => {
    const script = readFileSync(
      new URL("../scripts/audit-sbi-shinsei-r2.sh", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-sbi-shinsei.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    expect(config.r2_buckets).toEqual([
      {
        binding: "SBI_SHINSEI_SNAPSHOTS",
        bucket_name: "kogane-sbi-shinsei-collector-poc",
        remote: true,
      },
    ]);
  });
});

interface StoredObject {
  body: Uint8Array;
  size: number;
  httpMetadata: { contentType: string };
}
function stored(body: Uint8Array): StoredObject {
  return {
    body,
    size: body.byteLength,
    httpMetadata: { contentType: "application/json" },
  };
}
function fakeBucket(objects: Map<string, StoredObject>, manifestKey: string): R2Bucket {
  return {
    get: async (key: string) => {
      const object = objects.get(key);
      return object
        ? ({
            ...object,
            arrayBuffer: async () => object.body.slice().buffer,
          } as unknown as R2ObjectBody)
        : null;
    },
    list: async (options: R2ListOptions) => {
      if (options.prefix === "raw/sbi-shinsei/" && options.limit === 1)
        return {
          objects: [{ key: manifestKey }],
          truncated: false,
        } as unknown as R2Objects;
      const entries = [...objects.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .sort()
        .map((key) => ({ key }));
      return { objects: entries, truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}
function auditRequest(): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}
function withToken(name: string): Uint8Array {
  const value = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_ROOT), "utf8")) as Record<
    string,
    unknown
  >;
  value["header"] = {
    ...(value["header"] as Record<string, unknown>),
    newToken: "SYNTHETIC",
  };
  return encode(value);
}
function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
async function digest(body: Uint8Array): Promise<string> {
  const copy = new Uint8Array(body);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function forbiddenFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((child, index) => forbiddenFields(child, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  const forbidden = /(?:^|_)(?:key|hash|sha256|body|value|amount|balance)(?:$|_)/iu;
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenFields(child, `${path}.${key}`),
  ]);
}
