// Miniflare's Node-side proxy, under Bun, made to wait for the reply it reads.
//
// Every `DB.prepare`, `bind` and R2 property a test touches goes through
// Miniflare's synchronous proxy. `SynchronousFetcher.fetch` (miniflare
// dist/src/index.js) posts the call to a helper worker thread, blocks in
// `Atomics.wait` until that thread notifies, then reads the reply once with
// `receiveMessageOnPort` and asserts `message?.id === id`. It assumes the
// reply is already on the port when the wait returns. Under Bun that is not
// guaranteed: in CI, with every workspace's checks running in parallel, the
// read found the port empty (`AssertionError: false == true` at `#syncCall`
// or at a proxy `get`, first in `mizuho-pipeline.test.ts`'s migrations on
// #236 and in `lanes.test.ts`'s seeding on #235). The reply then arrived
// after all: every later call on that Miniflare read its predecessor's reply
// and failed the same way within milliseconds (lanes.test.ts on #235), so a
// single early read broke the rest of the file. It is not a timeout, a shared
// instance or an un-awaited call: a synchronous call blocks the only JS
// thread, so no two calls ever overlap, and the first failure on #236 was on
// a fresh instance.
//
// The fix is on the read: when the port is still empty, wait for the reply
// that is on its way instead of reading nothing, so the next call can never
// read this one's reply. Miniflare's own id assertion stays in force and
// still fails loudly should a reply ever come out of order. Nothing else in
// the processor tests reads a port synchronously, and a port that stays
// empty past `REPLY_WAIT_MS` is an error that names the cause rather than a
// silent hang. Installed once per process by the bunfig preload and by
// `harness.ts`; installing twice is a no-op.
import workerThreads from "node:worker_threads";

/** How long a read waits for a reply before it fails. */
export const REPLY_WAIT_MS = 60_000;

type Receive = typeof workerThreads.receiveMessageOnPort;
/** Marks the installed guard and keeps the runtime's own function on it. */
const GUARD = Symbol.for("kogane.processor.miniflare-sync-proxy");
type Guarded = Receive & { [GUARD]: Receive };

/** The runtime's own `receiveMessageOnPort`, whether or not the guard is installed. */
export const unguardedReceiveMessageOnPort: Receive =
  (workerThreads.receiveMessageOnPort as Partial<Guarded>)[GUARD] ??
  workerThreads.receiveMessageOnPort;

// A 1 ms sleep that blocks the thread, as the waiting caller already does.
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Reads one message, waiting up to `waitMs` for one to be queued. */
export function receiveQueuedMessage(
  port: Parameters<Receive>[0],
  receive: Receive = unguardedReceiveMessageOnPort,
  waitMs: number = REPLY_WAIT_MS,
): ReturnType<Receive> {
  let received = receive(port);
  const deadline = performance.now() + waitMs;
  while (received === undefined) {
    if (performance.now() >= deadline)
      throw new Error(
        `miniflare-sync-proxy: no reply on the proxy port within ${waitMs} ms; the helper thread never answered`,
      );
    Atomics.wait(sleeper, 0, 0, 1);
    received = receive(port);
  }
  return received;
}

/** Whether this process reads Miniflare's replies through the guard. */
export function miniflareSyncProxyGuarded(): boolean {
  return GUARD in workerThreads.receiveMessageOnPort;
}

if (!miniflareSyncProxyGuarded())
  // Miniflare calls it through `require("node:worker_threads")`, this same
  // module object, at every read, so replacing the export is enough.
  workerThreads.receiveMessageOnPort = Object.assign(
    (port: Parameters<Receive>[0]) => receiveQueuedMessage(port),
    { [GUARD]: unguardedReceiveMessageOnPort },
  ) satisfies Guarded;
