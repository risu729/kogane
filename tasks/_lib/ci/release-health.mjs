import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HEALTH_POLICY = Object.freeze({
  totalMs: 205000,
  requestMs: 30000,
  delayMs: 5000,
  maxAttempts: 6,
});
const SHA = /^[0-9a-f]{40}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code) => {
  throw new Error(code);
};

/** An old identity is retryable only after every health/schema check passes. */
export function assessReleaseHealth(body, expectedSha, expectedMigration) {
  if (
    typeof expectedSha !== "string" ||
    !SHA.test(expectedSha) ||
    typeof expectedMigration !== "string"
  )
    fail("health_target_invalid");
  if (
    !object(body) ||
    !object(body.core) ||
    !object(body.read) ||
    !object(body.processor) ||
    !object(body.data) ||
    !object(body.grants) ||
    !object(body.capabilities) ||
    typeof body.releaseSha !== "string" ||
    !SHA.test(body.releaseSha) ||
    typeof body.processor.releaseSha !== "string" ||
    !SHA.test(body.processor.releaseSha) ||
    !Array.isArray(body.core.migrationsApplied) ||
    !body.core.migrationsApplied.every((value) => typeof value === "string") ||
    typeof body.read.required !== "boolean" ||
    typeof body.read.ok !== "boolean" ||
    typeof body.data.markerPresent !== "boolean"
  )
    fail("health_response_invalid");
  if (
    body.status !== "ok" ||
    body.core.bound !== true ||
    body.core.ok !== true ||
    body.data.bound !== true ||
    body.data.ok !== true ||
    body.grants.usable !== true ||
    body.processor.ok !== true ||
    (body.read.required && (body.read.bound !== true || body.read.ok !== true))
  )
    fail("health_unhealthy");
  if (expectedMigration !== "" && !body.core.migrationsApplied.includes(expectedMigration))
    fail("health_core_migration_missing");
  return body.releaseSha === expectedSha && body.processor.releaseSha === expectedSha
    ? "ready"
    : "identity_pending";
}

function policyFor(overrides) {
  const policy = { ...HEALTH_POLICY, ...overrides };
  for (const key of Object.keys(policy)) {
    if (
      !Object.hasOwn(HEALTH_POLICY, key) ||
      !Number.isSafeInteger(policy[key]) ||
      policy[key] < 1 ||
      policy[key] > HEALTH_POLICY[key]
    )
      fail("health_policy_invalid");
  }
  return Object.freeze(policy);
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) fail("health_response_invalid");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) fail("health_response_invalid");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("health_response_invalid");
  }
}

