// What `settledTest()` (test/support/settle.ts) promises the files that share
// one Miniflare across their cases (docs/ci.md, Miniflare under Bun): a case
// that times out fails alone and the next case starts only once its body has
// settled; a rejection after the timeout is still reported; `done` callbacks
// and `.each` keep working; `test.concurrent` is refused. The fixture runs as
// its own `bun test` process, as test/bun-timeout-kill.test.ts runs its own.
import { expect, test } from "bun:test";

test("a settled case that times out fails alone and the next case waits for its body", async () => {
  const fixture = new URL("./fixtures/settled-test.ts", import.meta.url).pathname;
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
  const settle = /^SETTLE (.*)$/mu.exec(output)?.[1];
  expect({ exitCode, settle: settle === undefined ? null : JSON.parse(settle) }).toEqual({
    // The two deliberate timeouts are the failing cases.
    exitCode: 1,
    settle: {
      sawSlowBodyDone: true,
      sawLateBodyDone: true,
      doneArity: 1,
      eachRow: 7,
      concurrentRefused: true,
    },
  });
  expect(output).toMatch(/\(fail\) times out/u);
  expect(output).toMatch(/\(fail\) rejects late/u);
  expect(output).toContain("synthetic late rejection");
  expect(output).toMatch(/\b2 fail\b/u);
  expect(output).toMatch(/\b5 pass\b/u);
}, 30_000);
