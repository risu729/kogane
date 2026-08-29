import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium as patchrightChromium } from "patchright";
import { chromium } from "playwright";
import WebSocket from "ws";

const LOGIN_URL =
  "https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006";
const GLOBALPASS_HOST = "www.debit.vpass.ne.jp";
const TURNSTILE_HOST = "challenges.cloudflare.com";
const TURNSTILE_HELPER_HOST = "brunhild.challenges.cloudflare.com";
const PROBE_EGRESS_HOST = "kogane-globalpass-collector-poc.takuanimal.workers.dev";
const PROBE_EGRESS_URL = `https://${PROBE_EGRESS_HOST}/egress`;
const RELAY_HOSTS = new Set([
  GLOBALPASS_HOST,
  TURNSTILE_HOST,
  TURNSTILE_HELPER_HOST,
  PROBE_EGRESS_HOST,
]);
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const DAILY_MONTHS = 2;
const PROBE_VARIANTS = [
  "baseline",
  "webdriver-false",
  "windows",
  "headed-windows",
  "headed-persistent-windows",
  "chrome-stable-headed-persistent-windows",
  "chrome-stable-no-ua-direct",
  "chrome-stable-no-ua-split",
  "chrome-stable-no-ua-all-tamia",
  "chrome-stable-no-ua-all-tamia-default-automation",
  "chrome-stable-windows-matched-all-tamia",
  "chrome-stable-windows-matched-direct",
  "patchright-chrome-native-all-tamia",
  "patchright-chrome-native-direct",
  "chrome-direct-process-attach-late-all-tamia",
  "chrome-direct-process-attach-late-direct",
];
let collecting = false;
let xvfbProcess;

async function writeLine(response, value) {
  if (!response.write(`${JSON.stringify(value)}\n`)) {
    await once(response, "drain");
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validRequest(value) {
  return (
    value &&
    (value.mode === "daily" || value.mode === "backfill") &&
    typeof value.user === "string" &&
    value.user.length > 0 &&
    typeof value.password === "string" &&
    value.password.length > 0 &&
    typeof value.relayToken === "string" &&
    value.relayToken.length >= 32 &&
    typeof value.relayUrl === "string" &&
    value.relayUrl.startsWith("wss://")
  );
}

function validProbeRequest(value) {
  return (
    value &&
    PROBE_VARIANTS.includes(value.variant) &&
    typeof value.relayToken === "string" &&
    value.relayToken.length >= 32 &&
    typeof value.relayUrl === "string" &&
    value.relayUrl.startsWith("wss://")
  );
}

function startSocksRelay(relayToken, relayUrl) {
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
      const port = buffer.readUInt16BE(offset);
      const remainder = buffer.subarray(offset + 2);
      if (!RELAY_HOSTS.has(hostname) || port !== 443) return fail();

      phase = "connecting";
      const target = new URL(relayUrl);
      target.searchParams.set("host", hostname);
      target.searchParams.set("port", String(port));
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

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function normalizeMonth(label, value) {
  for (const candidate of [label, value]) {
    const match = candidate.match(/(20\d{2})\D*([01]?\d)/u);
    if (!match) continue;
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return `${match[1]}-${String(month).padStart(2, "0")}`;
    }
  }
  return null;
}

async function findMonthSelect(page) {
  const choices = await page.locator("select").evaluateAll((selects) =>
    selects.map((select, index) => ({
      index,
      options: [...select.options].map((option) => ({
        label: option.textContent?.trim() ?? "",
        value: option.value,
      })),
    })),
  );
  const ranked = choices
    .map((choice) => ({
      ...choice,
      months: choice.options
        .map((option) => ({
          ...option,
          month: normalizeMonth(option.label, option.value),
        }))
        .filter((option) => option.month !== null),
    }))
    .sort((left, right) => right.months.length - left.months.length);
  if (!ranked[0] || ranked[0].months.length < 2) {
    throw new Error("GLOBAL PASS activity month selector was not found");
  }
  return ranked[0];
}

async function openActivity(page) {
  try {
    await findMonthSelect(page);
    return;
  } catch {
    // The home screen exposes an activity link, not the month selector.
  }
  const candidates = page.getByRole("link", { name: /ご利用明細|利用明細/u });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    await candidate.click();
    await page.waitForLoadState("domcontentloaded");
    return;
  }
  throw new Error("GLOBAL PASS activity link was not found after login");
}

async function visibleLoginButton(page) {
  const candidates = page.locator(
    "button[name=nablarch_form1_2],button[name=nablarch_form1_5]",
  );
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  throw new Error("GLOBAL PASS visible login button was not found");
}

async function selectMonth(page, index, value) {
  const select = page.locator("select").nth(index);
  const changePost = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).hostname === GLOBALPASS_HOST &&
        response.request().method() === "POST",
      { timeout: 2_500 },
    )
    .then(() => true)
    .catch(() => false);
  await select.selectOption(value);
  if (!(await changePost)) {
    const form = select.locator("xpath=ancestor::form[1]");
    if ((await form.count()) !== 1) {
      throw new Error("GLOBAL PASS month selector has no enclosing form");
    }
    const submits = form.locator(
      'button[type="submit"],input[type="submit"]',
    );
    let clicked = false;
    const count = await submits.count();
    for (let submitIndex = 0; submitIndex < count; submitIndex += 1) {
      const submit = submits.nth(submitIndex);
      if (!(await submit.isVisible())) continue;
      const label = (
        (await submit.textContent()) ??
        (await submit.getAttribute("value")) ??
        ""
      ).trim();
      if (!/表示|照会|検索|選択/u.test(label)) continue;
      await submit.click();
      clicked = true;
      break;
    }
    if (!clicked) {
      throw new Error(
        "GLOBAL PASS month selection did not POST and has no read-only submit control",
      );
    }
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1_500);
  const selected = await page.locator("select").nth(index).inputValue();
  if (selected !== value) {
    throw new Error("GLOBAL PASS month selection did not stick");
  }
}

