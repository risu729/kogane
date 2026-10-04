import { readFileSync } from "node:fs";
import { verifyAlarmCronRemoval } from "./alarm-cron-readback.mjs";
const order = JSON.parse(readFileSync("infra/deploy-order.json", "utf8"));
const app = order.workers.find((worker) => worker.name === "app");
const jobs = JSON.parse(readFileSync("config/alarm-jobs.json", "utf8"));
const client = process.env.CF_ACCESS_CLIENT_ID,
  secret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!client || !secret) throw new Error("schedule_bootstrap_credentials_missing");
const cronWorkers = await verifyAlarmCronRemoval({
  jobs,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  token: process.env.CLOUDFLARE_API_TOKEN,
});
console.log(`Cron removal verified: ${cronWorkers} Workers have no Cron triggers.`);
const started = Date.now();
const response = await fetch(
  `https://${app.worker}.${order.workersDevSubdomain}/api/ops/v1/schedules/bootstrap`,
  {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(120000),
    headers: { "CF-Access-Client-Id": client, "CF-Access-Client-Secret": secret },
  },
);
if (response.status !== 200) throw new Error(`schedule_bootstrap_http_${response.status}`);
const result = await response.json();
if (
  result.status !== "armed" ||
  !Array.isArray(result.reservations) ||
  result.reservations.length !== jobs.length
)
  throw new Error("schedule_bootstrap_incomplete");
const ids = new Set();
let armed = 0;
for (const reservation of result.reservations) {
  if (
    ids.has(reservation.id) ||
    !jobs.some((job) => job.id === reservation.id) ||
    typeof reservation.enabled !== "boolean"
  )
    throw new Error("schedule_bootstrap_invalid_identity");
  ids.add(reservation.id);
  if (reservation.enabled) {
    if (
      !Number.isFinite(Date.parse(reservation.actualAlarmAt)) ||
      Date.parse(reservation.actualAlarmAt) < started - 30000
    )
      throw new Error("schedule_bootstrap_reservation_missing");
    armed++;
  } else if (reservation.actualAlarmAt !== null)
    throw new Error("schedule_bootstrap_disabled_alarm");
}
console.log(`Schedule reservations verified: ${armed} armed, ${jobs.length - armed} disabled.`);
