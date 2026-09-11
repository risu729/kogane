import { getPlatformProxy } from "wrangler";

const LANES = ["incremental", "repair", "replay"];
const REPLAY = ["plan", "start", "pause", "resume", "cancel", "inspect"];
const usage =
  "Usage: node scripts/ops.ts status | catchup <1..1000 sweeps> | sweep <lane> [1..40 jobs] | replay <command> <json>";
const [command = "status", first = "1", second] = process.argv.slice(2);
const calls: { path: string; method: "GET" | "POST"; body?: string }[] = [];
if (command === "status") calls.push({ path: "status", method: "GET" });
else if (command === "catchup") {
  const count = Number(first);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error(usage);
  for (let index = 0; index < count; index++)
    calls.push({ path: "sweep?maxJobs=40", method: "POST" });
} else if (command === "sweep") {
  const jobs = Number(second ?? "0");
  if (!LANES.includes(first) || !Number.isInteger(jobs) || jobs < 0 || jobs > 40)
    throw new Error(usage);
  calls.push({ path: `sweep?lane=${first}${jobs ? `&maxJobs=${jobs}` : ""}`, method: "POST" });
} else if (command === "replay") {
  if (!REPLAY.includes(first) || typeof second !== "string") throw new Error(usage);
  // Parse locally so a malformed command fails before any remote call.
  calls.push({ path: `replay/${first}`, method: "POST", body: JSON.stringify(JSON.parse(second)) });
} else throw new Error(usage);
const proxy = await getPlatformProxy<{ OBSERVATIONS: Fetcher }>({
  configPath: new URL("../wrangler.ops.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
try {
  for (const [index, call] of calls.entries()) {
    const response = await proxy.env.OBSERVATIONS.fetch(
      `https://observations.internal/${call.path}`,
      call.body === undefined
        ? { method: call.method }
        : { method: call.method, body: call.body, headers: { "content-type": "application/json" } },
    );
    if (!response.ok) throw new Error(`Observation service HTTP ${response.status}`);
    console.log(JSON.stringify({ sweep: index + 1, ...((await response.json()) as object) }));
  }
} finally {
  await proxy.dispose();
}
