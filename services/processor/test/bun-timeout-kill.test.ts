// What Bun's test runner does to child processes when a case times out, which
// a file sharing one Miniflare across its cases relies on (docs/ci.md,
// Miniflare under Bun; test/card-debit-accounts.test.ts): it SIGTERMs every
// process a hook or a case spawned, such as a workerd started in beforeAll,
// and leaves one started while the module loaded. Should a Bun upgrade change
// either, this fails and names which.
import { expect, test } from "bun:test";

test("a timeout kills the process a hook spawned and spares the one spawned at load", () => {
  const fixture = new URL("./fixtures/bun-timeout-kill.ts", import.meta.url).pathname;
  const run = Bun.spawnSync([process.execPath, "test", fixture], {
    cwd: new URL("./fixtures/", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = run.stdout.toString() + run.stderr.toString();
  const fate = /^FATE (.*)$/mu.exec(output)?.[1];
  expect({ exitCode: run.exitCode, fate: fate === undefined ? null : JSON.parse(fate) }).toEqual({
    // The deliberate timeout is the one failing case.
    exitCode: 1,
    fate: {
      atLoad: { exitCode: null, signalCode: null },
      inHook: { exitCode: null, signalCode: "SIGTERM" },
    },
  });
  expect(output).toContain("killed 1 dangling process");
  expect(output).toMatch(/\(fail\) times out/u);
});
