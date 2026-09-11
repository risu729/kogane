import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { relayDiagnostics, startConnectRelay, trackRelayClosure } from "./connect-relay.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function nextPayload(peer) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.off("message", message);
      peer.off("error", error);
    };
    const error = (failure) => {
      cleanup();
      reject(failure);
    };
    const message = (...args) => {
      if (args[0].byteLength > 0) {
        cleanup();
        resolve(args);
      }
    };
    peer.on("message", message);
    peer.once("error", error);
  });
}
test("relay error-code diagnostics read accessors once and safely retain classification", (t) => {
  const records = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = console.warn = (value) => records.push(JSON.parse(String(value)));
  t.after(() => {
    console.log = previousLog;
    console.warn = previousWarn;
  });
  const diagnostic = relayDiagnostics(
    "11111111-1111-4111-8111-111111111111",
    undefined,
    "allowed.invalid",
  );
  let codeReads = 0;
  let errorReads = 0;
  const changing = {
    get code() {
      return ++codeReads === 1 ? "ECONNRESET" : "synthetic-private-second-value";
    },
  };
  diagnostic.mark(
    "local-tcp-error",
    { bufferedAmount: 0 },
    {
      get error() {
        errorReads++;
        return changing;
      },
    },
  );
  assert.equal(codeReads, 1);
  assert.equal(errorReads, 1);
  assert.equal(records.at(-1).errorCode, "ECONNRESET");
  assert.doesNotThrow(() =>
    diagnostic.mark(
      "websocket-error",
      { bufferedAmount: 0 },
      {
        error: {
          get code() {
            throw new Error("synthetic-private-accessor");
          },
        },
      },
    ),
  );
  assert.equal(records.at(-1).errorCode, "unclassified");
  diagnostic.mark(
    "websocket-stream-error",
    { bufferedAmount: 0 },
    {
      error: {
        code: {
          toString() {
            throw new Error("synthetic-private-coercion");
          },
        },
      },
    },
  );
  assert.equal(records.at(-1).errorCode, "unclassified");
  assert.doesNotThrow(() => diagnostic.record({ outcome: "closed", closeCode: 1000 }));
  assert.equal(records.at(-1).outcome, "closed");
  assert.ok(!JSON.stringify(records).includes("synthetic-private"));
});

