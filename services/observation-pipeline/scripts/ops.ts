import { getPlatformProxy } from "wrangler";

const [command = "status", countText = "1"] = process.argv.slice(2);
const count = Number(countText);
if (
  !["status", "catchup"].includes(command) ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 1000
) {
  throw new Error("Usage: node scripts/ops.ts status | catchup <1..1000 sweeps>");
}
const proxy = await getPlatformProxy<{ OBSERVATIONS: Fetcher }>({
  configPath: new URL("../wrangler.ops.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
try {
  for (let index = 0; index < (command === "status" ? 1 : count); index++) {
    const response = await proxy.env.OBSERVATIONS.fetch(
      `https://observations.internal/${command === "status" ? "status" : "sweep?maxJobs=40"}`,
      { method: command === "status" ? "GET" : "POST" },
    );
    if (!response.ok) throw new Error(`Observation service HTTP ${response.status}`);
    console.log(JSON.stringify({ sweep: index + 1, ...((await response.json()) as object) }));
  }
} finally {
  await proxy.dispose();
}
