import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import http from "node:http";
import { chromium } from "playwright";
import { collectFromPage, publicFailure, validateRequest } from "./browser.mjs";
import { createServer } from "./server.mjs";

const secret = "SYNTHETIC_PRIVATE_CREDENTIAL_729";
const credential = { userId: secret, securityNumber: secret, password: secret };
// A fixture-local submit handler turns the observed POST/redirect into a fetch
// then a separate navigation, so each request is intercepted independently.
const login = `<form id="logonAction" method="POST" action="/ibank/logonActionSimple.action">
  <input id="access-number" name="userId">
  <input id="securityNumber" name="securityNumber" type="password">
  <input id="internet-password" name="password" type="password">
  <input name="devicePrint" type="hidden" id="device-print">
  <button id="logonButton" name="Login" type="submit" onclick="document.querySelector('#device-print').value='normal-handler'">Logon</button>
  </form><script>
  for (const id of ['securityNumber','internet-password']) document.getElementById(id).addEventListener('blur', (event) => { event.target.value = 'mapped'; });
  document.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch(event.target.action, { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
    if (response.ok) location.href = 'viewAccountPortfolio.html';
    else document.body.innerHTML = '<h1>Access Denied</h1>';
  });
  </script>`;
const portfolio = "<ul id=acctSummaryList><li>synthetic account</li></ul>";
const extractors = {
  extractPortfolio() {
    return [
      {
        accountKey: "a".repeat(64),
        label: "Synthetic account",
        currentBalanceText: "$1.00",
        availableBalanceText: "$1.00",
        detailsUrl: "https://ibanking.stgeorge.com.au/ibank/accountDetails.action?index=0",
      },
    ];
  },
  extractAccountDetails() {
    return {
      accountKey: "a".repeat(64),
      transactions: [],
      historyState: "unknown",
      pendingState: "unknown",
      openingBalanceText: null,
      closingBalanceText: null,
    };
  },
};
let browser;
let rejectingProxy;
let bankNetworkAttempts = 0;
let rejectedBankConnections = 0;
const observedRequests = new Set();
const interceptedRequests = new Set();
async function offlineContext() {
  const context = await browser.newContext();
  context.on("request", (request) => observedRequests.add(request));
  return context;
}
async function routeFixture(context, handler) {
  await context.route("**/*", (route) => {
    interceptedRequests.add(route.request());
    const url = new URL(route.request().url());
    if (
      url.origin !== "https://ibanking.stgeorge.com.au" ||
      ![
        "/ibank/loginPage.action",
        "/ibank/logonActionSimple.action",
        "/ibank/viewAccountPortfolio.html",
        "/ibank/accountDetails.action",
      ].includes(url.pathname)
    )
      return route.abort("blockedbyclient");
    return handler(route);
  });
}
before(async () => {
  // Defense in depth: even redirect hops which escape Playwright routing can
  // reach only this rejecting loopback proxy, never an upstream bank socket.
  rejectingProxy = http.createServer((_request, response) => {
    response.writeHead(502);
    response.end();
  });
  rejectingProxy.on("connect", (request, socket) => {
    if (request.url === "ibanking.stgeorge.com.au:443") bankNetworkAttempts++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    if (request.url === "ibanking.stgeorge.com.au:443") rejectedBankConnections++;
  });
  rejectingProxy.listen(0, "127.0.0.1");
  await once(rejectingProxy, "listening");
  browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${rejectingProxy.address().port}` },
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => rejectingProxy.close(resolve));
  // Chromium may preconnect before Fetch pauses the request. Such TCP attempts
  // terminate at the rejecting proxy; every actual request is locally routed.
  assert.equal(rejectedBankConnections, bankNetworkAttempts);
  assert.ok(observedRequests.size > 0);
  assert.ok([...observedRequests].every((request) => interceptedRequests.has(request)));
});

test("validates a fixed egress and never reflects invalid credentials", () => {
  assert.equal(validateRequest({ credential, egress: "direct" }).egress, "direct");
  for (const input of [
    { credential, egress: "automatic" },
    { credential, egress: "direct", relayToken: secret },
    { credential, egress: "tamia", relayToken: secret, relayUrl: "wss://other.invalid/tcp" },
    {
      credential,
      egress: "tamia",
      relayToken: secret.repeat(2),
      relayUrl: "wss://other.workers.dev/tcp",
    },
    { credential, egress: "direct", retry: true },
    { credential: { ...credential, token: secret }, egress: "direct" },
  ]) {
    try {
      validateRequest(input);
      assert.fail("expected rejection");
    } catch (error) {
      assert.deepEqual(publicFailure(error), { status: "failed", reason: "invalid-request" });
    }
  }
  assert.deepEqual(publicFailure(new Error(secret)), {
    status: "failed",
    reason: "runtime-failed",
  });
});

test("rejects a changed login destination before filling credentials", async () => {
  const context = await offlineContext();
  let posts = 0;
  try {
    await routeFixture(context, (route) => {
      if (route.request().method() === "POST") posts++;
      return route.fulfill({
        contentType: "text/html",
        body: login.replace("/ibank/logonActionSimple.action", "/ibank/viewAccountPortfolio.html"),
      });
    });
    const page = await context.newPage();
    const result = await collectFromPage(page, credential, extractors).catch(publicFailure);
    assert.deepEqual(result, { status: "failed", reason: "login-layout-unknown" });
    assert.equal(await page.locator("#access-number").inputValue(), "");
    assert.equal(posts, 0);
  } finally {
    await context.close();
  }
});

for (const [status, body, reason] of [
  [200, "<h1>Request Error</h1><p>private reference and VPN/TOR notice</p>", "bank-request-error"],
  [403, "<h1>Access Denied</h1>", "http-denied"],
  [
    200,
    "<h1>Verify your identity</h1><input autocomplete=one-time-code>",
    "authentication-challenge",
  ],
])
  test(`stops ${reason} before filling or submitting credentials`, async () => {
    const context = await offlineContext();
    let posts = 0;
    try {
      await routeFixture(context, (route) => {
        if (route.request().method() === "POST") posts++;
        return route.fulfill({ status, contentType: "text/html", body });
      });
      const page = await context.newPage();
      const failure = await collectFromPage(page, credential, extractors).catch(publicFailure);
      assert.deepEqual(failure, { status: "failed", reason });
      assert.equal(posts, 0);
      assert.equal(JSON.stringify(failure).includes(secret), false);
    } finally {
      await context.close();
    }
  });

test("normal form handlers run once and only schema projection leaves the browser", async () => {
  const context = await offlineContext();
  let submits = 0;
  let handlersRan = false;
  let detailsGets = 0;
  try {
    await routeFixture(context, (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        submits++;
        const form = new URLSearchParams(request.postData());
        handlersRan =
          form.get("securityNumber") === "mapped" &&
          form.get("password") === "mapped" &&
          form.get("devicePrint") === "normal-handler";
        return route.fulfill({ status: 200, contentType: "text/html", body: portfolio });
      }
      if (pathname === "/ibank/accountDetails.action") detailsGets++;
      return route.fulfill({
        contentType: "text/html",
        body: pathname === "/ibank/loginPage.action" ? login : portfolio,
      });
    });
    const page = await context.newPage();
    const result = await collectFromPage(page, credential, extractors);
    assert.equal(result.status, "success");
    assert.equal(submits, 1);
    assert.equal(handlersRan, true);
    assert.equal(detailsGets, 1);
    assert.equal(result.snapshot.accounts[0].historyState, "unknown");
    assert.equal("detailsUrl" in result.snapshot.accounts[0], false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes("devicePrint"), false);
  } finally {
    await context.close();
  }
});

test("rejects a challenge appearing during the final asynchronous extraction", async () => {
  const context = await offlineContext();
  try {
    await routeFixture(context, (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          new URL(route.request().url()).pathname === "/ibank/loginPage.action" ? login : portfolio,
      }),
    );
    const result = await collectFromPage(await context.newPage(), credential, {
      ...extractors,
      async extractAccountDetails() {
        await Promise.resolve();
        document.body.innerHTML = "<h1>Verify your identity</h1>";
        return {
          accountKey: "a".repeat(64),
          transactions: [],
          historyState: "unknown",
          pendingState: "unknown",
          openingBalanceText: null,
          closingBalanceText: null,
        };
      },
    }).catch(publicFailure);
    assert.deepEqual(result, { status: "failed", reason: "authentication-challenge" });
  } finally {
    await context.close();
  }
});

test("a rejection after the sole login POST is not retried", async () => {
  const context = await offlineContext();
  let submits = 0;
  try {
    await routeFixture(context, (route) => {
      const posted = route.request().method() === "POST";
      if (posted) submits++;
      return route.fulfill({
        status: posted ? 403 : 200,
        contentType: "text/html",
        body: posted ? "<h1>Access Denied</h1>" : login,
      });
    });
    const result = await collectFromPage(await context.newPage(), credential, extractors).catch(
      publicFailure,
    );
    assert.equal(result.status, "failed");
    assert.equal(submits, 1);
  } finally {
    await context.close();
  }
});

test("HTTP runtime serializes runs and sanitizes thrown errors", async () => {
  let release;
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = createServer(async () => {
    began();
    await gate;
    throw new Error(secret);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/collect`;
  const init = { method: "POST", body: JSON.stringify({ credential, egress: "direct" }) };
  try {
    const first = fetch(url, init);
    await started;
    const second = await fetch(url, init);
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { status: "failed", reason: "busy" });
    release();
    assert.deepEqual(await (await first).json(), { status: "failed", reason: "runtime-failed" });
  } finally {
    release();
    await new Promise((resolve) => server.close(resolve));
  }
});
