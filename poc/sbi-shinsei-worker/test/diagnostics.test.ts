import { describe, expect, test } from "bun:test";
import { BrowserCollectionError, browserDiagnostics, ContainerResponseError, failure, manifestFailure } from "../src/diagnostics";
import { collectSbiShinsei } from "../src/collector";

describe("safe SBI Shinsei diagnostics", () => {
  test("retains actual failed browser stage and authentication attempt from the handoff", async () => {
    let caught: unknown;
    try {
      await collectSbiShinsei({ credentialJson: JSON.stringify({ branchNumber: "012", accountNumber: "0345678", powerDirectPassword: "secret" }),
        collectHandoff: async () => JSON.stringify({ ok: false, stage: "security-connect-http-503", authenticationAttempted: true }) });
    } catch (error) { caught = error; }
    const result = failure("collect", caught);
    expect(result.diagnostics).toEqual({ stage: "security-connect-http-503", httpStatus: 503, authenticationAttempted: true });
    const stored = manifestFailure(result);
    expect(Object.keys(stored).sort()).toEqual(["errorType", "message", "operation"]);
    expect(stored.message).toContain("httpStatus=503");
  });

  test("rejects stage-like secrets, arbitrary error names, bodies, and forged status", () => {
    const secret = "password=synthetic-secret https://example.invalid/?token=secret";
    const error = new Error(secret, { cause: new Error(secret) });
    error.name = secret;
    Object.assign(error, { stage: "login-http-500", httpStatus: 500 });
    expect(failure("collect", error, "container-start")).toEqual({ operation: "collect", errorType: "Error", message: "collector_request_failed", diagnostics: { stage: "container-start" } });
    for (const stage of [secret, "secret-0123456789", "login-http-500-secret", "login-http-999", "toString", "container-secret"]) {
      const result = failure("collect", new BrowserCollectionError(stage, false));
      expect(result.diagnostics?.stage).toBe("unknown-browser-stage");
      expect(JSON.stringify(result)).not.toContain(stage);
    }
  });

  test("classifies known timeout, network and lifecycle stages, without inventing a status", () => {
    for (const stage of ["ui-login-response-timeout", "container-chrome-attach", "validate-token-network", "exchange-rate-http-503", "login-rejected"]) {
      expect(browserDiagnostics(stage).stage).toBe(stage);
    }
    expect(browserDiagnostics("login-http-0")).toEqual({ stage: "login-http-0" });
    expect(failure("collect", new ContainerResponseError(409), "container-request").diagnostics).toEqual({ stage: "container-request", httpStatus: 409 });
    expect(failure("collect", new ContainerResponseError(Infinity)).diagnostics?.httpStatus).toBeUndefined();
    expect(manifestFailure(failure("r2:normalized", new Error("secret"))).operation).toBe("r2:normalized");
  });
});
