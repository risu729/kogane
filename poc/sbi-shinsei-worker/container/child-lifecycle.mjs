const CHILDREN = new Set(["chrome", "xvfb"]);
const ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EAGAIN",
  "ENOMEM",
  "EINVAL",
  "EMFILE",
  "ENFILE",
]);
const SIGNALS = new Set([
  "SIGTERM",
  "SIGKILL",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGTRAP",
  "SIGPIPE",
  "SIGINT",
]);

/** Attach immediately after spawn: asynchronous child errors bypass try/catch. */
export function observeChildProcess(child, name, { relayUrl } = {}) {
  const kind = CHILDREN.has(name) ? name : "unknown";
  let runId;
  try {
    const value = new URL(relayUrl).searchParams.get("runId");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value ?? ""))
      runId = value;
  } catch {
    /* Never retain or log the URL. */
  }
  const startedAt = Date.now();
  let failed = false;
  let exited = false;
  let stopping = false;
  function emit(outcome, fields = {}) {
    try {
      console[outcome === "failed" ? "error" : "log"](
        JSON.stringify({
          event: "sbi-shinsei-child-process",
          child: kind,
          ...(runId ? { runId } : {}),
          outcome,
          phase: stopping ? "teardown" : "collection",
          durationMs: Math.max(0, Date.now() - startedAt),
          ...fields,
        }),
      );
    } catch {
      /* Observability must not prevent failure ownership or cleanup. */
    }
  }
  // Keep this listener installed for the child's lifetime, including stop/kill.
  child.on("error", (error) => {
    failed = true;
    let code = "unknown";
    try {
      const value = error?.code;
      if (ERROR_CODES.has(value)) code = value;
    } catch {
      /* Error messages, paths, arguments and stacks are never inspected. */
    }
    emit("failed", { errorCode: code });
  });
  child.once("spawn", () => emit("started"));
  child.once("exit", (exitCode, signal) => {
    exited = true;
    const fields = {};
    if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) fields.exitCode = exitCode;
    if (SIGNALS.has(signal)) fields.signal = signal;
    emit(stopping ? "stopped" : exitCode === 0 ? "exited" : "failed", fields);
  });
  return {
    isStopped: () =>
      exited ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      (failed && child.pid === undefined),
    assertRunning() {
      if (failed || exited || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("child_process_unavailable");
      }
    },
    stopping() {
      stopping = true;
    },
  };
}
