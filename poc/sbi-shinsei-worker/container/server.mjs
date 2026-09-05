import { createStageDiagnostics } from "./stage-diagnostics.mjs";
import { observeChildProcess } from "./child-lifecycle.mjs";
import http from "node:http";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startConnectRelay } from "./connect-relay.mjs";

const LOGIN_URL =
  "https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/login?mode=1";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const PROXY_HOSTS = new Set([
  "bk.web.sbishinseibank.co.jp",
  "www.sbishinseibank.co.jp",
  "distribute.cafisbrain.com",
  "diproxy.cafisbrain.com",
  "platform-websdk.transmitsecurity.io",
]);
let collecting = false;
process.env.DISPLAY = ":99";
const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1365x768x24", "-nolisten", "tcp"], {
  stdio: "ignore",
});
const xvfbLifecycle = observeChildProcess(xvfb, "xvfb");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    xvfbLifecycle.stopping();
    xvfb.kill("SIGTERM");
    process.exit(0);
  });
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request-too-large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCredentialRequest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "credentialJson,relayToken,relayUrl" ||
    typeof value.credentialJson !== "string" ||
    typeof value.relayToken !== "string" ||
    value.relayToken.length < 32 ||
    typeof value.relayUrl !== "string" ||
    !value.relayUrl.startsWith("wss://")
  ) {
    throw new Error("request-shape");
  }
  const credential = JSON.parse(value.credentialJson);
  if (
    !credential ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    Object.keys(credential).sort().join(",") !== "accountNumber,branchNumber,powerDirectPassword" ||
    typeof credential.branchNumber !== "string" ||
    !/^\d{3}$/u.test(credential.branchNumber) ||
    typeof credential.accountNumber !== "string" ||
    !/^\d{7}$/u.test(credential.accountNumber) ||
    typeof credential.powerDirectPassword !== "string" ||
    credential.powerDirectPassword.length === 0 ||
    credential.powerDirectPassword.length > 128
  ) {
    throw new Error("credential-shape");
  }
  return {
    credential,
    relayToken: value.relayToken,
    relayUrl: value.relayUrl,
  };
}

function failure(stage, authenticationAttempted = false) {
  return JSON.stringify({ ok: false, stage, authenticationAttempted });
}

function validateHandoff(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_RESPONSE_BYTES) {
    return failure("handoff-size");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return failure("handoff-json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("handoff-shape");
  }
  if (parsed.ok === false) {
    const keys = Object.keys(parsed).sort().join(",");
    if (
      keys === "authenticationAttempted,ok,stage" &&
      typeof parsed.authenticationAttempted === "boolean" &&
      typeof parsed.stage === "string" &&
      /^[a-z0-9-]{1,80}$/u.test(parsed.stage)
    ) {
      return value;
    }
    return failure("handoff-shape");
  }
  const envelopeKeys = Object.keys(parsed).sort().join(",");
  if (
    parsed.ok !== true ||
    (envelopeKeys !== "ok,responses" && envelopeKeys !== "failure,ok,responses") ||
    !parsed.responses ||
    typeof parsed.responses !== "object" ||
    Array.isArray(parsed.responses)
  ) {
    return failure("handoff-shape");
  }
  const plans = [
    ["topBalances", "top-accounts-balance-and-activity"],
    ["balanceSummary", "balance-summary-and-stage"],
    ["exchangeRate", "exchange-rate"],
    ["yenDeposit", "yen-deposit-account"],
  ];
  const responseKeys = Object.keys(parsed.responses).sort();
  const expectedKeys = plans
    .slice(0, responseKeys.length)
    .map(([key]) => key)
    .sort();
  if (
    responseKeys.length < 1 ||
    responseKeys.length > plans.length ||
    responseKeys.some((key, index) => key !== expectedKeys[index]) ||
    Object.values(parsed.responses).some((entry) => typeof entry !== "string")
  ) {
    return failure("handoff-shape");
  }
  if (parsed.failure === undefined) {
    if (responseKeys.length !== plans.length) return failure("handoff-shape");
  } else {
    const next = plans[responseKeys.length];
    if (
      !next ||
      responseKeys.length === plans.length ||
      !parsed.failure ||
      typeof parsed.failure !== "object" ||
      Array.isArray(parsed.failure) ||
      Object.keys(parsed.failure).sort().join(",") !== "dataset,stage" ||
      parsed.failure.dataset !== next[1] ||
      typeof parsed.failure.stage !== "string" ||
      !/^[a-z0-9-]{1,80}$/u.test(parsed.failure.stage)
    ) {
      return failure("handoff-shape");
    }
  }
  return value;
}

