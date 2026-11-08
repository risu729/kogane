import { afterEach, describe, expect, it, vi } from "vitest";
import { relayTcp } from "../src/worker";

const NativePair = WebSocketPair;
const active: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of active.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function tunnel(
  options: { network?: "tamia" | "cf-gateway"; writeFails?: boolean; autoCloseRead?: boolean } = {},
) {
  const pending: Promise<unknown>[] = [];
  const logs: Array<Record<string, unknown> & { level: string }> = [];
  const nativePairs: InstanceType<typeof NativePair>[] = [];
  for (const level of ["log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((line: unknown) =>
      logs.push({ ...JSON.parse(String(line)), level }),
    );
  class Peer extends EventTarget {
    accepted = false;
    sent: number[][] = [];
    closes: number[] = [];
    accept() {
      this.accepted = true;
    }
    send(bytes: Uint8Array) {
      this.sent.push([...bytes]);
    }
    close(code: number) {
      this.closes.push(code);
    }
  }
  let peer: Peer;
  class Pair {
    0: WebSocket;
    1: Peer;
    constructor() {
      const pair = new NativePair();
      pair[1].accept();
      nativePairs.push(pair);
      this[0] = pair[0];
      this[1] = peer = new Peer();
    }
  }
  vi.stubGlobal("WebSocketPair", Pair);
  let reader!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = controller;
    },
  });
  let writeCalls = 0,
    socketCloses = 0,
    writerCloses = 0;
  const written: number[][] = [];
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      writeCalls++;
      if (options.writeFails) throw new Error("private-upstream-write");
      written.push([...bytes]);
    },
    close() {
      writerCloses++;
    },
  });
  let open!: () => void, rejectOpen!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    open = resolve;
    rejectOpen = reject;
  });
  const socket = {
    readable,
    writable,
    opened,
    async close() {
      socketCloses++;
      if (options.autoCloseRead !== false) {
        try {
          reader.close();
        } catch {}
      }
    },
  };
  const connects: string[] = [];
  const env = {
    RELAY_TOKEN: "private-".repeat(8),
    MESH: {
      connect() {
        connects.push("tamia");
        return socket;
      },
    },
    CF_EGRESS: {
      connect() {
        connects.push("cf-gateway");
        return socket;
      },
    },
  };
  const request = new Request(
    `https://private-worker.test/tcp?host=challenges.cloudflare.com&port=443&network=${options.network ?? "tamia"}`,
    {
      headers: { upgrade: "websocket", authorization: `Bearer ${env.RELAY_TOKEN}` },
    },
  );
  const response = await relayTcp(
    request,
    env as unknown as Env,
    {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as ExecutionContext,
    new URL(request.url),
  );
  expect(response.status).toBe(101);
  expect(peer!.accepted).toBe(true);
  response.webSocket!.accept();
  const all = async () => {
    for (let index = 0; index < pending.length; index++) await pending[index];
  };
  active.push(async () => {
    try {
      reader.close();
    } catch {}
    await Promise.allSettled(pending);
    for (const pair of nativePairs) {
      try {
        pair[0].close(1000);
        pair[1].close(1000);
      } catch {}
    }
  });
  const terminal = () => {
    const result = logs.filter((entry) => entry.event === "globalpass-relay-closed");
    expect(result).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("private-");
    return result[0]!;
  };
  return {
    peer: peer!,
    reader,
    written,
    connects,
    open,
    rejectOpen,
    all,
    terminal,
    flushWrites: async () => {
      for (const promise of pending.slice(1)) await promise;
    },
    counts: () => ({ writeCalls, socketCloses, writerCloses }),
  };
}

