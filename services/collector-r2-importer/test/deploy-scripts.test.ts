import { describe, expect, test } from "bun:test";

describe("collector R2 importer deployment scripts", () => {
  test("syncs all required secret names before deploying without deleting unrelated secrets", async () => {
    const deploy = await Bun.file(new URL("../scripts/deploy.sh", import.meta.url)).text();
    const sync = await Bun.file(new URL("../scripts/sync-secrets.sh", import.meta.url)).text();
    const config = JSON.parse(
      await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text(),
    ) as { secrets: { required: string[] } };
    const required = [
      "RAW_EVIDENCE_TOKEN",
      "RAW_EVIDENCE_TOKEN_SBI_VC",
      "RAW_EVIDENCE_TOKEN_SONY",
      "RAW_EVIDENCE_TOKEN_SBI_SHINSEI",
      "RAW_EVIDENCE_TOKEN_MOBILE_SUICA",
      "RAW_EVIDENCE_TOKEN_GLOBAL_PASS",
      "ORIGIN_FINGERPRINT_KEY",
    ];

    expect(deploy.indexOf("bash scripts/sync-secrets.sh"))
      .toBeLessThan(deploy.indexOf("npx wrangler deploy"));
    expect(sync).toContain("wrangler secret bulk");
    expect(sync).toContain("wrangler secret list --format json");
    expect(sync).not.toContain("wrangler secret delete");
    expect(sync).not.toContain("wrangler secret put RAW_EVIDENCE_TOKEN");
    expect(config.secrets.required).toEqual(required);
  });
});
