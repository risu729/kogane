import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  logFailure,
  MoneyForwardHttpError,
  MoneyForwardProtocolError,
  safeFailure,
} from "../src/diagnostics";
import { collectMoneyForward } from "../src/moneyforward";
import worker from "../src/worker";
import type { MoneyForwardCredential } from "../src/types";

afterEach(() => mock.restore());
const PRIVATE = "private-body-token-cookie-email-account-id";
const credential: MoneyForwardCredential = {
  rpId: "id.moneyforward.com",
  origin: "https://id.moneyforward.com",
  credentialId: "00112233-4455-6677-8899-aabbccddeeff",
  keyValue: "test-only",
  counter: 0,
};
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
function trigger() {
  return new Request("https://collector.test/trigger", {
    method: "POST",
    headers: { authorization: "Bearer test-admin" },
  }) as Parameters<typeof worker.fetch>[0];
}
function fixture(secret: string, data: FakeR2Bucket) {
  return Object.assign({} as Env, {
    ADMIN_TRIGGER_TOKEN: "test-admin",
    MONEYFORWARD_CREDENTIAL_JSON: secret,
    COLLECTOR_SCHEMA_VERSION: "test",
    DATA: data,
  });
}

describe("Money Forward safe stage diagnostics", () => {
  test("unknown or hostile errors cannot disclose data or break diagnostics", () => {
    const error = Object.assign(new Error(PRIVATE), { name: PRIVATE, status: 503 });
    expect(safeFailure(error)).toEqual({
      errorType: "UnknownError",
      failureCode: "operation_failed",
    });
    const hostile = new MoneyForwardHttpError(503);
    Object.defineProperty(hostile, "status", {
      get() {
        throw new Error(PRIVATE);
      },
    });
    expect(safeFailure(hostile)).toEqual({
      errorType: "UnknownError",
      failureCode: "operation_failed",
    });
    spyOn(console, "error").mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    expect(logFailure("test-run", "passkey-options", error).errorType).toBe("UnknownError");
  });

  test("passkey options HTTP failure preserves stage and status but never body or token", async () => {
    const stages: string[] = [];
    try {
      await collectMoneyForward({
        credential,
        onStage: (stage) => {
          stages.push(stage);
        },
        fetcher: async (input) =>
          String(input).endsWith("/sign_in")
            ? new Response(`<meta name="csrf-token" content="${PRIVATE}">`)
            : new Response(PRIVATE, { status: 503 }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(stages).toEqual(["login-entry", "passkey-options"]);
      expect(safeFailure(error)).toEqual({
        errorType: "MoneyForwardHttpError",
        failureCode: "provider_http_failed",
        httpStatus: 503,
      });
      expect(JSON.stringify(safeFailure(error))).not.toContain(PRIVATE);
    }
  });

  test("redirect limit failure omits response-controlled paths and cookie names", async () => {
    try {
      await collectMoneyForward({
        credential,
        fetcher: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: `https://id.moneyforward.com/${PRIVATE}`,
              "set-cookie": `${PRIVATE}=value; Secure; Path=/`,
            },
          }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(safeFailure(error)).toMatchObject({
        failureCode: "provider_protocol_failed",
        reasonCode: "redirect-limit",
      });
      expect(String(error)).not.toContain(PRIVATE);
    }
  });

  test("broken stage callback does not prevent provider requests", async () => {
    let calls = 0;
    await expect(
      collectMoneyForward({
        credential,
        onStage: () => {
          throw new Error("logger failed");
        },
        fetcher: async () => {
          calls++;
          return new Response(PRIVATE, { status: 503 });
        },
      }),
    ).rejects.toThrow("Money Forward");
    expect(calls).toBe(1);
  });

  test("configuration failure still records a failed shared terminal when logging fails", async () => {
    const data = new FakeR2Bucket();
    spyOn(console, "log").mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    spyOn(console, "error").mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    const response = await worker.fetch(trigger(), fixture(PRIVATE, data));
    expect(response.status).toBe(502);
    const result = (await response.json()) as { terminalKey: string; persistence: string };
    expect(result.persistence).toBe("persisted");
    const terminal = data.entries.get(result.terminalKey);
    expect(JSON.parse(new TextDecoder().decode(terminal!.bytes)).providerOutcome).toBe("failed");
    const contents = [...data.entries.values()]
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("\n");
    expect(contents).toContain("collector_failed");
    expect(contents).not.toContain(PRIVATE);
  });

  test("failed shared upload publishes no terminal and keeps diagnostics safe", async () => {
    const logs = captureLogs();
    const data = new FakeR2Bucket({
      beforePut: () => {
        throw new Error(PRIVATE);
      },
    });
    const response = await worker.fetch(trigger(), fixture(PRIVATE, data));
    expect(response.status).toBe(502);
    const result = (await response.json()) as { persistence: string };
    expect(result.persistence).toBe("incomplete");
    expect([...data.entries.keys()].some((key) => key.endsWith("/terminal.json"))).toBe(false);
    expect(logs.join()).not.toContain(PRIVATE);
  });
});

describe("diagnostics snapshot error properties once", () => {
  test("stateful allowed-first name, status and reason getters never leak later values", () => {
    let nameReads = 0;
    const generic = new Error(PRIVATE);
    Object.defineProperty(generic, "name", { get: () => (++nameReads === 1 ? "Error" : PRIVATE) });
    expect(safeFailure(generic)).toEqual({ errorType: "Error", failureCode: "operation_failed" });
    expect(nameReads).toBe(1);

    let statusReads = 0;
    let reasonReads = 0;
    const protocol = new MoneyForwardProtocolError("invalid-response", 503);
    Object.defineProperty(protocol, "status", { get: () => (++statusReads === 1 ? 503 : PRIVATE) });
    Object.defineProperty(protocol, "reasonCode", {
      get: () => (++reasonReads === 1 ? "invalid-response" : PRIVATE),
    });
    const detail = safeFailure(protocol);
    expect(detail).toEqual({
      errorType: "MoneyForwardProtocolError",
      failureCode: "provider_protocol_failed",
      httpStatus: 503,
      reasonCode: "invalid-response",
    });
    expect(statusReads).toBe(1);
    expect(reasonReads).toBe(1);
    expect(JSON.stringify(detail)).not.toContain(PRIVATE);
  });
});
