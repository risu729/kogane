import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
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
function fixture(session: object, data: FakeR2Bucket) {
  return Object.assign({} as Env, {
    ADMIN_TRIGGER_TOKEN: "admin-test-only",
    COLLECTOR_SCHEMA_VERSION: "test",
    VPOINT_SESSION: { idFromName: () => "test-id", get: () => session },
    DATA: data,
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

  for (const uploadFails of [false, true]) {
    test(`failed collection keeps safe diagnostics; upload failure=${uploadFails}`, async () => {
      const logs = captureLogs();
      const data = new FakeR2Bucket({
        beforePut: () => {
          if (uploadFails) throw new Error(PRIVATE);
        },
      });
      const env = fixture(
        {
          getSession: async () => {
            throw new Error(PRIVATE);
          },
        },
        data,
      );
      const response = await worker.fetch(trigger(), env);
      expect(response.status).toBe(502);
      const result = (await response.json()) as {
        terminal: { persisted: boolean; terminalKey: string };
      };
      expect(result.terminal.persisted).toBe(!uploadFails);
      if (!uploadFails) {
        const bytes = data.entries.get(result.terminal.terminalKey)!.bytes;
        expect(JSON.parse(new TextDecoder().decode(bytes)).providerOutcome).toBe("failed");
      } else
        expect([...data.entries.keys()].some((key) => key.endsWith("/terminal.json"))).toBe(false);
      expect(logs.join()).not.toContain(PRIVATE);
    });
  }

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
    await expect(worker.email(message, env, context())).rejects.toThrow("stage=email-forward");
    const failures = logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "collector-stage-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toBe("email-forward");
    expect(logs.join()).not.toContain(PRIVATE);
  });

  test("archives a V Point Pay notification in DATA and still forwards it", async () => {
    const logs = captureLogs();
    const data = new FakeR2Bucket();
    const importerPaths: string[] = [];
    const pending: Promise<unknown>[] = [];
    let forwards = 0;
    const env = Object.assign({} as Env, {
      VPOINT_EMAIL_RECIPIENT: "collector@example.invalid",
      VPOINT_PAY_EMAIL_RECIPIENT: "pay@example.invalid",
      VPOINT_EMAIL_FORWARD_TO: "mailbox@example.invalid",
      DATA: data,
      COLLECTOR_SCHEMA_VERSION: "test",
      RAW_EVIDENCE_IMPORTER: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          importerPaths.push(new URL(request.url).pathname);
          return Response.json({
            source: "v-point-pay-email",
            status: "sealed",
            centralRunId: 1,
            artifactCount: 2,
            sealed: true,
            allObjectsReused: false,
          });
        },
      },
    });
    const raw = new TextEncoder().encode(
      [
        "From: V Point Pay <info@prepaid.smbc-card.com>",
        "To: pay@example.invalid",
        `Subject: =?UTF-8?B?${Buffer.from("【VポイントPay】ご利用のお知らせ").toString("base64")}?=`,
        "Date: Sun, 31 Aug 2026 12:00:00 +0900",
        "Message-ID: <synthetic@example.invalid>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "◇利用金額：1円",
      ].join("\r\n"),
    );
    const message = Object.assign({} as ForwardableEmailMessage, {
      from: "info@prepaid.smbc-card.com",
      to: "pay@example.invalid",
      raw: new Blob([raw]).stream(),
      forward: async () => {
        forwards += 1;
      },
    });
    const ctx = {
      waitUntil(value: Promise<unknown>) {
        pending.push(value);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    await worker.email(message, env, ctx);
    await Promise.all(pending);
    expect(data.putKeys.filter((key) => key.startsWith("objects/"))).toHaveLength(2);
    expect(data.putKeys.at(-1)).toEndWith("/terminal.json");
    expect(importerPaths).toEqual([]);
    expect(forwards).toBe(1);
    expect(logs.join()).not.toContain("raw/v-point-pay-email/");
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
    await expect(worker.email(message, env, context())).resolves.toBeUndefined();
    expect(forwards).toBe(1);
  });
});

function context(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
