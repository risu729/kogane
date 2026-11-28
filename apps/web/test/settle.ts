// A drop-in `test` for a browser test file whose cases share one Chromium
// (docs/ci.md, browser tests under Bun). Bun's runner cannot stop the body of
// a case that timed out: it fails the case and starts the next one while the
// body is still driving the shared browser and the file's local server.
// `settledTest()` keeps each case's body and registers an `afterEach` that
// waits for it to settle, so the next case starts only once it has. The wait
// is bounded by `afterEach`'s default 5 s deadline: a body that has not
// settled by then fails its case at the hook and goes on running. A late
// rejection is still reported by Bun as an error between tests.
//
// The browser itself must launch while the module loads (a top-level `await`),
// not in `beforeAll`: at a timeout Bun SIGTERMs every process a hook or a case
// spawned and leaves the ones spawned at load, so a browser launched in a hook
// dies with the timed-out case and every later case fails to open a page.
// Launch it only when the suite will run, so a skipped suite starts nothing;
// the local server and seeding may stay in `beforeAll`.
//
//   let browser: Browser;
//   if (runnable) browser = await chromium.launch({ executablePath });
//   const test = settledTest();
//   describe.if(runnable)("…", () => {
//     afterAll(() => browser?.close());
//   });
//
// The browser tests of experiments/observation-pipeline-local and
// experiments/st-george-automation import this file too.
import { afterEach, test as bunTest } from "bun:test";

type Callable = (...args: unknown[]) => unknown;

// Modifiers that are themselves a `test`, and the ones that return one.
const MODIFIERS = new Set(["only", "skip", "todo", "failing", "concurrent", "serial"]);
const FACTORIES = new Set([
  "if",
  "skipIf",
  "todoIf",
  "failingIf",
  "concurrentIf",
  "serialIf",
  "each",
]);

/** Call once at the top level of a test file, before its cases. */
export function settledTest(): typeof bunTest {
  let body: unknown;
  afterEach(async () => {
    const running = body;
    body = undefined;
    try {
      await running;
    } catch {
      // The case has already failed with this rejection, or timed out.
    }
  });
  const keep = (fn: Callable): Callable => {
    const kept = function (this: unknown, ...args: unknown[]) {
      body = fn.apply(this, args);
      return body;
    };
    // Bun reads a case's arity to decide whether to pass `done`.
    Object.defineProperty(kept, "length", { value: fn.length });
    return kept;
  };
  const wrap = <F extends Callable>(register: F, owner: unknown): F =>
    new Proxy(register, {
      apply: (target, _self, args: unknown[]) =>
        Reflect.apply(
          target,
          owner,
          args.map((arg) => (typeof arg === "function" ? keep(arg as Callable) : arg)),
        ),
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key);
        if (typeof key !== "string" || typeof value !== "function") return value;
        if (MODIFIERS.has(key)) return wrap(value as Callable, target);
        if (FACTORIES.has(key))
          return (...args: unknown[]) =>
            wrap(Reflect.apply(value as Callable, target, args) as Callable, target);
        return value;
      },
    });
  return wrap(bunTest as unknown as Callable, undefined) as unknown as typeof bunTest;
}
