import { describe, expect, test } from "bun:test";
import { BrowserCollectionError, browserDiagnostics, ContainerResponseError, containerLifecycleDetails, containerResponseReason, containerStopDetails, failure, manifestFailure } from "../src/diagnostics";
import { collectSbiShinsei } from "../src/collector";

describe("safe SBI Shinsei diagnostics", () => {
  test("classifies only bounded SDK HTTP500 envelopes and keeps provider text private", async () => {
    for (const [body, reason] of [
      ["Container suddenly disconnected, try again", "transport-disconnected"],
      ["Failed to start container: secret provider error", "startup-failed"],
      ["Error proxying request to container: secret provider error", "proxy-failed"],
      ["secret Container suddenly disconnected, try again", "unclassified-response"],
      ["Container suddenly disconnected, try again secret", "unclassified-response"],
      ["unknown secret provider body", "unclassified-response"],
      ["Failed to start container: " + "x".repeat(2048), "unclassified-response"],
    ]) {
      expect(await containerResponseReason(new Response(body, { status: 500 }))).toBe(reason!);
    }
    const untouched = new Response("secret success payload");
    expect(await containerResponseReason(untouched)).toBe("unclassified-response");
    expect(await untouched.text()).toBe("secret success payload");
    const locked = new Response("secret", { status: 500 });
    locked.body!.getReader();
    expect(await containerResponseReason(locked)).toBe("unclassified-response");
    let canceled = false;
    const never = new Response(new ReadableStream({ cancel() { canceled = true; throw new Error("secret"); } }), { status: 500 });
    expect(await containerResponseReason(never, 5)).toBe("unclassified-response");
    expect(canceled).toBe(true);
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret")); } }), { status: 500 });
    expect(await containerResponseReason(broken)).toBe("unclassified-response");
    expect(failure("collect", new ContainerResponseError(500, "secret"), "container-request").diagnostics?.responseReason).toBeUndefined();
  });
  test("container lifecycle keeps only exact known reasons and bounded exit codes", () => {
    expect(containerLifecycleDetails(new Error("container exited with unexpected exit code: 1"))).toEqual({ errorType: "Error", reason: "process-exit", exitCode: 1 });
    expect(containerLifecycleDetails(new Error("runtime signalled the container to exit: 137"))).toEqual({ errorType: "Error", reason: "runtime-signal", exitCode: 137 });
    expect(containerLifecycleDetails(new Error("Network connection lost."))).toEqual({ errorType: "Error", reason: "transport-disconnected" });
    expect(containerStopDetails({ exitCode: 137, reason: "runtime_signal" })).toEqual({ exitCode: 137, reason: "runtime_signal" });
    for (const message of ["container exited with unexpected exit code: 999", "secret container exited with unexpected exit code: 1", "container exited with unexpected exit code: 1 token=secret", "constructor", "token=secret"]) {
      expect(containerLifecycleDetails(new Error(message))).toEqual({ errorType: "Error", reason: "unknown-lifecycle-error" });
    }
    expect(containerStopDetails({ exitCode: "137", reason: "token=secret" })).toEqual({ reason: "unknown-stop" });
    expect(containerStopDetails({ exitCode: 256, reason: "exit" })).toEqual({ reason: "exit" });
    const hostile = new Error();
    Object.defineProperty(hostile, "message", { get() { throw new Error("secret"); } });
    expect(containerLifecycleDetails(hostile)).toEqual({ errorType: "Error", reason: "unknown-lifecycle-error" });
    expect(containerStopDetails(new Proxy({}, { get() { throw new Error("secret"); } }))).toEqual({ reason: "unknown-stop" });
  });
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
