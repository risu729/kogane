import net from "node:net";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const port = Number(process.env.KOGANE_SOCKS_PORT || 11080);
const relayUrl =
  process.env.KOGANE_RELAY_URL ||
  "wss://kogane-globalpass-collector-poc.takuanimal.workers.dev/tcp";
const allowedHosts = new Set([
  "www.debit.vpass.ne.jp",
  "challenges.cloudflare.com",
  "brunhild.challenges.cloudflare.com",
  "kogane-globalpass-collector-poc.takuanimal.workers.dev",
]);

const lines = createInterface({ input: process.stdin, terminal: false });
const firstLine = await new Promise((resolve, reject) => {
  lines.once("line", resolve);
  lines.once("close", () => reject(new Error("relay token was not provided")));
});
lines.close();
const relayToken = String(firstLine).trim();
if (relayToken.length < 32) throw new Error("relay token is invalid");

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let phase = "greeting";
  let relay;

  const fail = () => {
    if (!socket.destroyed) socket.destroy();
    if (relay && relay.readyState < WebSocket.CLOSING) relay.close();
  };

  socket.on("data", (chunk) => {
    if (phase === "relay") {
      if (relay?.readyState === WebSocket.OPEN) relay.send(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (phase === "greeting") {
      if (buffer.length < 2) return;
      const methodCount = buffer[1];
      if (buffer.length < 2 + methodCount || buffer[0] !== 5) return fail();
      buffer = buffer.subarray(2 + methodCount);
      socket.write(Buffer.from([5, 0]));
      phase = "request";
    }
    if (phase !== "request" || buffer.length < 5) return;
    if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3) return fail();
    const length = buffer[4];
    if (buffer.length < 7 + length) return;
    const hostname = buffer.subarray(5, 5 + length).toString("utf8");
    const offset = 5 + length;
    const destinationPort = buffer.readUInt16BE(offset);
    const remainder = buffer.subarray(offset + 2);
    if (!allowedHosts.has(hostname) || destinationPort !== 443) return fail();

    phase = "connecting";
    const target = new URL(relayUrl);
    target.searchParams.set("host", hostname);
    target.searchParams.set("port", String(destinationPort));
    relay = new WebSocket(target, {
      headers: { authorization: `Bearer ${relayToken}` },
    });
    relay.binaryType = "arraybuffer";
    relay.on("open", () => {
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      phase = "relay";
      if (remainder.length) relay.send(remainder);
    });
    relay.on("message", (data) => socket.write(Buffer.from(data)));
    relay.on("close", () => socket.end());
    relay.on("error", fail);
  });
  socket.on("error", fail);
  socket.on("close", () => {
    if (relay && relay.readyState < WebSocket.CLOSING) relay.close();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, host: "127.0.0.1", port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
