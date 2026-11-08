const stages = new Set([
  "collection",
  "relay-start",
  "browser-launch",
  "login-page",
  "challenge",
  "login-submit",
  "activity-open",
  "month-discovery",
  "statement-read",
  "logout",
  "browser-close",
  "relay-close",
]);
const types = new Set(["Error", "TypeError", "SyntaxError", "TimeoutError", "AbortError"]);
/**
 * Why one challenge attempt ended, as a closed code: the Turnstile token was
 * generated (`token`), the wait ran out with the widget frame present
 * (`token-timeout`) or absent (`widget-missing`), the edge refused the page
 * (`edge-denied`), or the page could not be read after the wait
 * (`page-unreadable`).
 */
export const CHALLENGE_ATTEMPT_CODES = new Set([
  "token",
  "token-timeout",
  "widget-missing",
  "edge-denied",
  "page-unreadable",
]);
/** Which kind of host answered with the last HTTP error: a closed class, never a URL. */
export const HTTP_HOST_CLASSES = new Set(["globalpass", "turnstile", "turnstile-helper", "other"]);

function httpStatusOrNothing(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

export function createBrowserDiagnostics(relayUrl) {
  let runId;
  try {
    const candidate = new URL(relayUrl).searchParams.get("runId");
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        candidate ?? "",
      )
    )
      runId = candidate;
  } catch {}
  let currentStage = "collection";
  // The innermost stage that failed first: the one a run's failure code names.
  let failedStage;
  function write(record) {
    try {
      console.log(
        JSON.stringify({
          event: "globalpass-browser-diagnostic",
          runId,
          ...record,
        }),
      );
    } catch {}
  }
  function emit(stage, outcome, elapsedMs, error, httpStatus) {
    try {
      const candidate = error instanceof Error ? error.name : undefined;
      const name = types.has(candidate) ? candidate : "UnknownError";
      const status = httpStatusOrNothing(httpStatus);
      write({
        stage: stages.has(stage) ? stage : "unknown",
        outcome,
        elapsedMs,
        ...(outcome === "failed" ? { errorType: name } : {}),
        ...(status === undefined ? {} : { httpStatus: status }),
      });
    } catch {}
  }
  return {
    /**
     * `blame: false` logs a failure without making it the run's failed stage
     * (teardown after another failure).
     */
    async step(stage, action, { blame = true } = {}) {
      const previous = currentStage;
      currentStage = stage;
      const start = Date.now();
      emit(stage, "started", 0);
      try {
        const result = await action();
        emit(stage, "success", Date.now() - start);
        return result;
      } catch (error) {
        if (blame && failedStage === undefined && stages.has(stage)) failedStage = stage;
        emit(stage, "failed", Date.now() - start, error);
        throw error;
      } finally {
        currentStage = previous;
      }
    },
    http(status) {
      emit(currentStage, "http-error", 0, undefined, status);
    },
    /**
     * One challenge attempt: its number, how long it waited, a closed code
     * for how it ended, and the last HTTP error status seen during it with the
     * class of host that sent it. Numbers and closed codes only.
     */
    challengeAttempt({ attempt, elapsedMs, code, lastHttpStatus, lastHttpHost, turnstileFrames }) {
      try {
        const status = httpStatusOrNothing(lastHttpStatus);
        write({
          stage: "challenge",
          outcome: code === "token" ? "attempt-success" : "attempt-failed",
          attempt: Number.isInteger(attempt) && attempt >= 1 && attempt <= 10 ? attempt : 0,
          elapsedMs: Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0,
          code: CHALLENGE_ATTEMPT_CODES.has(code) ? code : "page-unreadable",
          ...(status === undefined ? {} : { lastHttpStatus: status }),
          ...(status !== undefined && HTTP_HOST_CLASSES.has(lastHttpHost) ? { lastHttpHost } : {}),
          ...(Number.isInteger(turnstileFrames) && turnstileFrames >= 0 && turnstileFrames <= 99
            ? { turnstileFrames }
            : {}),
        });
      } catch {}
    },
    /**
     * The container relay's counts at close: CONNECT requests by outcome, bytes each
     * way and socket errors by closed code (`RELAY_SOCKET_ERROR_CODES`).
     */
    relaySummary(stats) {
      try {
        const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
        const socketErrors = {};
        for (const [code, value] of Object.entries(stats?.socketErrors ?? {})) {
          if (/^(?:E[A-Z]{2,15}|ERR_[A-Z_]{1,40}|other)$/u.test(code)) {
            socketErrors[code] = count(value);
          }
        }
        console.log(
          JSON.stringify({
            event: "globalpass-container-relay-summary",
            runId,
            connects: count(stats?.connects),
            denied: count(stats?.denied),
            established: count(stats?.established),
            upstreamFailed: count(stats?.upstreamFailed),
            upstreamTimeout: count(stats?.upstreamTimeout),
            bytesUp: count(stats?.bytesUp),
            bytesDown: count(stats?.bytesDown),
            socketErrors,
          }),
        );
      } catch {}
    },
    get failedStage() {
      return failedStage;
    },
  };
}
