import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";

import { WebSocketServer } from "ws";

import { parseConnectAuthority, startConnectRelay } from "../container/connect-relay.mjs";

function readThrough(socket, delimiter) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socket ended before the delimiter"));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const offset = buffer.indexOf(delimiter);
      if (offset < 0) return;
      socket.pause();
      cleanup();
      const end = offset + delimiter.length;
      resolve({ header: buffer.subarray(0, end), remainder: buffer.subarray(end) });
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function readBytes(socket, length, initial = Buffer.alloc(0)) {
  if (initial.length >= length) return Promise.resolve(initial.subarray(0, length));
  return new Promise((resolve, reject) => {
    let buffer = initial;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socket ended before enough bytes arrived"));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < length) return;
      socket.pause();
      cleanup();
      resolve(buffer.subarray(0, length));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.resume();
  });
}

test("parseConnectAuthority accepts canonical authorities only", () => {
  assert.deepEqual(parseConnectAuthority("EXAMPLE.com:443"), {
    hostname: "example.com",
    port: 443,
  });
  assert.equal(parseConnectAuthority("example.com"), null);
  assert.equal(parseConnectAuthority("example.com:443/path"), null);
  assert.equal(parseConnectAuthority("user@example.com:443"), null);
  assert.equal(parseConnectAuthority("example.com:70000"), null);
});

test("HTTP CONNECT relays binary bytes over an authenticated WebSocket", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  let requestUrl;
  let authorization;
  upstream.on("connection", (socket, request) => {
    requestUrl = request.url;
    authorization = request.headers.authorization;
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });

  const relay = await startConnectRelay({
    relayToken: "relay-token-for-test",
    relayUrl: `ws://127.0.0.1:${upstreamAddress.port}/tcp?network=tamia`,
    allowedHosts: new Set(["allowed.example"]),
    connectTimeoutMs: 2_000,
  });
  const client = net.connect(relay.port, "127.0.0.1");
  const payload = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0xde, 0xad]);
  try {
    await once(client, "connect");
    client.write(
      Buffer.concat([
        Buffer.from("CONNECT ALLOWED.example:443 HTTP/1.1\r\nHost: ALLOWED.example:443\r\n\r\n"),
        payload,
      ]),
    );
    const response = await readThrough(client, Buffer.from("\r\n\r\n"));
    assert.match(response.header.toString("ascii"), /^HTTP\/1\.1 200 /u);
    const echoed = await readBytes(client, payload.length, response.remainder);
    assert.deepEqual(echoed, payload);
    assert.equal(authorization, "Bearer relay-token-for-test");
    const target = new URL(requestUrl, "ws://relay.invalid");
    assert.equal(target.searchParams.get("network"), "tamia");
    assert.equal(target.searchParams.get("host"), "allowed.example");
    assert.equal(target.searchParams.get("port"), "443");
  } finally {
    client.destroy();
    await relay.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("HTTP CONNECT rejects targets outside the allowlist before opening WSS", async () => {
  const relay = await startConnectRelay({
    relayToken: "relay-token-for-test",
    relayUrl: "ws://127.0.0.1:1/tcp",
    allowedHosts: new Set(["allowed.example"]),
    connectTimeoutMs: 200,
  });
  const client = net.connect(relay.port, "127.0.0.1");
  try {
    await once(client, "connect");
    client.write("CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n");
    const response = await readThrough(client, Buffer.from("\r\n\r\n"));
    assert.match(response.header.toString("ascii"), /^HTTP\/1\.1 403 /u);
  } finally {
    client.destroy();
    await relay.close();
  }
});

test("HTTP CONNECT reports an upstream WebSocket failure", async () => {
  const unavailable = net.createServer();
  await new Promise((resolve, reject) => {
    unavailable.once("error", reject);
    unavailable.listen(0, "127.0.0.1", resolve);
  });
  const unavailableAddress = unavailable.address();
  assert.ok(unavailableAddress && typeof unavailableAddress !== "string");
  const unavailablePort = unavailableAddress.port;
  await new Promise((resolve) => unavailable.close(resolve));

  const relay = await startConnectRelay({
    relayToken: "relay-token-for-test",
    relayUrl: `ws://127.0.0.1:${unavailablePort}/tcp`,
    allowedHosts: new Set(["allowed.example"]),
    connectTimeoutMs: 2_000,
  });
  const client = net.connect(relay.port, "127.0.0.1");
  try {
    await once(client, "connect");
    client.write("CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
    const response = await readThrough(client, Buffer.from("\r\n\r\n"));
    assert.match(response.header.toString("ascii"), /^HTTP\/1\.1 502 /u);
  } finally {
    client.destroy();
    await relay.close();
  }
});
