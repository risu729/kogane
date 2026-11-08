import http from "node:http";
import { randomUUID } from "node:crypto";

import WebSocket, { createWebSocketStream } from "ws";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

// Keep createWebSocketStream's write flush/finalizer intact while giving its
// no-argument close a standard status code. Explicit peer/error codes pass through.
class RelayWebSocket extends WebSocket {
  constructor(address, options, diagnostic) {
    super(address, options);
    this.diagnostic = diagnostic;
  }
  send(data, ...args) {
    const open = this.readyState === WebSocket.OPEN;
    const result = super.send(data, ...args);
    if (open) this.diagnostic?.sent(data, this);
    else this.diagnostic?.mark("websocket-send-not-open", this);
    return result;
  }
  close(code = 1000, data) {
    this.diagnostic?.mark("websocket-close-called", this, { requestedCode: code });
    return super.close(code, data);
  }
  terminate() {
    this.diagnostic?.mark("websocket-terminate-called", this);
    return super.terminate();
  }
}

const TARGET_CLASSES = new Map([
  ["bk.web.sbishinseibank.co.jp", "bank-web"],
  ["www.sbishinseibank.co.jp", "bank-public"],
  ["distribute.cafisbrain.com", "cafis-distribute"],
  ["diproxy.cafisbrain.com", "cafis-proxy"],
  ["platform-websdk.transmitsecurity.io", "transmit-security"],
]);
const SOCKET_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/** A closed code for a socket error: one of SOCKET_ERROR_CODES or `unclassified`. */
function socketErrorCode(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    /* An accessor failure remains unclassified. */
  }
  return typeof code === "string" && SOCKET_ERROR_CODES.has(code) ? code : "unclassified";
}

// Counts describe data messages queued/received at ws's public API, not wire
// delivery acknowledgements. Only lengths and fixed labels enter these records.
export function relayDiagnostics(relayId, runId, hostname) {
  const started = Date.now();
  const totals = {
    wsSentBytesQueued: 0,
    wsSentFramesQueued: 0,
    wsReceivedBytes: 0,
    wsReceivedFrames: 0,
    maxBufferedAmount: 0,
  };
  const closeTimeline = [];
  const seen = new Set();
  let bufferedAmountAtClose;
  let firstCloseEvent;
  const sample = (relay) => {
    const amount = relay?.bufferedAmount;
    if (Number.isSafeInteger(amount) && amount >= 0)
      totals.maxBufferedAmount = Math.max(totals.maxBufferedAmount, amount);
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
  };
  const bytes = (data) =>
    typeof data === "string"
      ? Buffer.byteLength(data)
      : ArrayBuffer.isView(data) || data instanceof ArrayBuffer
        ? data.byteLength
        : 0;
  const safe = (action) => {
    try {
      action();
    } catch {
      /* Diagnostics cannot alter transport behavior. */
    }
  };
  return {
    sent(data, relay) {
      safe(() => {
        totals.wsSentFramesQueued++;
        totals.wsSentBytesQueued += bytes(data);
        sample(relay);
      });
    },
    received(data, relay) {
      safe(() => {
        totals.wsReceivedFrames++;
        totals.wsReceivedBytes += bytes(data);
        sample(relay);
      });
    },
    mark(stage, relay, details = {}) {
      safe(() => {
        const amount = sample(relay);
        if (
          !["websocket-open", "websocket-connect-start", "initial-frame-queued"].includes(stage) &&
          !firstCloseEvent
        ) {
          firstCloseEvent = stage;
          bufferedAmountAtClose = amount;
        }
        if (seen.has(stage) || closeTimeline.length >= 16) return;
        seen.add(stage);
        const entry = { stage, elapsedMs: Math.max(0, Date.now() - started) };
        if (
          Number.isInteger(details.requestedCode) &&
          details.requestedCode >= 1000 &&
          details.requestedCode <= 4999
        )
          entry.requestedCode = details.requestedCode;
        if (
          Number.isInteger(details.receivedCode) &&
          details.receivedCode >= 1000 &&
          details.receivedCode <= 4999
        )
          entry.receivedCode = details.receivedCode;
        const error = details.error;
        if (error) entry.errorCode = socketErrorCode(error);
        closeTimeline.push(entry);
        console.log(
          JSON.stringify({
            event: "sbi-shinsei-container-relay-stage",
            relayId,
            ...(runId ? { runId } : {}),
            targetClass: TARGET_CLASSES.get(hostname) ?? "allowed-upstream",
            ...entry,
            ...totals,
            firstCloseEvent,
            bufferedAmountAtClose,
          }),
        );
      });
    },
    record(details) {
      safe(() =>
        console[details.outcome === "closed" ? "log" : "warn"](
          JSON.stringify({
            event: "sbi-shinsei-container-relay-closed",
            relayId,
            ...(runId ? { runId } : {}),
            targetClass: TARGET_CLASSES.get(hostname) ?? "allowed-upstream",
            ...details,
            ...totals,
            durationMs: Math.max(0, Date.now() - started),
            firstCloseEvent,
            bufferedAmountAtClose,
            closeTimeline,
          }),
        ),
      );
    },
  };
}

