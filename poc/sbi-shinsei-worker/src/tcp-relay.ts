import { emitDiagnostic, safeErrorType } from "./diagnostics";

interface RelaySocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<void>;
  close(): Promise<void>;
}

type CloseReason = "peer-close" | "upstream-eof" | "transport-error";

/** Own every stream/socket promise for the lifetime of a single relay. */
export function startTcpRelay(options: {
  socket: RelaySocket;
  server: WebSocket;
  waitUntil: (promise: Promise<unknown>) => void;
  runId?: string;
}): void {
  const { socket, server, waitUntil } = options;
  const startedAt = Date.now();
  const relayId = crypto.randomUUID();
  const correlation = { relayId, ...(options.runId ? { runId: options.runId } : {}) };
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let closeReason: CloseReason | undefined;
  let transportFailed = false;
  let closeTask: Promise<void> | undefined;
  let writeChain = Promise.resolve();
  let readerReleased = false;
  const cleanupStages = new Set<string>();

  const log = (level: "log" | "warn" | "error", stage: string, outcome: string, error?: unknown) => {
    emitDiagnostic(level, {
      event: "sbi-shinsei-relay-stage", phase: "relay", ...correlation,
      stage, outcome, durationMs: Math.max(0, Date.now() - startedAt),
      ...(closeReason ? { closeReason } : {}),
      transportFailed,
      ...(error === undefined ? {} : { errorType: safeErrorType(error) }),
    });
  };

  function observeFailure(stage: string, error: unknown): void {
    if (closeReason) {
      // Once either peer deliberately starts closing, stream cancellation errors
      // describe cleanup. Never relabel a failure observed before that point.
      if (!cleanupStages.has(stage)) {
        cleanupStages.add(stage);
        log("log", stage, "expected-close", error);
      }
      return;
    }
    transportFailed = true;
    log("error", stage, "failed", error);
    close("transport-error");
  }

  function close(reason: CloseReason): Promise<void> {
    if (closeTask) return closeTask;
    closeReason = reason;
    log("log", "cleanup", "started");
    // Close the socket immediately: waiting for a pending write to drain first
    // can leave the relay alive indefinitely after the browser has gone away.
    closeTask = (async () => {
      const closeSocket = Promise.resolve().then(() => socket.close()).catch(error => observeFailure("socket-close", error));
      const cancelReader = Promise.resolve().then(() => readerReleased ? undefined : reader.cancel()).catch(error => observeFailure("reader-cancel", error));
      const abortWriter = Promise.resolve().then(() => writer.abort()).catch(error => observeFailure("writer-abort", error));
      await Promise.all([closeSocket, cancelReader, abortWriter, writeChain]);
      try { writer.releaseLock(); }
      catch (error) { observeFailure("writer-release", error); }
      if (reason !== "peer-close") {
        try { server.close(transportFailed ? 1011 : 1000, transportFailed ? "relay failed" : "upstream closed"); }
        catch (error) { observeFailure("websocket-close", error); }
      }
      log("log", "terminal", transportFailed ? "failed" : "closed");
    })().catch(error => {
      // Keep the promise given to waitUntil handled even for cleanup failures.
      observeFailure("cleanup", error);
    });
    waitUntil(closeTask);
    return closeTask;
  }

  log("log", "connect", "started");
  // Attach handlers immediately. Socket.closed can reject independently of a
  // reader/write call, and .finally(() => socket.close()) also creates a new
  // rejecting promise unless its result is explicitly observed.
  waitUntil(socket.opened.then(
    () => { if (!closeReason) log("log", "connect", "success"); },
    error => observeFailure("socket-open", error),
  ));
  waitUntil(socket.closed.then(
    () => { void close(closeReason ?? "upstream-eof"); },
    error => observeFailure("socket-closed", error),
  ));
  waitUntil(writer.closed.catch(error => observeFailure("writer-closed", error)));
  waitUntil(reader.closed.catch(error => observeFailure("reader-closed", error)));

  waitUntil((async () => {
    try {
      while (!closeReason) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!closeReason) server.send(value);
      }
    } catch (error) {
      observeFailure("relay-read", error);
    } finally {
      try { reader.releaseLock(); readerReleased = true; }
      catch (error) { observeFailure("reader-release", error); }
      void close(closeReason ?? "upstream-eof");
    }
  })());

  server.addEventListener("message", event => {
    if (closeReason) return;
    // Keep the stored chain fulfilled after a failure; later messages must not
    // replay the same rejected write and generate duplicate transport errors.
    writeChain = writeChain.then(async () => {
      if (closeReason) return;
      const bytes = await websocketBytes(event.data);
      if (!closeReason) await writer.write(bytes);
    }).catch(error => observeFailure("relay-write", error));
    waitUntil(writeChain);
  });
  server.addEventListener("close", () => { void close("peer-close"); });
  server.addEventListener("error", () => observeFailure("websocket-error", new Error("websocket_error")));
}

async function websocketBytes(data: string | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}