async function signOut(page) {
  const candidates = page.getByRole("link", { name: /ログアウト/u });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click().catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return;
  }
}

function normalizeDiagnosticPath(url) {
  if (url.pathname.startsWith("/turnstile/v0/")) {
    return url.pathname.endsWith("/api.js")
      ? "/turnstile/v0/<build>/api.js"
      : "/turnstile/v0/<redacted>";
  }
  if (url.pathname.startsWith("/cdn-cgi/challenge-platform/")) {
    if (url.pathname.includes("/pat/")) {
      return "/cdn-cgi/challenge-platform/<redacted>/pat/<redacted>";
    }
    return "/cdn-cgi/challenge-platform/<redacted>";
  }
  return url.pathname
    .replace(/;jsessionid=[^/;]+/giu, ";jsessionid=<redacted>")
    .slice(0, 120);
}

function probeConfiguration(variant) {
  const index = PROBE_VARIANTS.indexOf(variant);
  if (index >= 0 && index <= 5) {
    return {
      webdriverFalse: index >= 1,
      windows: index >= 2,
      windowsVersion: "153.0.0.0",
      headed: index >= 3,
      persistent: index >= 4,
      chromeStable: index >= 5,
      nativeContext: false,
      patchright: false,
      directChrome: false,
      egress: "split",
    };
  }
  const chromeNative = {
    webdriverFalse: true,
    windows: false,
    windowsVersion: null,
    headed: true,
    persistent: true,
    chromeStable: true,
    nativeContext: true,
    patchright: false,
    directChrome: false,
  };
  if (variant === "chrome-stable-no-ua-direct") {
    return { ...chromeNative, egress: "direct" };
  }
  if (variant === "chrome-stable-no-ua-split") {
    return { ...chromeNative, egress: "split" };
  }
  if (variant === "chrome-stable-no-ua-all-tamia") {
    return { ...chromeNative, egress: "all-tamia" };
  }
  if (variant === "chrome-stable-no-ua-all-tamia-default-automation") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      egress: "all-tamia",
    };
  }
  if (variant === "chrome-stable-windows-matched-all-tamia") {
    return {
      ...chromeNative,
      windows: true,
      windowsVersion: "152.0.7977.64",
      nativeContext: false,
      egress: "all-tamia",
    };
  }
  if (variant === "chrome-stable-windows-matched-direct") {
    return {
      ...chromeNative,
      windows: true,
      windowsVersion: "152.0.7977.64",
      nativeContext: false,
      egress: "direct",
    };
  }
  if (variant === "patchright-chrome-native-all-tamia") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      patchright: true,
      egress: "all-tamia",
    };
  }
  if (variant === "patchright-chrome-native-direct") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      patchright: true,
      egress: "direct",
    };
  }
  if (variant === "chrome-direct-process-attach-late-all-tamia") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      directChrome: true,
      egress: "all-tamia",
    };
  }
  if (variant === "chrome-direct-process-attach-late-direct") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      directChrome: true,
      egress: "direct",
    };
  }
  throw new Error("unknown probe configuration");
}

