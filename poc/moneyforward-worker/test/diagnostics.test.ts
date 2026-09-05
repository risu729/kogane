import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logFailure, MoneyForwardHttpError, MoneyForwardProtocolError, safeFailure } from "../src/diagnostics";
import { collectMoneyForward } from "../src/moneyforward";
import worker from "../src/worker";
import type { MoneyForwardCredential } from "../src/types";

afterEach(() => mock.restore());
const PRIVATE = "private-body-token-cookie-email-account-id";
const credential: MoneyForwardCredential = {
  rpId: "id.moneyforward.com", origin: "https://id.moneyforward.com",
  credentialId: "00112233-4455-6677-8899-aabbccddeeff", keyValue: "test-only", counter: 0,
};
function captureLogs() {
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
  spyOn(console, "error").mockImplementation((line) => { lines.push(String(line)); });
  return lines;
}
function trigger() {
  return new Request("https://collector.test/trigger", {
    method: "POST", headers: { authorization: "Bearer test-admin" },
  }) as Parameters<typeof worker.fetch>[0];
}
function fixture(secret: string, put: (key: string, body: string) => Promise<void>) {
  return Object.assign({} as Env, { ADMIN_TRIGGER_TOKEN: "test-admin", MONEYFORWARD_CREDENTIAL_JSON: secret,
    COLLECTOR_SCHEMA_VERSION: "test", SNAPSHOTS: { put } });
}

