import http from "node:http";

import WebSocket, { createWebSocketStream } from "ws";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

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

/** The socket error codes a relay summary counts by name; any other is `other`. */
export const RELAY_SOCKET_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

function errorCode(error) {
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && RELAY_SOCKET_ERROR_CODES.has(code) ? code : "other";
}

/**
 * A local HTTP CONNECT proxy for the browser that carries each allowed
 * tunnel over an authenticated WebSocket to the Worker's `/tcp` relay.
 *
 * Every socket and stream it owns has a permanent `error` listener: a browser
 * that resets a tunnel (or a refused CONNECT it never reads) must end that
 * tunnel, never the process. Before this, a reset on a refused CONNECT's
 * socket was an unhandled `read ECONNRESET` that crashed the container
 * (observed 2026-11-07 18:17 UTC).
 *
 * `stats()` returns counts only: CONNECT requests by outcome, socket errors by closed
 * code and bytes each way. No host, URL or payload.
 */
export function startConnectRelay({
  relayToken,
  relayUrl,
  allowedHosts,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
}) {
  const sockets = new Set();
  const counts = {
    connects: 0,
    denied: 0,
    established: 0,
    upstreamFailed: 0,
    upstreamTimeout: 0,
    bytesUp: 0,
    bytesDown: 0,
  };
  const socketErrors = {};
  const countError = (error) => {
    const code = errorCode(error);
    socketErrors[code] = (socketErrors[code] ?? 0) + 1;
  };
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
    // the socket over; this listener stays for the socket's whole life.
    socket.on("error", countError);
    socket.pause();
    counts.connects += 1;
    const address = parseConnectAuthority(request.url ?? "");
    if (!address || address.port !== 443 || !allowedHosts.has(address.hostname)) {
      counts.denied += 1;
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      // Read (and drop) whatever the browser still sends, so its close is
      // seen and the socket is released instead of lingering paused.
      socket.resume();
      return;
    }

    const target = new URL(relayUrl);
    target.searchParams.set("host", address.hostname);
    target.searchParams.set("port", String(address.port));
    const relay = new WebSocket(target, {
      headers: { authorization: `Bearer ${relayToken}` },
    });
    let established = false;
    let responseSent = false;
    let relayStream;
    // A WebSocket error after open is also re-emitted by its stream: count it once.
    let countedRelayError;
    const countRelayError = (error) => {
      if (error === countedRelayError) return;
      countedRelayError = error;
      countError(error);
    };
    const rejectConnect = (status) => {
      if (responseSent || socket.destroyed) return;
      responseSent = true;
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.resume();
    };
    const timeout = setTimeout(() => {
      if (!established) {
        if (!responseSent) counts.upstreamTimeout += 1;
        rejectConnect("504 Gateway Timeout");
      }
      if (relay.readyState < WebSocket.CLOSED) relay.terminate();
    }, connectTimeoutMs);

    const closeRelay = () => {
      clearTimeout(timeout);
      if (relay.readyState < WebSocket.CLOSED) relay.terminate();
    };
    const fail = () => {
      clearTimeout(timeout);
      if (!established) {
        // A browser that hung up first is not an upstream failure.
        if (!responseSent && !socket.destroyed) counts.upstreamFailed += 1;
        rejectConnect("502 Bad Gateway");
      } else if (!socket.destroyed) {
        socket.destroy();
      }
    };

    relay.once("open", () => {
      clearTimeout(timeout);
      if (responseSent || socket.destroyed) {
        relay.terminate();
        return;
      }
      established = true;
      responseSent = true;
      counts.established += 1;
      relayStream = createWebSocketStream(relay);
      relayStream.on("error", (error) => {
        countRelayError(error);
        fail();
      });
      relayStream.on("data", (chunk) => {
        counts.bytesDown += chunk.length;
      });
      socket.on("data", (chunk) => {
        counts.bytesUp += chunk.length;
      });
      socket.write(
        "HTTP/1.1 200 Connection Established\r\nProxy-Agent: kogane-connect-relay\r\n\r\n",
      );
      if (head.length) {
        counts.bytesUp += head.length;
        relayStream.write(head);
      }
      socket.pipe(relayStream).pipe(socket);
      socket.resume();
    });
    relay.on("error", (error) => {
      countRelayError(error);
      fail();
    });
    relay.once("close", () => {
      clearTimeout(timeout);
      if (!established) fail();
      else if (!socket.destroyed) socket.end();
    });
    socket.on("error", closeRelay);
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
      server.on("error", countError);
      resolve({
        port: address.port,
        stats: () => ({ ...counts, socketErrors: { ...socketErrors } }),
        close: () =>
          new Promise((done, closeReject) => {
            for (const socket of sockets) socket.destroy();
            server.close((error) => {
              if (error) closeReject(error);
              else done();
            });
          }),
      });
    });
  });
}
