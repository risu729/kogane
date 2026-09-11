import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/sbi-shinsei-audit-worker";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = `raw/sbi-shinsei/2026/09/07/${RUN_ID}/`;
const FIXTURE_ROOT = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/",
  import.meta.url,
);
const FILENAMES = {
  "top-accounts-balance-and-activity": "raw-top-accounts-balance-and-activity.json",
  "balance-summary-and-stage": "raw-balance-summary-and-stage.json",
  "exchange-rate": "raw-exchange-rate.json",
  "yen-deposit-account": "raw-yen-deposit-account.json",
  normalized: "normalized.json",
} as const;
type Dataset = keyof typeof FILENAMES;

describe("SBI Shinsei aggregate-only R2 Layer B audit", () => {
  test("reuses the complete Layer A contract, parses success routes, and emits aggregates", async () => {
    const run = await successRun();
    const response = await auditWorker.fetch(auditRequest(), {
      SBI_SHINSEI_SNAPSHOTS: fakeBucket(run.objects, run.manifestKey),
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

  test("fails closed on size, metadata, native checksum, content type, and cross-artifact drift", async () => {
    const cases: ((run: Awaited<ReturnType<typeof successRun>>) => void | Promise<void>)[] = [
      (run) => {
        run.objects.get(run.manifestKey)!.size = 256 * 1024 + 1;
      },
      (run) => {
        run.objects.get(`${PREFIX}${FILENAMES["yen-deposit-account"]}`)!.customMetadata = {
          dataset: "yen-deposit-account",
          sha256: run.artifacts.find((item) => item.dataset === "yen-deposit-account")!.sha256,
          unknown: "drift",
        };
      },
      (run) => {
        run.objects.get(`${PREFIX}${FILENAMES["exchange-rate"]}`)!.checksums.sha256 =
          new Uint8Array(32).buffer;
      },
      (run) => {
        run.objects.get(`${PREFIX}${FILENAMES["balance-summary-and-stage"]}`)!.httpMetadata = {
          contentType: "application/json; charset=utf-8",
        };
      },
      (run) =>
        replacePayload(
          run,
          "normalized",
          encode({
            schemaVersion: "sbi-shinsei-v1",
            capturedAt: "2026-09-07T00:02:00.000Z",
            balances: [],
            transactions: [],
          }),
        ),
    ];
    for (const mutate of cases) {
      const run = await successRun();
      await mutate(run);
      const response = await auditWorker.fetch(auditRequest(), {
        SBI_SHINSEI_SNAPSHOTS: fakeBucket(run.objects, run.manifestKey),
      });
      expect(await response.json()).toMatchObject({
        auditedManifestCount: 0,
        failedManifestCount: 1,
        failureCode: "contract_validation_failed",
      });
    }
  });

  test("fails closed on double-prefixed inventory and a stagnant run cursor", async () => {
    const extra = await successRun();
    extra.objects.set(`${PREFIX}raw/sbi-shinsei/unexpected.json`, stored(encode({})));
    const extraResponse = await auditWorker.fetch(auditRequest(), {
      SBI_SHINSEI_SNAPSHOTS: fakeBucket(extra.objects, extra.manifestKey),
    });
    expect(await extraResponse.json()).toMatchObject({
      auditedManifestCount: 0,
      failedManifestCount: 1,
    });

    const stagnant = await successRun();
    const stagnantResponse = await auditWorker.fetch(auditRequest(), {
      SBI_SHINSEI_SNAPSHOTS: fakeBucket(stagnant.objects, stagnant.manifestKey, true),
    });
    expect(await stagnantResponse.json()).toMatchObject({
      auditedManifestCount: 0,
      failedManifestCount: 1,
    });
  });

  test("never invokes Layer B parsers for a partial or failed manifest", async () => {
    const top = withToken("top-accounts-balance-and-activity");
    const topValue = JSON.parse(new TextDecoder().decode(top)) as Record<string, unknown>;
    const activity = (
      (
        (topValue["responseParam"] as Record<string, unknown>)["activity"] as Record<
          string,
          unknown
        >
      )["responseParam"] as Record<string, unknown>
    )["activityDetails"] as Record<string, unknown>[];
    activity[1]!["txnReferenceNo"] = activity[0]!["txnReferenceNo"];
    const run = await buildRun({
      payloads: { "top-accounts-balance-and-activity": encode(topValue) },
      status: "partial",
      failures: [
        failure("read:balance-summary-and-stage"),
        failure("read:exchange-rate"),
        failure("read:yen-deposit-account"),
        failure("derive:normalized"),
      ],
    });
    const response = await auditWorker.fetch(auditRequest(), {
      SBI_SHINSEI_SNAPSHOTS: fakeBucket(run.objects, run.manifestKey),
    });
    expect(await response.json()).toMatchObject({
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "partial",
      matchedArtifactCount: 0,
      parsedArtifactCount: 0,
      decisionCoveredArtifactCount: 0,
    });

    const failed = await buildRun({
      payloads: {},
      status: "failed",
      failures: [{ operation: "collect", errorType: "SyntheticFailure", message: "failed" }],
    });
    const failedResponse = await auditWorker.fetch(auditRequest(), {
      SBI_SHINSEI_SNAPSHOTS: fakeBucket(failed.objects, failed.manifestKey),
    });
    expect(await failedResponse.json()).toMatchObject({
      auditedManifestCount: 1,
      manifestStatus: "failed",
      parsedArtifactCount: 0,
    });
  });

  test("the harness is local, bounded, remote-read-only, and never deploys or mutates R2", () => {
    const script = readFileSync(
      new URL("../scripts/audit-sbi-shinsei-r2.sh", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-sbi-shinsei.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).toContain("pages > 100000");
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

async function successRun() {
  return buildRun({
    payloads: {
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
        responseParam: { exchangeRateInformation: { responseParam: { exchangeRates: [] } } },
        header: { adapterResultCode: "0", newToken: "SYNTHETIC" },
      }),
      "yen-deposit-account": withToken("yen-deposit-account"),
      normalized: encode({
        schemaVersion: "sbi-shinsei-v1",
        capturedAt: "2026-09-07T00:02:00.000Z",
        balances: [
          {
            accountKey: "SYNTHETIC-001",
            product: "yen-savings",
            currency: "JPY",
            balance: "123456",
            yenEquivalent: "123456",
            asOf: "2026-09-07T00:02:00.000Z",
          },
          {
            accountKey: "SYNTHETIC-002",
            product: "foreign-savings",
            currency: "USD",
            balance: "12.3400",
            yenEquivalent: "9876",
            asOf: "2026-09-07T00:02:00.000Z",
          },
        ],
        transactions: [
          {
            accountKey: "SYNTHETIC-001",
            transactionDate: "2026-09-06",
            description: "Synthetic debit",
            debit: "1200",
            credit: null,
            balance: "122256",
            currency: "JPY",
          },
          {
            accountKey: "SYNTHETIC-001",
            transactionDate: "2026-09-07",
            description: "Synthetic credit",
            debit: null,
            credit: "2500",
            balance: "124756",
            currency: "JPY",
          },
        ],
      }),
    },
    status: "success",
    failures: [],
  });
}

async function buildRun(options: {
  payloads: Partial<Record<Dataset, Uint8Array>>;
  status: "success" | "partial" | "failed";
  failures: Record<string, unknown>[];
}) {
  const objects = new Map<string, StoredObject>();
  const artifacts: Array<{
    dataset: Dataset;
    key: string;
    mediaType: "application/json";
    sha256: string;
    bytes: number;
  }> = [];
  for (const dataset of Object.keys(FILENAMES) as Dataset[]) {
    const bytes = options.payloads[dataset];
    if (!bytes) continue;
    const key = `${PREFIX}${FILENAMES[dataset]}`;
    const sha256 = await digest(bytes);
    objects.set(key, stored(bytes, { dataset, sha256 }, sha256));
    artifacts.push({
      dataset,
      key,
      mediaType: "application/json",
      sha256,
      bytes: bytes.byteLength,
    });
  }
  const manifestKey = `${PREFIX}manifest.json`;
  const manifestBytes = encode({
    schemaVersion: "sbi-shinsei-worker-poc-v1",
    source: "sbi-shinsei",
    runId: RUN_ID,
    startedAt: "2026-09-07T00:00:00.000Z",
    completedAt: "2026-09-07T00:02:00.000Z",
    status: options.status,
    liveReadsEnabled: true,
    artifacts,
    failures: options.failures,
  });
  const manifestSha256 = await digest(manifestBytes);
  objects.set(
    manifestKey,
    stored(
      manifestBytes,
      { source: "sbi-shinsei", status: options.status, runId: RUN_ID, sha256: manifestSha256 },
      manifestSha256,
    ),
  );
  return { objects, manifestKey, artifacts };
}

async function replacePayload(
  run: Awaited<ReturnType<typeof buildRun>>,
  dataset: Dataset,
  body: Uint8Array,
): Promise<void> {
  const artifact = run.artifacts.find((item) => item.dataset === dataset)!;
  artifact.sha256 = await digest(body);
  artifact.bytes = body.byteLength;
  run.objects.set(
    artifact.key,
    stored(body, { dataset, sha256: artifact.sha256 }, artifact.sha256),
  );

  const currentManifest = run.objects.get(run.manifestKey)!;
  const manifest = JSON.parse(new TextDecoder().decode(currentManifest.body)) as Record<
    string,
    unknown
  >;
  manifest["artifacts"] = run.artifacts;
  const manifestBytes = encode(manifest);
  const manifestSha256 = await digest(manifestBytes);
  run.objects.set(
    run.manifestKey,
    stored(
      manifestBytes,
      {
        source: "sbi-shinsei",
        status: String(manifest["status"]),
        runId: RUN_ID,
        sha256: manifestSha256,
      },
      manifestSha256,
    ),
  );
}

interface StoredObject {
  body: Uint8Array;
  size: number;
  httpMetadata: { contentType: string };
  customMetadata?: Record<string, string>;
  checksums: { sha256?: ArrayBuffer };
}
function stored(
  body: Uint8Array,
  customMetadata?: Record<string, string>,
  nativeSha256?: string,
): StoredObject {
  return {
    body,
    size: body.byteLength,
    httpMetadata: { contentType: "application/json" },
    ...(customMetadata ? { customMetadata } : {}),
    checksums: { ...(nativeSha256 ? { sha256: hexBuffer(nativeSha256) } : {}) },
  };
}
function fakeBucket(
  objects: Map<string, StoredObject>,
  manifestKey: string,
  stagnantRunCursor = false,
): R2Bucket {
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
      if (options.prefix === "raw/sbi-shinsei/" && options.limit === 1) {
        return { objects: [{ key: manifestKey }], truncated: false } as unknown as R2Objects;
      }
      if (stagnantRunCursor && options.prefix === PREFIX) {
        return {
          objects: [],
          truncated: true,
          cursor: options.cursor ?? "SYNTHETIC-STAGNANT",
        } as unknown as R2Objects;
      }
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
  value["header"] = { ...(value["header"] as Record<string, unknown>), newToken: "SYNTHETIC" };
  return encode(value);
}
function failure(operation: string): Record<string, unknown> {
  return { operation, errorType: "NotAttempted", message: "not attempted" };
}
function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
async function digest(body: Uint8Array): Promise<string> {
  const copy = new Uint8Array(body);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function hexBuffer(value: string): ArrayBuffer {
  const result = new ArrayBuffer(value.length / 2);
  const bytes = new Uint8Array(result);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
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