async function upstream(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

test("relay diagnostics correlate both directions, count only bytes, and preserve EOF ordering", async (t) => {
  const records = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = console.warn = (value) => records.push(JSON.parse(String(value)));
  t.after(() => {
    console.log = previousLog;
    console.warn = previousWarn;
  });
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const runId = "11111111-1111-4111-8111-111111111111";
  const proxy = await startConnectRelay({
    relayUrl: `${url}?runId=${runId}&relayId=synthetic-untrusted-id`,
    relayToken: "synthetic-private-token",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer, request] = await connected;
  await response;
  const relayId = new URL(request.url, "http://loopback.invalid").searchParams.get("relayId");
  assert.match(relayId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const payload = Buffer.from("synthetic-private-payload");
  const message = nextPayload(peer);
  client.write(payload);
  assert.deepEqual((await message)[0], payload);
  let downstreamBytes = 0;
  const received = new Promise((resolve) =>
    client.on("data", (bytes) => {
      downstreamBytes += bytes.length;
      if (downstreamBytes === 40) resolve();
    }),
  );
  peer.send(Buffer.alloc(17, 7));
  peer.send(Buffer.alloc(23, 7));
  await received;
  const peerClosed = once(peer, "close");
  client.end();
  assert.equal((await peerClosed)[0], 1000);
  await proxy.close();
  const terminal = records.find(
    (record) => record.event === "sbi-shinsei-container-relay-closed" && record.relayId === relayId,
  );
  assert.equal(terminal.runId, runId);
  assert.equal(terminal.targetClass, "allowed-upstream");
  assert.equal(terminal.wsSentBytesQueued, payload.length);
  assert.equal(terminal.wsSentFramesQueued, 2);
  assert.equal(terminal.wsReceivedBytes, 40);
  assert.equal(terminal.wsReceivedFrames, 2);
  assert.equal(terminal.firstCloseEvent, "local-tcp-eof");
  assert.ok(terminal.bufferedAmountAtClose >= 0);
  assert.ok(terminal.maxBufferedAmount >= terminal.bufferedAmountAtClose);
  const timeline = terminal.closeTimeline;
  assert.ok(timeline.length <= 16);
  assert.ok(
    timeline.findIndex((entry) => entry.stage === "local-tcp-eof") <
      timeline.findIndex((entry) => entry.stage === "websocket-close-called"),
  );
  assert.equal(
    timeline.find((entry) => entry.stage === "websocket-close-called").requestedCode,
    1000,
  );
  assert.equal(timeline.find((entry) => entry.stage === "websocket-peer-close").receivedCode, 1000);
  assert.ok(
    timeline.every(
      (entry, index) =>
        entry.elapsedMs >= 0 && (index === 0 || entry.elapsedMs >= timeline[index - 1].elapsedMs),
    ),
  );
  const encoded = JSON.stringify(records);
  for (const secret of [
    "synthetic-private-token",
    "synthetic-private-payload",
    "synthetic-untrusted-id",
    "allowed.invalid",
    url,
  ])
    assert.ok(!encoded.includes(secret));
});

test("throwing metric loggers preserve proxy data and graceful close", async (t) => {
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = console.warn = () => {
    throw new Error("synthetic logger failure");
  };
  t.after(() => {
    console.log = previousLog;
    console.warn = previousWarn;
  });
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  await response;
  const message = nextPayload(peer);
  const peerClosed = once(peer, "close");
  client.end("synthetic-payload");
  assert.equal(String((await message)[0]), "synthetic-payload");
  assert.equal((await peerClosed)[0], 1000);
  await proxy.close();
});

test("initial empty binary frame precedes CONNECT head and TLS payload exactly once", async (t) => {
  const { server, url } = await upstream(t);
  const frames = [];
  server.on("connection", (peer) =>
    peer.on("message", (bytes, binary) => frames.push({ bytes, binary })),
  );
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  const response = once(client, "data");
  const head = Buffer.from("synthetic-first-tls-head");
  client.write(
    Buffer.concat([
      Buffer.from("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n"),
      head,
    ]),
  );
  const [peer] = await connected;
  assert.match(String((await response)[0]), /200 Connection Established/u);
  const peerClosed = once(peer, "close");
  const payload = Buffer.alloc(256 * 1024, 7);
  client.end(payload);
  assert.equal((await peerClosed)[0], 1000);
  assert.equal(frames[0].bytes.length, 0);
  assert.equal(frames[0].binary, true);
  assert.equal(frames.filter((frame) => frame.bytes.length === 0).length, 1);
  assert.deepEqual(
    Buffer.concat(frames.slice(1).map((frame) => frame.bytes)),
    Buffer.concat([head, payload]),
  );
  await proxy.close();
});

for (const sendFailure of ["throw", "callback", "stall"])
  test(`initial frame ${sendFailure} failure is bounded, visible and never acknowledges CONNECT`, async (t) => {
    const { url } = await upstream(t);
    const originalSend = WebSocket.prototype.send;
    const originalWarn = console.warn;
    const records = [];
    console.warn = (value) => records.push(JSON.parse(String(value)));
    WebSocket.prototype.send = function (data, ...args) {
      if (Buffer.isBuffer(data) && data.length === 0) {
        const error = Object.assign(new Error("synthetic-private-initial-error"), {
          code: "EPIPE",
        });
        if (sendFailure === "throw") throw error;
        if (sendFailure === "stall") return;
        queueMicrotask(() => args.at(-1)(error));
        return;
      }
      return originalSend.call(this, data, ...args);
    };
    t.after(() => {
      WebSocket.prototype.send = originalSend;
      console.warn = originalWarn;
    });
    const proxy = await startConnectRelay({
      relayUrl: url,
      relayToken: "synthetic-only",
      allowedHosts: new Set(["allowed.invalid"]),
      connectTimeoutMs: 100,
      closeTimeoutMs: 100,
    });
    t.after(() => proxy.close());
    const client = net.connect(proxy.port, "127.0.0.1");
    t.after(() => client.destroy());
    await once(client, "connect");
    const response = once(client, "data");
    client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
    assert.match(
      String((await response)[0]),
      sendFailure === "stall" ? /504 Gateway Timeout/u : /502 Bad Gateway/u,
    );
    await proxy.close();
    const terminal = records.find(
      (record) => record.event === "sbi-shinsei-container-relay-closed",
    );
    assert.equal(terminal.outcome, "failed");
    assert.ok(
      terminal.closeTimeline.some((entry) =>
        sendFailure === "stall"
          ? entry.stage === "connect-timeout"
          : entry.stage === "initial-frame-error" && entry.errorCode === "EPIPE",
      ),
    );
    assert.ok(!JSON.stringify(records).includes("synthetic-private"));
  });

test("normal relay close sends 1000 and waits for the peer's delayed close handshake", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const client = new WebSocket(url);
  const lifecycle = trackRelayClosure(client, { timeoutMs: 500 });
  const [peer] = await connected;
  await once(client, "open");
  peer.pause();
  const peerClosed = once(peer, "close");
  let completed = false;
  const closing = lifecycle.close().then(() => {
    completed = true;
  });
  await delay(25);
  assert.equal(completed, false);
  peer.resume();
  await closing;
  const [code] = await peerClosed;
  assert.equal(code, 1000);
});

test("proxy shutdown waits for a relay whose local TCP socket already closed", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  assert.match(String((await response)[0]), /200 Connection Established/u);
  peer.pause();
  const peerClosed = once(peer, "close");
  const clientClosed = once(client, "close");
  client.destroy();
  await clientClosed;
  // Allow the proxy's local socket close handler to run before global shutdown.
  await delay(10);
  let completed = false;
  const shutdown = proxy.close().then(() => {
    completed = true;
  });
  await delay(25);
  assert.equal(completed, false);
  peer.resume();
  await shutdown;
  const [code] = await peerClosed;
  assert.equal(code, 1000);
});

test("proxy shutdown closes still-active relays gracefully before returning", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  await response;
  const peerClosed = once(peer, "close");
  await proxy.close();
  assert.equal((await peerClosed)[0], 1000);
  client.destroy();
});

