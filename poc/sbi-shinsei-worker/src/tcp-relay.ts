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
  connect: () => RelaySocket;
  server: WebSocket;
  waitUntil: (promise: Promise<unknown>) => void;
  runId?: string;
  relayId?: string;
}): void {
  const { server, waitUntil } = options;
  const startedAt = Date.now();
  const relayId = options.relayId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(options.relayId)
    ? options.relayId : crypto.randomUUID();
  const correlation = { relayId, ...(options.runId ? { runId: options.runId } : {}) };
  let socket: RelaySocket | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let closeReason: CloseReason | undefined;
  let transportFailed = false;
  let closeTask: Promise<void> | undefined;
  let writeChain = Promise.resolve();
  let readerReleased = false;
  let peerCloseCode: number | undefined;
  let peerWasClean: boolean | undefined;
  const cleanupStages = new Set<string>();
  let sequence = 0;
  let cleanupStartedAt: number | undefined;
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  const metrics = {
    wsReceivedBytes: 0, wsReceivedFrames: 0,
    upstreamWrittenBytes: 0, upstreamWrittenChunks: 0,
    upstreamReadBytes: 0, upstreamReadChunks: 0,
    wsQueuedBytes: 0, wsQueuedFrames: 0,
    pendingWrites: 0, peakPendingWrites: 0,
  };
  const add = (key: keyof typeof metrics, value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) return;
    metrics[key] = Math.min(Number.MAX_SAFE_INTEGER, metrics[key] + value);
  };
  const activity = () => {
    const elapsed = Math.max(0, Date.now() - startedAt);
    firstActivityMs ??= elapsed;
    lastActivityMs = elapsed;
  };

  const log = (level: "log" | "warn" | "error", stage: string, outcome: string, error?: unknown) => {
    let websocketReadyState: number | undefined;
    try {
      const value = server.readyState;
      if (Number.isInteger(value) && value >= 0 && value <= 3) websocketReadyState = value;
    } catch { /* Reading diagnostic state must never change relay behavior. */ }
    emitDiagnostic(level, {
      event: "sbi-shinsei-relay-stage", phase: "relay", ...correlation,
      sequence: sequence = Math.min(Number.MAX_SAFE_INTEGER, sequence + 1), ...metrics,
      stage, outcome, durationMs: Math.max(0, Date.now() - startedAt),
      ...(cleanupStartedAt === undefined ? {} : { cleanupDurationMs: Math.max(0, Date.now() - cleanupStartedAt) }),
      ...(firstActivityMs === undefined ? {} : { firstActivityMs, lastActivityMs }),
      ...(websocketReadyState === undefined ? {} : { websocketReadyState }),
      ...(closeReason ? { closeReason } : {}),
      ...(peerCloseCode === undefined ? {} : { peerCloseCode }),
      ...(peerWasClean === undefined ? {} : { peerWasClean }),
      transportFailed, socketCreated: socket !== undefined,
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
    cleanupStartedAt = Date.now();
    log("log", "cleanup", "started");
    // Close the socket immediately: waiting for a pending write to drain first
    // can leave the relay alive indefinitely after the browser has gone away.
    closeTask = (async () => {
      const closeSocket = Promise.resolve().then(() => socket?.close()).catch(error => observeFailure("socket-close", error));
      const cancelReader = Promise.resolve().then(() => readerReleased ? undefined : reader?.cancel()).catch(error => observeFailure("reader-cancel", error));
      const abortWriter = Promise.resolve().then(() => writer?.abort()).catch(error => observeFailure("writer-abort", error));
      await Promise.all([closeSocket, cancelReader, abortWriter, writeChain]);
      try { writer?.releaseLock(); }
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

  function ensureConnected(): WritableStreamDefaultWriter<Uint8Array> {
    if (writer) return writer;
    log("log", "connect", "started");
    try { socket = options.connect(); }
    catch (error) { observeFailure("socket-connect", error); throw error; }
    // Observe lifecycle promises immediately after creating the socket, before
    // acquiring streams or forwarding the first client TLS frame.
    waitUntil(socket.opened.then(
      () => { if (!closeReason) log("log", "connect", "success"); },
      error => observeFailure("socket-open", error),
    ));
    waitUntil(socket.closed.then(
      () => { void close(closeReason ?? "upstream-eof"); },
      error => observeFailure("socket-closed", error),
    ));
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    const relayReader = reader;
    waitUntil(writer.closed.catch(error => observeFailure("writer-closed", error)));
    waitUntil(reader.closed.catch(error => observeFailure("reader-closed", error)));

    waitUntil((async () => {
      try {
        while (!closeReason) {
          const { value, done } = await relayReader.read();
          if (done) break;
          add("upstreamReadBytes", value.byteLength);
          add("upstreamReadChunks", 1);
          activity();
          if (!closeReason) {
            server.send(value);
            // send() only queues the frame; it does not acknowledge peer delivery.
            add("wsQueuedBytes", value.byteLength);
            add("wsQueuedFrames", 1);
          }
        }
      } catch (error) {
        observeFailure("relay-read", error);
      } finally {
        try { relayReader.releaseLock(); readerReleased = true; }
        catch (error) { observeFailure("reader-release", error); }
        void close(closeReason ?? "upstream-eof");
      }
    })());
    return writer;
  }

  // HTTPS is client-first. Avoid creating an upstream socket for speculative
  // browser connections that close without sending any TLS data.
  log("log", "awaiting-data", "started");

  server.addEventListener("message", event => {
    // Count receipt before queued work: closure may prevent the upstream write.
    add("wsReceivedFrames", 1);
    try { add("wsReceivedBytes", websocketByteLength(event.data)); }
    catch { /* Byte counting cannot reject an otherwise accepted message. */ }
    activity();
    if (closeReason) return;
    add("pendingWrites", 1);
    metrics.peakPendingWrites = Math.max(metrics.peakPendingWrites, metrics.pendingWrites);
    // Keep the stored chain fulfilled after a failure; later messages must not
    // replay the same rejected write and generate duplicate transport errors.
    writeChain = writeChain.then(async () => {
      try {
        if (closeReason) return;
        const bytes = await websocketBytes(event.data);
        if (!closeReason && bytes.byteLength > 0) {
          const upstreamWriter = ensureConnected();
          await upstreamWriter.write(bytes);
          // Completed local stream writes do not prove remote application receipt.
          add("upstreamWrittenBytes", bytes.byteLength);
          add("upstreamWrittenChunks", 1);
          activity();
        }
      } finally { metrics.pendingWrites = Math.max(0, metrics.pendingWrites - 1); }
    }).catch(error => observeFailure("relay-write", error));
    waitUntil(writeChain);
  });
  server.addEventListener("close", event => {
    if (Number.isInteger(event.code) && event.code >= 1000 && event.code <= 4999) peerCloseCode = event.code;
    if (typeof event.wasClean === "boolean") peerWasClean = event.wasClean;
    log("log", "websocket-peer-close", "received");
    void close("peer-close");
  });
  server.addEventListener("error", () => observeFailure("websocket-error", new Error("websocket_error")));
}

function websocketByteLength(data: string | ArrayBuffer | Blob): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.size;
}

async function websocketBytes(data: string | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}
