import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startConnectRelay } from "./connect-relay.mjs";
import { observeChildProcess } from "./child-lifecycle.mjs";

const ORIGIN = "https://ibanking.stgeorge.com.au";
const LOGIN = ORIGIN + "/ibank/loginPage.action";
const PORTFOLIO = ORIGIN + "/ibank/viewAccountPortfolio.html";
const MAX_ACCOUNTS = 20;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const RUN_TIMEOUT_MS = 180_000;
export const PROXY_HOSTS = new Set([
  "ibanking.stgeorge.com.au",
  "www.stgeorge.com.au",
  "webapps.stgeorge.com.au",
  "digital-api.stgeorge.com.au",
]);
const FAILURE_CODES = new Set([
  "invalid-request",
  "runtime-unavailable",
  "runtime-failed",
  "deadline-exceeded",
  "bank-request-error",
  "authentication-challenge",
  "http-denied",
  "unexpected-route",
  "login-layout-unknown",
  "login-rejected",
  "session-expired",
  "navigation-failed",
  "snapshot-shape",
  "account-limit",
  "snapshot-limit",
  "download-blocked",
]);
export class CollectionError extends Error {
  constructor(code) {
    super(FAILURE_CODES.has(code) ? code : "runtime-failed");
  }
}
const fail = (code) => {
  throw new CollectionError(code);
};
export function publicFailure(error) {
  return {
    status: "failed",
    reason:
      error instanceof CollectionError && FAILURE_CODES.has(error.message)
        ? error.message
        : "runtime-failed",
  };
}
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
export function validateRequest(value) {
  if (
    !exactKeys(value, ["credential", "egress", "relayUrl", "relayToken"]) ||
    !exactKeys(value.credential, ["userId", "securityNumber", "password"]) ||
    !["direct", "tamia"].includes(value.egress)
  )
    fail("invalid-request");
  for (const key of ["userId", "securityNumber", "password"]) {
    const field = value.credential[key];
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > 512 ||
      /[\r\n\0]/u.test(field)
    )
      fail("invalid-request");
  }
  if (value.egress === "tamia") {
    try {
      const url = new URL(value.relayUrl);
      if (
        url.protocol !== "wss:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.port ||
        url.pathname !== "/tcp" ||
        url.hostname !== "kogane-st-george-collector.takuanimal.workers.dev" ||
        url.searchParams.size > 1 ||
        [...url.searchParams.keys()].some((key) => key !== "runId") ||
        (url.searchParams.has("runId") &&
          !/^[0-9a-f-]{36}$/iu.test(url.searchParams.get("runId"))) ||
        typeof value.relayToken !== "string" ||
        value.relayToken.length < 32 ||
        value.relayToken.length > 4096 ||
        /[\r\n\0]/u.test(value.relayToken)
      )
        fail("invalid-request");
    } catch {
      fail("invalid-request");
    }
  } else if (value.relayUrl !== undefined || value.relayToken !== undefined)
    fail("invalid-request");
  return value;
}

function routeOf(raw) {
  try {
    const url = new URL(raw);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) return "unknown";
    if (url.pathname === "/ibank/loginPage.action") return "login";
    if (url.pathname === "/ibank/viewAccountPortfolio.html") return "portfolio";
    if (url.pathname === "/ibank/accountDetails.action") return "transactions";
  } catch {
    /* Never include the offending URL in errors. */
  }
  return "unknown";
}

// Runs in the page, returning fixed labels/booleans only. No body or value leaves it.
export function readState() {
  const visible = (node) => node.getClientRects().length > 0;
  const has = (selector) => [...document.querySelectorAll(selector)].some(visible);
  const notices = [...document.querySelectorAll("h1,h2,[role=alert],.error")]
    .filter(visible)
    .map((node) => node.textContent ?? "")
    .join(" ");
  let reason = null;
  if (/request\s+error/iu.test(notices)) reason = "bank-request-error";
  else if (
    /captcha|verify your identity|unusual (?:activity|location)|account locked|secure code|one.time (?:code|password)|approve.*(?:app|device)/iu.test(
      notices,
    ) ||
    has(
      'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[id*="captcha"],input[autocomplete="one-time-code"]',
    )
  )
    reason = "authentication-challenge";
  else if (/access denied/iu.test(notices)) reason = "http-denied";
  else if (/session (?:has )?expired|session invalid|logged out|signed out/iu.test(notices))
    reason = "session-expired";
  return {
    reason,
    login:
      has('input[name="userId"]') &&
      has('input[name="securityNumber"]') &&
      has('input[name="password"]'),
    portfolio: has("#acctSummaryList > li"),
  };
}

