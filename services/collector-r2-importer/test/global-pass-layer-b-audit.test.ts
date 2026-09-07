import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import auditWorker from "../src/global-pass-layer-b-audit-worker";

describe("GLOBAL PASS aggregate-only R2 Layer B audit", () => {
  test("returns a bounded aggregate for a non-manifest object", async () => {
    const response = await auditWorker.fetch(request(), {
      GLOBAL_PASS_SNAPSHOTS: bucket({
        objects: [{ key: "raw/prestia-globalpass/artifact" }],
        truncated: false,
      }),
    });
    expect((await response.json()) as unknown).toEqual({
      schemaVersion: "global-pass-layer-b-aggregate-audit-v1",
      scannedObjectCount: 1,
      auditedManifestCount: 0,
      skippedObjectCount: 1,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
  });

  test("reduces strict validation failure and rejects unsafe cursors", async () => {
    const missing = {
      ...bucket({
        objects: [
          {
            key: "raw/prestia-globalpass/2099/01/01/123e4567-e89b-42d3-a456-426614174000/manifest.json",
          },
        ],
        truncated: false,
      }),
      get: async () => null,
    } as unknown as R2Bucket;
    const response = await auditWorker.fetch(request(), { GLOBAL_PASS_SNAPSHOTS: missing });
    expect(await response.json()).toMatchObject({
      failedManifestCount: 1,
      failureCode: "layer_a_contract_validation_failed",
    });
    const invalid = await auditWorker.fetch(request("bad cursor"), {
      GLOBAL_PASS_SNAPSHOTS: missing,
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as unknown).toEqual({ error: "cursor_invalid" });
  });

  test("the harness stays local, remote-read-only, and never deploys", () => {
    const script = readFileSync(
      new URL("../scripts/audit-global-pass-layer-b-r2.sh", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.audit-global-pass-layer-b.jsonc", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(script).toContain("wrangler dev");
    expect(script).toContain("--ip 127.0.0.1");
    expect(script).not.toMatch(/wrangler\s+deploy/u);
    expect(script).not.toMatch(/r2\s+object\s+(?:put|delete)/u);
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
    expect(config.r2_buckets).toEqual([
      {
        binding: "GLOBAL_PASS_SNAPSHOTS",
        bucket_name: "kogane-globalpass-collector-poc",
        remote: true,
      },
    ]);
  });
});

function request(cursor?: string): Request {
  return new Request("http://127.0.0.1/audit-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cursor === undefined ? {} : { cursor }),
  });
}

function bucket(result: {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}): R2Bucket {
  return {
    list: async (options: R2ListOptions) => {
      expect(options).toMatchObject({ prefix: "raw/prestia-globalpass/", limit: 1 });
      return result as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}