test("TCP EOF flushes its final payload before the stream sends a normal close frame", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  await response;
  const chunks = [];
  peer.on("message", (bytes) => chunks.push(bytes));
  const peerClosed = once(peer, "close");
  const finalPayload = Buffer.alloc(256 * 1024, 7);
  client.end(finalPayload);
  const [code] = await peerClosed;
  assert.deepEqual(Buffer.concat(chunks), finalPayload);
  assert.equal(code, 1000);
  await proxy.close();
  client.destroy();
});

test("proxy preserves an explicit peer close code instead of replacing it with the default", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  await response;
  const peerClosed = once(peer, "close");
  peer.close(1001, "synthetic peer shutdown");
  const [code, reason] = await peerClosed;
  assert.equal(code, 1001);
  assert.equal(String(reason), "synthetic peer shutdown");
});

test("remote termination without an error event remains an abnormal 1006 close", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const client = new WebSocket(url);
  const records = [];
  const lifecycle = trackRelayClosure(client, { onClosed: (record) => records.push(record) });
  const [peer] = await connected;
  await once(client, "open");
  peer.terminate();
  await lifecycle.closed;
  assert.deepEqual(records, [{ outcome: "abnormal-close", closeCode: 1006 }]);
});

test("a local TCP reset preserves its failure but closes the healthy Worker WebSocket gracefully", async (t) => {
  const records = [];
  const originalWarn = console.warn;
  console.warn = (value) => records.push(JSON.parse(String(value)));
  t.after(() => {
    console.warn = originalWarn;
  });
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({
    relayUrl: url,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    closeTimeoutMs: 500,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  await response;
  const peerClosed = once(peer, "close");
  client.resetAndDestroy();
  assert.equal((await peerClosed)[0], 1000);
  await proxy.close();
  assert.ok(
    records.some(
      (record) =>
        record.outcome === "failed" &&
        record.failureStage === "local-tcp" &&
        record.closeCode === 1000,
    ),
  );
  const terminal = records.find(
    (record) => record.outcome === "failed" && record.failureStage === "local-tcp",
  );
  assert.equal(terminal.firstCloseEvent, "local-tcp-error");
  const reset = terminal.closeTimeline.find((entry) => entry.stage === "local-tcp-error");
  assert.equal(reset.errorCode, "ECONNRESET");
  assert.ok(reset.elapsedMs >= 0);
});

test("an unresponsive peer has a bounded forced fallback instead of hanging shutdown", async (t) => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const client = new WebSocket(url);
  const records = [];
  const lifecycle = trackRelayClosure(client, {
    timeoutMs: 30,
    onClosed: (record) => records.push(record),
  });
  const [peer] = await connected;
  await once(client, "open");
  peer.pause();
  const start = Date.now();
  await lifecycle.close();
  assert.ok(Date.now() - start < 500);
  assert.deepEqual(records, [{ outcome: "forced-timeout", closeCode: 1006 }]);
  peer.resume();
});

test("a connection that never upgrades still returns a bounded 504", async (t) => {
  const sockets = new Set();
  const stalled = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => stalled.close(resolve));
  });
  const proxy = await startConnectRelay({
    relayUrl: `ws://127.0.0.1:${stalled.address().port}`,
    relayToken: "synthetic-only",
    allowedHosts: new Set(["allowed.invalid"]),
    connectTimeoutMs: 30,
    closeTimeoutMs: 30,
  });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  assert.match(String((await response)[0]), /504 Gateway Timeout/u);
  client.destroy();
  await proxy.close();
});

test("throwing close/terminate callbacks cannot escape cleanup and genuine errors remain failed", async () => {
  class BrokenRelay extends EventEmitter {
    readyState = WebSocket.OPEN;
    close() {
      throw new Error("private-close-body");
    }
    terminate() {
      throw new Error("private-terminate-body");
    }
  }
  const relay = new BrokenRelay();
  const records = [];
  const lifecycle = trackRelayClosure(relay, { onClosed: (record) => records.push(record) });
  await lifecycle.close();
  await lifecycle.abort();
  assert.deepEqual(records, [{ outcome: "failed", closeCode: 1006 }]);
});