// Check the observed form destination and control ownership before filling any
// credential. A familiar-looking input on a different form is not sufficient.
export function hasExpectedLoginForm() {
  const form = document.querySelector("#logonAction");
  if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== "post") return false;
  const action = new URL(form.action, location.href);
  if (action.href !== "https://ibanking.stgeorge.com.au/ibank/logonActionSimple.action")
    return false;
  return [
    ["#access-number", "userId"],
    ["#securityNumber", "securityNumber"],
    ["#internet-password", "password"],
    ["#logonButton", "Login"],
  ].every(([selector, name]) => {
    const control = document.querySelector(selector);
    return control?.form === form && control.name === name;
  });
}

// A page.route guard misses server redirect hops. Fetch pauses every main-frame
// Document GET before sending it, including those hops; auth itself is not replayed.
export async function navigateReadOnly(page, url) {
  if (routeOf(url) === "unknown") fail("unexpected-route");
  const session = await page.context().newCDPSession(page);
  const pending = [];
  let guardFailed = false;
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    session.on("Fetch.requestPaused", (event) => {
      const blocked =
        event.frameId === frameTree.frame.id &&
        (event.request.method !== "GET" || routeOf(event.request.url) === "unknown");
      pending.push(
        session
          .send(
            blocked ? "Fetch.failRequest" : "Fetch.continueRequest",
            blocked
              ? { requestId: event.requestId, errorReason: "BlockedByClient" }
              : { requestId: event.requestId },
          )
          .catch(() => {
            guardFailed = true;
          }),
      );
    });
    await session.send("Fetch.enable", {
      patterns: [{ resourceType: "Document", requestStage: "Request" }],
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await Promise.all(pending);
    if (guardFailed) fail("navigation-failed");
  } finally {
    await Promise.allSettled(pending);
    await session.send("Fetch.disable").catch(() => {});
    await session.detach().catch(() => {});
  }
}

export async function collectFromPage(page, credential, extractors) {
  let stopReason = null;
  const response = (event) => {
    try {
      if ([401, 403, 429].includes(event.status()) && new URL(event.url()).origin === ORIGIN)
        stopReason ??= "http-denied";
    } catch {
      stopReason ??= "unexpected-route";
    }
  };
  const download = (event) => {
    stopReason ??= "download-blocked";
    void event.cancel().catch(() => {});
  };
  page.on("response", response);
  page.on("download", download);
  const check = async () => {
    if (stopReason) fail(stopReason);
    const before = routeOf(page.url());
    if (before === "unknown") fail("unexpected-route");
    const state = await page.evaluate(readState);
    if (stopReason) fail(stopReason);
    if (state.reason) fail(state.reason);
    if (before !== routeOf(page.url())) fail("unexpected-route");
    return { ...state, route: before };
  };
  try {
    page.setDefaultTimeout(10_000);
    await navigateReadOnly(page, LOGIN);
    const initial = await check();
    if (initial.route !== "login" || !initial.login) fail("login-layout-unknown");
    if (!(await page.evaluate(hasExpectedLoginForm))) fail("login-layout-unknown");
    await page.locator("#access-number").fill(credential.userId);
    await page.locator("#securityNumber").fill(credential.securityNumber);
    await page.locator("#securityNumber").press("Tab");
    await page.locator("#internet-password").fill(credential.password);
    await page.locator("#internet-password").press("Tab");
    await check();
    // Exactly one genuine button click: blur mapping and onclick device-print
    // handlers belong to the bank. Never form.submit(), guessed POST, or retry.
    await page.locator("#logonButton").click({ timeout: 30_000 });
    if (routeOf(page.url()) === "login") {
      await page
        .waitForURL((url) => url.pathname !== "/ibank/loginPage.action", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        })
        .catch(async () => {
          await check();
          fail("login-rejected");
        });
    }
    const authenticated = await check();
    if (authenticated.login || authenticated.route === "login") fail("login-rejected");
    if (authenticated.route !== "portfolio" || !authenticated.portfolio) fail("unexpected-route");
    const portfolio = await page.evaluate(extractors.extractPortfolio);
    const portfolioState = await check();
    if (portfolioState.route !== "portfolio" || !portfolioState.portfolio) fail("unexpected-route");
    if (!Array.isArray(portfolio) || portfolio.length === 0) fail("snapshot-shape");
    if (portfolio.length > MAX_ACCOUNTS) fail("account-limit");
    const accounts = [];
    const seen = new Set();
    for (const account of portfolio) {
      await check();
      if (typeof account.accountKey !== "string" || seen.has(account.accountKey))
        fail("snapshot-shape");
      seen.add(account.accountKey);
      const details = new URL(account.detailsUrl, PORTFOLIO);
      if (
        routeOf(details.href) !== "transactions" ||
        details.searchParams.size !== 1 ||
        !/^[0-9]+$/u.test(details.searchParams.get("index") ?? "")
      )
        fail("snapshot-shape");
      await navigateReadOnly(page, details.href);
      const state = await check();
      if (state.login) fail("session-expired");
      const projected = await page.evaluate(extractors.extractAccountDetails);
      const projectedState = await check();
      if (projectedState.login) fail("session-expired");
      if (projectedState.route !== "transactions") fail("unexpected-route");
      if (!projected || projected.accountKey !== account.accountKey) fail("snapshot-shape");
      accounts.push({
        accountKey: account.accountKey,
        label: account.label,
        currentBalanceText: account.currentBalanceText,
        availableBalanceText: account.availableBalanceText,
        transactions: projected.transactions,
        historyState: projected.historyState,
        pendingState: projected.pendingState,
        openingBalanceText: projected.openingBalanceText,
        closingBalanceText: projected.closingBalanceText,
      });
    }
    const snapshot = {
      schema: "st-george-browser-v1",
      observedAt: new Date().toISOString(),
      currency: "AUD",
      currencyEvidence: "source-configured",
      accounts,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) fail("snapshot-limit");
    return { status: "success", snapshot };
  } finally {
    page.off("response", response);
    page.off("download", download);
  }
}

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new CollectionError("runtime-unavailable")),
      );
    });
  });
}
async function stopChild(child, lifecycle) {
  if (!child) return;
  lifecycle.stopping();
  if (lifecycle.isStopped()) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 20 && !lifecycle.isStopped(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!lifecycle.isStopped()) child.kill("SIGKILL");
}

