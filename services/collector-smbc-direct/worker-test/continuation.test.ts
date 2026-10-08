import { env } from "cloudflare:test";
import { artifactDataset } from "../../../packages/application/src/collection/descriptors";
import { describe, expect, it } from "vitest";
import {
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import {
  dataBucket,
  manifestBytes,
  persistBackfillRun,
  persistSharedRun,
  readStagedArtifacts,
} from "../src/shared-collection";
import { runPrefix, storeBytes, storeJson } from "../src/storage";
import { monthRanges } from "../src/dates";
import type { BackfillManifest, StoredArtifact } from "../src/types";

const STARTED = "2099-01-01T00:00:00.000Z";
async function month(prefix: string, number: number): Promise<StoredArtifact[]> {
  const mm = String(number).padStart(2, "0");
  const range = monthRanges(
    "2099-" + mm + "-01",
    number === 4 ? "2099-04-28" : "2099-" + mm + "-" + (number === 2 ? "28" : "31"),
  )[0]!;
  const base =
    prefix +
    "/transactions/" +
    range.start.replaceAll("-", "") +
    "-" +
    range.end.replaceAll("-", "");
  const raw = await storeBytes({
    bucket: env.DATA,
    key: base + ".raw.json.sjis",
    bytes: new TextEncoder().encode('{"rows":[]}'),
    mediaType: "application/json",
    artifact: { dataset: "transactions-raw", range, transactionCount: 0 },
  });
  const normalized = await storeJson({
    bucket: env.DATA,
    key: base + ".normalized.json",
    value: { range, transactions: [] },
    artifact: { dataset: "transactions-normalized", range, transactionCount: 0 },
  });
  return [raw, normalized];
}
function manifest(
  runId: string,
  artifacts: StoredArtifact[],
  completed: number,
  success = false,
): BackfillManifest {
  return {
    schemaVersion: "smbc-direct-backfill-worker-poc-v2",
    source: "smbc-direct",
    runId,
    startedAt: STARTED,
    completedAt: "2099-01-01T00:0" + completed + ":00.000Z",
    status: success ? "success" : "partial",
    requestedRange: { start: "2099-01-01", end: "2099-04-28" },
    completedChunks: completed,
    totalChunks: 4,
    transactionCount: 0,
    artifacts,
    failureCodes: success ? [] : ["session_missing"],
    logoutSucceeded: success,
  };
}
async function input(value: BackfillManifest, session = "synthetic-session") {
  return {
    manifest: value,
    manifestBytes: manifestBytes(value),
    prefix: runPrefix(STARTED, value.runId),
    bytesByKey: await readStagedArtifacts(dataBucket(env.DATA), value),
    identity: {
      attemptId: "old-synthetic-attempt",
      acquisitionSessionRef: "synthetic-initial-session",
      continuationSessionRef: session,
    },
  };
}

describe("SMBC resumed publication", () => {
  it("recovers a legacy partial terminal, spans three sessions and publishes each normalized chunk once", async () => {
    const run = "synthetic-resume-multi";
    const prefix = runPrefix(STARTED, run);
    const first = await month(prefix, 1);
    const bucket = dataBucket(env.DATA);
    await persistSharedRun(bucket, await input(manifest(run, first, 1)));
    const original = new Uint8Array(
      await (await env.DATA.get(terminalKey("smbc-direct", run)))!.arrayBuffer(),
    );
    const second = [...first, ...(await month(prefix, 2))];
    const mid = await persistBackfillRun(
      bucket,
      await input(manifest(run, second, 2), "synthetic-session-two"),
    );
    expect(mid.outcome).toBe("persisted");
    const all = [...second, ...(await month(prefix, 3)), ...(await month(prefix, 4))];
    const fullInput = await input(manifest(run, all, 4, true), "synthetic-session-three");
    const final = await persistBackfillRun(bucket, fullInput);
    expect(final.outcome).toBe("persisted");
    expect(final.waitingForHuman).toBe(false);
    const listed = await env.DATA.list({ prefix: "runs/smbc-direct/" + run });
    expect(listed.objects).toHaveLength(3);
    const keys: string[] = [];
    for (const object of listed.objects) {
      const id = object.key.slice("runs/smbc-direct/".length, -"/terminal.json".length);
      const read = await readTerminal(bucket, "smbc-direct", id);
      if (read.outcome !== "found") throw new Error("missing test terminal");
      expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
        outcome: "ok",
        problems: [],
      });
      for (const artifact of read.manifest.artifacts) {
        if (artifact.artifactKey.endsWith(".normalized.json")) {
          expect(artifactDataset("smbc-direct", artifact)).toBe("transactions-normalized");
        }
      }
      keys.push(
        ...read.manifest.artifacts
          .filter((a) => a.artifactKey.endsWith(".normalized.json"))
          .map((a) => a.artifactKey),
      );
      if (object.key === final.terminalKey) {
        expect(read.manifest.requestedScope.startValue).toBe("2099-03-01");
        expect(read.manifest.coverageStatus).toBe("complete");
        expect(read.manifest.acquisitionSessionRef).toBe("synthetic-session-three");
        const snapshot = read.manifest.artifacts.find(
          (a) => a.artifactKey === "backfill-manifest.json",
        )!;
        expect(
          new Uint8Array(await (await env.DATA.get(snapshot.storageRef.key))!.arrayBuffer()),
        ).toEqual(fullInput.manifestBytes);
      }
    }
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(
      new Uint8Array(await (await env.DATA.get(terminalKey("smbc-direct", run)))!.arrayBuffer()),
    ).toEqual(original);
    expect((await persistBackfillRun(bucket, fullInput)).outcome).toBe("already_persisted");
    expect((await env.DATA.list({ prefix: "runs/smbc-direct/" + run })).objects).toHaveLength(3);
  });

  it("retries a fresh publication without creating another terminal", async () => {
    const run = "synthetic-resume-idempotent";
    const value = await input(manifest(run, await month(runPrefix(STARTED, run), 1), 1));
    const bucket = dataBucket(env.DATA);
    expect((await persistBackfillRun(bucket, value)).outcome).toBe("persisted");
    expect((await persistBackfillRun(bucket, value)).outcome).toBe("already_persisted");
  });

  it("refuses loss or changed normalized evidence already published", async () => {
    const run = "synthetic-resume-drift";
    const prefix = runPrefix(STARTED, run);
    const first = await month(prefix, 1);
    const bucket = dataBucket(env.DATA);
    await persistBackfillRun(bucket, await input(manifest(run, first, 1)));
    const missing = await input(manifest(run, [], 1));
    await expect(persistBackfillRun(bucket, missing)).rejects.toThrow(
      "shared_published_normalized_changed",
    );
    const changed = await storeJson({
      bucket: env.DATA,
      key: first[1]!.key,
      value: { changed: true },
      artifact: { dataset: "transactions-normalized", range: first[1]!.range! },
    });
    await expect(
      persistBackfillRun(bucket, await input(manifest(run, [first[0]!, changed], 1))),
    ).rejects.toThrow("shared_published_normalized_changed");
    expect((await env.DATA.list({ prefix: "runs/smbc-direct/" + run })).objects).toHaveLength(1);
  });

  it("retains a previously published raw-only chunk as the input of a new normalization", async () => {
    const run = "synthetic-resume-raw-only";
    const pair = await month(runPrefix(STARTED, run), 1);
    const bucket = dataBucket(env.DATA);
    await persistBackfillRun(bucket, await input(manifest(run, [pair[0]!], 0)));
    const result = await persistBackfillRun(bucket, await input(manifest(run, pair, 1)));
    const id = result.terminalKey.slice("runs/smbc-direct/".length, -"/terminal.json".length);
    const read = await readTerminal(bucket, "smbc-direct", id);
    if (read.outcome !== "found") throw new Error("missing test terminal");
    const transform = read.manifest.transformations[0]!;
    expect(transform.inputArtifactKeys).toEqual(["transactions/20990101-20990131.raw.json.sjis"]);
    expect(
      read.manifest.artifacts.filter((a) => a.artifactKey.endsWith(".normalized.json")),
    ).toHaveLength(1);
    expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });
  });
  it("preserves a changed failure snapshot even when a fresh approval captured no new provider bytes", async () => {
    const run = "synthetic-resume-empty";
    const bucket = dataBucket(env.DATA);
    const first = await month(runPrefix(STARTED, run), 1);
    await persistBackfillRun(bucket, await input(manifest(run, first, 1)));
    const failed: BackfillManifest = {
      ...manifest(run, first, 1),
      completedAt: "2099-01-01T00:02:00.000Z",
      failureCodes: ["transactions_http_500"],
    };
    const saved = await input(failed, "synthetic-later-session");
    const result = await persistBackfillRun(bucket, saved);
    expect(result.outcome).toBe("persisted");
    const id = result.terminalKey.slice("runs/smbc-direct/".length, -"/terminal.json".length);
    const read = await readTerminal(bucket, "smbc-direct", id);
    if (read.outcome !== "found") throw new Error("missing test terminal");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.artifacts.filter((a) => a.unitKey === "account")).toHaveLength(0);
    expect(read.manifest.requestedScope.startValue).toBe("2099-02-01");
    const snapshot = read.manifest.artifacts.find(
      (a) => a.artifactKey === "backfill-manifest.json",
    )!;
    expect(
      new Uint8Array(await (await env.DATA.get(snapshot.storageRef.key))!.arrayBuffer()),
    ).toEqual(saved.manifestBytes);
    expect((await persistBackfillRun(bucket, saved)).outcome).toBe("already_persisted");
    expect((await env.DATA.list({ prefix: "runs/smbc-direct/" + run })).objects).toHaveLength(2);
  });

  it("pins a missing initial publication to the original session and refuses success without new evidence", async () => {
    const run = "synthetic-resume-provenance";
    const bucket = dataBucket(env.DATA);
    const first = await month(runPrefix(STARTED, run), 1);
    await persistBackfillRun(
      bucket,
      await input(manifest(run, first, 1), "synthetic-resumed-session"),
    );
    const read = await readTerminal(bucket, "smbc-direct", run);
    if (read.outcome !== "found") throw new Error("missing test terminal");
    expect(read.manifest.acquisitionSessionRef).toBe("synthetic-initial-session");
    await expect(
      persistBackfillRun(bucket, await input(manifest(run, first, 1, true))),
    ).rejects.toThrow("shared_success_without_new_evidence");
  });
});
