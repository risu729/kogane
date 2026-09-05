import { describe, expect, test } from "bun:test";

describe("GLOBAL PASS raw-evidence backfill script", () => {
  test("reads a private token safely and preserves the source outbox", async () => {
    const script = await Bun.file(
      new URL("../scripts/backfill-raw-evidence.sh", import.meta.url),
    ).text();
    expect(script).toContain("O_NOFOLLOW");
    expect(script).toContain("S_ISREG");
    expect(script).toContain("owned by the current user");
    expect(script).toContain("must have mode 0600");
    expect(script).toContain("length($value) < 20");
    expect(script).toContain("limit=1");
    expect(script).toContain(".deferredManifestCount");
    expect(script).toContain("deferredChunks");
    expect(script).toContain("backfill cursor did not advance");
    expect(script).not.toMatch(
      /(?:wrangler\s+r2\s+object\s+delete|SNAPSHOTS\.delete|rm\s+[^\n]*raw\/prestia-globalpass)/u,
    );
  });
});
