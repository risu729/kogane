// Installed after the HTTP/synchronous proxy guards, before any test creates
// a runtime. This public API seam leaves production Workers and Miniflare's
// SQL/serialization/finalizers untouched. Only D1 bindings obtained through
// getD1Database are wrapped; R2 and arbitrary getBindings results are unchanged.
import "./miniflare-http-proxy.ts";
import type { Miniflare as MiniflareRuntime } from "miniflare";
import { retainNativeD1 } from "./miniflare-d1-retention.ts";

// A static Miniflare import can capture Bun HTTP classes before the guard
// replaces undici. Load the package only after that side effect has finished.
const { Miniflare } = await import("miniflare");

const GUARD = Symbol.for("kogane.processor.miniflare-d1-lifetime");
type GetDatabase = typeof Miniflare.prototype.getD1Database;
type Guarded = GetDatabase & { [GUARD]?: GetDatabase };
export const unguardedGetD1Database: GetDatabase =
  (Miniflare.prototype.getD1Database as Guarded)[GUARD] ?? Miniflare.prototype.getD1Database;

export const miniflareD1LifetimeGuarded = (): boolean => GUARD in Miniflare.prototype.getD1Database;

export function installMiniflareD1Lifetime(): void {
  if (miniflareD1LifetimeGuarded()) return;
  Miniflare.prototype.getD1Database = Object.assign(
    async function (this: MiniflareRuntime, ...args: Parameters<GetDatabase>) {
      return retainNativeD1(await unguardedGetD1Database.apply(this, args));
    },
    { [GUARD]: unguardedGetD1Database },
  );
}
installMiniflareD1Lifetime();
