import { expect, test } from "bun:test";
import { inputFingerprint } from "../src/releases";
import { artifactMeta } from "../src/worker";

test("only Sony receives an explicitly open lower date bound", () => {
  const row = {
    id: 1,
    fetch_run_id: 1,
    source_id: "sony-bank",
    dataset: "yen-history-csv",
    artifact_key: "yen-history.csv",
    fetch_unit_key: "account",
    mime: "text/csv",
    fetched_at: "2099-04-03T00:00:00Z",
    sha256: "0".repeat(64),
    blob_key: "synthetic",
    byte_size: 1,
    window_start: null,
    window_end: "2099-04-02",
    run_status: "success" as const,
    run_failure_count: 0,
    unit_outcome: "success",
    unit_status: "success" as const,
  };
  expect(artifactMeta(row)).toMatchObject({ retainedHistoryEnd: "2099-04-02" });
  expect(artifactMeta(row).runWindow).toBeUndefined();
  expect(artifactMeta({ ...row, source_id: "paypay" })).not.toHaveProperty("retainedHistoryEnd");
  expect(artifactMeta({ ...row, source_id: "paypay" }).runWindow).toBeUndefined();
  expect(artifactMeta({ ...row, window_end: null }).runWindow).toBeUndefined();
  expect(artifactMeta({ ...row, window_start: "" })).not.toHaveProperty("retainedHistoryEnd");
  expect(artifactMeta({ ...row, window_start: "2099-04-01" }).runWindow).toEqual({
    from: "2099-04-01",
    to: "2099-04-02",
  });
});

test("the explicit retained end participates in the parser input fingerprint", async () => {
  const meta = {
    id: 1,
    sourceId: "sony-bank",
    runStatus: "success" as const,
    runFailureCount: 0,
    dataset: "yen-history-csv",
    mime: "text/csv",
    url: null,
    fetchedAt: "2099-04-03T00:00:00Z",
    sha256: "0".repeat(64),
    retainedHistoryEnd: "2099-04-02",
  };
  const input = { rawSha256: meta.sha256, manifestDigest: "1".repeat(64), meta };
  expect(await inputFingerprint(input)).toBe(await inputFingerprint(input));
  expect(await inputFingerprint(input)).not.toBe(
    await inputFingerprint({ ...input, meta: { ...meta, retainedHistoryEnd: "2099-04-01" } }),
  );
  const withoutEnd = { ...meta } as Partial<typeof meta>;
  delete withoutEnd.retainedHistoryEnd;
  expect(await inputFingerprint(input)).not.toBe(
    await inputFingerprint({ ...input, meta: withoutEnd as typeof meta }),
  );
});
