// A controlled version of workers-sdk issue 16230 on the installed transport:
// delay only the async batch CALL after serialization, allow FREE through,
// force GC, and release the CALL only after its argument was actually freed.
// The control must fail in Native revival; the guarded call must succeed.
// No operation is retried and no existing deadline is changed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  installMiniflareD1Lifetime,
  miniflareD1LifetimeGuarded,
  unguardedGetD1Database,
} from "./miniflare-d1-lifetime.ts";
import { pendingNativeD1Calls } from "./miniflare-d1-retention.ts";

type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Read only addresses from devalue's flat Native records, never retain stubs. */
function nativeAddresses(body: unknown): number[] {
  if (typeof body !== "string") throw new Error("expected serialized batch arguments");
  const values: unknown = JSON.parse(body);
  if (!Array.isArray(values)) throw new Error("expected devalue flat records");
  const addresses: number[] = [];
  for (const entry of values) {
    if (!Array.isArray(entry) || entry[0] !== "Native") continue;
    const tuple: unknown = values[entry[1] as number];
    if (!Array.isArray(tuple)) throw new Error("expected Native tuple");
    const address: unknown = values[tuple[0] as number];
    if (typeof address !== "number") throw new Error("expected Native address");
    addresses.push(address);
  }
  if (addresses.length === 0) throw new Error("batch had no native statement arguments");
  return addresses;
}

function runtime() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('test'); } };",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  const dispatch = mf.dispatchFetch;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const state = {
    mf,
    enabled: false,
    arrived,
    release,
    arguments: [] as number[],
    freed: new Set<number>(),
    finalized: 0,
  };
  // This public instance field is captured when its proxy client is created.
  // The gate sees serialized requests only; it holds no statement/target refs.
  mf.dispatchFetch = async (input, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const operation = headers.get("MF-Op");
    if (
      state.enabled &&
      init?.method === "POST" &&
      operation === "CALL" &&
      headers.get("MF-Op-Key") === "batch"
    ) {
      state.arguments = nativeAddresses(init.body);
      entered();
      await held;
    }
    const response = await dispatch(input, init);
    if (init?.method === "DELETE" && operation === "FREE" && response.ok)
      for (const address of (headers.get("MF-Op-Target") ?? "").split(","))
        state.freed.add(Number(address));
    return response;
  };
  const registry = new FinalizationRegistry(() => {
    state.finalized++;
  });
  // A separate frame returns the ephemeral proxy. The response callbacks
  // must not share a lexical scope with a local statement binding that JSC
  // might conservatively retain while their Promise is pending.
  const statement = (db: Database) => {
    const native = db.prepare("SELECT 42 AS n");
    registry.register(native, "argument");
    return native;
  };
  const submit = (db: Database): Promise<Outcome> => {
    return db.batch([statement(db)]).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  };
  return { ...state, state, submit, registry };
}

type Fixture = ReturnType<typeof runtime> & { db: Database };
const fixtures: Fixture[] = [];
beforeAll(async () => {
  // The gate's three MF-Op headers and devalue records are checked against
  // this exact dependency, independently of the public API wrapper.
  const require = createRequire(import.meta.url);
  const manifest = join(dirname(require.resolve("miniflare")), "../../package.json");
  expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe("5.20260831.0-alpha");
  for (const guarded of [false, true]) {
    const fixture = runtime();
    const db = guarded
      ? await fixture.mf.getD1Database("DB")
      : await unguardedGetD1Database.call(fixture.mf, "DB");
    // The first batch discovers that batch is async. The gated batch below
    // must take the async path instead of blocking the test's JS thread.
    await db.batch([db.prepare("SELECT 1 AS n")]);
    fixtures.push({ ...fixture, db });
  }
}, 60_000);
afterAll(async () => {
  for (const fixture of fixtures) {
    fixture.release();
    await fixture.mf.dispose();
  }
});

async function gcTurn(): Promise<void> {
  // Never dereference a WeakRef before GC in this task: deref itself would
  // keep a target alive until the next task and invalidate the control.
  await Bun.sleep(0);
  Bun.gc(true);
  await Bun.sleep(10);
}
const freedArgument = (fixture: Fixture): boolean =>
  fixture.state.arguments.some((address) => fixture.state.freed.has(address));

test("the D1 preload installs once and preserves the native accessor", () => {
  const installed = Miniflare.prototype.getD1Database;
  installMiniflareD1Lifetime();
  installMiniflareD1Lifetime();
  expect(Miniflare.prototype.getD1Database).toBe(installed);
  expect(Reflect.get(installed, Symbol.for("kogane.processor.miniflare-d1-lifetime"))).toBe(
    unguardedGetD1Database,
  );
});

test("an unguarded in-flight D1 argument is freed; the guarded call survives the same GC window", async () => {
  expect(miniflareD1LifetimeGuarded()).toBe(true);
  const before = pendingNativeD1Calls();
  const control = fixtures[0]!;
  const guarded = fixtures[1]!;
  control.state.enabled = true;
  const failed = control.submit(control.db);
  await control.arrived;
  let turns = 0;
  while (turns < 40 && !(control.state.finalized > 0 && freedArgument(control))) {
    await gcTurn();
    turns++;
  }
  // Fail, never skip or retry, if the intended GC/FREE race was not induced.
  expect(control.state.finalized).toBeGreaterThan(0);
  expect(freedArgument(control)).toBe(true);
  control.release();
  const failure = await failed;
  if (failure.ok) throw new Error("unguarded control unexpectedly succeeded");
  expect(failure.error).toBeInstanceOf(Error);
  const error = failure.error as Error;
  expect(error.name).toBe("AssertionError");
  expect(error.message).toContain("false == true");
  expect(error.stack).toMatch(/at Native\b/u);

  guarded.state.enabled = true;
  const completed = guarded.submit(guarded.db);
  await guarded.arrived;
  for (let turn = 0; turn < turns; turn++) await gcTurn();
  // Miniflare batches FREE after 100 ms; allow that same opportunity here.
  await Bun.sleep(150);
  expect(pendingNativeD1Calls()).toBe(before + 1);
  expect(guarded.state.finalized).toBe(0);
  expect(freedArgument(guarded)).toBe(false);
  guarded.release();
  const success = await completed;
  expect(success).toMatchObject({ ok: true, value: [{ results: [{ n: 42 }] }] });
  expect(pendingNativeD1Calls()).toBe(before);

  // Once the response settles, the proxy is collectable rather than pinned
  // until runtime disposal. A failure here exposes a leaked retention root.
  for (let turn = 0; turn < 40 && !freedArgument(guarded); turn++) await gcTurn();
  expect(guarded.state.finalized).toBeGreaterThan(0);
  expect(freedArgument(guarded)).toBe(true);
});
