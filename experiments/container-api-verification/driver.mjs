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
import {
  BACKPRESSURE_MAX_CHUNKS,
  READER_LIFETIME_FRAMES,
  READER_LIFETIME_FRAME_BYTES,
} from "./container/server.mjs";
import { createSyntheticRequest } from "./http-diagnostics.mjs";
import { waitHttpReady } from "./http-readiness.mjs";

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
      "container-api-verification-stream-failure.json",
      "container-api-verification-stream-check-failure.json",
      "container-api-verification-sdk-startup-failure.json",
      "container-api-verification-initialize-outer-failure.json",
      "container-api-verification-state-timeout-failure.json",
      "container-api-verification-http-ready-timeout-failure.json",
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
const stateWaitStages = new Set([
  "reader_resume_idle",
  "reader_cancel_idle",
  "signal_stop",
  "nonzero_exit_stop",
]);
const stateWaitPhases = new Set(["baseline_sdk", "native", "native_unmonitored", "rollback_sdk"]);
export function stateTimeoutFailureRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "code,errors,exitSeven,phase,running,sdkAlarmPresent,signaled,startup,stops,substage" ||
    value.code !== "state_timeout_observation" ||
    !stateWaitPhases.has(value.phase) ||
    !stateWaitStages.has(value.substage) ||
    value.running !== 1 ||
    ![0, 1].includes(value.sdkAlarmPresent) ||
    ["startup", "stops", "errors", "signaled", "exitSeven"].some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 0,
    )
  )
    closed("state_timeout_record");
  return {
    code: "state_timeout_observation",
    phase: value.phase,
    substage: value.substage,
    running: value.running,
    sdkAlarmPresent: value.sdkAlarmPresent,
    startup: value.startup,
    stops: value.stops,
    errors: value.errors,
    signaled: value.signaled,
    exitSeven: value.exitSeven,
  };
}
/** Observe only the last existing poll; no extra request or activity renewal. */
export async function waitForState({
  json,
  predicate,
  phase,
  substage,
  temp,
  timeout = 90_000,
  now = Date.now,
  sleep = pause,
}) {
  const deadline = now() + timeout;
  let state;
  do {
    state = await json("/state");
    if (predicate(state)) return state;
    await sleep(3000);
  } while (now() < deadline);
  try {
    if (state?.revision !== (phase === "rollback_sdk" ? "baseline_sdk" : phase))
      closed("state_timeout_record");
    writeRecord(
      temp,
      "container-api-verification-state-timeout-failure.json",
      stateTimeoutFailureRecord({
        code: "state_timeout_observation",
        phase,
        substage,
        running: state.running,
        sdkAlarmPresent: state.sdkAlarmPresent,
        startup: state[phase.startsWith("native") ? "starts" : "startCallbacks"],
        stops: state.stops,
        errors: state.errors,
        signaled: state.signaled,
        exitSeven: state.exitSeven,
      }),
    );
  } catch {
    // Invalid state or persistence failure cannot replace the original timeout.
  }
  closed("state_timeout");
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
const streamEncodings = new Set(["absent", "identity", "gzip", "br", "deflate", "other"]);
export function streamEncodingCategory(value) {
  if (value === null) return "absent";
  const normalized = value.trim().toLowerCase();
  return streamEncodings.has(normalized) ? normalized : "other";
}
export function streamFailureRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "body,bytes,code,elapsedMs,encoding,reads,terminal" ||
    value.code !== "stream_failure_observation" ||
    ![0, 1].includes(value.body) ||
    !streamEncodings.has(value.encoding) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > 4096 ||
    !Number.isSafeInteger(value.reads) ||
    value.reads < 0 ||
    value.reads > 4096 ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 125_000 ||
    !["missing_body", "clean_eof"].includes(value.terminal) ||
    (value.terminal === "missing_body" &&
      (value.body !== 0 || value.bytes !== 0 || value.reads !== 0)) ||
    (value.terminal === "clean_eof" && value.body !== 1)
  )
    closed("stream_failure_record");
  return {
    code: "stream_failure_observation",
    body: value.body,
    encoding: value.encoding,
    bytes: value.bytes,
    reads: value.reads,
    elapsedMs: value.elapsedMs,
    terminal: value.terminal,
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

// Public-edge diagnostic only; phase acceptance uses the in-DO controller boundary below.
export async function verifyPublicBackpressureDiagnostic({
  request,
  json,
  wait = pause,
  now = Date.now,
}) {
  const baseline = await json("/stats");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(baseline?.processIdentity ?? ""))
    closed("backpressure_process");
  const response = await request("/backpressure");
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the owned encoding failure if the transport also fails to cancel.
    }
    closed("backpressure_encoding");
  }
  const reader = response.body?.getReader();
  if (!reader) closed("backpressure_chunks");
  let failed = false;
  try {
    let first;
    try {
      first = await reader.read();
    } catch {
      closed("backpressure_stream");
    }
    if (first.done || !first.value?.byteLength) closed("backpressure_chunks");
    // Preserve the existing 1s+35s measurement. Diagnostics do not assume which
    // predicate failed or change how much data the bounded source may emit.
    await wait(1000);
    const stalled = await json("/stats");
    const started = now();
    await wait(35_000);
    if (now() - started < 30_000) closed("backpressure_timing");
    // /stats proxies into the Container and can auto-start a stopped SDK process.
    // The DO-only state observation happens first and never sends Container traffic.
    if ((await json("/state"))?.running !== 1) closed("backpressure_process");
    const after = await json("/stats");
    // Fixed diagnostic precedence: timing, process, malformed/exhausted source,
    // stream count, POST count, then continued producer progress.
    if (now() - started < 30_000) closed("backpressure_timing");
    if (
      stalled?.processIdentity !== baseline.processIdentity ||
      after?.processIdentity !== baseline.processIdentity
    )
      closed("backpressure_process");
    if (
      ![stalled.backpressureChunks, after.backpressureChunks].every(
        (count) => Number.isSafeInteger(count) && count >= 1,
      )
    )
      closed("backpressure_chunks");
    if (stalled.backpressureChunks >= BACKPRESSURE_MAX_CHUNKS)
      closed("backpressure_exhausted_early");
    if (after.backpressureChunks >= BACKPRESSURE_MAX_CHUNKS) closed("backpressure_exhausted_late");
    if (stalled.streams !== 1 || after.streams !== 1) closed("backpressure_stream");
    if (stalled.posts !== baseline.posts || after.posts !== baseline.posts)
      closed("backpressure_posts");
    if (after.backpressureChunks !== stalled.backpressureChunks) closed("backpressure_progress");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A broken transport during cancellation must not erase the measured failure.
      if (!failed) closed("backpressure_stream");
    }
  }
}
const backpressureReasons = new Set([
  "timing",
  "process",
  "stream",
  "posts",
  "chunks",
  "encoding",
  "exhausted_early",
  "exhausted_late",
  "progress",
  "timeout",
]);
/** One bounded public GET; the DO reports its own SDK/native response-boundary observation. */
export async function verifyBackpressureCheck({ request }) {
  const response = await request("/backpressure-check");
  const reader = response.body?.getReader();
  if (!reader) closed("backpressure_report");
  let report,
    complete = false;
  try {
    const parts = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value?.byteLength ?? 0;
      if (size > 1024) closed("backpressure_report");
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    closed("backpressure_report");
  } finally {
    if (!complete) {
      let timer;
      try {
        await Promise.race([
          reader.cancel(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("cancel_timeout")), 1000);
          }),
        ]);
      } catch {
        // Preserve the owned report failure when cancellation also fails.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    typeof report.code !== "string"
  )
    closed("backpressure_report");
  const keys = Object.keys(report).sort().join(",");
  if (report.code === "pass") {
    if (
      keys !== "code,earlyChunks,elapsedMs,lateChunks" ||
      !Number.isSafeInteger(report.earlyChunks) ||
      report.earlyChunks < 1 ||
      report.earlyChunks >= BACKPRESSURE_MAX_CHUNKS ||
      !Number.isSafeInteger(report.lateChunks) ||
      report.lateChunks !== report.earlyChunks ||
      !Number.isSafeInteger(report.elapsedMs) ||
      report.elapsedMs < 30_000 ||
      report.elapsedMs > 110_000
    )
      closed("backpressure_report");
    return report;
  }
  if (keys !== "code" || !backpressureReasons.has(report.code)) closed("backpressure_report");
  closed(`backpressure_${report.code}`);
}
const readerReasons = new Set([
  "timing",
  "process",
  "identity",
  "posts",
  "payload",
  "stream",
  "cancel",
  "timeout",
]);
/** One 120s public GET; the DO validates the actual controller-returned reader. */
export async function verifyReaderLifetimeCheck({ request, arm }) {
  if (arm !== "resume" && arm !== "cancel") closed("reader_report");
  const response = await request(
    arm === "resume" ? "/reader-resume-check" : "/reader-cancel-check",
  );
  const reader = response.body?.getReader();
  if (!reader) closed("reader_report");
  let report,
    complete = false;
  try {
    const parts = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value?.byteLength ?? 0;
      if (size > 1024) closed("reader_report");
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    closed("reader_report");
  } finally {
    if (!complete) {
      let timer;
      try {
        await Promise.race([
          reader.cancel(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("cancel_timeout")), 1000);
          }),
        ]);
      } catch {
        /* Preserve the owned report failure. */
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    typeof report.code !== "string"
  )
    closed("reader_report");
  const keys = Object.keys(report).sort().join(",");
  if (report.code === "pass") {
    const total = READER_LIFETIME_FRAMES * READER_LIFETIME_FRAME_BYTES;
    if (
      keys !== "bytes,code,elapsedMs" ||
      !Number.isSafeInteger(report.elapsedMs) ||
      report.elapsedMs < 35_000 ||
      report.elapsedMs > 110_000 ||
      !Number.isSafeInteger(report.bytes) ||
      report.bytes < 1 ||
      (arm === "resume" ? report.bytes !== total : report.bytes >= total)
    )
      closed("reader_report");
    return report;
  }
  if (keys !== "code" || !readerReasons.has(report.code)) closed("reader_report");
  closed(`reader_${report.code}`);
}
/** Keep Container traffic before the reader gate, then observe only DO state until idle. */
export async function verifyReaderIdleCycle({ arm, request, json, waitState, now = Date.now }) {
  if ((await json("/state")).running !== 1) closed("reader_process");
  let before;
  try {
    before = canonicalUuid((await json("/stats")).processIdentity);
  } catch {
    closed("reader_identity");
  }
  await verifyReaderLifetimeCheck({ request, arm });
  const started = now();
  await waitState(
    (value) => value.running === 0,
    arm === "resume" ? "reader_resume_idle" : "reader_cancel_idle",
  );
  const observed = now() - started;
  if (!Number.isSafeInteger(observed) || observed < 20_000 || observed > 90_000)
    closed("reader_idle");
  const restarted = await json(
    "/once",
    "POST",
    arm === "resume" ? "idle_restart" : "reader_cancel_restart",
  );
  try {
    if (canonicalUuid(restarted?.processIdentity) === before) closed("reader_restart");
  } catch {
    closed("reader_restart");
  }
  return observed;
}
const streamCheckReasons = new Set([
  "timeout",
  "process",
  "stats",
  "identity",
  "posts",
  "streams",
  "streams_before",
  "streams_after",
  "fetch",
  "http",
  "body",
  "encoding",
  "payload",
  "limit",
  "eof",
  "partial",
  "timing",
]);
export function initializeOuterFailureRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "cfErrorOriginPresent,cfErrorType,cfRayPresent,code,contentType,phase,redirected,responseUrl" ||
    value.code !== "initialize_outer_failure_observation" ||
    value.phase !== "baseline_sdk" ||
    ![
      "missing",
      "other",
      "1000",
      "1016",
      "1101",
      "1102",
      "521",
      "522",
      "523",
      "524",
      "525",
      "526",
    ].includes(value.cfErrorType) ||
    typeof value.cfErrorOriginPresent !== "boolean" ||
    typeof value.cfRayPresent !== "boolean" ||
    ![
      "missing",
      "other",
      "application/json",
      "text/html",
      "text/plain",
      "application/octet-stream",
    ].includes(value.contentType) ||
    !["expected", "other", "absent"].includes(value.responseUrl) ||
    typeof value.redirected !== "boolean"
  )
    closed("record");
  return {
    code: "initialize_outer_failure_observation",
    phase: "baseline_sdk",
    cfErrorType: value.cfErrorType,
    cfErrorOriginPresent: value.cfErrorOriginPresent,
    cfRayPresent: value.cfRayPresent,
    contentType: value.contentType,
    responseUrl: value.responseUrl,
    redirected: value.redirected,
  };
}
export function sdkStartupFailureRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "category,code,phase" ||
    value.code !== "sdk_startup_failure_observation" ||
    !["baseline_sdk", "rollback_sdk"].includes(value.phase) ||
    !["sdk_no_instance_response", "other_503_response", "unavailable"].includes(value.category)
  )
    closed("record");
  return { code: "sdk_startup_failure_observation", phase: value.phase, category: value.category };
}
export function streamCheckFailureRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "code,elapsedMs,failureCode,identityMatches,postsMatches,running,samples,stage,streams" ||
    value.code !== "stream_check_failure_observation" ||
    ![
      "timeout",
      "process",
      "stats",
      "identity",
      "posts",
      "streams_before",
      "streams_after",
    ].includes(value.failureCode) ||
    !["before", "after"].includes(value.stage) ||
    (value.failureCode === "streams_before" && value.stage !== "before") ||
    (value.failureCode === "streams_after" && value.stage !== "after") ||
    !Number.isSafeInteger(value.samples) ||
    value.samples < 0 ||
    value.samples > 31 ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 46_000 ||
    ![0, 1, null].includes(value.running) ||
    ![0, 1, 2, null].includes(value.streams) ||
    ![0, 1, null].includes(value.identityMatches) ||
    ![0, 1, null].includes(value.postsMatches)
  )
    closed("stream_check_report");
  return {
    code: "stream_check_failure_observation",
    failureCode: value.failureCode,
    stage: value.stage,
    samples: value.samples,
    elapsedMs: value.elapsedMs,
    running: value.running,
    streams: value.streams,
    identityMatches: value.identityMatches,
    postsMatches: value.postsMatches,
  };
}
/** Read a finite report from the actual controller response boundary. */
export async function verifyStreamErrorCheck({ request, temp }) {
  const response = await request("/stream-error-check");
  const reader = response.body?.getReader();
  if (!reader) closed("stream_check_report");
  let report,
    complete = false;
  try {
    const parts = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value?.byteLength ?? 0;
      if (size > 1024) closed("stream_check_report");
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    closed("stream_check_report");
  } finally {
    if (!complete) {
      let timer;
      try {
        await Promise.race([
          reader.cancel(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("cancel_timeout")), 1000);
          }),
        ]);
      } catch {
        // Preserve the report failure.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) closed("stream_check_report");
  const keys = Object.keys(report).sort().join(",");
  if (report.code === "pass") {
    if (
      keys !== "bytes,code,elapsedMs,reads" ||
      report.bytes !== 35 ||
      !Number.isSafeInteger(report.reads) ||
      report.reads < 1 ||
      report.reads > 35 ||
      !Number.isSafeInteger(report.elapsedMs) ||
      report.elapsedMs < 35_000 ||
      report.elapsedMs > 46_000
    )
      closed("stream_check_report");
    return report;
  }
  if (!streamCheckReasons.has(report.code)) closed("stream_check_report");
  if (keys === "code,observation") {
    const record = streamCheckFailureRecord({
      code: "stream_check_failure_observation",
      failureCode: report.code,
      ...report.observation,
    });
    if (
      !report.observation ||
      Object.keys(report.observation).sort().join(",") !==
        "elapsedMs,identityMatches,postsMatches,running,samples,stage,streams"
    )
      closed("stream_check_report");
    if (temp) {
      try {
        writeRecord(temp, "container-api-verification-stream-check-failure.json", record);
      } catch {
        // Private diagnostic persistence must not erase the validated primary failure.
      }
    }
  } else if (keys !== "code") closed("stream_check_report");
  closed(`stream_check_${report.code}`);
}
/** Retained public-edge diagnostic; phase acceptance uses the in-DO check above. */
export async function verifyStreamErrorGate({ request, temp, now = Date.now }) {
  const failureStarted = now();
  const failureResponse = await request("/stream-error");
  const failureElapsed = () => Math.min(125_000, Math.max(0, now() - failureStarted));
  const encoding = streamEncodingCategory(failureResponse.headers.get("content-encoding"));
  const failure = failureResponse.body?.getReader();
  if (!failure) {
    writeRecord(
      temp,
      "container-api-verification-stream-failure.json",
      streamFailureRecord({
        code: "stream_failure_observation",
        body: 0,
        encoding,
        bytes: 0,
        reads: 0,
        elapsedMs: failureElapsed(),
        terminal: "missing_body",
      }),
    );
    closed("stream_failure_missing_body");
  }
  let failed = false,
    failureBytes = 0,
    failureReads = 0;
  try {
    while (true) {
      const part = await failure.read();
      if (part.done) break;
      failureBytes += part.value.byteLength;
      failureReads++;
      if (failureBytes > 4096 || failureReads > 4096) {
        let cancelTimer;
        try {
          await Promise.race([
            failure.cancel(),
            new Promise((_, reject) => {
              cancelTimer = setTimeout(() => reject(new Error("cancel_timeout")), 1000);
            }),
          ]);
        } catch {
          /* Preserve the source limit failure. */
        } finally {
          if (cancelTimer) clearTimeout(cancelTimer);
        }
        closed("stream_failure_limit");
      }
    }
  } catch (error) {
    if (error?.message === "verification_stream_failure_limit") throw error;
    // Preserve the existing gate: any terminal reader exception counts as the expected error.
    failed = true;
  }
  if (!failed) {
    writeRecord(
      temp,
      "container-api-verification-stream-failure.json",
      streamFailureRecord({
        code: "stream_failure_observation",
        body: 1,
        encoding,
        bytes: failureBytes,
        reads: failureReads,
        elapsedMs: failureElapsed(),
        terminal: "clean_eof",
      }),
    );
    closed("stream_failure_clean_eof");
  }
  return { code: "pass" };
}
export async function verifyPhase({
  phase,
  temp,
  subdomain,
  key,
  accountId,
  apiToken,
  appId,
  rolloutDeadline,
  fetchImpl = fetch,
  now = Date.now,
  bootstrapSleep = pause,
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
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(appId ?? "") ||
    !Number.isSafeInteger(rolloutDeadline) ||
    rolloutDeadline - now() > 180_000
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
    readerLifetimeChecks: 0,
    cancelChecks: 0,
    streamFailureChecks: 0,
    idleChecks: 0,
    destroyRestartChecks: 0,
    signalChecks: 0,
    nonzeroExitChecks: 0,
    recoveryChecks: 0,
    sdkAlarmChecks: 0,
  };
  const request = createSyntheticRequest({
    origin,
    key,
    fetchImpl,
    phase,
    onFailure: ({ code, category, observation }) => {
      if (phase === "baseline_sdk" && code === "verification_http_initialize_outer_not_found") {
        try {
          writeRecord(
            temp,
            "container-api-verification-initialize-outer-failure.json",
            initializeOuterFailureRecord(observation),
          );
        } catch {
          // O_EXCL retains the first observation; persistence cannot replace the HTTP error.
        }
        return;
      }
      if (
        !["baseline_sdk", "rollback_sdk"].includes(phase) ||
        code !== "verification_http_once_concurrency_upstream_unavailable"
      )
        return;
      try {
        writeRecord(
          temp,
          "container-api-verification-sdk-startup-failure.json",
          sdkStartupFailureRecord({ code: "sdk_startup_failure_observation", phase, category }),
        );
      } catch {
        // O_EXCL retains the first failure; write failure cannot replace the HTTP error.
      }
    },
  });
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
  const waitState = (predicate, substage, timeout = 90_000) =>
    waitForState({ json, predicate, phase, substage, temp, timeout });
  const bootstrapState = () =>
    waitHttpReady({
      phase,
      subdomain,
      key,
      deadline: rolloutDeadline,
      fetchImpl,
      now,
      sleep: bootstrapSleep,
    });
  const state = await bootstrapState();
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
  const sentinel = await bootstrapState();
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
  const canceled = (await request("/stream")).body?.getReader();
  if (!canceled) closed("cancel");
  await canceled.read();
  await canceled.cancel();
  counts.cancelChecks++;
  await verifyStreamErrorCheck({ request, temp });
  counts.streamFailureChecks++;
  counts.idleObservedMs = await verifyReaderIdleCycle({ arm: "resume", request, json, waitState });
  counts.cancelIdleObservedMs = await verifyReaderIdleCycle({
    arm: "cancel",
    request,
    json,
    waitState,
  });
  counts.readerLifetimeChecks += 2;
  counts.idleChecks += 2;
  await json("/destroy", "POST");
  if ((await json("/state")).running !== 0) closed("destroy");
  await json("/once", "POST", "destroy_restart");
  if ((await json("/stats")).posts !== 1) closed("restart");
  counts.destroyRestartChecks++;
  await json("/signal", "POST");
  await waitState((value) => value.running === 0, "signal_stop");
  counts.signalChecks++;
  if (["native", "native_recovered"].includes(phase) && (await json("/state")).signaled < 1)
    closed("signal_diagnostic");
  await json("/once", "POST", "signal_restart");
  await json("/exit", "POST");
  await waitState((value) => value.running === 0, "nonzero_exit_stop");
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
      rolloutDeadline: Number(process.env.HARNESS_ROLLOUT_DEADLINE),
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
