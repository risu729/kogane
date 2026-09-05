import { describe, expect, test } from "bun:test";
import { parseSonyManifest } from "../src/sony";
import { parseSbiShinseiManifest } from "../src/sbi-shinsei";
import { failure as sonyFailure, SonyBankError } from "../../../poc/sony-bank-worker/src/diagnostics";
import { failure as shinseiFailure, BrowserCollectionError } from "../../../poc/sbi-shinsei-worker/src/diagnostics";
import { storeManifest as storeSonyManifest } from "../../../poc/sony-bank-worker/src/storage";
import { storeManifest as storeShinseiManifest } from "../../../poc/sbi-shinsei-worker/src/storage";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const common = { runId, startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:01.000Z", status: "failed" as const, artifacts: [] };

describe("collector diagnostic manifest compatibility", () => {
  test("Sony source R2 bytes retain CSV diagnostics and pass the unchanged central importer", async () => {
    const captured: Uint8Array[] = [];
    const prefix = `raw/sony-bank/2026/09/05/${runId}`;
    await storeSonyManifest({ bucket: bucket(captured), prefix, manifest: {
      ...common, schemaVersion: "sony-bank-worker-poc-v2", source: "sony-bank",
      window: { from: "2026-09-01", to: "2026-09-05" }, transactionCount: 0,
      failures: [sonyFailure("collect", new SonyBankError("EABA0600S1fE12:JPY", 500, 1))],
    } });
    const parsed = parseSonyManifest(captured[0]!, `${prefix}/manifest.json`);
    expect(parsed.failures[0]?.message).toContain("stage=history-csv");
    expect(parsed.failures[0]?.message).toContain("httpStatus=500");
    expect(Object.keys(parsed.failures[0]!).sort()).toEqual(["errorType", "message", "operation"]);
  });

  test("Shinsei source R2 bytes retain timeout diagnostics and pass the unchanged central importer", async () => {
    const captured: Uint8Array[] = [];
    const prefix = `raw/sbi-shinsei/2026/09/05/${runId}`;
    await storeShinseiManifest({ bucket: bucket(captured), prefix, manifest: {
      ...common, schemaVersion: "sbi-shinsei-worker-poc-v1", source: "sbi-shinsei", liveReadsEnabled: true,
      failures: [shinseiFailure("collect", new BrowserCollectionError("ui-login-response-timeout", true))],
    } });
    const parsed = parseSbiShinseiManifest(captured[0]!, `${prefix}/manifest.json`);
    expect(parsed.failures[0]?.message).toContain("stage=ui-login-response-timeout");
    expect(parsed.failures[0]?.message).toContain("authenticationAttempted=true");
    expect(Object.keys(parsed.failures[0]!).sort()).toEqual(["errorType", "message", "operation"]);
  });
});

function bucket(captured: Uint8Array[]): R2Bucket {
  return { put: async (key: string, bytes: Uint8Array, options: R2PutOptions) => {
    captured.push(bytes.slice());
    const digest = options.sha256 as Uint8Array;
    return { key, size: bytes.byteLength, checksums: { sha256: digest.slice().buffer } };
  } } as unknown as R2Bucket;
}