describe("GLOBAL PASS Worker relay lifecycle", () => {
  it.each(["tamia", "cf-gateway"] as const)(
    "normal peer close logs one closed record over %s",
    async (network) => {
      const h = await tunnel({ network });
      h.open();
      await Promise.resolve();
      h.peer.dispatchEvent(new MessageEvent("message", { data: "abc" }));
      h.peer.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1, 2]).buffer }));
      await h.flushWrites();
      h.reader.enqueue(new Uint8Array([3, 4, 5]));
      await Promise.resolve();
      h.peer.dispatchEvent(new Event("close"));
      await h.all();
      expect(h.connects).toEqual([network]);
      expect(h.written).toHaveLength(2);
      expect(h.counts()).toMatchObject({ writerCloses: 1, socketCloses: 1 });
      expect(h.terminal()).toMatchObject({
        host: "turnstile",
        network,
        outcome: "peer-closed",
        level: "log",
        bytesUp: 5,
        bytesDown: 3,
      });
      expect(h.terminal().durationMs).toBeGreaterThanOrEqual(0);
      for (const key of ["errorType", "category", "httpStatus", "code"])
        expect(h.terminal()).not.toHaveProperty(key);
    },
  );
  it("upstream EOF closes the peer and logs upstream-closed once", async () => {
    const h = await tunnel();
    h.open();
    await Promise.resolve();
    h.reader.enqueue(new Uint8Array([1, 2, 3]));
    h.reader.close();
    await h.all();
    expect(h.peer.sent).toEqual([[1, 2, 3]]);
    expect(h.peer.closes).toEqual([1000]);
    expect(h.terminal()).toMatchObject({
      outcome: "upstream-closed",
      level: "log",
      bytesUp: 0,
      bytesDown: 3,
    });
  });
  it("a rejected socket.opened remains a connect failure", async () => {
    const h = await tunnel();
    h.rejectOpen(new Error("private-connect"));
    h.reader.error(new Error("private-read"));
    await h.all();
    expect(h.terminal()).toMatchObject({
      outcome: "upstream-connect-failed",
      level: "error",
      errorType: "Error",
      bytesUp: 0,
      bytesDown: 0,
    });
  });
  it("socket creation alone is not an opened upstream; the promise controls classification", async () => {
    const h = await tunnel();
    h.reader.error(new Error("private-before-open"));
    await h.all();
    expect(h.terminal()).toMatchObject({ outcome: "upstream-connect-failed", level: "error" });
  });
  it("a read failure after socket.opened resolves is a read failure", async () => {
    const h = await tunnel();
    h.open();
    await Promise.resolve();
    h.reader.error(new Error("private-after-open"));
    await h.all();
    expect(h.terminal()).toMatchObject({
      outcome: "upstream-read-failed",
      level: "error",
      errorType: "Error",
    });
  });
  it("a failed write closes with 1011, closes the socket, suppresses queued writes and logs once", async () => {
    const h = await tunnel({ writeFails: true });
    h.open();
    await Promise.resolve();
    h.peer.dispatchEvent(new MessageEvent("message", { data: "abc" }));
    h.peer.dispatchEvent(new MessageEvent("message", { data: "def" }));
    await h.all();
    expect(h.peer.closes[0]).toBe(1011);
    expect(h.counts()).toMatchObject({ writeCalls: 1, socketCloses: 1 });
    expect(h.terminal()).toMatchObject({
      outcome: "upstream-write-failed",
      level: "error",
      bytesUp: 0,
      bytesDown: 0,
      errorType: "Error",
    });
  });
  it("a read error after peer close is teardown at log level without error fields", async () => {
    const h = await tunnel({ autoCloseRead: false });
    h.open();
    await Promise.resolve();
    h.peer.dispatchEvent(new Event("close"));
    h.reader.error(new Error("private-after-peer-close"));
    await h.all();
    expect(h.terminal()).toMatchObject({
      outcome: "peer-closed",
      level: "log",
      bytesUp: 0,
      bytesDown: 0,
    });
    for (const key of ["errorType", "category", "httpStatus", "code"])
      expect(h.terminal()).not.toHaveProperty(key);
  });
});
