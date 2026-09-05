import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { startTcpRelay } from "../src/tcp-relay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).forEach(restore => restore()); });
function harness(options: { cleanupRejects?: boolean; write?: () => Promise<void>; sendFails?: boolean; loggerThrows?: boolean; relayId?: string; connectThrows?: boolean; openFails?: boolean } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  for (const level of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, level).mockImplementation(value => {
      logs.push({ level, ...JSON.parse(String(value)) });
      if (options.loggerThrows) throw new Error("private-logger-body");
    });
    restores.push(() => spy.mockRestore());
  }
  class Peer extends EventTarget {
    sent: unknown[] = [];
    closeCodes: number[] = [];
    readyState = 1;
    send(value: unknown) { if (options.sendFails) throw new Error("private-send-body"); this.sent.push(value); }
    close(code: number) { this.readyState = 3; this.closeCodes.push(code); this.dispatchEvent(new Event("close")); }
    message(data: string | ArrayBuffer | Blob = new Uint8Array([1]).buffer) {
      const before = pending.length;
      this.dispatchEvent(new MessageEvent("message", { data }));
      return Promise.all(pending.slice(before));
    }
  }
  const peer = new Peer();
  const closed = deferred<void>();
  const opened = deferred<unknown>();
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  let closeCalls = 0;
  let writeCalls = 0;
  let connectCalls = 0;
  const written: Uint8Array[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { readableController = controller; },
    cancel() { if (options.cleanupRejects) throw new Error("private-cancel-body"); },
  });
  const writable = new WritableStream<Uint8Array>({
    async write(bytes) { writeCalls++; await options.write?.(); written.push(bytes.slice()); },
    abort() { if (options.cleanupRejects) throw new Error("private-abort-body"); },
  });
  const pending: Promise<unknown>[] = [];
  startTcpRelay({
    connect: () => {
      connectCalls++;
      if (options.connectThrows) throw new Error("private-connect-body");
      if (options.openFails) opened.reject(new Error("private-open-body"));
      else opened.resolve({});
      return { readable, writable, opened: opened.promise, closed: closed.promise, close: async () => {
      closeCalls++;
      if (options.cleanupRejects) {
        closed.reject(new Error("private-closed-body"));
        throw new Error("private-close-body");
      }
      closed.resolve();
      } };
    },
    server: peer as unknown as WebSocket,
    runId: "00000000-0000-4000-8000-000000000001",
    ...(options.relayId === undefined ? {} : { relayId: options.relayId }),
    waitUntil: promise => pending.push(promise),
  });
  return {
    peer, logs, closed, readableController, readable, writable, written,
    connectCalls: () => connectCalls,
    closeCalls: () => closeCalls, writeCalls: () => writeCalls,
    async drain() {
      // Any rejected lifecycle promise will fail the test, including promises
      // registered from asynchronous close callbacks after the first snapshot.
      let count = 0;
      while (count !== pending.length) { count = pending.length; await Promise.all(pending); }
    },
  };
}

