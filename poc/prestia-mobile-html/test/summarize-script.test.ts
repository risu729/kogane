import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Python structural summary never prints form-action path or query values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prestia-summary-"));
  try {
    const htmlPath = join(directory, "response.html");
    await writeFile(
      htmlPath,
      '<form name="POMHTOP" method="post" action="https://example.test/path-private?token=query-private">' +
        '<input type="hidden" name="_TOKEN" value="also-private"></form>',
    );
    const process = Bun.spawn(["python3", "scripts/summarize-html.py", htmlPath], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    expect(await process.exited).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"actionPresent": true');
    expect(stdout).not.toContain("path-private");
    expect(stdout).not.toContain("query-private");
    expect(stdout).not.toContain("also-private");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
