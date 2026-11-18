// Run by test/bun-timeout-kill.test.ts as its own `bun test` process, never
// discovered by the suite: one process started while the module loads, one in
// beforeAll, then a case that times out. The last case prints what became of
// both.
import { afterAll, beforeAll, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";

const atLoad = spawn("sleep", ["60"]);
let inHook: ChildProcess;
beforeAll(() => {
  inHook = spawn("sleep", ["60"]);
});
afterAll(() => {
  atLoad.kill();
  inHook.kill();
});

test("times out", () => new Promise((resolve) => setTimeout(resolve, 1_000)), 50);

test("reports", async () => {
  // A killed process is seen once its exit is; one left alive is reported
  // as such after the wait.
  if (inHook.exitCode === null && inHook.signalCode === null)
    await Promise.race([
      new Promise((resolve) => inHook.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  console.log(
    "FATE " +
      JSON.stringify({
        atLoad: { exitCode: atLoad.exitCode, signalCode: atLoad.signalCode },
        inHook: { exitCode: inHook.exitCode, signalCode: inHook.signalCode },
      }),
  );
});