function probeContextOptions(config) {
  if (config.nativeContext) return { viewport: null };
  const windowsVersion = config.windowsVersion ?? "153.0.0.0";
  return {
    locale: config.windows ? "en-US" : "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1365, height: 768 },
    ...(config.windows
      ? { userAgent: windowsUserAgent(windowsVersion) }
      : {}),
  };
}

function windowsUserAgent(version) {
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  );
}

function diagnosticConsoleSignal(message) {
  const codes = message.match(/\b(?:1|2|3|4|6)\d{5}\b/gu) ?? [];
  if (!/turnstile|challenge|cloudflare|error/iu.test(message) && codes.length === 0) {
    return null;
  }
  return {
    codes: [...new Set(codes)].slice(0, 8),
    category: /turnstile/iu.test(message)
      ? "turnstile"
      : /challenge|cloudflare/iu.test(message)
        ? "challenge"
        : "error",
  };
}

function probeProxy(config, socksPort) {
  if (config.egress === "direct") return undefined;
  const bypass =
    config.egress === "split"
      ? `${TURNSTILE_HOST},${TURNSTILE_HELPER_HOST}`
      : undefined;
  return {
    server: `socks5://127.0.0.1:${socksPort}`,
    ...(bypass ? { bypass } : {}),
  };
}

async function ensureXvfb() {
  if (xvfbProcess && xvfbProcess.exitCode === null) return ":99";
  xvfbProcess = spawn(
    "Xvfb",
    [":99", "-screen", "0", "1365x768x24", "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    xvfbProcess.once("error", reject);
    const check = async (attempt) => {
      if (xvfbProcess.exitCode !== null) {
        reject(new Error(`Xvfb exited with code ${xvfbProcess.exitCode}`));
        return;
      }
      try {
        await access("/tmp/.X11-unix/X99");
        resolve();
      } catch {
        if (attempt >= 50) {
          reject(new Error("Xvfb did not create its display socket"));
          return;
        }
        setTimeout(() => void check(attempt + 1), 50);
      }
    };
    void check(0);
  });
  return ":99";
}

async function launchProbeContext(config, socksPort) {
  const browserType = config.patchright ? patchrightChromium : chromium;
  const args = config.patchright
    ? ["--no-sandbox"]
    : ["--no-sandbox", "--disable-dev-shm-usage"];
  if (config.webdriverFalse && !config.patchright) {
    args.push("--disable-blink-features=AutomationControlled");
  }
  if (config.headed) args.push("--window-size=1365,768");
  const display = config.headed ? await ensureXvfb() : undefined;
  const launchOptions = {
    headless: !config.headed,
    args,
    ...(config.chromeStable ? { channel: "chrome" } : {}),
    ...(display ? { env: { ...process.env, DISPLAY: display } } : {}),
    ...(probeProxy(config, socksPort)
      ? { proxy: probeProxy(config, socksPort) }
      : {}),
  };
  let browser;
  let context;
  let profileDirectory;
  if (config.persistent) {
    profileDirectory = await mkdtemp(
      path.join(os.tmpdir(), "kogane-globalpass-profile-"),
    );
    context = await browserType.launchPersistentContext(profileDirectory, {
      ...launchOptions,
      ...probeContextOptions(config),
    });
    browser = context.browser();
  } else {
    browser = await browserType.launch(launchOptions);
    context = await browser.newContext(probeContextOptions(config));
  }
  return {
    browser,
    context,
    async close() {
      try {
        if (config.persistent) await context.close();
        else await browser.close();
      } finally {
        if (profileDirectory) {
          await rm(profileDirectory, { recursive: true, force: true });
        }
      }
    },
  };
}

