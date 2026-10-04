// Aggregate-only, explicitly read-only D1 diagnostic. No caller-supplied SQL,
// output files, financial values, model requests or adoption operations.
import { execFileSync } from "node:child_process";
import { CARD_SETTLEMENT_AUTOMATION_SHADOW_SQL } from "../src/card-settlement-shadow.ts";
import { CARD_SETTLEMENT_AUTOMATION_POLICY } from "../../../packages/domain/src/card-settlement-automation.ts";

if (process.argv.slice(2).join(" ") !== "--remote") {
  console.log("Usage: mise run //services/processor:settlement:shadow -- --remote");
  process.exit(process.argv.length > 2 ? 1 : 0);
}
try {
  const output = execFileSync(
    "./node_modules/.bin/wrangler",
    [
      "d1",
      "execute",
      "kogane-raw-evidence",
      "--remote",
      "--config",
      "wrangler.jsonc",
      "--command",
      CARD_SETTLEMENT_AUTOMATION_SHADOW_SQL,
      "--json",
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90000,
    },
  );
  const result = JSON.parse(output) as { success: boolean; results: Record<string, unknown>[] }[];
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    !result[0]?.success ||
    result[0].results.length !== 1
  )
    throw new Error("invalid");
  const counts = result[0].results[0]!;
  if (!Object.values(counts).every((value) => Number.isSafeInteger(value) && Number(value) >= 0))
    throw new Error("invalid");
  console.log(
    JSON.stringify({
      policy: CARD_SETTLEMENT_AUTOMATION_POLICY,
      mode: "read-only-prerequisites",
      policyAuthorizationConfigured: false,
      adoptionEnabled: false,
      counts,
    }),
  );
} catch {
  console.error("card_settlement_shadow_query_failed");
  process.exitCode = 1;
}
