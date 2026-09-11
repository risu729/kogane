import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/myjcb-audit-worker";

const FIXTURE_ROOT = new URL(
  "../../../tests/fixtures/observation-pipeline/myjcb/2026-09-07/run-synthetic/",
  import.meta.url,
);

describe("MyJCB aggregate-only R2 Layer B audit", () => {
  test("validates and parses a complete anonymous collector-shaped run", async () => {
    const manifestBody = new Uint8Array(readFileSync(new URL("manifest.json", FIXTURE_ROOT)));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBody)) as Manifest;
    const prefix = `raw/myjcb/2026/09/07/${manifest.runId}/`;
    const manifestKey = `${prefix}manifest.json`;
    const objects = new Map<string, StoredObject>();
    for (const artifact of manifest.artifacts) {
      const body = new Uint8Array(
        readFileSync(new URL(artifact.key.slice(prefix.length), FIXTURE_ROOT)),
      );
      objects.set(
        artifact.key,
        stored(body, artifact.mediaType, {
          source: "myjcb",
          dataset: artifact.dataset,
          sha256: artifact.sha256,
          ...(artifact.statementState ? { statementState: artifact.statementState } : {}),
          ...(artifact.period ? { period: artifact.period } : {}),
        }),
      );
    }
    objects.set(
      manifestKey,
      stored(manifestBody, "application/json", {
        source: "myjcb",
        status: manifest.status,
        runId: manifest.runId,
      }),
    );
    const response = await auditWorker.fetch(auditRequest(), {
      MYJCB_SNAPSHOTS: fakeBucket(objects, manifestKey),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: "myjcb-r2-layer-b-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 1,
      failedManifestCount: 0,
      manifestStatus: "success",
      artifactCount: 7,
      matchedArtifactCount: 7,
      parsedArtifactCount: 7,
      transactionObservationCount: 3,
      metricObservationCount: 2,
      hasMultipleConnections: false,
      hasNonEmptyLedger: true,
      hasDisplayedPastMonth: true,
    });
    expect(forbiddenFields(body)).toEqual([]);
  });

  test("is local, remote-read-only, and never deploys or mutates R2", () => {
    const script = readFileSync(new URL("../scripts/audit-myjcb-r2.sh", import.meta.url), "utf8");
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-myjcb.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    expect(config.r2_buckets).toEqual([
      {
        binding: "MYJCB_SNAPSHOTS",
        bucket_name: "kogane-myjcb-collector-poc",
        remote: true,
      },
    ]);
  });
});

interface ManifestArtifact {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  statementState?: string;
  period?: string;
}

interface Manifest {
  runId: string;
  status: "success" | "partial" | "failed";
  artifacts: ManifestArtifact[];
}

interface StoredObject {
  body: Uint8Array;
  size: number;
  httpMetadata: { contentType: string };
  customMetadata: Record<string, string>;
}

function stored(
  body: Uint8Array,
  contentType: string,
  customMetadata: Record<string, string>,
): StoredObject {
  return { body, size: body.byteLength, httpMetadata: { contentType }, customMetadata };
}

function fakeBucket(objects: Map<string, StoredObject>, manifestKey: string): R2Bucket {
  return {
    get: async (key: string) => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        ...object,
        arrayBuffer: async () => object.body.slice().buffer,
      } as unknown as R2ObjectBody;
    },
    list: async (options: R2ListOptions) => {
      if (options.prefix === "raw/myjcb/" && options.limit === 1) {
        return { objects: [{ key: manifestKey }], truncated: false } as unknown as R2Objects;
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
