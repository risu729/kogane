import { canonicalDriverHttpCode, syntheticHttpFailure } from "./http-diagnostics.mjs";

const phases = Object.freeze([
  "baseline_sdk",
  "native",
  "native_unmonitored",
  "native_recovered",
  "rollback_sdk",
]);
const completedResponses = new Set([
  "none",
  "unmarked_404",
  "unmarked_503",
  "validated_old_revision",
]);
/** Closed projection of the last response classified within the existing rollout budget. */
export function httpReadyTimeoutFailureRecord(value) {
  const expected = value?.phase === "rollback_sdk" ? "baseline_sdk" : value?.phase;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "code,lastCompletedResponse,observedRevision,phase" ||
    value.code !== "http_ready_timeout_observation" ||
    !phases.includes(value.phase) ||
    !completedResponses.has(value.lastCompletedResponse) ||
    (value.lastCompletedResponse === "validated_old_revision"
      ? !phases.includes(value.observedRevision) || value.observedRevision === expected
      : value.observedRevision !== "none")
  )
    fail("observation");
  return {
    code: "http_ready_timeout_observation",
    phase: value.phase,
    lastCompletedResponse: value.lastCompletedResponse,
    observedRevision: value.observedRevision,
  };
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fail = (code) => {
  throw new Error(`verification_state_${code}`);
};
function revisionState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !phases.includes(value.revision)
  )
    fail("schema");
  const startup = value.revision.startsWith("native") ? "starts" : "startCallbacks";
  const keys = [
    "kvSentinelMatch",
    "sqlSentinelMatch",
    "sdkAlarmPresent",
    "revision",
    "running",
    startup,
    "stops",
    "errors",
    "signaled",
    "exitSeven",
  ];
  if (
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    ["kvSentinelMatch", "sqlSentinelMatch", "sdkAlarmPresent", "running"].some(
      (key) => ![0, 1].includes(value[key]),
    ) ||
    [startup, "stops", "errors", "signaled", "exitSeven"].some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 0,
    )
  )
    fail("schema");
  return value.revision;
}

/** Public-route propagation only: authenticated fixed GET/state, no Container traffic or POST.
 * The caller supplies the remaining part of its existing absolute 180s rollout budget.
 * /state may initialize the existing synthetic SQLite table, but never seeds its sentinels.
 */
export async function waitHttpReady({
  phase,
  subdomain,
  key,
  deadline,
  fetchImpl = fetch,
  now = Date.now,
  sleep = pause,
  onTimeout,
}) {
  if (
    !phases.includes(phase) ||
    typeof subdomain !== "string" ||
    !/^[a-z0-9-]+$/u.test(subdomain) ||
    typeof key !== "string" ||
    !key ||
    !Number.isSafeInteger(deadline)
  )
    fail("inputs");
  const expected = phase === "rollback_sdk" ? "baseline_sdk" : phase;
  const url = `https://kogane-container-api-verification.${subdomain}.workers.dev/state`;
  const remaining = () => {
    const rest = deadline - now();
    if (!Number.isFinite(rest) || rest > 180_000) fail("inputs");
    if (rest <= 0) fail("timeout");
    return rest;
  };
  let lastCompletedResponse = "none",
    observedRevision = "none";
  try {
    while (true) {
      const controller = new AbortController();
      let timer, reader, body;
      const timeout = Math.min(30_000, remaining());
      try {
        const ready = await Promise.race([
          (async () => {
            const response = await fetchImpl(url, {
              method: "GET",
              redirect: "manual",
              cache: "no-store",
              signal: controller.signal,
              headers: { authorization: `Bearer ${key}` },
            });
            remaining();
            if (controller.signal.aborted) fail("transport");
            body = response.body;
            // Only unmarked bootstrap/edge statuses are retryable; their bodies stay unread.
            if (
              (response.status === 404 || response.status === 503) &&
              response.headers.get("x-verification-failure") === null &&
              response.headers.get("x-verification-upstream-status") === null
            ) {
              lastCompletedResponse = response.status === 404 ? "unmarked_404" : "unmarked_503";
              observedRevision = "none";
              return false;
            }
            if (response.status !== 200)
              throw new Error(syntheticHttpFailure("/state", "GET", response));
            reader = response.body?.getReader();
            if (!reader) fail("response");
            const chunks = [];
            let size = 0;
            while (true) {
              const { value, done } = await reader.read();
              remaining();
              if (done) break;
              size += value.byteLength;
              if (size > 8192) fail("response");
              chunks.push(Buffer.from(value));
            }
            let state;
            try {
              state = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              fail("response");
            }
            const revision = revisionState(state);
            remaining();
            if (revision !== expected) {
              lastCompletedResponse = "validated_old_revision";
              observedRevision = revision;
            }
            return revision === expected ? state : undefined;
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new Error(
                  deadline - now() <= 0
                    ? "verification_state_timeout"
                    : "verification_state_transport",
                ),
              );
            }, timeout);
          }),
        ]);
        remaining();
        if (ready) return ready;
      } catch (error) {
        if (controller.signal.aborted && deadline - now() <= 0) fail("timeout");
        const code = canonicalDriverHttpCode(error?.message);
        throw new Error(code ?? "verification_state_transport", { cause: error });
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
        else void body?.cancel().catch(() => {});
      }
      await sleep(Math.min(2000, remaining()));
    }
  } catch (error) {
    if (error?.message === "verification_state_timeout") {
      try {
        onTimeout?.(
          httpReadyTimeoutFailureRecord({
            code: "http_ready_timeout_observation",
            phase,
            lastCompletedResponse,
            observedRevision,
          }),
        );
      } catch {
        // Failure-only observation cannot replace the original error or its cause.
      }
    }
    throw error;
  }
}
