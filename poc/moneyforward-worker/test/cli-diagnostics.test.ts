import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("live smoke rejects malformed credential input without logging its contents", async () => {
  const secretMarker = "private-credential-must-never-appear";
  const child = Bun.spawn([process.execPath, "scripts/live-smoke.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdin: new Blob([`${secretMarker}{invalid-json`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(1);
  expect(stdout + stderr).not.toContain(secretMarker);
  const result = JSON.parse(stderr.trim());
  expect(result).toMatchObject({ ok: false, errorType: "Error", failureCode: "operation_failed" });
  expect(result).not.toHaveProperty("message");
});

test("live smoke never prints a provider response JSON parsing error body", async () => {
  const secretMarker = "private-provider-body-must-never-appear";
  const directory = await mkdtemp(join(tmpdir(), "kogane-cli-test-"));
  const preload = join(directory, "fetch-fixture.js");
  try {
    await writeFile(preload, `let count=0; globalThis.fetch=async()=> ++count === 1
      ? new Response('<meta name="csrf-token" content="test-csrf">')
      : new Response(${JSON.stringify(secretMarker)}, {headers:{'content-type':'application/json'}});`);
    const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/live-smoke.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdin: new Blob([JSON.stringify({ rpId: "id.moneyforward.com", origin: "https://id.moneyforward.com",
        credentialId: "test-only", keyValue: "test-only", counter: 0 })]),
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout + stderr).not.toContain(secretMarker);
    expect(JSON.parse(stderr.trim())).toMatchObject({ ok: false, errorType: "SyntaxError", failureCode: "operation_failed" });
    expect(JSON.parse(stderr.trim())).not.toHaveProperty("message");
  } finally { await unlink(preload); await rmdir(directory); }
});
