import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { backfillMoneyForward } from "../src/worker";

const SECRET = `collector-r2-moneyforward.${"f".repeat(32)}`;

describe("MoneyForward backfill cursor", () => {
  test("encrypts versioned scan state and rejects tampering or key rotation", async () => {
    const env = environment(listBucket("opaque-scan"));
    const first = await backfillMoneyForward(env, undefined);
    expect(first).toMatchObject({
      source: "moneyforward-me",
      scannedObjectCount: 1,
      skippedManifestCount: 1,
      truncated: true,
    });
    const cursor = String(first.nextCursor);
    expect(cursor).toMatch(/^moneyforward-scan-v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,11800}$/u);
    const encodedParts = cursor.split(".").slice(1);
    expect(
      encodedParts.map((part) => Buffer.from(part!, "base64url").toString()).join(""),
    ).not.toContain("opaque-scan");
    const parts = cursor.split(".");
    parts[1] = `${parts[1]![0] === "a" ? "b" : "a"}${parts[1]!.slice(1)}`;
    await expect(backfillMoneyForward(env, parts.join("."))).rejects.toThrow("cursor_invalid");
    await expect(
      backfillMoneyForward(
        environment(listBucket("opaque-scan"), `collector-r2-moneyforward.${"e".repeat(32)}`),
        cursor,
      ),
    ).rejects.toThrow("cursor_invalid");
    await expect(
      backfillMoneyForward(env, "moneyforward-scan-v1.cGF5bG9hZA.c2lnbmF0dXJl"),
    ).rejects.toThrow("cursor_invalid");
    await expect(
      backfillMoneyForward(environment(listBucket("opaque-scan"), "invalid"), undefined),
    ).rejects.toThrow("cursor_configuration_invalid");
  });

  test("stops when an R2 cursor does not advance", async () => {
    const first = await backfillMoneyForward(environment(listBucket("opaque-scan")), undefined);
    const cursor = String(first.nextCursor);
    await expect(
      backfillMoneyForward(environment(listBucket("opaque-scan")), cursor),
    ).rejects.toThrow("prefix_cursor_did_not_advance");
  });

  test("continues across an empty truncated R2 page", async () => {
    const bucket = {
      list: async () => ({ objects: [], truncated: true, cursor: "opaque-next" }),
    } as unknown as R2Bucket;
    const page = await backfillMoneyForward(environment(bucket), undefined);
    expect(page).toMatchObject({
      scannedObjectCount: 0,
      importedManifestCount: 0,
      skippedManifestCount: 0,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      truncated: true,
    });
    expect(page.nextCursor).toMatch(
      /^moneyforward-scan-v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,11800}$/u,
    );
  });
});

function listBucket(cursor: string): R2Bucket {
  return {
    list: async (options: R2ListOptions) => {
      expect(options).toMatchObject({ prefix: "raw/moneyforward/", limit: 1 });
      return {
        objects: [{ key: "raw/moneyforward/2026/09/05/run/accounts.html" }],
        truncated: true,
        cursor,
      } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function environment(bucket: R2Bucket, secret = SECRET): Env {
  return {
    MONEYFORWARD_SNAPSHOTS: bucket,
    RAW_EVIDENCE_TOKEN_MONEYFORWARD: secret,
    ORIGIN_FINGERPRINT_KEY: "ab".repeat(32),
    IMPORTER_VERSION: "collector-r2-importer-v17",
    RAW_EVIDENCE: {} as Fetcher,
  } as unknown as Env;
}
