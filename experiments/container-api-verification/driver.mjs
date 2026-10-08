// The driver never deploys, deletes, expands permissions, reads secret stores or invokes banks.
import { pathToFileURL } from "node:url";
import {
  readFileSync,
  writeFileSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
  lstatSync,
  realpathSync,
} from "node:fs";
import { canonicalHex, canonicalUuid, canonicalImageRef } from "./identifiers.mjs";
import { resolve } from "node:path";
import { BACKPRESSURE_MAX_CHUNKS } from "./container/server.mjs";
import { createSyntheticRequest } from "./http-diagnostics.mjs";

const workerName = "kogane-container-api-verification";
const appName = `${workerName}-verificationcontainer`;
const closed = (code) => {
  throw new Error(`verification_${code}`);
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function recordPath(temp, name) {
  if (
    ![
      "container-api-verification-baseline.json",
      "container-api-verification-recovery.json",
    ].includes(name)
  )
    closed("record");
  const directory = lstatSync(temp);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid() ||
    realpathSync(temp) !== resolve(temp)
  )
    closed("record");
  return resolve(temp, name);
}
function recordDescriptor(fd) {
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid !== process.getuid() ||
    stat.size > 1024
  )
    closed("record");
}
export function readRecord(temp, name) {
  let fd;
  try {
    fd = openSync(recordPath(temp, name), constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
    recordDescriptor(fd);
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function writeRecord(temp, name, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 1024) closed("record");
  let fd;
  try {
    fd = openSync(
      recordPath(temp, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    recordDescriptor(fd);
    writeFileSync(fd, text);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function baselineRecord(value, account) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "appId,image,namespace,workerVersion"
  )
    closed("baseline");
  return {
    appId: canonicalUuid(value.appId),
    namespace: canonicalHex(value.namespace, 32),
    image: canonicalImageRef(value.image, account),
    workerVersion: canonicalUuid(value.workerVersion),
  };
}
export function recoveryRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "processIdentity"
  )
    closed("recovery_baseline");
  return { processIdentity: canonicalUuid(value.processIdentity) };
}
export function identity(app, version) {
  const binding = version.resources?.bindings?.filter(
    (entry) =>
      entry.type === "durable_object_namespace" &&
      entry.name === "HARNESS" &&
      entry.class_name === "VerificationContainer" &&
      (entry.script_name === undefined || entry.script_name === workerName),
  );
  if (
    !Array.isArray(binding) ||
    binding.length !== 1 ||
    !/^[a-f0-9]{32}$/u.test(binding[0].namespace_id ?? "") ||
    app.name !== appName ||
    app.scheduling_policy !== "default" ||
    app.configuration?.vcpu !== 0.25 ||
    app.configuration?.memory_mib !== 1024 ||
    app.configuration?.disk?.size_mb !== 4000 ||
    app.max_instances !== 1 ||
    JSON.stringify(app.constraints?.regions) !== JSON.stringify(["APAC"]) ||
    app.durable_objects?.namespace_id !== binding[0].namespace_id ||
    !/^registry\.cloudflare\.com\/[a-z0-9_-]+\/kogane-container-api-verification-verificationcontainer@sha256:[a-f0-9]{64}$/u.test(
      app.configuration?.image ?? "",
    )
  )
    closed("identity");
  return {
    appId: canonicalUuid(app.id),
    namespace: canonicalHex(binding[0].namespace_id, 32),
    image: canonicalImageRef(app.configuration.image, app.account_id),
  };
}
export function sameIdentity(before, after) {
  return (
    before.appId === after.appId &&
    before.namespace === after.namespace &&
    before.image === after.image
  );
}
/** SDK readiness callbacks are per caller; process identity measures the process serving POSTs. */
export async function verifyConcurrency({ phase, json }) {
  if (!["baseline_sdk", "native", "native_unmonitored", "rollback_sdk"].includes(phase))
    closed("phase");
  const before = await json("/state");
  if (before?.running !== 0) closed("concurrency_state");
  const replies = await Promise.all([
    json("/once", "POST", "concurrency"),
    json("/once", "POST", "concurrency"),
  ]);
  const after = await json("/state"),
    stats = await json("/stats");
  if (replies.some((reply) => reply?.accepted !== 1) || stats?.posts !== 2)
    closed("concurrency_posts");
  let processIdentity;
  try {
    processIdentity = canonicalUuid(stats.processIdentity);
    if (replies.some((reply) => canonicalUuid(reply?.processIdentity) !== processIdentity))
      closed("concurrency_process");
  } catch {
    closed("concurrency_process");
  }
  if (after?.running !== 1) closed("concurrency_state");
  if (
    (phase === "native" || phase === "native_unmonitored") &&
    (!Number.isSafeInteger(before.starts) ||
      before.starts < 0 ||
      !Number.isSafeInteger(after.starts) ||
      after.starts - before.starts !== 1)
  )
    closed("concurrency_start");
}

export async function verifyBackpressure({ request, json, wait = pause, now = Date.now }) {
  const baseline = await json("/stats");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(baseline.processIdentity ?? ""))
    closed("backpressure");
  const reader = (await request("/backpressure")).body?.getReader();
  if (!reader) closed("backpressure");
  try {
    const first = await reader.read();
    if (first.done || first.value.byteLength === 0) closed("backpressure");
    // Stop consuming. This unpaced source must stall, rather than finish inside
    // proxy/client buffers; a tiny paced stream would not establish backpressure.
    await wait(1000);
    const stalled = await json("/stats");
    const started = now();
    await wait(35_000);
    const after = await json("/stats");
    if (
      now() - started < 30_000 ||
      stalled.processIdentity !== baseline.processIdentity ||
      after.processIdentity !== baseline.processIdentity ||
      stalled.streams !== 1 ||
      after.streams !== 1 ||
      stalled.posts !== baseline.posts ||
      after.posts !== baseline.posts ||
      !Number.isSafeInteger(stalled.backpressureChunks) ||
      stalled.backpressureChunks < 1 ||
      stalled.backpressureChunks >= BACKPRESSURE_MAX_CHUNKS ||
      after.backpressureChunks !== stalled.backpressureChunks
    )
      closed("backpressure");
  } finally {
    await reader.cancel();
  }
}
export async function verifyPhase({
  phase,
  temp,
  subdomain,
  key,
  accountId,
  apiToken,
  appId,
  fetchImpl = fetch,
  report = console.log,
}) {
  if (
    !["baseline_sdk", "native", "native_unmonitored", "native_recovered", "rollback_sdk"].includes(
      phase,
    ) ||
    !temp
  )
    closed("phase");
  if (
    !/^[a-z0-9-]+$/u.test(subdomain ?? "") ||
    !key ||
    !/^[a-f0-9]{32}$/u.test(accountId ?? "") ||
    !apiToken ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(appId ?? "")
  )
    closed("inputs");
  const origin = `https://${workerName}.${subdomain}.workers.dev`;
  const counts = {
    phases: 0,
    identityMatches: 0,
    sentinelMatches: 0,
    concurrencyChecks: 0,
    longDelayChecks: 0,
    longStreamChecks: 0,
    backpressureChecks: 0,
    cancelChecks: 0,
    streamFailureChecks: 0,
    idleChecks: 0,
    destroyRestartChecks: 0,
    signalChecks: 0,
    nonzeroExitChecks: 0,
    recoveryChecks: 0,
    sdkAlarmChecks: 0,
  };
  const request = createSyntheticRequest({ origin, key, fetchImpl });
  async function json(path, method = "GET", substage) {
    try {
      return await (await request(path, method, substage)).json();
    } catch (error) {
      if (error?.message?.startsWith("verification_")) throw error;
      closed("response");
    }
  }
  async function api(path) {
    let response, body;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
        {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
          headers: { authorization: `Bearer ${apiToken}` },
        },
      );
    } catch {
      closed("identity_transport");
    }
    if (response.status !== 200) closed("identity_http");
    try {
      body = await response.json();
    } catch {
      closed("identity_response");
    }
    if (body?.success !== true || body.result === undefined) closed("identity_response");
    return body.result;
  }
  async function snapshot() {
    const app = await api(`containers/applications/${appId}`);
    const versions = (await api(`workers/scripts/${workerName}/deployments`)).deployments?.[0]
      ?.versions;
    if (
      !Array.isArray(versions) ||
      versions.length !== 1 ||
      versions[0].percentage !== 100 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(versions[0].version_id ?? "")
    )
      closed("allocation");
    if (app.id !== appId || app.account_id !== accountId || app.active_rollout_id != null)
      closed("application");
    const applicationVersions = await api(`containers/applications/${appId}/versions`);
    if (
      !Number.isSafeInteger(app.version) ||
      app.version < 0 ||
      !Array.isArray(applicationVersions) ||
      applicationVersions.filter(
        (entry) =>
          entry.version === app.version &&
          entry.percentage === 100 &&
          entry.configuration?.image === app.configuration?.image,
      ).length !== 1 ||
      applicationVersions.some((entry) => entry.version !== app.version && entry.percentage !== 0)
    )
      closed("application_rollout");
    return {
      ...identity(
        app,
        await api(`workers/scripts/${workerName}/versions/${versions[0].version_id}`),
      ),
      workerVersion: canonicalUuid(versions[0].version_id),
    };
  }
  async function waitState(predicate, timeout = 90_000) {
    const deadline = Date.now() + timeout;
    do {
      const state = await json("/state");
      if (predicate(state)) return state;
      await pause(3000);
    } while (Date.now() < deadline);
    closed("state_timeout");
  }
  const state = await json("/state");
  if (state.revision !== (phase === "rollback_sdk" ? "baseline_sdk" : phase)) closed("revision");
  let baseline;
  if (phase !== "baseline_sdk") {
    try {
      baseline = baselineRecord(
        readRecord(temp, "container-api-verification-baseline.json"),
        accountId,
      );
    } catch {
      closed("baseline");
    }
  }
  if (phase === "baseline_sdk") await json("/initialize", "POST");
  const sentinel = await json("/state");
  if (sentinel.kvSentinelMatch !== 1 || sentinel.sqlSentinelMatch !== 1) closed("sentinel");
  counts.sentinelMatches++;
  const current = await snapshot();
  if (!baseline) {
    baseline = baselineRecord(current, accountId);
    writeRecord(temp, "container-api-verification-baseline.json", baseline);
  }
  if (!sameIdentity(baseline, current)) closed("identity_changed");
  counts.identityMatches++;
  if (phase === "rollback_sdk" && current.workerVersion !== baseline.workerVersion)
    closed("rollback_version");
  if (phase === "native_recovered") {
    // The previous phase deliberately leaves the process active before redeploy.
    let recovery;
    try {
      recovery = recoveryRecord(readRecord(temp, "container-api-verification-recovery.json"));
    } catch {
      closed("recovery_baseline");
    }
    if (state.running !== 1 || (await json("/stats")).processIdentity !== recovery.processIdentity)
      closed("recovery");
    counts.recoveryChecks++;
    counts.phases++;
    report(JSON.stringify({ code: "verification_phase_complete", phase, ...counts }));
    return counts; // Parent cancels the hold before any destroy or rollback.
  }
  await json("/destroy", "POST");
  await verifyConcurrency({ phase, json });
  counts.concurrencyChecks++;
  const start = Date.now();
  const delayed = await json("/delay");
  if (delayed.completed !== 1 || Date.now() - start < 30_000 || (await json("/stats")).posts !== 2)
    closed("delay");
  counts.longDelayChecks++;
  const streamStart = Date.now(),
    stream = await request("/stream");
  const reader = stream.body?.getReader();
  if (!reader) closed("stream");
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
  }
  if (bytes !== 40 || Date.now() - streamStart < 30_000 || (await json("/stats")).posts !== 2)
    closed("stream");
  counts.longStreamChecks++;
  await verifyBackpressure({ request, json });
  counts.backpressureChecks++;
  const canceled = (await request("/stream")).body?.getReader();
  if (!canceled) closed("cancel");
  await canceled.read();
  await canceled.cancel();
  counts.cancelChecks++;
  const failure = (await request("/stream-error")).body?.getReader();
  if (!failure) closed("stream_failure");
  let failed = false;
  try {
    while (!(await failure.read()).done) {
      /* Only synthetic bytes. */
    }
  } catch {
    failed = true;
  }
  if (!failed) closed("stream_failure");
  counts.streamFailureChecks++;
  // State polling never sends container traffic, starts a process or resets its idle timer.
  const idleStarted = Date.now();
  await waitState((value) => value.running === 0);
  counts.idleChecks++;
  counts.idleObservedMs = Date.now() - idleStarted;
  await json("/once", "POST", "idle_restart");
  await json("/destroy", "POST");
  if ((await json("/state")).running !== 0) closed("destroy");
  await json("/once", "POST", "destroy_restart");
  if ((await json("/stats")).posts !== 1) closed("restart");
  counts.destroyRestartChecks++;
  await json("/signal", "POST");
  await waitState((value) => value.running === 0);
  counts.signalChecks++;
  if (["native", "native_recovered"].includes(phase) && (await json("/state")).signaled < 1)
    closed("signal_diagnostic");
  await json("/once", "POST", "signal_restart");
  await json("/exit", "POST");
  await waitState((value) => value.running === 0);
  counts.nonzeroExitChecks++;
  if (["native", "native_recovered"].includes(phase) && (await json("/state")).exitSeven < 1)
    closed("exit_diagnostic");
  if (phase === "baseline_sdk" || phase === "rollback_sdk") {
    await json("/once", "POST", "exit_restart");
    if ((await json("/state")).sdkAlarmPresent !== 1) closed("sdk_alarm");
    counts.sdkAlarmChecks++;
  }
  await json("/destroy", "POST");
  counts.phases++;
  report(JSON.stringify({ code: "verification_phase_complete", phase, ...counts }));
  return counts;
  // This driver proves control-plane/process checks only; no billable-usage assertion.
}
export async function recoveryHold({
  temp,
  subdomain,
  key,
  fetchImpl = fetch,
  report = console.log,
}) {
  if (!/^[a-z0-9-]+$/u.test(subdomain ?? "") || !key) closed("inputs");
  if (!temp) closed("inputs");
  let statistics;
  try {
    const response = await fetchImpl(`https://${workerName}.${subdomain}.workers.dev/stats`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.status !== 200) closed("hold");
    statistics = await response.json();
  } catch {
    closed("hold");
  }
  let recovery;
  try {
    recovery = recoveryRecord({ processIdentity: statistics?.processIdentity });
  } catch {
    closed("hold");
  }
  writeRecord(temp, "container-api-verification-recovery.json", recovery);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  let reader,
    opened = false;
  try {
    const response = await fetchImpl(`https://${workerName}.${subdomain}.workers.dev/hold`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.status !== 200 || !response.body) closed("hold");
    reader = response.body.getReader();
    const first = await reader.read();
    if (first.done) closed("hold");
    report(JSON.stringify({ code: "verification_recovery_stream_open", streams: 1 }));
    opened = true;
    while (!(await reader.read()).done) {
      /* Synthetic bytes only. */
    }
  } catch {
    if (!opened) closed("hold");
    if (!controller.signal.aborted)
      report(JSON.stringify({ code: "verification_recovery_stream_disconnected", streams: 1 }));
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", stop);
    await reader?.cancel().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {
      phase: process.env.HARNESS_PHASE,
      temp: process.env.RUNNER_TEMP,
      subdomain: process.env.HARNESS_SUBDOMAIN,
      key: process.env.HARNESS_KEY,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.HARNESS_API_TOKEN,
      appId: process.env.HARNESS_APPLICATION_ID,
    };
    if (process.argv[2] === "recovery-hold") await recoveryHold(options);
    else await verifyPhase(options);
  } catch (error) {
    console.error(
      /^verification_[a-z_]+$/u.test(error?.message ?? "") ? error.message : "verification_failed",
    );
    process.exitCode = 1;
  }
}