export async function runBrowserCollection(input) {
  let browser, chromeChild, chromeLifecycle, xvfbChild, xvfbLifecycle, relay, profile;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void browser?.close().catch(() => {});
    chromeChild?.kill("SIGTERM");
  }, RUN_TIMEOUT_MS);
  try {
    const options = validateRequest(input);
    if (process.env.DEBUG || process.env.PWDEBUG) fail("runtime-unavailable");
    profile = await mkdtemp(path.join(os.tmpdir(), "kogane-st-george-"));
    if (options.egress === "tamia")
      relay = await startConnectRelay({
        relayToken: options.relayToken,
        relayUrl: options.relayUrl,
        allowedHosts: PROXY_HOSTS,
      });
    xvfbChild = spawn("Xvfb", [":99", "-screen", "0", "1365x768x24", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    xvfbLifecycle = observeChildProcess(xvfbChild, "xvfb");
    await new Promise((resolve) => setTimeout(resolve, 300));
    xvfbLifecycle.assertRunning();
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    chromeChild = spawn(
      process.env.CHROMIUM_PATH || chromium.executablePath(),
      [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        "--window-size=1365,768",
        ...(relay ? [`--proxy-server=http://127.0.0.1:${relay.port}`] : []),
        "about:blank",
      ],
      { env: { ...process.env, DISPLAY: ":99" }, stdio: "ignore" },
    );
    chromeLifecycle = observeChildProcess(chromeChild, "chrome");
    const readyDeadline = Date.now() + 15_000;
    let ready = false;
    while (!ready && Date.now() < readyDeadline) {
      if (expired) break;
      chromeLifecycle.assertRunning();
      try {
        ready = (await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        /* Startup only; never retries bank requests. */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready || expired) fail(expired ? "deadline-exceeded" : "runtime-unavailable");
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) fail("runtime-unavailable");
    const extractors = await import("./extract.mjs");
    const result = await collectFromPage(page, options.credential, extractors);
    if (expired) fail("deadline-exceeded");
    return result;
  } catch (error) {
    return expired ? publicFailure(new CollectionError("deadline-exceeded")) : publicFailure(error);
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    await stopChild(chromeChild, chromeLifecycle);
    await relay?.close().catch(() => {});
    await stopChild(xvfbChild, xvfbLifecycle);
    if (profile) {
      const absolute = path.resolve(profile);
      if (
        path.dirname(absolute) === path.resolve(os.tmpdir()) &&
        path.basename(absolute).startsWith("kogane-st-george-")
      )
        await rm(absolute, { recursive: true, force: true }).catch(() => {});
    }
  }
}
