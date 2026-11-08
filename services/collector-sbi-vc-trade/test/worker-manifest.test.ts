// The collector manifest a shared-mode run stores in DATA names the objects
// DATA holds. The Durable Object runs end to end in Bun with the gateway
// answered by a synthetic fake; no provider is contacted and no real account
// value appears anywhere.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { objectKey, readTerminal } from "../../../packages/collection/src/index";
import { encryptSession } from "../src/crypto";
import type { SessionMaterial } from "../src/types";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { SbiVcSessionState } = await import("../src/worker");

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const SEED: SessionMaterial = {
  cookies: {
    vctBffSid: "synthetic-sid",
    jSessionId: "synthetic-jsession",
    awsAlbApp: ["app0", "app1", "app2", "app3"],
    awsAlb: "synthetic-alb",
    awsAlbCors: "synthetic-cors",
  },
  secureKey: "synthetic-secure",
};

/** One synthetic gateway answer per read; every paged list is one page long. */
function gateway(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = JSON.parse(String(init?.body)) as {
    event: string;
    data: Record<string, unknown>;
  };
  const paged = request.event === "executionList" || request.event === "getCashflowList";
  return Promise.resolve(
    Response.json({
      meta: { status: "OK", secureKey: "synthetic-next-secure", timestamp: "synthetic" },
      body: paged
        ? {
            list: [{ synthetic: request.event }],
            pageNumber: Number(request.data.pageNumber),
            pageSize: 30,
            totalNumOfPages: 1,
            totalSize: 1,
          }
        : { synthetic: request.event },
    }),
  );
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

async function collect() {
  const values = new Map<string, unknown>([["session", await encryptSession(SEED, KEY)]]);
  const state = {
    storage: {
      get: async (name: string) => values.get(name),
      put: async (name: string | Record<string, unknown>, value?: unknown) => {
        if (typeof name === "string") values.set(name, value);
        else for (const [field, item] of Object.entries(name)) values.set(field, item);
      },
      delete: async (name: string) => values.delete(name),
    },
    abort: () => undefined,
  } as unknown as DurableObjectState;
  const data = new FakeR2Bucket();
  for (const spy of [
    spyOn(globalThis, "fetch").mockImplementation(gateway as typeof fetch),
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ])
    restores.push(() => spy.mockRestore());
  const session = new SbiVcSessionState(state, {
    SESSION_ENCRYPTION_KEY: KEY,
    COLLECTOR_SCHEMA_VERSION: "sbi-vc-trade-worker-poc-v1",
    DATA: data,
  } as unknown as Env);
  const summary = await session.runCollection();
  return { summary, data };
}

describe("the stored collector manifest", () => {
  test("names the content-addressed object of every artifact, as the terminal does", async () => {
    const { summary, data } = await collect();
    expect(summary.status).toBe("success");
    const read = await readTerminal(data, "sbi-vc-trade", summary.runId);
    if (read.outcome !== "found") throw new Error("terminal missing");
    const manifestRef = read.manifest.artifacts.find(
      (entry) => entry.artifactKey === "manifest.json",
    )!.storageRef.key;
    const manifest = JSON.parse(new TextDecoder().decode(data.entries.get(manifestRef)!.bytes)) as {
      artifacts: { dataset: string; key: string; sha256: string; bytes: number }[];
    };
    const planned = read.manifest.artifacts.filter(
      (entry) => entry.artifactKey !== "manifest.json",
    );
    expect(manifest.artifacts).toHaveLength(6);
    expect(manifest.artifacts).toHaveLength(planned.length);
    for (const entry of manifest.artifacts) {
      const terminalEntry = planned.find(
        (candidate) => candidate.artifactKey === `${entry.dataset}.json`,
      );
      // Digest, size and key are those of the object DATA holds. Before the
      // key was content-addressed it named a run-prefix staging key that
      // shared mode never writes.
      expect(terminalEntry?.sha256).toBe(entry.sha256);
      expect(terminalEntry?.byteSize).toBe(entry.bytes);
      expect(entry.key).toBe(objectKey(entry.sha256));
      expect(terminalEntry?.storageRef.key).toBe(entry.key);
      expect(data.entries.get(entry.key)?.bytes.byteLength).toBe(entry.bytes);
    }
  });
});
