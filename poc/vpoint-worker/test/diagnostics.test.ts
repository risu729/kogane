import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logAuthTrace, safeFailure } from "../src/diagnostics";
import { collectVPoint } from "../src/vpoint";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../src/worker");
const PRIVATE = "test-secret-cookie-phone-email-provider-body";
afterEach(() => mock.restore());

function captureLogs() {
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((line) => {
    lines.push(String(line));
  });
  spyOn(console, "error").mockImplementation((line) => {
    lines.push(String(line));
  });
  return lines;
}
function fixture(session: object, snapshots: object) {
  return Object.assign({} as Env, {
    ADMIN_TRIGGER_TOKEN: "admin-test-only",
    COLLECTOR_SCHEMA_VERSION: "test",
    VPOINT_SESSION: { idFromName: () => "test-id", get: () => session },
    SNAPSHOTS: snapshots,
    VPOINT_PAY_SNAPSHOTS: {
      list: async () => ({ objects: [], truncated: false }),
      put: async () => null,
    },
    RAW_EVIDENCE_IMPORTER: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { manifestKey: string };
        return Response.json({
          source: "v-point",
          manifestKey: body.manifestKey,
          status: "sealed",
          centralRunId: 1,
          artifactCount: 1,
          sealed: true,
          allObjectsReused: false,
        });
      },
    },
  });
}
function trigger() {
  return new Request<unknown, IncomingRequestCfProperties>("https://collector.test/trigger", {
    method: "POST",
    headers: { authorization: "Bearer admin-test-only" },
  });
}

describe("V Point safe diagnostics", () => {
  test("untrusted exception names, messages, stacks and response details are omitted", () => {
    const error = Object.assign(new Error(PRIVATE), {
      name: PRIVATE,
      status: 500,
      applicationCode: PRIVATE,
    });
    expect(safeFailure(error)).toEqual({
      errorType: "UnknownError",
      failureCode: "operation_failed",
    });
    expect(JSON.stringify(safeFailure(error))).not.toContain(PRIVATE);
  });

  test("provider HTTP failure retains status and active read stage without response body", async () => {
    const stages: string[] = [];
    try {
      await collectVPoint({
        sessionCookie: `session=${PRIVATE}`,
        onStage: (stage) => stages.push(stage),
        fetcher: async () => new Response(PRIVATE, { status: 503 }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(stages).toEqual(["balance-read"]);
      expect(safeFailure(error)).toEqual({
        errorType: "VPointError",
        failureCode: "provider_http_failed",
        httpStatus: 503,
      });
      expect(JSON.stringify(safeFailure(error))).not.toContain(PRIVATE);
    }
  });

  test("malicious provider application status cannot become a diagnostic", async () => {
    try {
      await collectVPoint({
        sessionCookie: "session=test",
        fetcher: async () => Response.json({ status: { code: PRIVATE } }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(safeFailure(error)).toEqual({
        errorType: "VPointApplicationError",
        failureCode: "provider_application_failed",
      });
      expect(String(error)).not.toContain(PRIVATE);
    }
  });

  test("auth trace maps allowlisted steps and discards arbitrary URL and fields", () => {
    const logs = captureLogs();
    logAuthTrace("test-run", { pathname: `/private/${PRIVATE}`, status: 503 });
    logAuthTrace("test-run", { pathname: "/tm/pc/login/STKIp0002042.do", status: 200 });
    expect(JSON.parse(logs[0]!).step).toBe("other");
    expect(JSON.parse(logs[1]!).step).toBe("email-code-request");
    expect(logs.join()).not.toContain(PRIVATE);
  });

  test("partial R2 failure is correlated, preserves partial outcome and redacts failure manifest", async () => {
    const logs = captureLogs();
    let manifest = "";
    const env = fixture(
      { getSession: async () => `session=${PRIVATE}` },
      {
        put: async (key: string, body: string) => {
          if (key.endsWith("/balance-info.json")) throw new Error(PRIVATE);
          if (key.endsWith("/manifest.json")) manifest = body;
        },
      },
    );
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request) => {
          const path = new URL(String(input)).pathname;
          return Response.json({
            status: { code: "0000" },
            results: path.endsWith("tpoint_history") ? { history: [], total: 0 } : {},
            privateBody: PRIVATE,
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const response = await worker.fetch(trigger(), env);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(manifest);
    expect(parsed.status).toBe("partial");
    expect(parsed.failures[0]).toMatchObject({
      stage: "artifact-store",
      failureCode: "operation_failed",
    });
    const failures = logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "collector-stage-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].runId).toBe(parsed.runId);
    expect(logs.join()).not.toContain(PRIVATE);
    expect(manifest).not.toContain(PRIVATE);
  });

  test("terminal manifest write failure has a safe correlated error even without a saved manifest", async () => {
    const logs = captureLogs();
    const env = fixture(
      {
        getSession: async () => {
          throw new Error(PRIVATE);
        },
      },
      {
        put: async () => {
          throw new Error(PRIVATE);
        },
      },
    );
    await expect(worker.fetch(trigger(), env)).rejects.toThrow("manifest storage failed");
    const failures = logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "collector-stage-failed");
    expect(failures.map((failure) => failure.stage)).toEqual(["session-load", "manifest-store"]);
    expect(failures[0].runId).toBe(failures[1].runId);
    expect(logs.join()).not.toContain(PRIVATE);
  });

  test("forwarding failure is logged once with safe message and no email address or body", async () => {
    const logs = captureLogs();
    const env = Object.assign({} as Env, {
      VPOINT_EMAIL_RECIPIENT: "collector@example.invalid",
      VPOINT_PAY_EMAIL_RECIPIENT: "pay@example.invalid",
      VPOINT_EMAIL_FORWARD_TO: `${PRIVATE}@example.invalid`,
    });
    const message = Object.assign({} as ForwardableEmailMessage, {
      to: "other@example.invalid",
      forward: async () => {
        throw new Error(PRIVATE);
      },
    });
    await expect(worker.email(message, env)).rejects.toThrow("stage=email-forward");
    const failures = logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "collector-stage-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toBe("email-forward");
    expect(logs.join()).not.toContain(PRIVATE);
  });
});

describe("logging cannot change collector behavior", () => {
  test("throwing and non-string error properties degrade to safe classification", () => {
    for (const field of ["name", "status", "reasonCode", "applicationCode"]) {
      const error = new Error(PRIVATE);
      Object.defineProperty(error, field, {
        get() {
          throw new Error(PRIVATE);
        },
      });
      expect(safeFailure(error)).toEqual({
        errorType: "UnknownError",
        failureCode: "operation_failed",
      });
    }
    expect(safeFailure(Object.assign(new Error(PRIVATE), { name: null }))).toEqual({
      errorType: "UnknownError",
      failureCode: "operation_failed",
    });
  });

  test("throwing console does not skip email forwarding", async () => {
    let forwards = 0;
    spyOn(console, "log").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    spyOn(console, "error").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const env = Object.assign({} as Env, {
      VPOINT_EMAIL_RECIPIENT: "collector@example.invalid",
      VPOINT_PAY_EMAIL_RECIPIENT: "pay@example.invalid",
      VPOINT_EMAIL_FORWARD_TO: "mailbox@example.invalid",
    });
    const message = Object.assign({} as ForwardableEmailMessage, {
      to: "other@example.invalid",
      forward: async () => {
        forwards++;
      },
    });
    await expect(worker.email(message, env)).resolves.toBeUndefined();
    expect(forwards).toBe(1);
  });
});
