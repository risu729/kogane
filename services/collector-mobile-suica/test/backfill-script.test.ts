import { describe, expect, test } from "bun:test";

describe("Mobile Suica raw-evidence backfill script", () => {
  test("reads a private token safely and preserves the source R2 outbox", async () => {
    const script = await Bun.file(
      new URL("../scripts/backfill-raw-evidence.sh", import.meta.url),
    ).text();
    expect(script).toContain("O_NOFOLLOW");
    expect(script).toContain("S_ISREG");
    expect(script).toContain("owned by the current user");
    expect(script).toContain("must have mode 0600");
    expect(script).toContain("length($value) < 20");
    expect(script).toContain("limit=1");
    expect(script).not.toMatch(
      /(?:wrangler\s+r2\s+object\s+delete|SNAPSHOTS\.delete|rm\s+[^\n]*raw\/mobile-suica)/u,
    );
  });
});