describe("Money Forward safe stage diagnostics", () => {
  test("unknown or hostile errors cannot disclose data or break diagnostics", () => {
    const error = Object.assign(new Error(PRIVATE), { name: PRIVATE, status: 503 });
    expect(safeFailure(error)).toEqual({ errorType: "UnknownError", failureCode: "operation_failed" });
    const hostile = new MoneyForwardHttpError(503);
    Object.defineProperty(hostile, "status", { get() { throw new Error(PRIVATE); } });
    expect(safeFailure(hostile)).toEqual({ errorType: "UnknownError", failureCode: "operation_failed" });
    spyOn(console, "error").mockImplementation(() => { throw new Error(PRIVATE); });
    expect(logFailure("test-run", "passkey-options", error).errorType).toBe("UnknownError");
  });

  test("passkey options HTTP failure preserves stage and status but never body or token", async () => {
    const stages: string[] = [];
    try {
      await collectMoneyForward({ credential, onStage: (stage) => { stages.push(stage); },
        fetcher: async (input) => String(input).endsWith("/sign_in")
          ? new Response(`<meta name="csrf-token" content="${PRIVATE}">`)
          : new Response(PRIVATE, { status: 503 }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(stages).toEqual(["login-entry", "passkey-options"]);
      expect(safeFailure(error)).toEqual({ errorType: "MoneyForwardHttpError", failureCode: "provider_http_failed", httpStatus: 503 });
      expect(JSON.stringify(safeFailure(error))).not.toContain(PRIVATE);
    }
  });

  test("redirect limit failure omits response-controlled paths and cookie names", async () => {
    try {
      await collectMoneyForward({ credential, fetcher: async () => new Response(null, {
        status: 302, headers: { location: `https://id.moneyforward.com/${PRIVATE}`, "set-cookie": `${PRIVATE}=value; Secure; Path=/` },
      }) });
      throw new Error("expected failure");
    } catch (error) {
      expect(safeFailure(error)).toMatchObject({ failureCode: "provider_protocol_failed", reasonCode: "redirect-limit" });
      expect(String(error)).not.toContain(PRIVATE);
    }
  });

  test("broken stage callback does not prevent provider requests", async () => {
    let calls = 0;
    await expect(collectMoneyForward({ credential, onStage: () => { throw new Error("logger failed"); },
      fetcher: async () => { calls++; return new Response(PRIVATE, { status: 503 }); },
    })).rejects.toThrow("Money Forward");
    expect(calls).toBe(1);
  });

  test("configuration failure remains failed even when logging fails", async () => {
    let manifest = "";
    spyOn(console, "log").mockImplementation(() => { throw new Error(PRIVATE); });
    spyOn(console, "error").mockImplementation(() => { throw new Error(PRIVATE); });
    const response = await worker.fetch(trigger(), fixture(PRIVATE, async (_key, body) => { manifest = body; }));
    expect(response.status).toBe(502);
    expect(JSON.parse(manifest).failures[0]).toMatchObject({ stage: "credential-load", failureCode: "credential_configuration_required" });
    expect(manifest).not.toContain(PRIVATE);
  });

  test("partial artifact storage preserves outcome with correlated safe failure record", async () => {
    const logs = captureLogs();
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const keyValue = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64url");
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/sign_in") return new Response(`<meta name="csrf-token" content="${PRIVATE}">`);
      if (url.pathname === "/webauthn/assertion/options") return Response.json({ challenge: "dGVzdA", rpId: "id.moneyforward.com" });
      if (url.pathname === "/webauthn/assertion") return Response.json({ redirectPath: "/me" });
      if (url.pathname === "/me") return new Response("signed-in");
      if (url.pathname === "/accounts") return new Response('<a href="/accounts/show/test-account">account</a>');
      if (url.pathname === "/accounts/show/test-account") return new Response(`<meta name="csrf-token" content="${PRIVATE}"><input name="account[id_hash]" value="${PRIVATE}"><input name="service[id]" value="1">`);
      return new Response(PRIVATE);
    }, { preconnect: globalThis.fetch.preconnect }));
    let manifest = "";
    const env = fixture(JSON.stringify({ ...credential, keyValue }), async (key, body) => {
      if (key.endsWith("/accounts.html")) throw new Error(PRIVATE);
      if (key.endsWith("/manifest.json")) manifest = body;
    });
    const response = await worker.fetch(trigger(), env);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(manifest);
    expect(parsed.status).toBe("partial");
    expect(parsed.monthlyFragmentCount).toBe(12);
    expect(parsed.failures[0]).toMatchObject({ stage: "artifact-store", failureCode: "operation_failed" });
    const failures = logs.map((line) => JSON.parse(line)).filter((line) => line.event === "collector-stage-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].runId).toBe(parsed.runId);
    expect(logs.join()).not.toContain(PRIVATE);
    expect(logs.join()).not.toContain(keyValue);
    expect(manifest).not.toContain(PRIVATE);
  });

  test("manifest storage failure logs correlation without persisting a manifest", async () => {
    const logs = captureLogs();
    await expect(worker.fetch(trigger(), fixture(PRIVATE, async () => { throw new Error(PRIVATE); })))
      .rejects.toThrow("manifest storage failed");
    const failures = logs.map((line) => JSON.parse(line)).filter((line) => line.event === "collector-stage-failed");
    expect(failures.map((item) => item.stage)).toEqual(["credential-load", "manifest-store"]);
    expect(failures[0].runId).toBe(failures[1].runId);
    expect(logs.join()).not.toContain(PRIVATE);
  });
});


describe("diagnostics snapshot error properties once", () => {
  test("stateful allowed-first name, status and reason getters never leak later values", () => {
    let nameReads = 0;
    const generic = new Error(PRIVATE);
    Object.defineProperty(generic, "name", { get: () => ++nameReads === 1 ? "Error" : PRIVATE });
    expect(safeFailure(generic)).toEqual({ errorType: "Error", failureCode: "operation_failed" });
    expect(nameReads).toBe(1);

    let statusReads = 0;
    let reasonReads = 0;
    const protocol = new MoneyForwardProtocolError("invalid-response", 503);
    Object.defineProperty(protocol, "status", { get: () => ++statusReads === 1 ? 503 : PRIVATE });
    Object.defineProperty(protocol, "reasonCode", { get: () => ++reasonReads === 1 ? "invalid-response" : PRIVATE });
    const detail = safeFailure(protocol);
    expect(detail).toEqual({ errorType: "MoneyForwardProtocolError", failureCode: "provider_protocol_failed", httpStatus: 503, reasonCode: "invalid-response" });
    expect(statusReads).toBe(1);
    expect(reasonReads).toBe(1);
    expect(JSON.stringify(detail)).not.toContain(PRIVATE);
  });
});
