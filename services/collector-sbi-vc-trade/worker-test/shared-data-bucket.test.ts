// U09 (G1-01, G1-02, G3-07, G3-10, G3-11): the SBI VC Trade shared-mode run,
// in the Workers runtime against a real Miniflare R2 `DATA` bucket and the real
// session Durable Object.
//
// The Worker writes DATA only. It does not read a collection-target var, and
// the deployed configuration does not declare one.
import { env, applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readTerminal,
  runPrefix as terminalRunPrefix,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import { dataBucket, persistSharedRun } from "../src/shared-collection";
import type { CollectionManifest } from "../src/types";

const testEnv = env as Env & { SCHEDULE_TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.SCHEDULE_DB, testEnv.SCHEDULE_TEST_MIGRATIONS);
});

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const BODY = JSON.stringify({ meta: { status: "OK" }, body: { list: [], totalSize: "0" } });

function manifest(runId: string): CollectionManifest {
  return {
    schemaVersion: "sbi-vc-trade-worker-poc-v1",
    source: "sbi-vc-trade",
    runId,
    startedAt: "2026-09-01T21:05:00.000Z",
    completedAt: "2026-09-01T21:06:00.000Z",
    status: "success",
    artifacts: [
      {
        dataset: "cash-balances",
        key: `raw/sbi-vc-trade/2026/09/01/${runId}/cash-balances.json`,
        sha256: "a".repeat(64),
        bytes: BODY.length,
      },
    ],
    failures: [],
  };
}

describe("SBI VC Trade shared DATA bucket", () => {
  it("stores every object and the terminal last, and R2 can re-verify them", async () => {
    const bucket = dataBucket(env.DATA);
    const value = manifest(RUN_ID);
    const summary = await persistSharedRun(bucket, {
      manifest: value,
      manifestJson: JSON.stringify(value),
      captures: [{ dataset: "cash-balances", body: BODY }],
      identity: { attemptId: "attempt-0001", acquisitionSessionRef: "session-0001" },
    });
    expect(summary.outcome).toBe("persisted");
    expect(summary.terminalKey).toBe(terminalKey("sbi-vc-trade", RUN_ID));

    const read = await readTerminal(bucket, "sbi-vc-trade", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.acquisitionSessionRef).toBe("session-0001");
    expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });
  });

  it("a persistent uncertain lease blocks reauthentication, keepalive and collection", async () => {
    const stub = env.SESSION_STATE.getByName("uncertain-lease");
    const health = await stub.getHealth(),
      ref = crypto.randomUUID();
    await env.SCHEDULE_DB.prepare(
      "INSERT INTO collection_execution_leases(source,lease_ref,started_at) VALUES('sbi-vc-trade',?,?)",
    )
      .bind(ref, "2026-01-01T00:00:00.000Z")
      .run();
    try {
      // Catch inside the real native object: the runtime test plugin reports
      // RPC boundary rejections as unhandled even when the caller awaits them.
      const refusals = await runInDurableObject(stub, async (instance) => {
        const outcomes: string[] = [];
        for (const invoke of [
          () => instance.runReauthenticate(true),
          () => instance.runKeepAlive(),
          () => instance.runCollection(),
        ]) {
          try {
            await invoke();
            outcomes.push("unexpected_success");
          } catch (error) {
            outcomes.push(error instanceof Error ? error.message : "unexpected_error");
          }
        }
        return outcomes;
      });
      expect(refusals).toEqual([
        "collection_busy_or_uncertain",
        "collection_busy_or_uncertain",
        "collection_busy_or_uncertain",
      ]);
      expect(await stub.getHealth()).toEqual(health);
      expect(
        await env.SCHEDULE_DB.prepare(
          "SELECT lease_ref FROM collection_execution_leases WHERE source='sbi-vc-trade'",
        ).first<string>("lease_ref"),
      ).toBe(ref);
    } finally {
      await env.SCHEDULE_DB.prepare(
        "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL WHERE source='sbi-vc-trade' AND lease_ref=?",
      )
        .bind(ref)
        .run();
    }
  });

  it("records a collection blocked on re-authentication as a human-required failure", async () => {
    const stub = env.SESSION_STATE.getByName("blocked-run");
    // No passkey credential is bound in this runtime, so re-authentication
    // fails exactly as a revoked credential would. Nothing retries it.
    const health = await stub.runReauthenticate(true);
    expect(health.lastReauthErrorCode).not.toBeNull();

    const summary = await stub.recordBlockedCollection();
    expect(summary).not.toBeNull();
    if (!summary) throw new Error("unreachable");
    expect(summary.waitingForHuman).toBe(true);
    expect(summary.outcome).toBe("persisted");

    const runId = summary.terminalKey.slice(
      terminalRunPrefix("sbi-vc-trade").length,
      -"/terminal.json".length,
    );
    const read = await readTerminal(dataBucket(env.DATA), "sbi-vc-trade", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("human_required_reauth");
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual(["manifest.json"]);

    const stored = await env.DATA.get(read.manifest.artifacts[0]!.storageRef.key);
    const text = await stored!.text();
    expect(text).not.toContain("secureKey");
    expect(text).not.toContain("Cookie");
  });
});