async function availableLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForChromeEndpoint(endpoint, child) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("Google Chrome exited with code " + child.exitCode);
    }
    try {
      const response = await fetch(endpoint + "/json/version");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Google Chrome CDP endpoint did not become ready");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function inspectProbePage(page) {
  return page.evaluate(() => {
    const input = document.querySelector("[name=cf-turnstile-response]");
    const body = document.body?.innerText ?? "";
    return {
      title: document.title.slice(0, 80),
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      webdriver: navigator.webdriver,
      language: navigator.language,
      languages: navigator.languages,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      loginFormVisible: Boolean(document.querySelector("#usrId")),
      denied: /Access Denied|アクセスが拒否/iu.test(body),
      challengeErrorCodes: [
        ...new Set(body.match(/\b(?:1|2|3|4|6)\d{5}\b/gu) ?? []),
      ].slice(0, 8),
      tokenLength: input && "value" in input ? input.value.length : 0,
      frames: [...document.querySelectorAll("iframe")]
        .map((frame) => {
          try {
            const url = new URL(frame.src);
            return {
              host: url.hostname,
              path: url.pathname.startsWith("/cdn-cgi/challenge-platform/")
                ? "/cdn-cgi/challenge-platform/<redacted>"
                : url.pathname.slice(0, 120),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(0, 8),
    };
  });
}

async function probeDirectChrome(payload, config, socksPort, startedAt) {
  const display = await ensureXvfb();
  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "kogane-globalpass-direct-chrome-profile-"),
  );
  const debuggingPort = await availableLocalPort();
  const endpoint = "http://127.0.0.1:" + debuggingPort;
  const attachedAfterMs = 25_000;
  const proxyArguments =
    config.egress === "direct"
      ? []
      : ["--proxy-server=socks5://127.0.0.1:" + socksPort];
  const child = spawn(
    "/usr/bin/google-chrome",
    [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=" + debuggingPort,
      "--remote-debugging-address=127.0.0.1",
      ...proxyArguments,
      "--window-size=1365,768",
      LOGIN_URL,
    ],
    {
      env: { ...process.env, DISPLAY: display },
      stdio: "ignore",
    },
  );
  let browser;
  try {
    await waitForChromeEndpoint(endpoint, child);
    const remaining = attachedAfterMs - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    browser = await chromium.connectOverCDP(endpoint);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page =
      pages.find((candidate) => {
        try {
          return new URL(candidate.url()).hostname === GLOBALPASS_HOST;
        } catch {
          return false;
        }
      }) ?? pages[0];
    if (!page) throw new Error("Google Chrome did not expose a page");
    const pageState = await inspectProbePage(page);
    return {
      variant: payload.variant,
      config,
      elapsedMs: Date.now() - startedAt,
      attachedAfterMs,
      tokenGenerated: pageState.tokenLength > 20,
      navigationStatus: null,
      browserVersion: browser.version(),
      egress: { route: config.egress, measured: false },
      page: pageState,
      consoleSignals: [],
      brunhildRequested: null,
      network: [],
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopChild(child);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

async function configureWindowsFingerprint(context, page, version) {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      get: () => "Win32",
    });
    Object.defineProperty(Navigator.prototype, "languages", {
      configurable: true,
      get: () => ["en-US", "ja", "en-AU", "en-GB", "en"],
    });
  });
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setUserAgentOverride", {
    userAgent: windowsUserAgent(version),
    acceptLanguage: "en-US,ja;q=0.9,en-AU;q=0.8,en-GB;q=0.7,en;q=0.6",
    platform: "Win32",
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: version.split(".")[0] },
        { brand: "Google Chrome", version: version.split(".")[0] },
        { brand: "Not_A Brand", version: "99" },
      ],
      fullVersionList: [
        { brand: "Chromium", version },
        { brand: "Google Chrome", version },
        { brand: "Not_A Brand", version: "99.0.0.0" },
      ],
      fullVersion: version,
      platform: "Windows",
      platformVersion: "10.0.0",
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  });
}

