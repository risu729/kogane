import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectFromPage,
  createRuntimeDiagnostics,
  hasExpectedLoginForm,
  publicFailure,
  readState,
} from "./browser.mjs";

const ORIGIN = "https://ibanking.stgeorge.com.au";
const LOGIN = ORIGIN + "/ibank/loginPage.action";
const LOGIN_POST = ORIGIN + "/ibank/logonActionSimple.action";
const PORTFOLIO = ORIGIN + "/ibank/viewAccountPortfolio.html";
const TRANSACTIONS = ORIGIN + "/ibank/accountDetails.action";
const secret = "SYNTHETIC_PRIVATE_REFUSAL_729";
const credential = { userId: secret, securityNumber: secret, password: secret };

// A structural page/CDP fake: no Chromium, sockets, fetch, or provider request.
// It traverses the production login/check sequence but owns every operation.
function fixture(spec) {
  const listeners = new Map();
  const commands = [];
  const navigations = [];
  let current = LOGIN;
  let submitted = false;
  let clicks = 0;
  let requestEvents = 0;
  let postSubmitStateReads = 0;
  let detached = 0;
  let sessions = 0;
  const session = {
    on(event) {
      assert.equal(event, "Fetch.requestPaused");
    },
    async send(method) {
      commands.push(method);
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "synthetic-main-frame" } } };
      assert.ok(["Fetch.enable", "Fetch.disable"].includes(method));
      return {};
    },
    async detach() {
      detached++;
    },
  };
  const page = {
    on(event, callback) {
      assert.equal(listeners.has(event), false);
      listeners.set(event, callback);
    },
    off(event, callback) {
      assert.equal(listeners.get(event), callback);
      listeners.delete(event);
    },
    url: () => current,
    setDefaultTimeout() {},
    context: () => ({
      async newCDPSession() {
        sessions++;
        return session;
      },
    }),
    async goto(url) {
      assert.equal(url, LOGIN);
      navigations.push(url);
      current = url;
    },
    locator() {
      return {
        async fill() {},
        async press() {},
        async click() {
          clicks++;
          submitted = true;
          current = spec.target;
          requestEvents++;
          listeners.get("request")({
            method: () => "POST",
            url: () => LOGIN_POST,
          });
          if (spec.responseError)
            listeners.get("response")({
              status: () => 403,
              url: () => secret,
            });
        },
      };
    },
    async waitForURL() {
      assert.equal(current, LOGIN);
      throw new Error("synthetic-navigation-timeout");
    },
    async evaluate(operation) {
      if (operation === hasExpectedLoginForm) return true;
      assert.equal(operation, readState);
      if (!submitted) return { reason: null, login: true, portfolio: false };
      postSubmitStateReads++;
      if (spec.changeRoute) current = TRANSACTIONS;
      if (spec.changeRouteOnStateRead === postSubmitStateReads) current = spec.changedTarget;
      return {
        reason: spec.reason ?? null,
        login: spec.login ?? false,
        portfolio: spec.portfolio ?? false,
      };
    },
  };
  return {
    page,
    verify() {
      assert.equal(clicks, 1);
      assert.equal(requestEvents, 1);
      assert.deepEqual(navigations, [LOGIN]);
      assert.equal(listeners.size, 0);
      assert.equal(sessions, 1);
      assert.equal(detached, 1);
      assert.deepEqual(commands, ["Page.getFrameTree", "Fetch.enable", "Fetch.disable"]);
      if (spec.minimumStateReads !== undefined) {
        assert.ok(postSubmitStateReads >= spec.minimumStateReads);
        assert.ok(postSubmitStateReads <= spec.maximumStateReads);
      } else assert.equal(postSubmitStateReads, spec.stateReads ?? 0);
    },
  };
}

const refused = [
  { refusal: "response-inspection", target: PORTFOLIO, responseError: true },
  { refusal: "route-other-origin", target: "https://synthetic.invalid/" + secret },
  {
    refusal: "route-userinfo",
    target: "https://" + secret + "@" + ORIGIN.slice(8) + "/ibank/viewAccountPortfolio.html",
  },
  { refusal: "route-fragment", target: PORTFOLIO + "#" + secret },
  { refusal: "route-path", target: ORIGIN + "/ibank/" + secret },
  {
    name: "a throwing refusal callback",
    refusal: "route-path",
    target: ORIGIN + "/ibank/" + secret,
    refusalCallbackThrows: true,
  },
  { refusal: "route-invalid", target: secret },
  { refusal: "route-login-post", target: LOGIN_POST },
  {
    refusal: "route-changed",
    target: PORTFOLIO,
    changeRoute: true,
    portfolio: true,
    stateReads: 1,
  },
  { refusal: "result-route-not-portfolio", target: TRANSACTIONS, stateReads: 1 },
  {
    refusal: "portfolio-marker-missing",
    target: PORTFOLIO,
    minimumStateReads: 2,
    maximumStateReads: 101,
  },
  {
    name: "a different known route while waiting for portfolio cards",
    refusal: "route-changed",
    target: PORTFOLIO,
    changeRouteOnStateRead: 2,
    changedTarget: TRANSACTIONS,
    stateReads: 2,
  },
  {
    name: "a forbidden route while waiting for portfolio cards",
    refusal: "route-changed",
    target: PORTFOLIO,
    changeRouteOnStateRead: 2,
    changedTarget: "https://synthetic.invalid/" + secret,
    stateReads: 2,
  },
];
const unchanged = [
  {
    name: "recognized challenge",
    target: PORTFOLIO,
    reason: "authentication-challenge",
    expected: "authentication-challenge",
    stateReads: 1,
  },
  { name: "login remains", target: LOGIN, login: true, expected: "login-rejected", stateReads: 1 },
];

async function run(spec) {
  const fake = fixture(spec);
  const records = [];
  const refusals = [];
  const diagnostic = createRuntimeDiagnostics({
    emit: (line) => records.push(JSON.parse(line)),
    now: () => 0,
  });
  const extractors = {
    extractPortfolio() {
      return assert.fail("a stopped login must not extract portfolio data");
    },
    extractAccountDetails() {
      return assert.fail("a stopped login must not extract account data");
    },
  };
  const result = await collectFromPage(
    fake.page,
    credential,
    extractors,
    diagnostic.stage,
    diagnostic.loginPost,
    (value) => {
      refusals.push(value);
      if (spec.refusalCallbackThrows) throw new Error(secret);
      diagnostic.refusal(value);
    },
  ).catch((error) => {
    diagnostic.failure(error);
    return publicFailure(error);
  });
  assert.deepEqual(result, { status: "failed", reason: spec.expected ?? "unexpected-route" });
  assert.deepEqual(refusals, spec.refusal ? [spec.refusal] : []);
  assert.deepEqual(records, [
    {
      event: "st-george-runtime-failure",
      stage: "login-result-state",
      errorType: "CollectionError",
      loginPostCount: 1,
      refusal: spec.refusalCallbackThrows ? "unknown" : (spec.refusal ?? "unknown"),
      durationMs: 0,
    },
  ]);
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  fake.verify();
}

for (const spec of refused)
  test(
    "offline refusal distinguishes " +
      (spec.name ?? spec.refusal) +
      " without changing the public stop",
    { timeout: 15_000 },
    async () => {
      await run(spec);
    },
  );

for (const spec of unchanged)
  test("offline " + spec.name + " retains its existing public stop", async () => {
    await run(spec);
  });
