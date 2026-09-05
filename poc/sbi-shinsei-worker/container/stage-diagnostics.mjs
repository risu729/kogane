const STAGES = new Set([
  "chrome-start", "relay-start", "chrome-attach", "navigation-final-url", "navigation-cafis", "ui-input",
  "ui-waiters", "ui-click", "ui-login-response", "login-session", "security-connect", "authenticated-reads", "handoff",
  "browser-close", "chrome-stop", "relay-close", "profile-remove",
]);

export function createStageDiagnostics(relayUrl) {
  let runId;
  try {
    const value = new URL(relayUrl).searchParams.get("runId");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value ?? "")) runId = value;
  } catch { /* Never include the URL in a diagnostic. */ }
  const startedAt = Date.now();
  let active;
  let activeStartedAt = startedAt;
  function emit(stage, outcome, durationMs, cleanup = false) {
    try {
      const level = outcome === "failed" ? cleanup ? "warn" : "error" : outcome === "partial" ? "warn" : "log";
      console[level](JSON.stringify({
        event: "sbi-shinsei-container-stage", ...(runId ? { runId } : {}),
        stage, outcome, durationMs: Math.max(0, durationMs), phase: cleanup ? "teardown" : "collection",
      }));
    } catch { /* Logging must not alter the collection or teardown result. */ }
  }
  return {
    begin(stage) {
      if (active) emit(active, "success", Date.now() - activeStartedAt);
      active = STAGES.has(stage) ? stage : "unknown";
      activeStartedAt = Date.now();
      emit(active, "started", 0);
    },
    finish(handoff) {
      let outcome = "failed";
      try {
        const value = JSON.parse(handoff);
        if (value.ok === true) {
          outcome = value.failure === undefined ? "success"
            : value.responses && Object.keys(value.responses).length > 0 ? "partial" : "failed";
        }
      } catch { /* Handoff validation remains the caller's responsibility. */ }
      if (active) emit(active, outcome, Date.now() - activeStartedAt);
      active = undefined;
      emit("terminal", outcome, Date.now() - startedAt);
      return handoff;
    },
    async cleanup(stage, action) {
      const safeStage = STAGES.has(stage) ? stage : "unknown";
      const start = Date.now();
      emit(safeStage, "started", 0, true);
      try {
        await action();
        emit(safeStage, "success", Date.now() - start, true);
      } catch {
        emit(safeStage, "failed", Date.now() - start, true);
      }
    },
  };
}
