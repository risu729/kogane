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
  function emit(stage, outcome, elapsedMs, error, httpStatus) {
    try {
      const candidate = error instanceof Error ? error.name : undefined;
      const name = types.has(candidate) ? candidate : "UnknownError";
      const record = {
        event: "globalpass-browser-diagnostic",
        runId,
        stage: stages.has(stage) ? stage : "unknown",
        outcome,
        elapsedMs,
        ...(outcome === "failed" ? { errorType: name } : {}),
        ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
          ? { httpStatus }
          : {}),
      };
      console.log(JSON.stringify(record));
    } catch {}
  }
  return {
    async step(stage, action) {
      const previous = currentStage;
      currentStage = stage;
      const start = Date.now();
      emit(stage, "started", 0);
      try {
        const result = await action();
        emit(stage, "success", Date.now() - start);
        return result;
      } catch (error) {
        emit(stage, "failed", Date.now() - start, error);
        throw error;
      } finally {
        currentStage = previous;
      }
    },
    http(status) {
      emit(currentStage, "http-error", 0, undefined, status);
    },
  };
}
