import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const retired = [
  "globalpass",
  "vpass",
  "myjcb",
  "sbi-securities",
  "sbi-shinsei",
  "sony-bank",
  "mobile-suica",
  "moneyforward",
  "vpoint",
  "mizuho",
  "prestia-bank",
  "vpoint-pay",
  "smbc-direct",
];
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("collector admin retirement inventory", () => {
  for (const name of retired)
    test(`${name}: no declared or runtime admin dependency`, () => {
      const directory = `services/collector-${name}`;
      for (const file of [
        "src/worker.ts",
        "env.d.ts",
        "cloudflare.config.ts",
        "wrangler.jsonc",
        ".dev.vars.example",
        "scripts/sync-local-secrets.sh",
      ]) {
        const path = `${directory}/${file}`;
        if (existsSync(resolve(root, path)))
          expect(read(path)).not.toMatch(/ADMIN_(?:TRIGGER_)?TOKEN|admin_token_file/);
      }
      const entrypoint = `${directory}/src/schedule-entrypoint.ts`;
      if (existsSync(resolve(root, entrypoint))) {
        const source = read(entrypoint);
        expect(source).toContain("runOperation");
        expect(source).not.toMatch(
          /export\s*\*|runCollection|runSharedCollection|createCollection/,
        );
      }
    });
  test("retired callers cannot upload an admin token or invoke an obsolete trigger", () => {
    for (const path of [
      "globalpass/scripts/trigger.sh",
      "moneyforward/scripts/trigger.sh",
      "sbi-securities/scripts/trigger.sh",
      "sbi-securities/scripts/backfill.sh",
      "sbi-shinsei/scripts/sync-admin-trigger-token.sh",
      "sbi-shinsei/test/admin-token-sync.test.sh",
    ])
      expect(existsSync(resolve(root, `services/collector-${path}`))).toBe(false);
  });
  test("the two recovery consumers and non-admin secret boundaries remain explicit", () => {
    expect(read("services/collector-sbi-vc-trade/src/worker.ts")).toContain("env.ADMIN_TOKEN");
    expect(read("services/collector-st-george/src/worker.ts")).toContain("env.ADMIN_TRIGGER_TOKEN");
    for (const name of ["globalpass", "sbi-shinsei", "st-george"])
      expect(read(`services/collector-${name}/src/worker.ts`)).toContain("env.RELAY_TOKEN");
    for (const name of ["sbi-vc-trade", "smbc-direct"])
      expect(read(`services/collector-${name}/cloudflare.config.ts`)).toContain(
        "SESSION_ENCRYPTION_KEY",
      );
  });
});
