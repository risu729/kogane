// Miniflare's per-runtime HTTP dispatcher must own its connections. Bun's
// built-in `undici` currently ignores fetch's dispatcher: it shares the native
// fetch pool and drops DispatchFetchDispatcher's `reset = true`. A runtime
// therefore reuses connections that Miniflare explicitly asks to close. CI
// observed ECONNRESET when a shared fixture resumed after another runtime's
// test; the precise socket-close race is not reproducible on demand.
//
// Restore the implementation Miniflare is locked against in this test process.
// This preserves its connection close, routing and disposal semantics without
// retrying requests (a failed write may already have completed). Production
// Workers and global fetch are untouched. Like the synchronous proxy guard,
// this replaces the CommonJS module object Miniflare reads, before test files
// run; Bun's mock.module does not replace its built-in CommonJS `undici`.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const runtimeUndici: Record<PropertyKey, unknown> = require("undici");
const GUARD = Symbol.for("kogane.processor.miniflare-http-proxy");

export function miniflareHttpProxyGuarded(): boolean {
  return GUARD in runtimeUndici;
}

if (!miniflareHttpProxyGuarded()) {
  // Resolve from Miniflare, whose manifest and the root lockfile own this
  // version. An absolute package entry bypasses Bun's built-in module alias.
  const miniflareRequire = createRequire(require.resolve("miniflare"));
  const manifest = miniflareRequire.resolve("undici/package.json");
  const lockedUndici: Record<PropertyKey, unknown> = require(join(dirname(manifest), "index.js"));
  Object.assign(runtimeUndici, lockedUndici);
  Object.defineProperty(runtimeUndici, GUARD, { value: true });
}