// A normal local TCP close must finish the WebSocket close handshake. Calling
// terminate() here cuts off Cloudflare's response pump outside Worker promises.
export function trackRelayClosure(
  relay,
  { timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS, onClosed = () => {} } = {},
) {
  let timer;
  let closing = false;
  let failed = false;
  let forced = false;
  let localTcpFailed = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let settled = false;
  function settle(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const closeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1006;
    const normal = closeCode === 1000 || closeCode === 1001 || closeCode === 1005;
    try {
      onClosed({
        outcome: failed
          ? "failed"
          : forced
            ? "forced-timeout"
            : normal
              ? "closed"
              : "abnormal-close",
        closeCode,
        ...(localTcpFailed ? { failureStage: "local-tcp" } : {}),
      });
    } catch {
      /* Logging must not prevent shutdown. */
    }
    resolveClosed();
  }
  function force() {
    try {
      if (relay.readyState !== WebSocket.CLOSED) relay.terminate();
    } catch {
      failed = true;
    } finally {
      settle(1006);
    }
  }
  const sendClose = () => {
    try {
      if (relay.readyState === WebSocket.OPEN) relay.close(1000, "proxy connection complete");
    } catch {
      failed = true;
      force();
    }
  };
  relay.once("close", (code) => settle(code));
  // The caller still handles connection errors. This marks the lifecycle outcome
  // without propagating any provider error message into operational logs.
  relay.once("error", () => {
    failed = true;
  });
  return {
    closed,
    close() {
      if (settled || closing) return closed;
      closing = true;
      if (relay.readyState === WebSocket.CLOSED) {
        settle(1000);
        return closed;
      }
      timer = setTimeout(() => {
        forced = true;
        force();
      }, timeoutMs);
      timer.unref?.();
      if (relay.readyState === WebSocket.CONNECTING) relay.once("open", sendClose);
      else sendClose();
      return closed;
    },
    abort() {
      if (!settled) {
        failed = true;
        force();
      }
      return closed;
    },
    localError() {
      failed = true;
      localTcpFailed = true;
      // A Chrome-side TCP reset does not mean the Worker WebSocket transport is
      // broken. Preserve that failure while still completing its close handshake.
      return relay.readyState === WebSocket.OPEN || relay.readyState === WebSocket.CLOSING
        ? this.close()
        : this.abort();
    },
  };
}

