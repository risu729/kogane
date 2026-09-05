import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { startConnectRelay, trackRelayClosure } from "./connect-relay.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function upstream(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

test("normal relay close sends 1000 and waits for the peer's delayed close handshake", async t => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const client = new WebSocket(url);
  const lifecycle = trackRelayClosure(client, { timeoutMs: 500 });
  const [peer] = await connected;
  await once(client, "open");
  peer.pause();
  const peerClosed = once(peer, "close");
  let completed = false;
  const closing = lifecycle.close().then(() => { completed = true; });
  await delay(25);
  assert.equal(completed, false);
  peer.resume();
  await closing;
  const [code] = await peerClosed;
  assert.equal(code, 1000);
});

test("proxy shutdown waits for a relay whose local TCP socket already closed", async t => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({ relayUrl: url, relayToken: "synthetic-only", allowedHosts: new Set(["allowed.invalid"]), closeTimeoutMs: 500 });
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
  const shutdown = proxy.close().then(() => { completed = true; });
  await delay(25);
  assert.equal(completed, false);
  peer.resume();
  await shutdown;
  const [code] = await peerClosed;
  assert.ok(code === 1000 || code === 1005);
});

test("proxy shutdown closes still-active relays gracefully before returning", async t => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({ relayUrl: url, relayToken: "synthetic-only", allowedHosts: new Set(["allowed.invalid"]), closeTimeoutMs: 500 });
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

test("TCP EOF flushes its final payload before the stream sends a normal close frame", async t => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({ relayUrl: url, relayToken: "synthetic-only", allowedHosts: new Set(["allowed.invalid"]), closeTimeoutMs: 500 });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, "127.0.0.1");
  await once(client, "connect");
  const response = once(client, "data");
  client.write("CONNECT allowed.invalid:443 HTTP/1.1\r\nHost: allowed.invalid:443\r\n\r\n");
  const [peer] = await connected;
  await response;
  const chunks = [];
  peer.on("message", bytes => chunks.push(bytes));
  const peerClosed = once(peer, "close");
  const finalPayload = Buffer.alloc(256 * 1024, 7);
  client.end(finalPayload);
  const [code] = await peerClosed;
  assert.deepEqual(Buffer.concat(chunks), finalPayload);
  assert.ok(code === 1000 || code === 1005);
  await proxy.close();
  client.destroy();
});

test("remote termination without an error event remains an abnormal 1006 close", async t => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const client = new WebSocket(url);
  const records = [];
  const lifecycle = trackRelayClosure(client, { onClosed: record => records.push(record) });
  const [peer] = await connected;
  await once(client, "open");
  peer.terminate();
  await lifecycle.closed;
  assert.deepEqual(records, [{ outcome: "abnormal-close", closeCode: 1006 }]);
});

test("a local TCP reset preserves its failure but closes the healthy Worker WebSocket gracefully", async t => {
  const records = [];
  const originalWarn = console.warn;
  console.warn = value => records.push(JSON.parse(String(value)));
  t.after(() => { console.warn = originalWarn; });
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const proxy = await startConnectRelay({ relayUrl: url, relayToken: "synthetic-only", allowedHosts: new Set(["allowed.invalid"]), closeTimeoutMs: 500 });
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
  assert.ok(records.some(record => record.outcome === "failed" && record.failureStage === "local-tcp" && record.closeCode === 1000));
});

test("an unresponsive peer has a bounded forced fallback instead of hanging shutdown", async t => {
  const { server, url } = await upstream(t);
  const connected = once(server, "connection");
  const client = new WebSocket(url);
  const records = [];
  const lifecycle = trackRelayClosure(client, { timeoutMs: 30, onClosed: record => records.push(record) });
  const [peer] = await connected;
  await once(client, "open");
  peer.pause();
  const start = Date.now();
  await lifecycle.close();
  assert.ok(Date.now() - start < 500);
  assert.deepEqual(records, [{ outcome: "forced-timeout", closeCode: 1006 }]);
  peer.resume();
});

test("a connection that never upgrades still returns a bounded 504", async t => {
  const sockets = new Set();
  const stalled = net.createServer(socket => { sockets.add(socket); socket.on("data", () => {}); socket.on("close", () => sockets.delete(socket)); });
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => stalled.close(resolve)); });
  const proxy = await startConnectRelay({ relayUrl: `ws://127.0.0.1:${stalled.address().port}`, relayToken: "synthetic-only", allowedHosts: new Set(["allowed.invalid"]), connectTimeoutMs: 30, closeTimeoutMs: 30 });
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
    close() { throw new Error("private-close-body"); }
    terminate() { throw new Error("private-terminate-body"); }
  }
  const relay = new BrokenRelay();
  const records = [];
  const lifecycle = trackRelayClosure(relay, { onClosed: record => records.push(record) });
  await lifecycle.close();
  await lifecycle.abort();
  assert.deepEqual(records, [{ outcome: "failed", closeCode: 1006 }]);
});
