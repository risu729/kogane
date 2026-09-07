import { describe, expect, test } from "bun:test";

describe("SMBC Direct raw evidence backfill script", () => {
  test("is syntactically valid and keeps cursor state outside the repository", async () => {
    const path = new URL("../scripts/backfill-raw-evidence.sh", import.meta.url);
    const process = Bun.spawn(["bash", "-n", path.pathname], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
    const script = await Bun.file(path).text();
    expect(script).toContain("smbc-direct-raw-evidence-backfill.cursor");
    expect(script).toContain("mode 0600");
    expect(script).toContain("cursor did not advance");
    expect(script).not.toContain("SMBC_CREDENTIAL_JSON");
  });

  test("syncs a dedicated admin bearer without writing its value to output", async () => {
    const script = await Bun.file(
      new URL("../scripts/sync-local-secrets.sh", import.meta.url),
    ).text();
    expect(script).toContain("ADMIN_TRIGGER_TOKEN");
    expect(script).toContain("admin_token_file");
    expect(script).toContain("chmod 600");
    expect(script).not.toMatch(/echo\s+["']?\$\{?admin_token/u);
  });
});
