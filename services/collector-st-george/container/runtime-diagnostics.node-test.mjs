import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CollectionError,
  createRuntimeDiagnostics,
  publicFailure,
  redactNotice,
  redactNotices,
  runBrowserCollection,
} from "./browser.mjs";

const secret = "SYNTHETIC_PRIVATE_CREDENTIAL_729";
function capture() {
  const events = [];
  let clock = 100;
  const diagnostic = createRuntimeDiagnostics({
    emit: (line) => events.push(JSON.parse(line)),
    now: () => clock,
  });
  clock = 125;
  return { diagnostic, events };
}

test("runtime failure emits once with fixed stage/type and no exception details", () => {
  const { diagnostic, events } = capture();
  diagnostic.stage("login-result-state");
  const error = new Error(secret);
  error.name = "TimeoutError";
  for (const key of ["message", "stack", "url"])
    Object.defineProperty(error, key, {
      get() {
        return assert.fail(`diagnostics must not inspect ${key}`);
      },
    });
  const summary = diagnostic.failure(error);
  assert.equal(diagnostic.failure(new Error(secret)), undefined);
  assert.deepEqual(events, [
    {
      event: "st-george-runtime-failure",
      stage: "login-result-state",
      errorType: "TimeoutError",
      refusal: "unknown",
      loginPostCount: 0,
      durationMs: 25,
      noticeCount: 0,
    },
  ]);
  assert.deepEqual(summary, {
    stage: "login-result-state",
    errorType: "TimeoutError",
    refusal: "unknown",
    loginPostCount: 0,
    durationMs: 25,
    notices: [],
  });
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.deepEqual(publicFailure(error), { status: "failed", reason: "runtime-failed" });
});

test("unexpected labels, unsafe accessors and throw values remain closed", () => {
  for (const error of [
    secret,
    null,
    { name: secret, message: secret },
    {
      get name() {
        throw new Error(secret);
      },
    },
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(secret);
        },
      },
    ),
  ]) {
    const { diagnostic, events } = capture();
    diagnostic.stage(secret);
    diagnostic.refusal(secret);
    diagnostic.failure(error);
    assert.equal(events[0].stage, "unknown");
    assert.equal(events[0].refusal, "unknown");
    assert.equal(events[0].errorType, "unknown");
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
  let reads = 0;
  const error = {
    get name() {
      return ++reads === 1 ? "Error" : secret;
    },
  };
  const { diagnostic, events } = capture();
  diagnostic.failure(error);
  assert.equal(reads, 1);
  assert.equal(events[0].errorType, "Error");
});

test("known collection failures retain their existing wire result", () => {
  const { diagnostic, events } = capture();
  const error = new CollectionError("authentication-challenge");
  diagnostic.stage("login-result-state");
  diagnostic.failure(error);
  assert.equal(events[0].errorType, "CollectionError");
  assert.deepEqual(publicFailure(error), { status: "failed", reason: "authentication-challenge" });
});

test("logging failure never replaces collection ownership", () => {
  const diagnostic = createRuntimeDiagnostics({
    emit() {
      throw new Error(secret);
    },
  });
  const error = new Error(secret);
  diagnostic.notices(["Request error"]);
  let summary;
  assert.doesNotThrow(() => (summary = diagnostic.failure(error)));
  assert.deepEqual(summary.notices, ["Request error"]);
  assert.deepEqual(publicFailure(error), { status: "failed", reason: "runtime-failed" });
  assert.deepEqual(publicFailure(error, summary), {
    status: "failed",
    reason: "runtime-failed",
    diagnostic: summary,
  });
});

test("bank notices keep words and lose numbers, addresses and control characters", () => {
  assert.equal(
    redactNotice("Access number 1234 5678 or 0412-345-678 locked\u0000 since 08/11/2026."),
    "Access number # or # locked since #.",
  );
  assert.equal(redactNotice("Write to a.b@example.invalid now"), "Write to [email] now");
  assert.equal(redactNotice("Step 2"), "Step #");
  assert.equal(redactNotice("\u202eReversed\u200b text"), "Reversed text");
  assert.equal(redactNotice("y".repeat(500)).length, 160);
  for (const value of [null, undefined, 7, {}, ["x"]]) assert.equal(redactNotice(value), "");
  assert.deepEqual(redactNotices("not a list"), []);
  assert.deepEqual(redactNotices(["", " ", "A", "A", "B", "C", "D", "E"]), ["A", "B", "C", "D"]);
  const { diagnostic } = capture();
  diagnostic.notices([secret.replace(/\d+/gu, "123"), 5]);
  const summary = diagnostic.failure(new Error(secret));
  assert.deepEqual(summary.notices, ["SYNTHETIC_PRIVATE_CREDENTIAL_#"]);
});

test("login POST observation is bounded and independent of failure stage", () => {
  for (const count of [0, 1, 2, 3]) {
    const { diagnostic, events } = capture();
    for (let index = 0; index < count; index++) diagnostic.loginPost();
    diagnostic.stage("login-submit");
    diagnostic.failure(new Error(secret));
    assert.equal(events[0].stage, "login-submit");
    assert.equal(events[0].loginPostCount, Math.min(2, count));
  }
});

test("runtime wrapper logs validation failure once and keeps its public result", async () => {
  const events = [];
  const original = console.error;
  console.error = (value) => events.push(JSON.parse(value));
  try {
    const result = await runBrowserCollection({ credential: secret });
    assert.deepEqual(Object.keys(result).sort(), ["diagnostic", "reason", "status"]);
    assert.equal(result.reason, "invalid-request");
    assert.equal(result.diagnostic.stage, "request-validation");
    assert.deepEqual(result.diagnostic.notices, []);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), [
      "durationMs",
      "errorType",
      "event",
      "loginPostCount",
      "noticeCount",
      "refusal",
      "stage",
    ]);
    assert.equal(events[0].event, "st-george-runtime-failure");
    assert.equal(events[0].stage, "request-validation");
    assert.equal(events[0].errorType, "CollectionError");
    assert.equal(events[0].loginPostCount, 0);
    assert.ok(Number.isSafeInteger(events[0].durationMs) && events[0].durationMs >= 0);
    assert.equal(JSON.stringify(events).includes(secret), false);
    console.error = () => {
      throw new Error(secret);
    };
    const unlogged = await runBrowserCollection({ credential: secret });
    assert.equal(unlogged.status, "failed");
    assert.equal(unlogged.reason, "invalid-request");
  } finally {
    console.error = original;
  }
});
