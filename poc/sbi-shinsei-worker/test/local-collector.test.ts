import { describe, expect, test } from "bun:test";
import { collectHybridLocalSbiShinsei } from "../src/local/collector";
import type { JscProvider } from "../src/types";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;

describe("SBI Shinsei local collector", () => {
  test("uses the captured sequence once and emits raw plus normalized artifacts", async () => {
    const fixtures = await Bun.file(fixturePath).json() as Record<string, unknown>;
    const calls: Array<{ path: string; authorization: string | null; csrf: string | null }> = [];
    const provider: JscProvider = {
      name: "synthetic",
      acquire: async () => ({
        sourceOrigin: "https://bk.web.sbishinseibank.co.jp",
        userAgent: "Synthetic Chrome User Agent for unit testing only",
        jsc: `synthetic-${"j".repeat(80)}`,
      }),
    };
    const mockFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        authorization: headers.get("authorization"),
        csrf: headers.get("x-csrf-token"),
      });
      if (url.pathname.endsWith("/login_auth_request_url")) {
        return jsonResponse({
          responseJSON: { authStatus: "success", token: "synthetic-initial" },
        }, {
          authorization: "synthetic-authorization",
          "content-type": "application/octet-stream",
        });
      }
      const fixture = fixtureForPath(url.pathname, fixtures);
      return jsonResponse(fixture, { "content-type": "application/json" });
    };

    const result = await collectHybridLocalSbiShinsei({
      credentialJson: JSON.stringify({
        branchNumber: "012",
        accountNumber: "0345678",
        powerDirectPassword: "synthetic-password",
      }),
      jscProvider: provider,
      fetch: mockFetch as typeof fetch,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(calls.map((call) => call.path)).toEqual([
      "/SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url",
      "/SFC/app/IFCM_CommonAdapter/securityConnect",
      "/SFC/app/IFCM_CommonAdapter/validateToken",
      "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity",
      "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage",
      "/SFC/app/IFCM_CommonAdapter/getExchangeRate",
      "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount",
    ]);
    expect(calls[1]?.csrf).toBe("synthetic-initial");
    expect(calls[2]?.csrf).toBe("synthetic-initial");
    expect(calls[3]?.csrf).toBe("synthetic-next-csrf-token");
    expect(calls.slice(1).every(
      (call) => call.authorization === "synthetic-authorization",
    )).toBeTrue();
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual([
      "raw-top-accounts-balance-and-activity.json",
      "raw-balance-summary-and-stage.json",
      "raw-exchange-rate.json",
      "raw-yen-deposit-account.json",
      "normalized.json",
    ]);
    expect(result.normalized.schemaVersion).toBe("sbi-shinsei-v1");
    expect(result.normalized.balances).toHaveLength(2);
    expect(result.normalized.balances[1]?.product).toBe("hyper-yokin");
    expect(result.normalized.transactions).toHaveLength(1);
  });
});

function jsonResponse(
  value: unknown,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), { status: 200, headers });
}

function fixtureForPath(
  path: string,
  fixtures: Record<string, unknown>,
): unknown {
  const mapping: Record<string, string> = {
    "/SFC/app/IFCM_CommonAdapter/securityConnect": "securityConnect",
    "/SFC/app/IFCM_CommonAdapter/validateToken": "validateToken",
    "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity": "topBalances",
    "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage": "balanceSummary",
    "/SFC/app/IFCM_CommonAdapter/getExchangeRate": "exchangeRate",
    "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount": "yenDeposit",
  };
  const key = mapping[path];
  if (!key || fixtures[key] === undefined) throw new Error("Unexpected path");
  return fixtures[key];
}
