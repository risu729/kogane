import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createSmokeProxy, isSmokeEntrypoint } from "./pinned-chrome/image-smoke.mjs";

const servers: (http.Server | net.Server)[] = [];
async function listen(server: http.Server | net.Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
async function request(port: number, path: string, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Authorization: "synthetic-private" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
async function tunnel(port: number, authority: string, payload = "") {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${payload}`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n") && (!payload || response.endsWith(payload))) socket.end();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("the offline proxy forwards only a locally constructed GET root without incoming headers", async () => {
  let requests = 0;
  const pagePort = await listen(
    http.createServer((incoming, response) => {
      requests += 1;
      expect(incoming.url).toBe("/");
      expect(incoming.method).toBe("GET");
      expect(incoming.headers.authorization).toBeUndefined();
      response.end("synthetic page");
    }),
  );
  const tlsPort = await listen(net.createServer());
  let denied = 0;
  const proxyPort = await listen(
    createSmokeProxy(pagePort, tlsPort, () => {
      denied += 1;
    }),
  );
  expect(await request(proxyPort, `http://127.0.0.1:${pagePort}/`)).toEqual({
    status: 200,
    body: "synthetic page",
  });
  for (const path of [
    `http://localhost:${pagePort}/`,
    `http://127.0.0.2:${pagePort}/`,
    `http://127.0.0.1:${tlsPort}/`,
    `https://127.0.0.1:${pagePort}/`,
    `http://user:password@127.0.0.1:${pagePort}/`,
    `http://127.0.0.1:${pagePort}@example.com/`,
    `http://127.0.0.1:${pagePort}/favicon.ico`,
    `http://127.0.0.1:${pagePort}/../`,
    `http://127.0.0.1:${pagePort}/%2e%2e/`,
    `http://127.0.0.1:${pagePort}/?target=https://example.com/`,
    `http://127.0.0.1:${pagePort}/#fragment`,
    "/",
    "//example.com/",
  ])
    expect({ path, status: (await request(proxyPort, path)).status }).toEqual({
      path,
      status: 403,
    });
  for (const method of ["POST", "PUT", "DELETE", "HEAD"])
    expect((await request(proxyPort, `http://127.0.0.1:${pagePort}/`, method)).status).toBe(403);
  expect(requests).toBe(1);
  expect(denied).toBe(17);
  // Bun's HTTP parser refuses this malformed request target before the handler.
  expect((await request(proxyPort, "not-a-url")).status).toBe(400);
  expect(denied).toBe(17);
  expect(requests).toBe(1);
});

test("the offline proxy tunnels only the exact locally allocated TLS endpoint", async () => {
  const pagePort = await listen(http.createServer());
  let connections = 0;
  const tlsPort = await listen(
    net.createServer((socket) => {
      connections += 1;
      socket.on("data", (bytes) => socket.end(bytes));
    }),
  );
  let denied = 0;
  const proxyPort = await listen(
    createSmokeProxy(pagePort, tlsPort, () => {
      denied += 1;
    }),
  );
  for (const authority of [
    `localhost:${tlsPort}`,
    `127.0.0.2:${tlsPort}`,
    `127.0.0.1:${pagePort}`,
    `user@127.0.0.1:${tlsPort}`,
    `127.0.0.1:${tlsPort}/`,
    `127.0.0.1:${tlsPort}?target=example.com`,
    `127.0.0.1:${tlsPort}@example.com`,
    `https://127.0.0.1:${tlsPort}`,
  ])
    expect(await tunnel(proxyPort, authority)).toBe("HTTP/1.1 403 Forbidden\r\n\r\n");
  expect(connections).toBe(0);
  expect(await tunnel(proxyPort, `127.0.0.1:${tlsPort}`, "synthetic TLS bytes")).toBe(
    "HTTP/1.1 200 Connection Established\r\n\r\nsynthetic TLS bytes",
  );
  expect(connections).toBe(1);
  expect(denied).toBe(8);
});

test("the offline proxy refuses invalid locally supplied ports", () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => createSmokeProxy(port, 443)).toThrow();
    expect(() => createSmokeProxy(80, port)).toThrow();
  }
});

test("node eval can import the smoke proxy without starting image-only browser checks", () => {
  const entry = new URL("./pinned-chrome/image-smoke.mjs", import.meta.url).href;
  const result = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const smoke = await import(${JSON.stringify(entry)}); console.log(typeof smoke.createSmokeProxy);`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result).toBe("function\n");
});

test("the smoke entry guard recognizes raw and encoded stdin URLs without executing imports", () => {
  const stdin = pathToFileURL(join(process.cwd(), "[eval1]"));
  expect(isSmokeEntrypoint(stdin.href, undefined)).toBe(true);
  expect(isSmokeEntrypoint(stdin.href.replace("%5Beval1%5D", "[eval1]"), undefined)).toBe(true);
  const module = new URL("./pinned-chrome/image-smoke.mjs", import.meta.url);
  expect(isSmokeEntrypoint(module.href, undefined)).toBe(false);
  expect(isSmokeEntrypoint(module.href, "other-entry.mjs")).toBe(false);
  expect(isSmokeEntrypoint(module.href, module.pathname)).toBe(true);
});
