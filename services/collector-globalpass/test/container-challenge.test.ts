import { describe, expect, spyOn, test } from "bun:test";
import { GLOBALPASS_CONTAINER_FAILURE_CODES, GLOBALPASS_CONTAINER_STAGES } from "../src/model";
// @ts-expect-error runtime container module is tested directly
import { obtainChallengeToken } from "../container/challenge.mjs";
// @ts-expect-error runtime container module is tested directly
import { createBrowserDiagnostics } from "../container/diagnostics.mjs";
// @ts-expect-error runtime container module is tested directly
import { CONTAINER_FAILURE_CODES, CollectorFailure, failureCode } from "../container/failure.mjs";

const runId = "01234567-89ab-4cde-8fab-0123456789ab";
const relayUrl = `wss://relay.test/tcp?runId=${runId}`;

function timeout(): Error {
  return Object.assign(new Error("private-wait-text"), { name: "TimeoutError" });
}

/**
 * A page whose `waitForFunction` answers each attempt in turn: `token`, a
 * timeout, or another error. `denied` makes the page read as Access Denied.
 */
function fakePage(
  attempts: Array<"token" | "timeout" | "closed">,
  options: { denied?: boolean; frames?: string[]; onWait?: () => void } = {},
) {
  let attempt = 0;
  const gotos: string[] = [];
  return {
    gotos,
    async goto(url: string) {
      gotos.push(url);
    },
    async waitForFunction() {
      options.onWait?.();
      const outcome = attempts[attempt++];
      if (outcome === "token") return true;
      if (outcome === "closed") throw new Error("private-target-closed");
      throw timeout();
    },
    frames() {
      return (options.frames ?? ["https://challenges.cloudflare.com/cdn-cgi/x"]).map((url) => ({
        url: () => url,
      }));
    },
    async evaluate() {
      return { tokenLength: 0, denied: options.denied === true };
    },
  };
}

function capture() {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((line) => {
    lines.push(String(line));
  });
  return {
    lines,
    events: () => lines.map((line) => JSON.parse(line)),
    restore: () => spy.mockRestore(),
  };
}

function options(
  lastHttpError = { status: null as number | null, host: null as string | null, seen: 0 },
) {
  return {
    diagnostics: createBrowserDiagnostics(relayUrl),
    lastHttpError,
    loginUrl: "https://login.test/",
    attempts: 3,
    attemptTimeoutMs: 10,
  };
}

describe("GLOBAL PASS challenge attempts", () => {
  test("a token on the first attempt reloads nothing", async () => {
    const log = capture();
    try {
      const page = fakePage(["token"]);
      expect(await obtainChallengeToken(page, options())).toBe(1);
      expect(page.gotos).toEqual([]);
      expect(log.events()).toEqual([
        expect.objectContaining({
          event: "globalpass-browser-diagnostic",
          runId,
          stage: "challenge",
          outcome: "attempt-success",
          attempt: 1,
          code: "token",
          turnstileFrames: 1,
        }),
      ]);
    } finally {
      log.restore();
    }
  });

  test("a stuck widget is retried on a fresh login page, with each attempt's last HTTP error", async () => {
    const log = capture();
    try {
      const lastHttpError = { status: null as number | null, host: null as string | null, seen: 0 };
      let waits = 0;
      const page = fakePage(["timeout", "token"], {
        onWait: () => {
          // The first attempt sees the PAT 401; the second sees nothing.
          if (++waits === 1) {
            lastHttpError.status = 401;
            lastHttpError.host = "turnstile";
            lastHttpError.seen += 1;
          }
        },
      });
      expect(await obtainChallengeToken(page, options(lastHttpError))).toBe(2);
      expect(page.gotos).toEqual(["https://login.test/"]);
      const [first, second] = log.events();
      expect(first).toMatchObject({
        outcome: "attempt-failed",
        attempt: 1,
        code: "token-timeout",
        lastHttpStatus: 401,
        lastHttpHost: "turnstile",
      });
      expect(second).toMatchObject({ outcome: "attempt-success", attempt: 2, code: "token" });
      expect(second).not.toHaveProperty("lastHttpStatus");
      expect(log.lines.join("\n")).not.toContain("private-");
    } finally {
      log.restore();
    }
  });

  test("three timeouts end as globalpass_challenge_timeout after three attempts", async () => {
    const log = capture();
    try {
      const page = fakePage(["timeout", "timeout", "timeout"], { frames: [] });
      const error = await obtainChallengeToken(page, options()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CollectorFailure);
      expect(error).toMatchObject({
        code: "globalpass_challenge_timeout",
        name: "TimeoutError",
        attempts: 3,
      });
      expect(page.gotos).toHaveLength(2);
      expect(log.events().map((e) => e.code)).toEqual([
        "widget-missing",
        "widget-missing",
        "widget-missing",
      ]);
    } finally {
      log.restore();
    }
  });

  test("attempt 1 counts the login page's HTTP errors, and each started attempt is reported", async () => {
    const log = capture();
    try {
      // A 403 seen while the login page loaded, before the challenge began.
      const lastHttpError = {
        status: 403 as number | null,
        host: "globalpass" as string | null,
        seen: 1,
      };
      const started: number[] = [];
      const page = fakePage(["timeout", "timeout", "timeout"]);
      await obtainChallengeToken(page, {
        ...options(lastHttpError),
        httpSeenAtStart: 0,
        onAttempt: (attempt: number) => started.push(attempt),
      }).catch(() => undefined);
      expect(started).toEqual([1, 2, 3]);
      const [first, second] = log.events();
      expect(first).toMatchObject({ attempt: 1, lastHttpStatus: 403, lastHttpHost: "globalpass" });
      expect(second).not.toHaveProperty("lastHttpStatus");
    } finally {
      log.restore();
    }
  });

  test("an edge refusal is not retried", async () => {
    const log = capture();
    try {
      const page = fakePage(["timeout", "token"], { denied: true });
      await expect(obtainChallengeToken(page, options())).rejects.toMatchObject({
        code: "globalpass_challenge_denied",
        attempts: 1,
      });
      expect(page.gotos).toEqual([]);
      expect(log.events()[0]).toMatchObject({ code: "edge-denied" });
    } finally {
      log.restore();
    }
  });

  test("a closed page is not a slow widget: no retry, its own code", async () => {
    const log = capture();
    try {
      const page = fakePage(["closed", "token"]);
      await expect(obtainChallengeToken(page, options())).rejects.toMatchObject({
        code: "globalpass_challenge_failed",
        attempts: 1,
      });
      expect(page.gotos).toEqual([]);
    } finally {
      log.restore();
    }
  });

  test("a reload that fails is the login page's failure", async () => {
    const log = capture();
    try {
      const page = fakePage(["timeout", "token"]);
      page.goto = async () => {
        throw timeout();
      };
      await expect(obtainChallengeToken(page, options())).rejects.toMatchObject({
        code: "globalpass_login_page_failed",
        name: "TimeoutError",
        attempts: 2,
      });
    } finally {
      log.restore();
    }
  });
});