async function probeTurnstile(payload) {
  const config = probeConfiguration(payload.variant);
  const socks = await startSocksRelay(payload.relayToken, payload.relayUrl);
  let launched;
  const network = [];
  const recordNetwork = (value) => {
    if (network.length < 80) network.push(value);
  };
  const startedAt = Date.now();
  try {
    if (config.directChrome) {
      return await probeDirectChrome(payload, config, socks.port, startedAt);
    }
    launched = await launchProbeContext(config, socks.port);
    const { browser, context } = launched;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        ["about:", "blob:", "data:"].includes(url.protocol) ||
        RELAY_HOSTS.has(url.hostname)
      ) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    if (config.windows) {
      await configureWindowsFingerprint(
        context,
        page,
        config.windowsVersion ?? "153.0.0.0",
      );
    }
    const consoleSignals = [];
    page.on("console", (message) => {
      const signal = diagnosticConsoleSignal(message.text());
      if (signal && consoleSignals.length < 16) {
        consoleSignals.push({ type: message.type(), ...signal });
      }
    });
    page.on("pageerror", (error) => {
      const signal = diagnosticConsoleSignal(error.message);
      if (signal && consoleSignals.length < 16) {
        consoleSignals.push({ type: "pageerror", ...signal });
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!RELAY_HOSTS.has(url.hostname)) return;
      recordNetwork({
        event: "response",
        host: url.hostname,
        path: normalizeDiagnosticPath(url),
        method: response.request().method(),
        resourceType: response.request().resourceType(),
        status: response.status(),
      });
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (!RELAY_HOSTS.has(url.hostname)) return;
      recordNetwork({
        event: "requestfailed",
        host: url.hostname,
        path: normalizeDiagnosticPath(url),
        method: request.method(),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText?.slice(0, 100) ?? "unknown",
      });
    });
    page.setDefaultTimeout(30_000);
    let egress = null;
    try {
      const egressResponse = await page.goto(PROBE_EGRESS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (egressResponse?.ok()) egress = await egressResponse.json();
    } catch {
      egress = { error: "egress probe failed" };
    }
    const navigation = await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
    });
    let tokenGenerated = false;
    try {
      await page.waitForFunction(
        () => {
          const input = document.querySelector("[name=cf-turnstile-response]");
          return Boolean(input && "value" in input && input.value.length > 20);
        },
        undefined,
        { timeout: 30_000 },
      );
      tokenGenerated = true;
    } catch {}
    const pageState = await inspectProbePage(page);
    return {
      variant: payload.variant,
      config,
      elapsedMs: Date.now() - startedAt,
      tokenGenerated,
      navigationStatus: navigation?.status() ?? null,
      browserVersion: browser?.version() ?? "unknown",
      egress,
      page: pageState,
      consoleSignals,
      brunhildRequested: network.some(
        (entry) => entry.host === TURNSTILE_HELPER_HOST,
      ),
      network,
    };
  } finally {
    try {
      if (launched) await launched.close();
    } finally {
      await socks.close();
    }
  }
}

