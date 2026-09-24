// The guard of test/miniflare-sync-proxy.ts, on Miniflare's own protocol: a
// helper thread answers each call on a MessagePort and wakes the caller
// through `Atomics.notify`. The helper here can wake the caller before its
// reply is queued, the order the CI failures showed, so the failure, its
// cascade and the fix are all reproduced deterministically.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import workerThreads, { MessageChannel, Worker } from "node:worker_threads";

test("every test process here reads Miniflare's proxy through the guard, from the bunfig preload", () => {
  // Checked before this file imports the guard itself (below, dynamically).
  expect(
    Symbol.for("kogane.processor.miniflare-sync-proxy") in workerThreads.receiveMessageOnPort,
  ).toBe(true);
  expect(readFileSync(new URL("../bunfig.toml", import.meta.url), "utf8")).toContain(
    'preload = ["./test/miniflare-sync-proxy.ts"]',
  );
});

const HELPER = `
const { workerData } = require("worker_threads");
const { notify, port } = workerData;
const wake = () => { Atomics.store(notify, 0, 1); Atomics.notify(notify, 0); };
port.addEventListener("message", (event) => {
  const { id, lateMs } = event.data;
  if (lateMs === 0) { port.postMessage({ id }); wake(); return; }
  // The caller wakes first; the reply is queued later.
  wake();
  setTimeout(() => port.postMessage({ id }), lateMs);
});
port.start();
`;
const channel = new MessageChannel();
const notify = new Int32Array(new SharedArrayBuffer(4));
const helper = new Worker(HELPER, {
  eval: true,
  workerData: { notify, port: channel.port2 },
  transferList: [channel.port2],
});
afterAll(async () => {
  await helper.terminate();
});

type Receive = typeof workerThreads.receiveMessageOnPort;
/** One synchronous call, exactly as Miniflare's `SynchronousFetcher.fetch` makes it. */
function call(id: number, lateMs: number, receive: Receive): unknown {
  Atomics.store(notify, 0, 0);
  channel.port1.postMessage({ id, lateMs });
  Atomics.wait(notify, 0, 0);
  return receive(channel.port1)?.message;
}

test("a reply queued after the caller wakes: missed and cascading without the guard, read in order with it", async () => {
  const { receiveQueuedMessage, unguardedReceiveMessageOnPort } =
    await import("./miniflare-sync-proxy.ts");
  const guarded = (port: Parameters<Receive>[0]) => receiveQueuedMessage(port);
  // The CI failure: the port is empty when read, so `message?.id === 0` fails.
  expect(call(0, 50, unguardedReceiveMessageOnPort)).toBeUndefined();
  await Bun.sleep(200);
  // Its cascade: the late reply is still queued and the next call reads it.
  expect(call(1, 0, unguardedReceiveMessageOnPort)).toEqual({ id: 0 });
  expect(unguardedReceiveMessageOnPort(channel.port1)?.message).toEqual({ id: 1 });

  // With the guard the read waits for the reply on its way, and the next call
  // reads its own: nothing is left behind to shift later replies.
  expect(call(2, 50, guarded)).toEqual({ id: 2 });
  expect(call(3, 0, guarded)).toEqual({ id: 3 });
  expect(call(4, 30, guarded)).toEqual({ id: 4 });
  expect(unguardedReceiveMessageOnPort(channel.port1)).toBeUndefined();
  // And the installed function is the guard.
  expect(call(5, 50, workerThreads.receiveMessageOnPort)).toEqual({ id: 5 });
}, 30_000);

test("a port that stays empty is an error naming the cause, not a hang", async () => {
  const { receiveQueuedMessage, unguardedReceiveMessageOnPort } =
    await import("./miniflare-sync-proxy.ts");
  const idle = new MessageChannel();
  expect(() => receiveQueuedMessage(idle.port1, unguardedReceiveMessageOnPort, 20)).toThrow(
    "no reply on the proxy port within 20 ms",
  );
  idle.port1.close();
});
