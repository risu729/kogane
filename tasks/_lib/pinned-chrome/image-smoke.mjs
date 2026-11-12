// Run only via `docker run --network none --entrypoint node IMAGE --input-type=module`
// with this file on stdin. It imports no server/collector and contacts loopback only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const launch = await import(pathToFileURL("/app/browser-launch.mjs"));
const { chromium } = await import(pathToFileURL("/app/node_modules/playwright/index.mjs"));
const version = "157.0.8103.78";
const directory = await mkdtemp(join(tmpdir(), "chrome-image-smoke-"));
const profilesBefore = (await readdir(tmpdir())).filter((name) =>
  name.startsWith("kogane-globalpass-profile-"),
);
const children = [];
const servers = [];
let deniedEgress = 0;
function child(executable, args, options) {
  const process = spawn(executable, args, options);
  // Observe spawn errors even before a readiness wait attaches.
  process.once("error", () => {});
  children.push(process);
  return process;
}
async function stop(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit");
  process.kill("SIGTERM");
  const force = setTimeout(() => process.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}
async function listening(server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function ready(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("synthetic_browser_not_ready");
}
async function chromeProcesses() {
  let count = 0;
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/u.test(pid)) continue;
    try {
      if ((await realpath(`/proc/${pid}/exe`)).startsWith("/opt/google/chrome/")) count += 1;
    } catch {}
  }
  return count;
}
async function assertGtkRuntime() {
  let browsers = 0;
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/u.test(pid)) continue;
    try {
      if ((await realpath(`/proc/${pid}/exe`)) !== "/opt/google/chrome/chrome") continue;
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command.includes("--type=")) continue;
      assert.ok(command.split("\0").includes("--no-default-browser-check"));
      const maps = await readFile(`/proc/${pid}/maps`, "utf8");
      assert.match(maps, /\/libgtk-(?:3|4)\.so/u);
      assert.doesNotMatch(maps, /\/(?:libqt[56]_shim|libQt[56][^/ ]*)\.so/u);
      browsers += 1;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  assert.equal(browsers, 1);
}
async function render(browser, context, page) {
  assert.equal(browser.version(), version);
  await page.goto(`http://127.0.0.1:${pagePort}/`, { waitUntil: "load" });
  const measured = await page.evaluate(async () => {
    await document.fonts.ready;
    const canvas = document.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgb(17, 34, 51)";
    ctx.fillRect(0, 0, 10, 10);
    return {
      title: document.title,
      text: document.querySelector("p").textContent,
      color: [...ctx.getImageData(1, 1, 1, 1).data],
      textWidth: document.querySelector("p").getBoundingClientRect().width,
    };
  });
  assert.deepEqual(measured.color, [17, 34, 51, 255]);
  assert.equal(measured.title, "Synthetic Chrome rendering");
  assert.equal(measured.text, "Synthetic 日本語 123");
  assert.ok(measured.textWidth > 0);
  assert.ok((await page.screenshot()).length > 1000);
  // No ignoreHTTPSErrors, SPKI bypass or certificate-error browser flag.
  await assert.rejects(page.goto(`https://127.0.0.1:${tlsPort}/`), /ERR_CERT_AUTHORITY_INVALID/u);
  assert.ok(context.pages().length >= 1);
  await assertGtkRuntime();
}
let pagePort;
let tlsPort;
try {
  assert.equal(await realpath("/usr/bin/google-chrome"), "/opt/google/chrome/google-chrome");
  assert.equal(await realpath("/usr/bin/google-chrome-stable"), "/opt/google/chrome/google-chrome");
  assert.match(
    execFileSync("/usr/bin/google-chrome", ["--version"], { encoding: "utf8" }),
    new RegExp(`^Google Chrome ${version.replaceAll(".", "\\.")}`),
  );
  assert.equal((await stat("/opt/google/chrome/chrome-sandbox")).mode & 0o7777, 0o755);
  assert.ok(
    (await readFile("/etc/ssl/certs/ca-certificates.crt", "utf8")).includes("BEGIN CERTIFICATE"),
  );
  const latinFont = execFileSync("fc-match", ["-f", "%{family}", "Liberation Sans"], {
    encoding: "utf8",
  });
  const japaneseFont = execFileSync("fc-match", ["-f", "%{family}", ":lang=ja"], {
    encoding: "utf8",
  });
  assert.match(latinFont, /Liberation Sans/u);
  assert.ok(japaneseFont.length > 0);
  // Inspect every bundled ELF, including crashpad, Vulkan/SwiftShader and management helpers.
  let elfFiles = 0;
  const optionalQt = {};
  const expectedQt = {
    "libqt5_shim.so": ["libQt5Core.so.5", "libQt5Gui.so.5", "libQt5Widgets.so.5"],
    "libqt6_shim.so": ["libQt6Core.so.6", "libQt6Gui.so.6", "libQt6Widgets.so.6"],
  };
  async function libraries(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await libraries(file);
      else if (entry.isFile()) {
        const handle = await open(file, "r");
        const bytes = Buffer.alloc(4);
        try {
          await handle.read(bytes, 0, 4, 0);
        } finally {
          await handle.close();
        }
        if (bytes.equals(Buffer.from([127, 69, 76, 70]))) {
          const result = execFileSync("ldd", [file], { encoding: "utf8", timeout: 10_000 });
          const missing = [...result.matchAll(/^\s*(\S+) => not found$/gmu)]
            .map((match) => match[1])
            .sort();
          assert.equal(
            result.split("\n").filter((line) => line.includes("not found")).length,
            missing.length,
          );
          if (
            file === `/opt/google/chrome/${entry.name}` &&
            Object.hasOwn(expectedQt, entry.name)
          ) {
            // These dynamically selected alternatives are not package Depends.
            // Exact deficits are recorded; every rendered path must additionally prove GTK use.
            assert.deepEqual(missing, [...expectedQt[entry.name]].sort());
            optionalQt[entry.name] = missing;
          } else assert.deepEqual(missing, [], "mandatory bundled ELF has an unresolved library");
          elfFiles += 1;
        }
      }
    }
  }
  await libraries("/opt/google/chrome");
  assert.ok(elfFiles >= 5);
  assert.equal(Object.keys(optionalQt).length, 2);
  assert.equal(await chromeProcesses(), 0);
  const xvfb = child("Xvfb", launch.XVFB_ARGS, { stdio: "ignore" });
  await ready(async () => {
    assert.equal(xvfb.exitCode, null);
    await access("/tmp/.X11-unix/X99");
    return true;
  });
  const pageServer = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Synthetic Chrome rendering</title><p style="font:24px Liberation Sans,sans-serif">Synthetic 日本語 123</p><canvas width="100" height="100"></canvas>',
    );
  });
  pagePort = await listening(pageServer);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  tlsPort = await listening(
    https.createServer(
      {
        key: await readFile(join(directory, "key.pem")),
        cert: await readFile(join(directory, "cert.pem")),
      },
      (_request, response) => response.end("synthetic"),
    ),
  );
  const proxy = http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.port !== String(pagePort)) {
      deniedEgress += 1;
      response.writeHead(403).end();
      return;
    }
    const upstream = http.request(url, { method: request.method }, (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connect", (request, socket, head) => {
    if (request.url !== `127.0.0.1:${tlsPort}`) {
      deniedEgress += 1;
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(tlsPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  const proxyPort = await listening(proxy);
  const paths = [];
  if (launch.launchProbeContext) {
    const launched = await launch.launchProbeContext(
      launch.probeConfiguration("chrome-stable-no-ua-all-tamia"),
      proxyPort,
      async () => ":99",
    );
    try {
      await render(launched.browser, launched.context, await launched.context.newPage());
      paths.push("globalpass-headed-stable-channel-persistent");
    } finally {
      await launched.close();
    }
    await ready(async () => (await chromeProcesses()) === 0);
  }
  const profileDirectory = join(directory, "wrapper-profile");
  const portServer = net.createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const debuggingPort = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const descriptor = launch.chromeLaunch
    ? launch.chromeLaunch(profileDirectory, debuggingPort, proxyPort)
    : launch.directChromeLaunch(
        launch.probeConfiguration("chrome-direct-process-attach-late-all-tamia"),
        proxyPort,
        profileDirectory,
        debuggingPort,
        ":99",
      );
  assert.ok(descriptor.args.includes("--no-sandbox"));
  const chrome = child(
    descriptor.executable,
    [...descriptor.args, `http://127.0.0.1:${pagePort}/`],
    descriptor.options,
  );
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  await ready(async () => {
    assert.equal(chrome.exitCode, null);
    return (await fetch(`${endpoint}/json/version`)).ok;
  });
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    await render(browser, browser.contexts()[0], browser.contexts()[0].pages()[0]);
    paths.push(
      launch.chromeLaunch
        ? "shinsei-headed-wrapper-cdp"
        : "globalpass-direct-probe-headed-wrapper-cdp",
    );
  } finally {
    await browser.close();
    await stop(chrome);
  }
  await ready(async () => (await chromeProcesses()) === 0);
  await rm(profileDirectory, { recursive: true, force: true });
  assert.deepEqual(
    (await readdir(tmpdir()))
      .filter((name) => name.startsWith("kogane-globalpass-profile-"))
      .sort(),
    profilesBefore.sort(),
  );
  await stop(xvfb);
  assert.ok(children.every((process) => process.exitCode !== null || process.signalCode !== null));
  console.log(
    JSON.stringify({
      event: "pinned_chrome_offline_smoke",
      version,
      paths,
      elfFiles,
      optionalQt,
      gtkRuntimeVerified: true,
      defaultBrowserCheckDisabledVerified: true,
      latinFont,
      japaneseFont,
      deniedEgress,
      rendered: true,
      untrustedCertificateRejected: true,
      cleaned: true,
    }),
  );
} finally {
  for (const process of children.reverse()) await stop(process);
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
  }
  await rm(directory, { recursive: true, force: true });
}
