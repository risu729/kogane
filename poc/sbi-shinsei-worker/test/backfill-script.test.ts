import { describe, expect, test } from "bun:test";

describe("SBI Shinsei raw-evidence backfill script", () => {
  test("keeps the source outbox private and supports a one-manifest canary", async () => {
    const script = await Bun.file(
      new URL("../scripts/backfill-raw-evidence.sh", import.meta.url),
    ).text();

    expect(script).toContain("O_NOFOLLOW");
    expect(script).toContain("S_ISREG");
    expect(script).toContain("must have mode 0600");
    expect(script).toContain("KOGANE_STOP_AFTER_MANIFEST");
    expect(script).toContain('"stoppedAfterManifest":true');
    expect(script).not.toContain("failedManifestKey");
    expect(script).not.toMatch(/(?:wrangler\s+r2\s+object\s+delete|SNAPSHOTS\.delete|SBI_SHINSEI_SNAPSHOTS\.delete)/u);
  });
});
