// Test transport only. Miniflare's eval helper has its own module realm, so
// restoring the parent's Undici exports cannot select this helper's fetch.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import workerThreads from "node:worker_threads";

const require = createRequire(import.meta.url);
const miniflareEntry = require.resolve("miniflare");
const miniflareRequire = createRequire(miniflareEntry);
const lockedUndiciEntry = require.resolve(
  join(dirname(miniflareRequire.resolve("undici/package.json")), "index.js"),
);
// Exact installed SynchronousFetcher payload, measured before this correction.
// A dependency change must review this private integration rather than fall back.
const HELPER_SHA256 = "4d25b5d205de6b409af1c5138b4b6f8277b532f70eea92767b2b85f821e735ad";
const UNDICI_SELECTION = 'const { Pool, fetch } = actualRequire("undici");';
const GUARD = Symbol.for("kogane.processor.miniflare-sync-worker");
type Constructor = typeof workerThreads.Worker;
type Guarded = Constructor & { [GUARD]?: Constructor };

/** Inspect ordinary options without invoking a caller's accessors. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && "value" in property ? property.value : undefined;
  } catch {
    return undefined;
  }
}

/** Keep other Workers and constructor semantics unchanged; rewrite one verified import only. */
export function guardMiniflareSyncWorker(original: Constructor): Constructor {
  if ((original as Guarded)[GUARD] !== undefined) return original;
  return new Proxy(original, {
    get(target, key, receiver) {
      return key === GUARD ? original : Reflect.get(target, key, receiver);
    },
    construct(target, args, newTarget) {
      const [script, options] = args;
      const data = ownValue(options, "workerData");
      if (ownValue(data, "filename") !== miniflareEntry)
        return Reflect.construct(target, args, newTarget);
      const notify = ownValue(data, "notifyHandle");
      const port = ownValue(data, "port");
      const transfers = ownValue(options, "transferList");
      if (
        args.length !== 2 ||
        ownValue(options, "eval") !== true ||
        typeof script !== "string" ||
        !(notify instanceof Int32Array) ||
        !(notify.buffer instanceof SharedArrayBuffer) ||
        notify.length !== 1 ||
        !(port instanceof workerThreads.MessagePort) ||
        !Array.isArray(transfers) ||
        ownValue(transfers, "length") !== 1 ||
        ownValue(transfers, "0") !== port ||
        createHash("sha256").update(script).digest("hex") !== HELPER_SHA256
      )
        throw new Error("miniflare-sync-worker: unreviewed synchronous helper shape");
      const start = script.indexOf(UNDICI_SELECTION);
      if (start < 0 || script.indexOf(UNDICI_SELECTION, start + UNDICI_SELECTION.length) !== -1)
        throw new Error("miniflare-sync-worker: unreviewed Undici selection");
      const rewritten =
        script.slice(0, start) +
        `const { Pool, fetch } = actualRequire(${JSON.stringify(lockedUndiciEntry)});` +
        script.slice(start + UNDICI_SELECTION.length);
      return Reflect.construct(target, [rewritten, options], newTarget);
    },
  });
}

export const unguardedMiniflareWorker: Constructor =
  (workerThreads.Worker as Guarded)[GUARD] ?? workerThreads.Worker;

export const miniflareSyncWorkerGuarded = (): boolean =>
  (workerThreads.Worker as Guarded)[GUARD] !== undefined;

if (!miniflareSyncWorkerGuarded())
  workerThreads.Worker = guardMiniflareSyncWorker(workerThreads.Worker);
