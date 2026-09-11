import { describe, expect, test } from "bun:test";
import {
  atStage,
  failure,
  manifestFailure,
  SonyBankError,
  SonyBankStageError,
} from "../src/diagnostics";
import { collectSonyBank } from "../src/sony-bank";

describe("safe Sony diagnostics", () => {
  test("retains the CSV event, currency and 500, but no provider code text", () => {
    const result = failure("collect", new SonyBankError("EABA0600S1fE12:JPY", 500, 1));
    expect(result.diagnostics).toEqual({
      stage: "history-csv",
      reason: "http_error",
      providerOperation: "EABA0600S1fE12",
      currency: "JPY",
      httpStatus: 500,
      providerErrorCount: 1,
    });
    const stored = manifestFailure(result);
    expect(Object.keys(stored).sort()).toEqual(["errorType", "message", "operation"]);
    expect(stored.message).toContain("httpStatus=500");
    expect(stored.message.length).toBeLessThanOrEqual(300);
  });

  test("drops arbitrary names, messages, causes and forged diagnostic fields", () => {
    const secret = "password=synthetic-secret https://example.invalid/?token=secret";
    const error = new Error(secret, { cause: new Error(secret) });
    error.name = secret;
    Object.assign(error, { httpStatus: 500, providerOperation: secret });
    const result = failure("collect", error);
    expect(result.errorType).toBe("Error");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    const forged = new SonyBankError(secret, Infinity, 9999, secret);
    expect(failure("collect", forged).diagnostics).toEqual({
      stage: "collect",
      reason: "unexpected_error",
      providerErrorCount: 100,
    });
    expect(failure("collect", new SonyBankStageError(secret)).diagnostics?.stage).toBe("collect");
  });

  test("network errors preserve the actual login step without echoing fetch errors", async () => {
    let caught: unknown;
    try {
      await collectSonyBank({
        credential: { branchNum: "001", accountNum: "1234567", loginPwd: "secret" },
        from: "2026-09-01",
        to: "2026-09-05",
        fetcher: async () => {
          throw new Error("Bearer synthetic-secret");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(failure("collect", caught).diagnostics).toEqual({
      stage: "login-page",
      reason: "network_error",
      providerOperation: "login-page",
    });
    expect(JSON.stringify(failure("collect", caught))).not.toContain("synthetic-secret");
  });

  test("a real CSV response failure passes through the full collection pipeline", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await collectSonyBank({
        credential: { branchNum: "001", accountNum: "1234567", loginPwd: "secret" },
        from: "2026-09-01",
        to: "2026-09-05",
        fetcher: async (input) => {
          calls++;
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/input/"))
            return new Response("", { headers: { "set-cookie": "FSID=secret" } });
          if (path.endsWith("revision.json")) return new Response("1");
          if (path.endsWith("csrf-token/get"))
            return Response.json({}, { headers: { "bff-csrf": "secret" } });
          if (path.endsWith("to-customers/login")) return Response.json({ accountInfo: [{}] });
          if (path.endsWith("gross-balance/acq")) return Response.json({});
          if (path.endsWith("ordinary-deposit-transaction-histories"))
            return Response.json({ transactionHistInfo: [{}], countCnt: 1 });
          if (path.endsWith("csv/load"))
            return Response.json(
              { errors: [{ code: "Bearer synthetic-secret" }] },
              { status: 500 },
            );
          throw new Error("unexpected request");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(9);
    const result = failure("collect", caught);
    expect(result.diagnostics?.httpStatus).toBe(500);
    expect(result.diagnostics?.stage).toBe("history-csv");
    expect(result.diagnostics?.providerErrorCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  test("unknown exceptions retain only the assigned stage and R2 operations survive", async () => {
    try {
      await atStage("wallet", async () => {
        throw new Error("Bearer synthetic-secret");
      });
    } catch (error) {
      expect(failure("collect", error).diagnostics?.stage).toBe("wallet");
    }
    expect(manifestFailure(failure("r2:yen-history-csv", new Error("secret"))).operation).toBe(
      "r2:yen-history-csv",
    );
  });
});