async function waitForXvfb() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    xvfbLifecycle.assertRunning();
    try {
      await access("/tmp/.X11-unix/X99");
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Xvfb did not create its display socket");
}

async function availableLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("local port allocation failed");
  }
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForChromeEndpoint(endpoint, lifecycle) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    lifecycle.assertRunning();
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Google Chrome CDP endpoint did not become ready");
}

async function stopChild(child, lifecycle) {
  if (lifecycle.isStopped()) return;
  lifecycle.stopping();
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function collectAuthenticatedReadsInPage(session) {
  const maximumBytes = 2 * 1024 * 1024;
  const fail = (stage) => JSON.stringify({ ok: false, stage, authenticationAttempted: true });
  let csrfToken = session.csrfToken;
  const read = async (path, body, stage) => {
    let response;
    try {
      response = await fetch(path, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: session.authorization,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw { stage: `${stage}-network` };
    }
    if (!response.ok || response.redirected || response.type === "opaqueredirect") {
      throw { stage: `${stage}-http-${response.status}` };
    }
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw { stage: `${stage}-content-type` };
    }
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      throw { stage: `${stage}-oversize` };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw { stage: `${stage}-json` };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw { stage: `${stage}-shape` };
    }
    const header = data.header;
    if (header && typeof header === "object" && !Array.isArray(header)) {
      const nextToken = header.newToken;
      if (nextToken !== undefined) {
        if (typeof nextToken !== "string" || nextToken.length === 0) {
          throw { stage: `${stage}-invalid-token` };
        }
        csrfToken = nextToken;
      }
    }
    const stored = JSON.parse(JSON.stringify(data));
    if (stored.header && typeof stored.header === "object" && !Array.isArray(stored.header)) {
      delete stored.header.newToken;
    }
    return { raw: JSON.stringify(stored), data };
  };

  try {
    const validation = await read(
      "/SFC/app/IFCM_CommonAdapter/validateToken",
      undefined,
      "validate-token",
    );
    if (
      !validation.data.header ||
      validation.data.header.adapterResultCode !== "0" ||
      typeof validation.data.header.newToken !== "string" ||
      validation.data.header.newToken.length === 0
    ) {
      return fail("validate-token-result");
    }
    csrfToken = validation.data.header.newToken;
    const responses = {};
    const plans = [
      {
        key: "topBalances",
        dataset: "top-accounts-balance-and-activity",
        path: "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity",
        body: undefined,
        stage: "top-balances",
      },
      {
        key: "balanceSummary",
        dataset: "balance-summary-and-stage",
        path: "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage",
        body: undefined,
        stage: "balance-summary",
      },
      {
        key: "exchangeRate",
        dataset: "exchange-rate",
        path: "/SFC/app/IFCM_CommonAdapter/getExchangeRate",
        body: undefined,
        stage: "exchange-rate",
      },
      {
        key: "yenDeposit",
        dataset: "yen-deposit-account",
        path: "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount",
        body: { requestParam: { screenGroupID: "CTYD0004" } },
        stage: "yen-deposit",
      },
    ];
    for (const [index, plan] of plans.entries()) {
      let result;
      try {
        result = await read(plan.path, plan.body, plan.stage);
        if (!result.data.header || result.data.header.adapterResultCode !== "0") {
          throw { stage: `${plan.stage}-result-code` };
        }
      } catch (error) {
        if (index === 0) return fail(error?.stage ?? "top-balances-failed");
        return JSON.stringify({
          ok: true,
          responses,
          failure: {
            dataset: plan.dataset,
            stage: error?.stage ?? `${plan.stage}-failed`,
          },
        });
      }
      responses[plan.key] = result.raw;
    }
    return JSON.stringify({
      ok: true,
      responses,
    });
  } catch (error) {
    return fail(error?.stage ?? "read-failed");
  } finally {
    csrfToken = "";
    session.authorization = "";
    session.csrfToken = "";
  }
}