function parseConnectAuthority(authority) {
  try {
    const target = new URL(`http://${authority}`);
    if (
      !target.hostname ||
      !target.port ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash
    ) {
      return null;
    }
    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { hostname: target.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

/**
 * A local HTTP CONNECT proxy for Chrome that carries each allowed tunnel over
 * an authenticated WebSocket to the Worker's `/tcp` relay.
 *
 * Every local socket keeps an `error` listener for its whole life. The HTTP
 * server removes its own listener when it hands a CONNECT socket over, so a
 * refused CONNECT (Chrome's background hosts outside the allowlist) answered
 * with `end(403)` and left paused had none: Chrome resetting it was an
 * unhandled `read ECONNRESET` that ended the container process (seen in the
 * GLOBAL PASS copy of this relay on 2026-11-07 18:17 UTC).
 *
 * `close()` logs one `sbi-shinsei-container-relay-summary` line: CONNECT requests by
 * outcome and local socket errors by closed code. No host, URL or payload.
 */
export function startConnectRelay({
  relayToken,
  relayUrl,
  allowedHosts,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
}) {
  const sockets = new Set();
  const relays = new Set();
  const counts = {
    connects: 0,
    refused: 0,
    refusedWhileClosing: 0,
    established: 0,
    upstreamFailed: 0,
    upstreamTimeout: 0,
    abandoned: 0,
    serverErrors: 0,
  };
  const socketErrors = {};
  const countSocketError = (error) => {
    try {
      const code = socketErrorCode(error);
      socketErrors[code] = (socketErrors[code] ?? 0) + 1;
    } catch {
      /* Counting cannot alter transport behavior. */
    }
  };
  let closing;
  let runId;
  try {
    const value = new URL(relayUrl).searchParams.get("runId");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value ?? ""))
      runId = value;
  } catch {
    /* Credentials and relay URLs never enter logs. */
  }
  const server = http.createServer((_request, response) => {
    response.writeHead(405, {
      connection: "close",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("CONNECT required\n");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("connect", (request, socket, head) => {
    // The HTTP server stops listening for this socket's errors once it hands
    // the socket over. This listener stays for the socket's whole life, so a
    // reset can end a tunnel but never the process.
    socket.on("error", countSocketError);
    socket.pause();
    counts.connects++;
    if (closing) {
      counts.refusedWhileClosing++;
      socket.destroy();
      return;
    }
    const address = parseConnectAuthority(request.url ?? "");
    if (!address || address.port !== 443 || !allowedHosts.has(address.hostname)) {
      counts.refused++;
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      // Read and drop whatever Chrome still sends, so its close is seen and
      // the socket is released instead of lingering paused.
      socket.resume();
      return;
    }

    const target = new URL(relayUrl);
    target.searchParams.set("host", address.hostname);
    target.searchParams.set("port", String(address.port));
    const relayId = randomUUID();
    target.searchParams.set("relayId", relayId);
    const diagnostic = relayDiagnostics(relayId, runId, address.hostname);
    const relay = new RelayWebSocket(
      target,
      {
        headers: { authorization: `Bearer ${relayToken}` },
      },
      diagnostic,
    );
    diagnostic.mark("websocket-connect-start", relay);
    relay.on("message", (data) => diagnostic.received(data, relay));
    relay.once("close", (code) =>
      diagnostic.mark("websocket-peer-close", relay, { receivedCode: code }),
    );
    const lifecycle = trackRelayClosure(relay, {
      timeoutMs: closeTimeoutMs,
      onClosed: (details) => {
        diagnostic.record(details);
      },
    });
    lifecycle.shutdown = () => {
      diagnostic.mark("proxy-shutdown", relay);
      return lifecycle.close();
    };
    relays.add(lifecycle);
    void lifecycle.closed.then(() => relays.delete(lifecycle));
    let established = false;
    let responseSent = false;
    let relayStream;
    const rejectConnect = (status) => {
      if (responseSent || socket.destroyed) return;
      responseSent = true;
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.resume();
    };
    const timeout = setTimeout(() => {
      diagnostic.mark("connect-timeout", relay);
      if (!established && !responseSent && !socket.destroyed) counts.upstreamTimeout++;
      if (!established) rejectConnect("504 Gateway Timeout");
      void lifecycle.abort();
    }, connectTimeoutMs);

    const closeRelay = () => {
      // Chrome dropped the socket before it got any answer (e.g. a preconnect).
      if (!responseSent) {
        responseSent = true;
        counts.abandoned++;
      }
      diagnostic.mark("local-tcp-close", relay);
      clearTimeout(timeout);
      void lifecycle.close();
    };
    const localTcpError = (error) => {
      diagnostic.mark("local-tcp-error", relay, { error });
      clearTimeout(timeout);
      void lifecycle.localError();
    };
    const fail = () => {
      clearTimeout(timeout);
      if (!established && !responseSent && !socket.destroyed) counts.upstreamFailed++;
      if (!established) rejectConnect("502 Bad Gateway");
      else if (!socket.destroyed) socket.destroy();
    };

    relay.once("open", () => {
      diagnostic.mark("websocket-open", relay);
      if (responseSent) {
        void lifecycle.close();
        return;
      }
      const initialFailure = (error) => {
        diagnostic.mark("initial-frame-error", relay, { error });
        fail();
        void lifecycle.abort();
      };
      try {
        // An initial empty binary data frame establishes the message path even
        // for unused browser preconnections. It contributes zero upstream bytes.
        // Wait for its local send callback before acknowledging CONNECT or
        // forwarding any TLS data; the existing deadline still bounds this wait.
        relay.send(Buffer.alloc(0), (error) => {
          if (error) {
            initialFailure(error);
            return;
          }
          try {
            if (responseSent || socket.destroyed || relay.readyState !== WebSocket.OPEN) {
              void lifecycle.close();
              return;
            }
            clearTimeout(timeout);
            established = true;
            responseSent = true;
            counts.established++;
            relayStream = createWebSocketStream(relay);
            relayStream.on("error", (error) => {
              diagnostic.mark("websocket-stream-error", relay, { error });
              fail();
            });
            socket.write(
              "HTTP/1.1 200 Connection Established\r\nProxy-Agent: kogane-connect-relay\r\n\r\n",
            );
            if (head.length) relayStream.write(head);
            socket.pipe(relayStream).pipe(socket);
            socket.resume();
          } catch (error) {
            initialFailure(error);
          }
        });
        diagnostic.mark("initial-frame-queued", relay);
      } catch (error) {
        initialFailure(error);
      }
    });
    relay.on("error", (error) => {
      diagnostic.mark("websocket-error", relay, { error });
      fail();
    });
    relay.once("close", () => {
      clearTimeout(timeout);
      if (!established) fail();
      else if (!socket.destroyed) socket.end();
    });
    // Keep pipe's existing EOF handling: its writable finalizer flushes pending
    // data before sending the normal close frame. Closing here on `end` could
    // discard the last queued TLS record before that flush finishes.
    socket.once("error", localTcpError);
    socket.once("end", () => diagnostic.mark("local-tcp-eof", relay));
    socket.once("close", closeRelay);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("CONNECT relay did not expose a TCP port"));
        return;
      }
      server.off("error", reject);
      server.on("error", () => {
        counts.serverErrors++;
      });
      const logSummary = () => {
        try {
          console.log(
            JSON.stringify({
              event: "sbi-shinsei-container-relay-summary",
              ...(runId ? { runId } : {}),
              ...counts,
              socketErrors,
            }),
          );
        } catch {
          /* Logging must not prevent shutdown. */
        }
      };
      resolve({
        port: address.port,
        close: () => {
          if (closing) return closing;
          closing = new Promise((done, closeReject) => {
            // Relays can outlive their local TCP sockets. Await all WebSockets,
            // including those already closing after removal from `sockets`.
            const relayClosures = [...relays].map((lifecycle) => lifecycle.shutdown());
            for (const socket of sockets) socket.destroy();
            server.close((error) => {
              logSummary();
              if (error) closeReject(error);
              else Promise.all(relayClosures).then(done, closeReject);
            });
          });
          return closing;
        },
      });
    });
  });
}