/** One request timer includes fetch and the entire body, even for a stalled body reader. */
async function readHealth({ url, clientId, clientSecret, fetchImpl, now, deadline, requestMs }) {
  const controller = new AbortController();
  const remaining = deadline - now();
  if (remaining <= 0) fail("health_deadline_exceeded");
  const budget = Math.min(remaining, requestMs);
  const requestDeadline = now() + budget;
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(now() >= deadline ? "health_deadline_exceeded" : "health_transport_unavailable"),
      );
    }, budget);
  });
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
      });
    } catch {
      fail("health_transport_unavailable");
    }
    if (response.redirected || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      fail("health_http_rejected");
    }
    let body;
    try {
      body = await boundedBody(response);
    } catch (error) {
      if (error?.message === "health_response_invalid") throw error;
      fail("health_transport_unavailable");
    }
    if (now() >= deadline) fail("health_deadline_exceeded");
    if (now() >= requestDeadline) fail("health_transport_unavailable");
    return body;
  })();
  try {
    return await Promise.race([operation, expiry]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function pollReleaseHealth({
  url,
  expectedSha,
  expectedMigration,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = () => performance.now(),
  policy: overrides = {},
}) {
  const started = now();
  const policy = policyFor(overrides);
  const deadline = started + policy.totalMs;
  // Capture immutable target strings before any asynchronous read.
  const targetSha = expectedSha,
    migration = expectedMigration;
  if (
    typeof targetSha !== "string" ||
    !SHA.test(targetSha) ||
    typeof migration !== "string" ||
    (migration !== "" && !/^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(migration))
  )
    fail("health_target_invalid");
  if (
    typeof clientId !== "string" ||
    !clientId ||
    typeof clientSecret !== "string" ||
    !clientSecret
  )
    fail("health_credentials_missing");
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    fail("health_url_invalid");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/api/ops/v1/health" ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))
    )
  )
    fail("health_url_invalid");
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (now() >= deadline) fail("health_deadline_exceeded");
    let body,
      outcome = "transport_pending";
    try {
      body = await readHealth({
        url: endpoint.href,
        clientId,
        clientSecret,
        fetchImpl,
        now,
        deadline,
        requestMs: policy.requestMs,
      });
      outcome = assessReleaseHealth(body, targetSha, migration);
    } catch (error) {
      if (now() >= deadline) fail("health_deadline_exceeded");
      if (error?.message !== "health_transport_unavailable") throw error;
    }
    // Parsing, semantic checks and final acceptance share the original total deadline.
    if (now() >= deadline) fail("health_deadline_exceeded");
    if (outcome === "ready")
      return Object.freeze({
        status: "verified",
        releaseSha: targetSha,
        attempts: attempt,
        readRequired: body.read.required,
        markerPresent: body.data.markerPresent,
        deadline,
      });
    if (attempt === policy.maxAttempts)
      fail(
        outcome === "identity_pending" ? "health_identity_pending" : "health_transport_unavailable",
      );
    const waitMs = Math.min(policy.delayMs, deadline - now());
    if (waitMs <= 0) fail("health_deadline_exceeded");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    // A capped final wait cannot start an additional read if a timer fires early.
    if (waitMs < policy.delayMs) fail("health_deadline_exceeded");
  }
  fail("health_identity_pending");
}

export async function main(env = process.env) {
  const order = JSON.parse(readFileSync("infra/deploy-order.json", "utf8"));
  const rows = order.workers.filter((worker) => worker.deploy && worker.healthAuth === "access");
  if (
    rows.length !== 1 ||
    rows[0].name !== "app" ||
    rows[0].healthPath !== "/api/ops/v1/health" ||
    rows[0].healthIdentity !== "releaseSha" ||
    !/^[a-z0-9-]{1,63}$/u.test(rows[0].worker) ||
    !/^[a-z0-9-]+\.workers\.dev$/u.test(order.workersDevSubdomain)
  )
    fail("health_order_invalid");
  const selected = JSON.parse(env.SELECTED ?? "null");
  if (!Array.isArray(selected) || !selected.every((name) => typeof name === "string"))
    fail("health_selection_invalid");
  if (!selected.includes("app")) {
    console.log("health_app_not_selected");
    return;
  }
  const manifest = JSON.parse(readFileSync(`${env.RUNNER_TEMP}/release-manifest.json`, "utf8"));
  if (manifest.sha !== env.SHA || !Array.isArray(manifest.migrations?.core?.files))
    fail("health_manifest_invalid");
  const expectedMigration = manifest.migrations.core.files.at(-1)?.file ?? "";
  const result = await pollReleaseHealth({
    url: `https://${rows[0].worker}.${order.workersDevSubdomain}${rows[0].healthPath}`,
    expectedSha: env.SHA,
    expectedMigration,
    clientId: env.CF_ACCESS_CLIENT_ID,
    clientSecret: env.CF_ACCESS_CLIENT_SECRET,
  });
  if (performance.now() >= result.deadline) fail("health_deadline_exceeded");
  const line = `Authenticated App/Processor health verified: release ${result.releaseSha}, attempts ${result.attempts}, read required=${result.readRequired}, marker=${result.markerPresent}.`;
  // No response body, credential, provider message or verified proof file is written.
  if (performance.now() >= result.deadline) fail("health_deadline_exceeded");
  console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const code =
      typeof error?.message === "string" && /^health_[a-z_]+$/u.test(error.message)
        ? error.message
        : "health_internal_error";
    console.error(code);
    process.exitCode = 1;
  }
}
