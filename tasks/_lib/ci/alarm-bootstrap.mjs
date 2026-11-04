import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyAlarmCronRemoval } from "./alarm-cron-readback.mjs";

export const BOOTSTRAP_POLICY = Object.freeze({ totalMs: 120000, maxAttempts: 6, delayMs: 5000 });
const SHA = /^[0-9a-f]{40}$/u;
const fail = (code) => {
  throw new Error(code);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function policyFor(overrides) {
  const policy = { ...BOOTSTRAP_POLICY, ...overrides };
  for (const key of Object.keys(policy))
    if (
      !Object.hasOwn(BOOTSTRAP_POLICY, key) ||
      !Number.isSafeInteger(policy[key]) ||
      policy[key] < 1 ||
      policy[key] > BOOTSTRAP_POLICY[key]
    )
      fail("schedule_bootstrap_policy_invalid");
  return Object.freeze(policy);
}
async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) fail("schedule_bootstrap_invalid_response");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) fail("schedule_bootstrap_invalid_response");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
  } catch {
    fail("schedule_bootstrap_invalid_response");
  }
}
async function postOnce({ url, expectedSha, clientId, clientSecret, fetchImpl, now, deadline }) {
  const remaining = deadline - now();
  if (remaining <= 0) fail("schedule_bootstrap_deadline_exceeded");
  const controller = new AbortController();
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("schedule_bootstrap_deadline_exceeded"));
    }, remaining);
  });
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "x-kogane-release-sha": expectedSha,
        },
      });
    } catch {
      fail("schedule_bootstrap_uncertain");
    }
    if (response.redirected || ![200, 503].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      fail("schedule_bootstrap_http_rejected");
    }
    let body;
    try {
      body = await boundedBody(response);
    } catch (error) {
      if (error?.message === "schedule_bootstrap_invalid_response") throw error;
      fail("schedule_bootstrap_uncertain");
    }
    if (now() >= deadline) fail("schedule_bootstrap_deadline_exceeded");
    return { status: response.status, body };
  })();
  try {
    return await Promise.race([operation, expiry]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function prewriteRefusal(body) {
  if (!object(body) || body.error !== "release_mismatch") return false;
  const keys = Object.keys(body).sort();
  if (keys.length === 1) return keys[0] === "error";
  return (
    keys.length === 2 &&
    keys[0] === "error" &&
    keys[1] === "requestId" &&
    typeof body.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body.requestId)
  );
}
function reservations(body, ids, expectedSha, startedWall) {
  if (
    !object(body) ||
    body.status !== "armed" ||
    !Array.isArray(body.reservations) ||
    body.reservations.length !== ids.size
  )
    fail("schedule_bootstrap_incomplete");
  // A 200 can follow writes. Missing/old identity must fail without replay.
  if (body.releaseSha !== expectedSha || body.processorReleaseSha !== expectedSha)
    fail("schedule_bootstrap_release_unverified");
  const seen = new Set();
  let armed = 0;
  for (const reservation of body.reservations) {
    if (
      !object(reservation) ||
      seen.has(reservation.id) ||
      !ids.has(reservation.id) ||
      typeof reservation.enabled !== "boolean"
    )
      fail("schedule_bootstrap_invalid_identity");
    seen.add(reservation.id);
    if (reservation.enabled) {
      if (
        typeof reservation.actualAlarmAt !== "string" ||
        !Number.isFinite(Date.parse(reservation.actualAlarmAt)) ||
        Date.parse(reservation.actualAlarmAt) < startedWall - 30000
      )
        fail("schedule_bootstrap_reservation_missing");
      armed++;
    } else if (reservation.actualAlarmAt !== null) fail("schedule_bootstrap_disabled_alarm");
  }
  return armed;
}
export async function bootstrapReleaseSchedules({
  url,
  expectedSha,
  jobs,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  policy: overrides = {},
}) {
  const started = now(),
    startedWall = wallNow();
  const policy = policyFor(overrides),
    deadline = started + policy.totalMs;
  const targetSha = expectedSha;
  if (typeof targetSha !== "string" || !SHA.test(targetSha))
    fail("schedule_bootstrap_target_invalid");
  if (
    typeof clientId !== "string" ||
    !clientId ||
    typeof clientSecret !== "string" ||
    !clientSecret
  )
    fail("schedule_bootstrap_credentials_missing");
  if (
    !Array.isArray(jobs) ||
    !jobs.length ||
    jobs.some((job) => typeof job?.id !== "string" || !/^[a-z0-9-]{1,100}$/u.test(job.id))
  )
    fail("schedule_bootstrap_jobs_invalid");
  const ids = new Set(jobs.map((job) => job.id));
  if (ids.size !== jobs.length) fail("schedule_bootstrap_jobs_invalid");
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    fail("schedule_bootstrap_url_invalid");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/api/ops/v1/schedules/bootstrap" ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))
    )
  )
    fail("schedule_bootstrap_url_invalid");
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (now() >= deadline) fail("schedule_bootstrap_deadline_exceeded");
    const response = await postOnce({
      url: endpoint.href,
      expectedSha: targetSha,
      clientId,
      clientSecret,
      fetchImpl,
      now,
      deadline,
    });
    if (response.status === 200) {
      const armed = reservations(response.body, ids, targetSha, startedWall);
      if (now() >= deadline) fail("schedule_bootstrap_deadline_exceeded");
      return Object.freeze({
        status: "verified",
        releaseSha: targetSha,
        armed,
        disabled: ids.size - armed,
        attempts: attempt,
        deadline,
      });
    }
    // This exact closed error is reserved for authenticated prewrite guards.
    if (!prewriteRefusal(response.body)) fail("schedule_bootstrap_http_rejected");
    if (now() >= deadline) fail("schedule_bootstrap_deadline_exceeded");
    if (attempt === policy.maxAttempts) fail("schedule_bootstrap_release_mismatch");
    const waitMs = Math.min(policy.delayMs, deadline - now());
    if (waitMs <= 0) fail("schedule_bootstrap_deadline_exceeded");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (waitMs < policy.delayMs) fail("schedule_bootstrap_deadline_exceeded");
  }
  fail("schedule_bootstrap_release_mismatch");
}
export async function main(env = process.env) {
  const targetSha = env.SHA;
  if (typeof targetSha !== "string" || !SHA.test(targetSha))
    fail("schedule_bootstrap_target_invalid");
  const order = JSON.parse(readFileSync("infra/deploy-order.json", "utf8"));
  const app = order.workers.find((worker) => worker.name === "app");
  if (
    !app ||
    !/^[a-z0-9-]{1,63}$/u.test(app.worker) ||
    !/^[a-z0-9-]+\.workers\.dev$/u.test(order.workersDevSubdomain)
  )
    fail("schedule_bootstrap_order_invalid");
  const jobs = JSON.parse(readFileSync("config/alarm-jobs.json", "utf8"));
  const clientId = env.CF_ACCESS_CLIENT_ID,
    clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) fail("schedule_bootstrap_credentials_missing");
  const cronWorkers = await verifyAlarmCronRemoval({
    jobs,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
  });
  console.log(`Cron removal verified: ${cronWorkers} Workers have no Cron triggers.`);
  const result = await bootstrapReleaseSchedules({
    url: `https://${app.worker}.${order.workersDevSubdomain}/api/ops/v1/schedules/bootstrap`,
    expectedSha: targetSha,
    jobs,
    clientId,
    clientSecret,
  });
  if (performance.now() >= result.deadline) fail("schedule_bootstrap_deadline_exceeded");
  const line = `Schedule reservations verified: ${result.armed} armed, ${result.disabled} disabled, release ${result.releaseSha}, attempts ${result.attempts}.`;
  if (performance.now() >= result.deadline) fail("schedule_bootstrap_deadline_exceeded");
  console.log(line);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      typeof error?.message === "string" && /^schedule_[a-z_]+$/u.test(error.message)
        ? error.message
        : "schedule_bootstrap_internal_error",
    );
    process.exitCode = 1;
  }
}