async function collect({ credential, relayToken, relayUrl }) {
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "kogane-sbi-shinsei-profile-"));
  const debuggingPort = await availableLocalPort();
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  const startedAt = Date.now();
  const diagnostic = createStageDiagnostics(relayUrl);
  let currentStage = "chrome-start";
  const advance = (stage) => {
    currentStage = stage;
    diagnostic.begin(stage);
  };
  let authenticationAttempted = false;
  let relay;
  let child;
  let childLifecycle;
  let browser;
  try {
    advance("relay-start");
    relay = await startConnectRelay({
      relayToken,
      relayUrl,
      allowedHosts: PROXY_HOSTS,
    });
    advance("chrome-start");
    await waitForXvfb();
    child = spawn(
      "/usr/bin/google-chrome",
      [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDirectory}`,
        `--remote-debugging-port=${debuggingPort}`,
        "--remote-debugging-address=127.0.0.1",
        "--lang=ja-JP",
        `--proxy-server=http://127.0.0.1:${relay.port}`,
        "--window-size=1365,768",
        LOGIN_URL,
      ],
      {
        env: { ...process.env, DISPLAY: ":99", TZ: "Asia/Tokyo" },
        stdio: "ignore",
      },
    );
    childLifecycle = observeChildProcess(child, "chrome", { relayUrl });
    await waitForChromeEndpoint(endpoint, childLifecycle);
    const remaining = 25_000 - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    advance("chrome-attach");
    browser = await chromium.connectOverCDP(endpoint);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => {
      try {
        return new URL(candidate.url()).hostname === "bk.web.sbishinseibank.co.jp";
      } catch {
        return false;
      }
    });
    if (!page) return diagnostic.finish(failure("navigation-page-unavailable"));
    advance("navigation-final-url");
    await page
      .waitForURL(
        (url) =>
          url.hostname === "bk.web.sbishinseibank.co.jp" &&
          url.pathname.endsWith("/index.html") &&
          url.searchParams.get("mode") === "1",
        { waitUntil: "domcontentloaded", timeout: 20_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(1_500);
    advance("navigation-cafis");
    try {
      await page.waitForFunction(
        () =>
          Boolean(document.getElementById("dtokeninfo")) &&
          typeof globalThis.CAFISBrainRiskCollector?.getDeviceTokenInfoV3 === "function",
        null,
        { timeout: 45_000 },
      );
    } catch {
      return diagnostic.finish(failure("navigation-cafis-unavailable"));
    }
    advance("ui-input");
    const userId = `${credential.branchNumber}${credential.accountNumber}`;
    const userIdInput = page.locator('input[name="nationalId"]').first();
    const passwordInput = page.locator("#loginPassword").first();
    const loginButton = page.locator("#authForm p.btnSpace button").first();
    if (
      !(await userIdInput.isVisible().catch(() => false)) ||
      !(await passwordInput.isVisible().catch(() => false)) ||
      !(await loginButton.isVisible().catch(() => false))
    ) {
      return diagnostic.finish(failure("login-form-unavailable"));
    }
    await page.mouse.move(260, 220, { steps: 8 });
    await userIdInput.click();
    await userIdInput.pressSequentially(userId, { delay: 55 });
    await page.mouse.move(390, 320, { steps: 8 });
    await passwordInput.click();
    await passwordInput.pressSequentially(credential.powerDirectPassword, {
      delay: 65,
    });
    await passwordInput.press("Tab");
    if (!(await loginButton.isEnabled().catch(() => false))) {
      await userIdInput.fill("").catch(() => undefined);
      await passwordInput.fill("").catch(() => undefined);
      credential.powerDirectPassword = "";
      return diagnostic.finish(failure("login-button-disabled"));
    }
    advance("ui-waiters");
    const loginResponse = page
      .waitForResponse(
        (response) =>
          response.url().endsWith("/SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url") &&
          response.request().method() === "POST",
        { timeout: 45_000 },
      )
      .catch(() => null);
    const securityResponse = page
      .waitForResponse(
        (candidate) => {
          const url = new URL(candidate.url());
          return (
            url.origin === "https://bk.web.sbishinseibank.co.jp" &&
            url.pathname === "/SFC/app/IFCM_CommonAdapter/securityConnect" &&
            candidate.request().method() === "POST"
          );
        },
        { timeout: 30_000 },
      )
      .catch(() => null);
    advance("ui-click");
    await page.mouse.move(480, 460, { steps: 10 });
    const clicked = await loginButton
      .click({ noWaitAfter: true, timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      await userIdInput.fill("").catch(() => undefined);
      await passwordInput.fill("").catch(() => undefined);
      credential.powerDirectPassword = "";
      return diagnostic.finish(failure("login-button-click-failed"));
    }
    authenticationAttempted = true;
    advance("ui-login-response");
    const response = await loginResponse.catch(() => null);
    await userIdInput.fill("").catch(() => undefined);
    await passwordInput.fill("").catch(() => undefined);
    credential.powerDirectPassword = "";
    if (!response) return diagnostic.finish(failure("ui-login-response-timeout", true));
    if (!response.ok()) {
      return diagnostic.finish(failure(`login-http-${response.status()}`, true));
    }
    advance("login-session");
    const loginHeaders = await response.allHeaders();
    let authorization = loginHeaders.authorization;
    let loginRaw = await response.text();
    let loginData;
    try {
      loginData = JSON.parse(loginRaw);
    } catch {
      return diagnostic.finish(failure("login-json", true));
    }
    let csrfToken = loginData?.responseJSON?.token;
    if (
      loginData?.responseJSON?.authStatus !== "success" ||
      typeof authorization !== "string" ||
      authorization.length === 0 ||
      typeof csrfToken !== "string" ||
      csrfToken.length === 0
    ) {
      return diagnostic.finish(failure("login-shape", true));
    }
    advance("security-connect");
    loginRaw = "";
    loginData = null;
    const security = await securityResponse;
    if (!security) return diagnostic.finish(failure("security-connect-timeout", true));
    if (!security.ok()) {
      return diagnostic.finish(failure(`security-connect-http-${security.status()}`, true));
    }
    advance("authenticated-reads");
    const handoff = await page.evaluate(collectAuthenticatedReadsInPage, {
      authorization,
      csrfToken,
    });
    authorization = "";
    csrfToken = "";
    advance("handoff");
    return diagnostic.finish(validateHandoff(handoff));
  } catch {
    return diagnostic.finish(failure(`container-${currentStage}`, authenticationAttempted));
  } finally {
    credential.powerDirectPassword = "";
    if (browser) await diagnostic.cleanup("browser-close", () => browser.close());
    if (child && childLifecycle)
      await diagnostic.cleanup("chrome-stop", () => stopChild(child, childLifecycle));
    if (relay) await diagnostic.cleanup("relay-close", () => relay.close());
    await diagnostic.cleanup("profile-remove", () =>
      rm(profileDirectory, { recursive: true, force: true }),
    );
  }
}

http
  .createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/collect") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    if (collecting) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(failure("container-busy"));
      return;
    }
    collecting = true;
    let payload;
    try {
      let requestJson;
      try {
        requestJson = await readJson(request);
      } catch {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(failure("request-json"));
        return;
      }
      try {
        payload = parseCredentialRequest(requestJson);
      } catch {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(failure("request-shape"));
        return;
      }
      const result = await collect(payload);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(result);
    } catch {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(failure("container-internal"));
    } finally {
      if (payload) {
        payload.credential.powerDirectPassword = "";
        payload.relayToken = "";
      }
      collecting = false;
    }
  })
  .listen(8080, "0.0.0.0");
