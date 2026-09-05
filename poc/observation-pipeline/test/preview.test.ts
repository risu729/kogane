import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("isolated preview identifies synthetic data and never creates the regular store", async () => {
  const regularStore = join(
    import.meta.dir,
    "..",
    "state",
    "kogane-poc.sqlite",
  );
  const existedBefore = existsSync(regularStore);
  const child = Bun.spawn([process.execPath, "run", "src/serve.ts", "--demo"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = await Promise.race([
      (async () => {
        let output = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error("Preview exited before becoming ready");
          output += new TextDecoder().decode(chunk.value);
          const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(output);
          if (match) return match[0];
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Preview startup timed out")),
          15_000,
        );
      }),
    ]);
    const metadata = await fetch(`${origin}/api/meta`).then((response) =>
      response.json(),
    );
    expect(metadata.source).toEqual({
      kind: "local-store",
      classification: "synthetic",
    });
    const overview = await fetch(`${origin}/api/overview`).then((response) =>
      response.json(),
    );
    expect(
      overview.sources.map((source: { id: string }) => source.id).sort(),
    ).toEqual(["paypay", "sbi-securities"]);
    expect(existsSync(regularStore)).toBe(existedBefore);
    const forbidden = await fetch(`${origin}/api/meta`, {
      headers: { host: "evil.example" },
    });
    expect(forbidden.status).toBe(403);
    expect(
      (await fetch(`${origin}/api/transactions`, { method: "POST" })).status,
    ).toBe(405);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await reader.cancel();
  }
}, 20_000);
