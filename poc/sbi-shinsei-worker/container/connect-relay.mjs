import http from "node:http";

import WebSocket, { createWebSocketStream } from "ws";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

// A normal local TCP close must finish the WebSocket close handshake. Calling
// terminate() here cuts off Cloudflare's response pump outside Worker promises.
export function trackRelayClosure(relay, { timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS, onClosed = () => {} } = {}) {
  let timer;
  let closing = false;
  let failed = false;
  let forced = false;
  let localTcpFailed = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let settled = false;
  function settle(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const closeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1006;
    const normal = closeCode === 1000 || closeCode === 1001 || closeCode === 1005;
    try { onClosed({ outcome: failed ? "failed" : forced ? "forced-timeout" : normal ? "closed" : "abnormal-close", closeCode, ...(localTcpFailed ? { failureStage: "local-tcp" } : {}) }); }
    catch { /* Logging must not prevent shutdown. */ }
    resolveClosed();
  }
  function force() {
    try { if (relay.readyState !== WebSocket.CLOSED) relay.terminate(); }
    catch { failed = true; }
    finally { settle(1006); }
  }
  const sendClose = () => {
    try {
      if (relay.readyState === WebSocket.OPEN) relay.close(1000, "proxy connection complete");
    } catch {
      failed = true;
      force();
    }
  };
  relay.once("close", code => settle(code));
  // The caller still handles connection errors. This marks the lifecycle outcome
  // without propagating any provider error message into operational logs.
  relay.once("error", () => { failed = true; });
  return {
    closed,
    close() {
      if (settled || closing) return closed;
      closing = true;
      if (relay.readyState === WebSocket.CLOSED) { settle(1000); return closed; }
      timer = setTimeout(() => { forced = true; force(); }, timeoutMs);
      timer.unref?.();
      if (relay.readyState === WebSocket.CONNECTING) relay.once("open", sendClose);
      else sendClose();
      return closed;
    },
    abort() {
      if (!settled) { failed = true; force(); }
      return closed;
    },
    localError() {
      failed = true;
      localTcpFailed = true;
      // A Chrome-side TCP reset does not mean the Worker WebSocket transport is
      // broken. Preserve that failure while still completing its close handshake.
      return relay.readyState === WebSocket.OPEN || relay.readyState === WebSocket.CLOSING
        ? this.close() : this.abort();
    },
  };
}

export function parseConnectAuthority(authority) {
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

export function startConnectRelay({
  relayToken,
  relayUrl,
  allowedHosts,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
}) {
  const sockets = new Set();
  const relays = new Set();
  let closing;
  let runId;
  try {
    const value = new URL(relayUrl).searchParams.get("runId");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value ?? "")) runId = value;
  } catch { /* Credentials and relay URLs never enter logs. */ }
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
    socket.pause();
    if (closing) { socket.destroy(); return; }
    const address = parseConnectAuthority(request.url ?? "");
    if (!address || address.port !== 443 || !allowedHosts.has(address.hostname)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }

    const target = new URL(relayUrl);
    target.searchParams.set("host", address.hostname);
    target.searchParams.set("port", String(address.port));
    const relay = new WebSocket(target, {
      headers: { authorization: `Bearer ${relayToken}` },
    });
    const lifecycle = trackRelayClosure(relay, {
      timeoutMs: closeTimeoutMs,
      onClosed: details => {
        try {
          console[details.outcome === "closed" ? "log" : "warn"](JSON.stringify({
            event: "sbi-shinsei-container-relay-closed", ...(runId ? { runId } : {}), ...details,
          }));
        } catch { /* Best effort. */ }
      },
    });
    relays.add(lifecycle);
    void lifecycle.closed.then(() => relays.delete(lifecycle));
    let established = false;
    let responseSent = false;
    let relayStream;
    const rejectConnect = (status) => {
      if (responseSent || socket.destroyed) return;
      responseSent = true;
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    const timeout = setTimeout(() => {
      if (!established) rejectConnect("504 Gateway Timeout");
      void lifecycle.abort();
    }, connectTimeoutMs);

    const closeRelay = () => {
      clearTimeout(timeout);
      void lifecycle.close();
    };
    const localTcpError = () => { clearTimeout(timeout); void lifecycle.localError(); };
    const fail = () => {
      clearTimeout(timeout);
      if (!established) rejectConnect("502 Bad Gateway");
      else if (!socket.destroyed) socket.destroy();
    };

    relay.once("open", () => {
      clearTimeout(timeout);
      if (responseSent) {
        void lifecycle.close();
        return;
      }
      established = true;
      responseSent = true;
      relayStream = createWebSocketStream(relay);
      relayStream.once("error", fail);
      socket.write(
        "HTTP/1.1 200 Connection Established\r\nProxy-Agent: kogane-connect-relay\r\n\r\n",
      );
      if (head.length) relayStream.write(head);
      socket.pipe(relayStream).pipe(socket);
      socket.resume();
    });
    relay.once("error", fail);
    relay.once("close", () => {
      clearTimeout(timeout);
      if (!established) fail();
      else if (!socket.destroyed) socket.end();
    });
    // Keep pipe's existing EOF handling: its writable finalizer flushes pending
    // data before sending a valid empty close frame. Closing here on `end` could
    // discard the last queued TLS record before that flush finishes.
    socket.once("error", localTcpError);
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
      resolve({
        port: address.port,
        close: () => {
          if (closing) return closing;
          closing = new Promise((done, closeReject) => {
            // Relays can outlive their local TCP sockets. Await all WebSockets,
            // including those already closing after removal from `sockets`.
            const relayClosures = [...relays].map(lifecycle => lifecycle.close());
            for (const socket of sockets) socket.destroy();
            server.close((error) => {
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