async function collect(payload, response) {
  const socks = await startSocksRelay(payload.relayToken, payload.relayUrl);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    proxy: {
      server: `socks5://127.0.0.1:${socks.port}`,
      bypass: `${TURNSTILE_HOST},${TURNSTILE_HELPER_HOST}`,
    },
  });
  let page;
  const networkDiagnostic = [];
  const recordNetwork = (value) => {
    if (networkDiagnostic.length < 24) networkDiagnostic.push(value);
  };
  try {
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1365, height: 768 },
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        ["about:", "blob:", "data:"].includes(url.protocol) ||
        RELAY_HOSTS.has(url.hostname)
      ) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    page = await context.newPage();
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      recordNetwork({
        event: "requestfailed",
        host: url.hostname,
        path: url.pathname.slice(0, 120),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText?.slice(0, 100) ?? "unknown",
      });
    });
    page.on("response", (pageResponse) => {
      if (pageResponse.status() < 400) return;
      const url = new URL(pageResponse.url());
      recordNetwork({
        event: "http",
        host: url.hostname,
        path: url.pathname.slice(0, 120),
        status: pageResponse.status(),
      });
    });
    page.setDefaultTimeout(45_000);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => {
        const input = document.querySelector("[name=cf-turnstile-response]");
        return Boolean(input && "value" in input && input.value.length > 20);
      });
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const response = document.querySelector("[name=cf-turnstile-response]");
        const body = document.body?.innerText ?? "";
        return {
          urlHost: location.hostname,
          title: document.title.slice(0, 80),
          responseField: response?.tagName ?? null,
          responseLength:
            response && "value" in response ? response.value.length : 0,
          loginFormVisible: Boolean(document.querySelector("#usrId")),
          denied: /Access Denied|アクセスが拒否/iu.test(body),
          frames: [...document.querySelectorAll("iframe")]
            .map((frame) => {
              try {
                const url = new URL(frame.src);
                return { host: url.hostname, path: url.pathname.slice(0, 120) };
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .slice(0, 8),
        };
      });
      throw new Error(
        `GLOBAL PASS Turnstile token unavailable: ${JSON.stringify({ networkDiagnostic, ...diagnostic })}`,
        { cause: error },
      );
    }
    await page.locator("#usrId").fill(payload.user);
    await page.locator("#password").fill(payload.password);
    await (await visibleLoginButton(page)).click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    const body = await page.locator("body").innerText();
    if (/Access Denied|アクセスが拒否/iu.test(body)) {
      throw new Error("GLOBAL PASS login was denied by the edge");
    }
    if (await page.locator("#usrId").isVisible().catch(() => false)) {
      throw new Error("GLOBAL PASS login returned to the credential form");
    }

    await openActivity(page);
    const selector = await findMonthSelect(page);
    const byMonth = new Map();
    for (const option of selector.months) {
      if (!byMonth.has(option.month)) byMonth.set(option.month, option.value);
    }
    const availableMonths = [...byMonth.keys()].sort().reverse();
    const selectedMonths =
      payload.mode === "backfill"
        ? availableMonths
        : availableMonths.slice(0, DAILY_MONTHS);
    await writeLine(response, {
      type: "metadata",
      availableMonths,
      selectedMonths,
      browserVersion: browser.version(),
    });
    for (const month of selectedMonths) {
      await selectMonth(page, selector.index, byMonth.get(month));
      const html = await page.content();
      if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
        throw new Error(`${month} activity HTML exceeded byte limit`);
      }
      await writeLine(response, { type: "artifact", month, html });
    }
    await signOut(page);
  } finally {
    try {
      await browser.close();
    } finally {
      await socks.close();
    }
  }
}

http
  .createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    const isCollect = request.method === "POST" && request.url === "/collect";
    const isProbe = request.method === "POST" && request.url === "/probe";
    if (!isCollect && !isProbe) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    if (collecting) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end('{"error":"collection already running"}');
      return;
    }
    collecting = true;
    try {
      const payload = await readJson(request);
      if (isProbe) {
        if (!validProbeRequest(payload)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end('{"error":"invalid probe request"}');
          return;
        }
        const result = await probeTurnstile(payload);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(result));
        return;
      }
      if (!validRequest(payload)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":"invalid collection request"}');
        return;
      }
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      try {
        await collect(payload, response);
      } catch (error) {
        await writeLine(response, {
          type: "error",
          errorType: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error ? error.message : "Collection failed",
        });
      }
      response.end();
    } catch {
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
      }
      response.end('{"error":"invalid request"}');
    } finally {
      collecting = false;
    }
  })
  .listen(8080, "0.0.0.0");
