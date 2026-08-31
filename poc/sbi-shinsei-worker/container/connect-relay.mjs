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

export function startConnectRelay({
  relayToken,
  relayUrl,
  allowedHosts,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
}) {
  const sockets = new Set();
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
      if (relay.readyState < WebSocket.CLOSED) relay.terminate();
    }, connectTimeoutMs);

    const closeRelay = () => {
      clearTimeout(timeout);
      if (relay.readyState < WebSocket.CLOSED) relay.terminate();
    };
    const fail = () => {
      clearTimeout(timeout);
      if (!established) rejectConnect("502 Bad Gateway");
      else if (!socket.destroyed) socket.destroy();
    };

    relay.once("open", () => {
      clearTimeout(timeout);
      if (responseSent) {
        relay.terminate();
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
    socket.once("error", closeRelay);
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
