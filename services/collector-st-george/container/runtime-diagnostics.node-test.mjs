import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CollectionError,
  createRuntimeDiagnostics,
  publicFailure,
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
        assert.fail(`diagnostics must not inspect ${key}`);
      },
    });
  diagnostic.failure(error);
  diagnostic.failure(new Error(secret));
  assert.deepEqual(events, [
    {
      event: "st-george-runtime-failure",
      stage: "login-result-state",
      errorType: "TimeoutError",
      loginPostCount: 0,
      durationMs: 25,
    },
  ]);
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
    diagnostic.failure(error);
    assert.equal(events[0].stage, "unknown");
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
  assert.doesNotThrow(() => diagnostic.failure(error));
  assert.deepEqual(publicFailure(error), { status: "failed", reason: "runtime-failed" });
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
    assert.deepEqual(await runBrowserCollection({ credential: secret }), {
      status: "failed",
      reason: "invalid-request",
    });
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), [
      "durationMs",
      "errorType",
      "event",
      "loginPostCount",
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
    assert.deepEqual(await runBrowserCollection({ credential: secret }), {
      status: "failed",
      reason: "invalid-request",
    });
  } finally {
    console.error = original;
  }
});