describe("TCP relay lifecycle", () => {
  test("peer teardown handles closed/close/abort/cancel rejections without runtime errors", async () => {
    const h = harness({ cleanupRejects: true });
    await h.peer.message();
    h.peer.dispatchEvent(new Event("close"));
    await h.drain();
    expect(h.closeCalls()).toBe(1);
    expect(h.logs.filter(log => log.level === "error")).toHaveLength(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "socket-close", outcome: "expected-close", closeReason: "peer-close" }));
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "closed", transportFailed: false }));
    expect(h.readable.locked).toBe(false);
    expect(h.writable.locked).toBe(false);
    expect(JSON.stringify(h.logs)).not.toContain("private-");
  });

  test("peer close traces only its bounded protocol code and clean flag, never its reason", async () => {
    const h = harness();
    h.peer.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false, reason: "private-token-and-url" }));
    await h.drain();
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "websocket-peer-close", outcome: "received", peerCloseCode: 1006, peerWasClean: false }));
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", peerCloseCode: 1006, peerWasClean: false }));
    expect(JSON.stringify(h.logs)).not.toContain("private-token-and-url");
  });

  test("upstream EOF closes cleanly once and releases both stream locks", async () => {
    const h = harness();
    await h.peer.message();
    h.readableController.enqueue(new Uint8Array([1, 2]));
    h.readableController.close();
    await h.drain();
    expect(h.peer.sent).toHaveLength(1);
    expect(h.closeCalls()).toBe(1);
    expect(h.peer.closeCodes).toEqual([1000]);
    expect(h.logs.some(log => log.stage === "reader-cancel")).toBe(false);
    expect(h.logs.filter(log => log.level === "error")).toHaveLength(0);
    expect(h.readable.locked).toBe(false);
    expect(h.writable.locked).toBe(false);
  });

  test("a transport rejection before peer closure remains an error", async () => {
    const h = harness();
    await h.peer.message();
    h.closed.reject(new Error("Bearer private-transport-token"));
    await h.drain();
    expect(h.logs.filter(log => log.level === "error")).toContainEqual(expect.objectContaining({ stage: "socket-closed", outcome: "failed" }));
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed", transportFailed: true }));
    expect(h.peer.closeCodes).toEqual([1011]);
    expect(JSON.stringify(h.logs)).not.toContain("private-");
  });

  test("a failed write is retained once and is not replayed by later messages", async () => {
    const h = harness({ write: async () => { throw new Error("private-write-body"); } });
    h.peer.message();
    await h.drain();
    h.peer.message();
    await h.drain();
    expect(h.writeCalls()).toBe(1);
    expect(h.logs.filter(log => log.level === "error")).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed" }));
  });

  test("peer close during an in-flight write drains cleanup without duplicate close or loss of correlation", async () => {
    const write = deferred<void>();
    const began = deferred<void>();
    const h = harness({ write: () => { began.resolve(); return write.promise; } });
    h.peer.message();
    await began.promise;
    h.peer.message(new Uint8Array([2, 3]).buffer);
    h.peer.dispatchEvent(new Event("close"));
    write.reject(new Error("private-cancelled-write"));
    await h.drain();
    expect(h.closeCalls()).toBe(1);
    expect(h.logs.filter(log => log.level === "error")).toHaveLength(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "closed" }));
    expect(h.writable.locked).toBe(false);
    expect(new Set(h.logs.map(log => log.relayId)).size).toBe(1);
    expect(h.logs.every(log => log.runId === "00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "cleanup", outcome: "started", pendingWrites: 2, peakPendingWrites: 2 }));
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", wsReceivedFrames: 2, wsReceivedBytes: 3, upstreamWrittenChunks: 0, upstreamWrittenBytes: 0, pendingWrites: 0, cleanupDurationMs: expect.any(Number) }));
  });

  test("bidirectional metrics distinguish received, completed writes and queued frames", async () => {
    const relayId = "00000000-0000-4000-8000-000000000002";
    const h = harness({ relayId });
    await Promise.all([h.peer.message("あ"), h.peer.message(new Blob([new Uint8Array([1, 2])]))]);
    h.readableController.enqueue(new Uint8Array([3, 4, 5]));
    h.readableController.enqueue(new Uint8Array([6]));
    h.readableController.close();
    await h.drain();
    const terminal = h.logs.find(log => log.stage === "terminal")!;
    expect(Number(terminal.firstActivityMs)).toBeLessThanOrEqual(Number(terminal.lastActivityMs));
    expect(Number(terminal.lastActivityMs)).toBeLessThanOrEqual(Number(terminal.durationMs));
    expect(terminal).toMatchObject({
      relayId, outcome: "closed", wsReceivedBytes: 5, wsReceivedFrames: 2,
      upstreamWrittenBytes: 5, upstreamWrittenChunks: 2,
      upstreamReadBytes: 4, upstreamReadChunks: 2, wsQueuedBytes: 4, wsQueuedFrames: 2,
      pendingWrites: 0, peakPendingWrites: 2, websocketReadyState: 3,
      firstActivityMs: expect.any(Number), lastActivityMs: expect.any(Number), cleanupDurationMs: expect.any(Number),
    });
    expect(h.logs.map(log => log.sequence)).toEqual(h.logs.map((_, index) => index + 1));
    expect(h.logs.every(log => log.stage !== "message" && log.stage !== "chunk")).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain("あ");
  });

  test("failed WebSocket queueing leaves upstream read bytes counted but no queued delivery claim", async () => {
    const h = harness({ sendFails: true });
    await h.peer.message();
    h.readableController.enqueue(new Uint8Array([1, 2, 3]));
    await h.drain();
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed", upstreamReadBytes: 3, upstreamReadChunks: 1, wsQueuedBytes: 0, wsQueuedFrames: 0 }));
    expect(h.peer.closeCodes).toEqual([1011]);
    expect(JSON.stringify(h.logs)).not.toContain("private-send-body");
  });

  test("failed upstream write keeps receipt counts without claiming a completed write", async () => {
    const h = harness({ write: async () => { throw new Error("private-write-body"); } });
    h.peer.message(new Uint8Array([1, 2, 3, 4]).buffer);
    await h.drain();
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed", wsReceivedBytes: 4, wsReceivedFrames: 1, upstreamWrittenBytes: 0, upstreamWrittenChunks: 0, pendingWrites: 0, peakPendingWrites: 1 }));
  });

  test("idle cleanup has zero counters and no invented first activity", async () => {
    const h = harness({ relayId: "https://private.invalid/?token=private-secret" });
    h.peer.dispatchEvent(new Event("close"));
    await h.drain();
    const terminal = h.logs.find(log => log.stage === "terminal")!;
    expect(terminal).toMatchObject({ wsReceivedBytes: 0, wsReceivedFrames: 0, upstreamReadBytes: 0, upstreamWrittenBytes: 0, wsQueuedBytes: 0, pendingWrites: 0, peakPendingWrites: 0 });
    expect(terminal).not.toHaveProperty("firstActivityMs");
    expect(terminal).not.toHaveProperty("lastActivityMs");
    expect(String(terminal.relayId)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(h.logs)).not.toContain("private");
    expect(h.connectCalls()).toBe(0);
    expect(h.closeCalls()).toBe(0);
    expect(terminal.socketCreated).toBe(false);
  });

  test("throwing metrics logger cannot interrupt forwarding or cleanup", async () => {
    const h = harness({ loggerThrows: true });
    await h.peer.message(new Uint8Array([1, 2]).buffer);
    h.readableController.enqueue(new Uint8Array([3]));
    h.readableController.close();
    await h.drain();
    expect(h.writeCalls()).toBe(1);
    expect(h.peer.sent).toHaveLength(1);
    expect(h.closeCalls()).toBe(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "closed", upstreamWrittenBytes: 2, wsQueuedBytes: 1 }));
  });

  test("empty frames never create an upstream socket", async () => {
    const h = harness();
    await Promise.all([h.peer.message(""), h.peer.message(new ArrayBuffer(0)), h.peer.message(new Blob([]))]);
    h.peer.dispatchEvent(new Event("close"));
    await h.drain();
    expect(h.connectCalls()).toBe(0);
    expect(h.closeCalls()).toBe(0);
    expect(h.writeCalls()).toBe(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", socketCreated: false, wsReceivedFrames: 3, wsReceivedBytes: 0, pendingWrites: 0 }));
  });

  test("first nonempty frame creates one socket and serializes asynchronous Blob conversion exactly once", async () => {
    const h = harness();
    const converted = deferred<ArrayBuffer>();
    const converting = deferred<void>();
    let conversions = 0;
    class DelayedBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { conversions++; converting.resolve(); return converted.promise; }
    }
    const first = h.peer.message(new DelayedBlob([new Uint8Array([1, 2])]));
    const second = h.peer.message(new Uint8Array([3]).buffer);
    await converting.promise;
    expect(h.connectCalls()).toBe(0);
    converted.resolve(new Uint8Array([1, 2]).buffer);
    await Promise.all([first, second]);
    expect(h.connectCalls()).toBe(1);
    expect(conversions).toBe(1);
    expect(h.written).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
    h.peer.dispatchEvent(new Event("close"));
    await h.drain();
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", socketCreated: true, upstreamWrittenBytes: 3, upstreamWrittenChunks: 2 }));
  });

  test("peer close during Blob conversion skips connection and every queued write", async () => {
    const h = harness();
    const converted = deferred<ArrayBuffer>();
    const converting = deferred<void>();
    class DelayedBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { converting.resolve(); return converted.promise; }
    }
    h.peer.message(new DelayedBlob([new Uint8Array([1])]));
    h.peer.message(new Uint8Array([2]).buffer);
    await converting.promise;
    h.peer.dispatchEvent(new Event("close"));
    converted.resolve(new Uint8Array([1]).buffer);
    await h.drain();
    expect(h.connectCalls()).toBe(0);
    expect(h.closeCalls()).toBe(0);
    expect(h.writeCalls()).toBe(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", socketCreated: false, outcome: "closed", pendingWrites: 0 }));
  });

  test("synchronous factory failure is reported before closure and never retried", async () => {
    const h = harness({ connectThrows: true });
    h.peer.message();
    h.peer.message();
    await h.drain();
    expect(h.connectCalls()).toBe(1);
    expect(h.closeCalls()).toBe(0);
    expect(h.logs.filter(log => log.level === "error")).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "socket-connect", outcome: "failed", socketCreated: false }));
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed", socketCreated: false }));
    expect(h.peer.closeCodes).toEqual([1011]);
    expect(JSON.stringify(h.logs)).not.toContain("private-connect-body");
  });

  test("socket-open rejection is owned immediately and remains a transport failure", async () => {
    const h = harness({ openFails: true });
    h.peer.message();
    await h.drain();
    expect(h.connectCalls()).toBe(1);
    expect(h.closeCalls()).toBe(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "socket-open", outcome: "failed", socketCreated: true }));
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed" }));
    expect(h.peer.closeCodes).toEqual([1011]);
    expect(JSON.stringify(h.logs)).not.toContain("private-open-body");
  });
});
