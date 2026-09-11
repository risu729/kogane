// Real-R2 semantics, in the Workers runtime.
//
// The in-memory fake in `test/` models create-only conditional writes; this
// suite checks the model against workerd's R2 implementation, because the
// terminal-last rule is only worth anything if `onlyIf: { etagDoesNotMatch:
// "*" }` really refuses to replace an existing object. The public Workers R2
// reference does not document the `"*"` wildcard, so the writer never relies
// on it alone: it HEADs first and, when the conditional put returns null,
// compares digests. Both halves are exercised here.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hexToBytes, nativeSha256Hex } from "../src/bucket";
import { sha256Hex } from "../src/digest";
import { objectKey, terminalKey } from "../src/keys";
import { listTerminals, readTerminal, verifyReferencedObjects } from "../src/reader";
import { persistRun } from "../src/writer";
import type { PersistArtifact, PersistRunPlan } from "../src/writer";
import type { TerminalRunFields } from "../src/manifest";

const SOURCE = "kogane-synthetic";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function artifact(artifactKey: string, text: string): Promise<PersistArtifact> {
  const bytes = bytesOf(text);
  return {
    artifactKey,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json",
    role: "provider_response",
    body: { kind: "bytes", bytes },
  };
}

function run(runId: string, overrides: Partial<TerminalRunFields> = {}): TerminalRunFields {
  return {
    source: SOURCE,
    producer: "example-collector",
    producerVersion: "example-collector-1.0.0",
    runId,
    attemptId: `attempt-${runId}`,
    requestedScope: { scopeKind: "full_snapshot", startValue: null, endValue: null, unitKeys: [] },
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
    providerOutcome: "success",
    coverageStatus: "unknown",
    persistenceComplete: true,
    units: [],
    ranges: [],
    reports: [],
    transformations: [],
    ...overrides,
  };
}

async function plan(runId: string, text: string): Promise<PersistRunPlan> {
  return { run: run(runId), artifacts: [await artifact("balance.json", text)] };
}

describe("R2 create-only writes in the Workers runtime", () => {
  it("refuses to replace an existing object with etagDoesNotMatch '*'", async () => {
    const key = "runs/kogane-synthetic/conditional/probe.json";
    const first = await env.DATA.put(key, bytesOf("first"), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    expect(first).not.toBeNull();
    const second = await env.DATA.put(key, bytesOf("second"), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    // Real R2 reports a failed precondition by returning null, not by throwing.
    expect(second).toBeNull();
    const stored = await env.DATA.get(key);
    expect(new TextDecoder().decode(new Uint8Array(await stored!.arrayBuffer()))).toBe("first");
    // Without the condition the same put would have replaced it.
    expect(await env.DATA.put(key, bytesOf("third"))).not.toBeNull();
  });

  it("rejects a body whose bytes do not match the declared sha256", async () => {
    const key = "runs/kogane-synthetic/conditional/checksum.json";
    const wrong = hexToBytes("00".repeat(32)).buffer as ArrayBuffer;
    await expect(env.DATA.put(key, bytesOf("payload"), { sha256: wrong })).rejects.toThrow();
    expect(await env.DATA.head(key)).toBeNull();
  });

  it("records a native sha256 for a declared single-part put", async () => {
    const bytes = bytesOf("native-checksum-probe");
    const digest = await sha256Hex(bytes);
    const key = objectKey(digest);
    const stored = await env.DATA.put(key, bytes.buffer.slice(0) as ArrayBuffer, {
      sha256: hexToBytes(digest).buffer as ArrayBuffer,
      customMetadata: { sha256: digest, byteSize: String(bytes.byteLength) },
    });
    expect(stored).not.toBeNull();
    expect(nativeSha256Hex(stored!)).toBe(digest);
  });

  it("persists a run, reads it back and verifies its objects through R2BucketLike", async () => {
    const runId = "2026-09-01T00-00-00-000Z";
    const persisted = await persistRun(env.DATA, await plan(runId, '{"synthetic":true}'));
    expect(persisted.outcome).toBe("persisted");
    if (persisted.outcome !== "persisted") throw new Error("unreachable");
    expect(persisted.terminalKey).toBe(terminalKey(SOURCE, runId));

    const read = await readTerminal(env.DATA, SOURCE, runId);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.terminalDigest).toBe(persisted.terminalDigest);
    expect(await verifyReferencedObjects(env.DATA, read.manifest)).toEqual({
      outcome: "ok",
      checked: 1,
      problems: [],
    });

    // G1-05 against real R2: the same run written again is a resend.
    const again = await persistRun(env.DATA, await plan(runId, '{"synthetic":true}'));
    expect(again.outcome).toBe("already_persisted");

    // G1-06 against real R2: a different manifest for the same run conflicts
    // and the stored terminal is untouched.
    const conflict = await persistRun(env.DATA, await plan(runId, '{"synthetic":"changed"}'));
    expect(conflict.outcome).toBe("conflict");
    if (conflict.outcome !== "conflict") throw new Error("unreachable");
    expect(conflict.storedDigest).toBe(persisted.terminalDigest);
    const after = await readTerminal(env.DATA, SOURCE, runId);
    if (after.outcome !== "found") throw new Error("unreachable");
    expect(after.terminalDigest).toBe(persisted.terminalDigest);
  });

  it("lists terminals from the real bucket with a bounded cursor scan", async () => {
    for (const runId of ["scan-b", "scan-a", "scan-c"]) {
      const result = await persistRun(env.DATA, await plan(runId, `{"run":"${runId}"}`));
      expect(result.outcome).toBe("persisted");
    }
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await listTerminals(env.DATA, {
        source: SOURCE,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...listed.terminals.map((ref) => ref.runId));
      cursor = listed.cursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    for (const runId of ["scan-a", "scan-b", "scan-c"]) expect(seen).toContain(runId);
  });
});
