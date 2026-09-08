import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
const [command = "catchup", argument = "100", source] = process.argv.slice(2);
if (!["catchup", "revise"].includes(command))
  throw new Error(
    "Usage: identity-ops.ts catchup <max sweeps> [source] | revise <local JSON file>",
  );
const count = command === "catchup" ? Number(argument) : 1;
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("Invalid sweep count");
if (source && !/^[a-z0-9-]{1,100}$/.test(source)) throw new Error("Invalid source");
const body = command === "revise" ? readFileSync(argument, "utf8") : undefined;
if (body && Buffer.byteLength(body) > 4096) throw new Error("Revision body too large");
const proxy = await getPlatformProxy<{ OBSERVATIONS: Fetcher }>({
  configPath: new URL("../wrangler.ops.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
try {
  for (let index = 0; index < count; index++) {
    const path =
      command === "revise"
        ? "identity-revise"
        : `identity-sweep?maxRuns=40${source ? `&source=${source}` : ""}`;
    const response = await proxy.env.OBSERVATIONS.fetch(`https://observations.internal/${path}`, {
      method: "POST",
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw new Error(`Identity service HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid service result");
    console.log(JSON.stringify({ sweep: index + 1, ...result }));
    if ("processedRuns" in result && result.processedRuns === 0) break;
  }
} finally {
  await proxy.dispose();
}
