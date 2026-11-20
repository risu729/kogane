// What Bun's test runner does to child processes when a case times out, which
// a file sharing one Miniflare across its cases relies on (docs/ci.md,
// Miniflare under Bun; test/support/settle.ts): it SIGTERMs every
// process a hook or a case spawned, such as a workerd started in beforeAll,
// and leaves one started while the module loaded. Should a Bun upgrade change
// either, this fails and names which.
import { expect, test } from "bun:test";

// The nested `bun test` took up to 4 s on a loaded 4-core host, close to the
// 5 s default, which a blocking spawnSync does not escape either: Bun fails a
// synchronous case that runs past its deadline. The case therefore awaits the
// process and has its own deadline, covering the fixture's 10 s window.
test("a timeout kills the process a hook spawned and spares the one spawned at load", async () => {
  const fixture = new URL("./fixtures/bun-timeout-kill.ts", import.meta.url).pathname;
  const run = Bun.spawn([process.execPath, "test", fixture], {
    cwd: new URL("./fixtures/", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  const output = stdout + stderr;
  const fate = /^FATE (.*)$/mu.exec(output)?.[1];
  expect({ exitCode, fate: fate === undefined ? null : JSON.parse(fate) }).toEqual({
    // The deliberate timeout is the one failing case.
    exitCode: 1,
    fate: {
      atLoad: { exitCode: null, signalCode: null },
      inHook: { exitCode: null, signalCode: "SIGTERM" },
    },
  });
  expect(output).toContain("killed 1 dangling process");
  expect(output).toMatch(/\(fail\) times out/u);
}, 30_000);
