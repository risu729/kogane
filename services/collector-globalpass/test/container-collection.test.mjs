import { describe, expect, spyOn, test } from "bun:test";
import { collect, writeLine } from "../container/collect.mjs";

async function run(options = {}) {
  const records = [],
    logs = [],
    closed = [],
    responses = [];
  let attempts = 0,
    credentialFills = 0;
  const timeout = () =>
    Object.assign(new Error("private-challenge-text"), { name: "TimeoutError" });
  const failure = (stage) => {
    if (options.failureStage === stage)
      throw Object.hasOwn(options, "failureValue")
        ? options.failureValue
        : new Error("private-provider-text");
  };
  const page = {
    on(event, listener) {
      if (event === "response") responses.push(listener);
    },
    setDefaultTimeout() {},
    async goto() {
      for (const listener of responses)
        listener({
          status: () => options.httpStatus ?? 200,
          url: () => "https://private-provider.test/login",
        });
    },
    async waitForFunction() {
      if (++attempts <= (options.challengeFailures ?? 0)) throw timeout();
    },
    async evaluate() {
      return { tokenLength: 0, denied: false };
    },
    frames() {
      return [];
    },
    locator(selector) {
      return {
        async fill() {
          credentialFills++;
        },
        async innerText() {
          return "";
        },
        async isVisible() {
          return selector !== "#usrId";
        },
      };
    },
    getByRole() {
      return {
        async count() {
          return 1;
        },
        nth() {
          return {
            async isVisible() {
              return true;
            },
            async click() {
              if (options.logoutFailed) throw new Error("private-signoff-text");
            },
          };
        },
      };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
  const response = {
    write(line) {
      records.push(JSON.parse(line));
      return true;
    },
  };
  const deps = {
    async startRelay() {
      return {
        port: 1234,
        stats: () => ({}),
        async close() {
          closed.push("relay");
          if (Object.hasOwn(options, "relayCloseError")) throw options.relayCloseError;
        },
      };
    },
    async launchBrowser() {
      return {
        browser: { version: () => "synthetic" },
        context: {
          async route() {},
          async newPage() {
            return page;
          },
        },
        async close() {
          closed.push("browser");
          if (Object.hasOwn(options, "browserCloseError")) throw options.browserCloseError;
        },
      };
    },
    pageSteps: {
      async visibleLoginButton() {
        return { async click() {} };
      },
      async openActivity() {
        failure("activity-open");
      },
      async findMonthSelect() {
        return { index: 0, months: [{ month: "2099-01", value: "synthetic" }] };
      },
      async selectMonth() {},
      async walkActivityPages(_page, stream, month) {
        failure("statement-read");
        await writeLine(stream, { type: "artifact", month, page: 1, pageCount: 1, html: "" });
      },
    },
    config: {
      loginUrl: "https://private-provider.test/login",
      allowedHosts: new Set(["private-provider.test"]),
      runtimeRevision: "synthetic",
      httpHostClass: () => "globalpass",
    },
  };
  const spies = ["log", "warn", "error"].map((level) =>
    spyOn(console, level).mockImplementation((line) => logs.push(String(line))),
  );
  try {
    await collect(
      {
        mode: "daily",
        user: "private-user",
        password: "private-password",
        relayToken: "private-token",
        relayUrl: "wss://private-relay.test/tcp",
      },
      response,
      deps,
    );
    expect(JSON.stringify(records) + logs.join("\n")).not.toContain("private-");
    return { records, logs, closed, attempts, credentialFills };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("GLOBAL PASS container orchestration", () => {
  test("three challenge timeouts retain their stage, count and closed code through teardown", async () => {
    const result = await run({ challengeFailures: 3 });
    expect(result.records).toEqual([
      {
        type: "error",
        operation: "browser-collection",
        errorType: "TimeoutError",
        errorCode: "globalpass_challenge_timeout",
        stage: "challenge",
        challengeAttempts: 3,
      },
    ]);
    expect(result.closed).toEqual(["browser", "relay"]);
    expect(result.credentialFills).toBe(0);
  });
  test("a later-stage failure keeps the successful challenge's attempt count", async () => {
    const result = await run({ challengeFailures: 1, failureStage: "activity-open" });
    expect(result.records).toEqual([
      {
        type: "error",
        operation: "browser-collection",
        errorType: "Error",
        errorCode: "globalpass_activity_open_failed",
        stage: "activity-open",
        challengeAttempts: 2,
      },
    ]);
    expect(result.credentialFills).toBe(2);
  });
  test("both teardown operations run without replacing a primary challenge failure", async () => {
    const result = await run({
      challengeFailures: 3,
      browserCloseError: new Error("private-browser"),
      relayCloseError: new Error("private-relay"),
    });
    expect(result.closed).toEqual(["browser", "relay"]);
    expect(result.records).toEqual([
      {
        type: "error",
        operation: "browser-collection",
        errorType: "TimeoutError",
        errorCode: "globalpass_challenge_timeout",
        stage: "challenge",
        challengeAttempts: 3,
      },
    ]);
  });
  test.each(["browser", "relay"])(
    "a %s teardown error after collection still fails the run",
    async (stage) => {
      const result = await run({ [`${stage}CloseError`]: new Error("private-cleanup") });
      expect(result.closed).toEqual(["browser", "relay"]);
      expect(result.records.at(-1)).toMatchObject({
        type: "error",
        errorCode: "globalpass_browser_close_failed",
        stage: `${stage}-close`,
        challengeAttempts: 1,
      });
      expect(result.records.filter((record) => record.type === "logout")).toEqual([
        { type: "logout", failed: false },
      ]);
    },
  );
  test.each([399, 400, 599, 600, 999])(
    "only 400-599 HTTP status is retained (status=%s)",
    async (status) => {
      const result = await run({ httpStatus: status, failureStage: "statement-read" });
      const error = result.records.at(-1);
      expect(error).toMatchObject({
        type: "error",
        stage: "statement-read",
        errorCode: "globalpass_statement_read_failed",
      });
      if (status >= 400 && status <= 599) expect(error.lastHttpStatus).toBe(status);
      else expect(error).not.toHaveProperty("lastHttpStatus");
    },
  );
  test.each([undefined, null, "private-value", 17, { token: "private-token" }])(
    "a thrown non-Error remains a failed acquisition (%p)",
    async (value) => {
      const result = await run({ failureStage: "activity-open", failureValue: value });
      expect(result.records).toEqual([
        {
          type: "error",
          operation: "browser-collection",
          errorType: "UnknownError",
          errorCode: "globalpass_activity_open_failed",
          stage: "activity-open",
          challengeAttempts: 1,
        },
      ]);
      expect(result.closed).toEqual(["browser", "relay"]);
    },
  );
  test("a failed provider logout remains an auxiliary flag after complete collection", async () => {
    const result = await run({ logoutFailed: true });
    expect(result.records.map((record) => record.type)).toEqual(["metadata", "artifact", "logout"]);
    expect(result.records.at(-1)).toEqual({ type: "logout", failed: true });
    expect(result.closed).toEqual(["browser", "relay"]);
  });
  test.each([undefined, null])(
    "a teardown throwing %p after success still emits an error record",
    async (value) => {
      const result = await run({ browserCloseError: value });
      expect(result.closed).toEqual(["browser", "relay"]);
      expect(result.records.at(-1)).toMatchObject({
        type: "error",
        errorType: "UnknownError",
        errorCode: "globalpass_browser_close_failed",
        stage: "browser-close",
        challengeAttempts: 1,
      });
    },
  );
  test.each([undefined, null])(
    "a first teardown throwing %p is not replaced by a later error",
    async (value) => {
      const result = await run({
        browserCloseError: value,
        relayCloseError: new TypeError("private-later-error"),
      });
      expect(result.closed).toEqual(["browser", "relay"]);
      expect(result.records.at(-1)).toMatchObject({
        type: "error",
        errorType: "UnknownError",
        errorCode: "globalpass_browser_close_failed",
        stage: "browser-close",
      });
    },
  );
});