describe("GLOBAL PASS container failure codes", () => {
  test("the container and the Worker hold the same closed lists", async () => {
    expect([...CONTAINER_FAILURE_CODES].sort()).toEqual(
      [...GLOBALPASS_CONTAINER_FAILURE_CODES].sort(),
    );
    const log = capture();
    try {
      const diagnostics = createBrowserDiagnostics(relayUrl);
      for (const stage of GLOBALPASS_CONTAINER_STAGES) {
        await diagnostics.step(stage, async () => undefined);
      }
      expect(log.events().every((e) => e.stage !== "unknown")).toBe(true);
    } finally {
      log.restore();
    }
  });

  test("a failure takes its own code, else the code of the first stage that failed", async () => {
    const log = capture();
    try {
      expect(failureCode(new CollectorFailure("globalpass_login_rejected", "x"), "challenge")).toBe(
        "globalpass_login_rejected",
      );
      expect(new CollectorFailure("private-code", "x").code).toBe("browser_collection_failed");
      const diagnostics = createBrowserDiagnostics(relayUrl);
      await diagnostics
        .step("collection", () =>
          diagnostics.step("month-discovery", async () => {
            throw new Error("private-selector");
          }),
        )
        .catch(() => undefined);
      expect(diagnostics.failedStage).toBe("month-discovery");
      expect(failureCode(new Error("private"), diagnostics.failedStage)).toBe(
        "globalpass_month_discovery_failed",
      );
      expect(failureCode(new Error("private"), undefined)).toBe("browser_collection_failed");
    } finally {
      log.restore();
    }
  });

  test("a teardown failure after another failure does not take over its stage", async () => {
    const log = capture();
    try {
      const diagnostics = createBrowserDiagnostics(relayUrl);
      await diagnostics
        .step(
          "browser-close",
          async () => {
            throw new Error("private-close");
          },
          { blame: false },
        )
        .catch(() => undefined);
      expect(diagnostics.failedStage).toBeUndefined();
      expect(log.events().at(-1)).toMatchObject({ stage: "browser-close", outcome: "failed" });
    } finally {
      log.restore();
    }
  });

  test("the relay summary keeps counts and closed socket codes only", () => {
    const log = capture();
    try {
      createBrowserDiagnostics(relayUrl).relaySummary({
        connects: 7,
        denied: 2,
        established: 5,
        upstreamFailed: 0,
        upstreamTimeout: -1,
        bytesUp: 10,
        bytesDown: 20,
        socketErrors: { ECONNRESET: 2, "private-code": 1, other: 1 },
      });
      expect(log.events()[0]).toEqual({
        event: "globalpass-container-relay-summary",
        runId,
        connects: 7,
        denied: 2,
        established: 5,
        upstreamFailed: 0,
        upstreamTimeout: 0,
        bytesUp: 10,
        bytesDown: 20,
        socketErrors: { ECONNRESET: 2, other: 1 },
      });
    } finally {
      log.restore();
    }
  });
});
