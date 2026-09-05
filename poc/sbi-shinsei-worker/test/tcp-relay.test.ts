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
function harness(options: { cleanupRejects?: boolean; write?: () => Promise<void> } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  for (const level of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, level).mockImplementation(value => logs.push({ level, ...JSON.parse(String(value)) }));
    restores.push(() => spy.mockRestore());
  }
  class Peer extends EventTarget {
    sent: unknown[] = [];
    closeCodes: number[] = [];
    send(value: unknown) { this.sent.push(value); }
    close(code: number) { this.closeCodes.push(code); this.dispatchEvent(new Event("close")); }
    message() { this.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1]).buffer })); }
  }
  const peer = new Peer();
  const closed = deferred<void>();
  const opened = deferred<unknown>();
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  let closeCalls = 0;
  let writeCalls = 0;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { readableController = controller; },
    cancel() { if (options.cleanupRejects) throw new Error("private-cancel-body"); },
  });
  const writable = new WritableStream<Uint8Array>({
    async write() { writeCalls++; await options.write?.(); },
    abort() { if (options.cleanupRejects) throw new Error("private-abort-body"); },
  });
  const pending: Promise<unknown>[] = [];
  startTcpRelay({
    socket: { readable, writable, opened: opened.promise, closed: closed.promise, close: async () => {
      closeCalls++;
      if (options.cleanupRejects) {
        closed.reject(new Error("private-closed-body"));
        throw new Error("private-close-body");
      }
      closed.resolve();
    } },
    server: peer as unknown as WebSocket,
    runId: "00000000-0000-4000-8000-000000000001",
    waitUntil: promise => pending.push(promise),
  });
  opened.resolve({});
  return {
    peer, logs, closed, readableController, readable, writable,
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

  test("upstream EOF closes cleanly once and releases both stream locks", async () => {
    const h = harness();
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
    h.peer.dispatchEvent(new Event("close"));
    write.reject(new Error("private-cancelled-write"));
    await h.drain();
    expect(h.closeCalls()).toBe(1);
    expect(h.logs.filter(log => log.level === "error")).toHaveLength(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "closed" }));
    expect(h.writable.locked).toBe(false);
    expect(new Set(h.logs.map(log => log.relayId)).size).toBe(1);
    expect(h.logs.every(log => log.runId === "00000000-0000-4000-8000-000000000001")).toBe(true);
  });
});
