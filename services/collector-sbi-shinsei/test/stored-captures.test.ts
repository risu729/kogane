// ADR 0029, amendment 2: a provider capture is stored as the provider wrote
// it, the account holder's name fields included. Synthetic data only: the
// names below are made-up placeholders, not anyone's name.
import { describe, expect, test } from "bun:test";
import { collectHybridLocalSbiShinsei } from "../src/local/collector";
import { parseCollectionResult } from "../src/local/windows-chrome-collector";
import type { JscProvider } from "../src/types";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;

const PLACEHOLDER_NAMES = {
  customerName: "PLACEHOLDER HOLDER",
  customerNameKanji: "見本　名前",
  customerNameKana: "ミホン　ナマエ",
} as const;

const CAPTURES = [
  ["topBalances", "top-accounts-balance-and-activity"],
  ["balanceSummary", "balance-summary-and-stage"],
  ["exchangeRate", "exchange-rate"],
  ["yenDeposit", "yen-deposit-account"],
] as const;

type Fixtures = Record<string, Record<string, unknown>>;

async function fixtures(): Promise<Fixtures> {
  const loaded = (await Bun.file(fixturePath).json()) as Fixtures;
  const response = loaded.balanceSummary!.responseParam as Record<string, Record<string, unknown>>;
  Object.assign(response.summary!.responseParam as object, PLACEHOLDER_NAMES);
  return loaded;
}

describe("provider captures are stored as the provider wrote them", () => {
  test("the Chrome handoff keeps every capture byte for byte, names included", async () => {
    const loaded = await fixtures();
    // Indented text with an escaped name: proves the provider's own bytes are
    // kept, not re-serialized or rewritten.
    const raw = Object.fromEntries(
      CAPTURES.map(([key]) => [key, JSON.stringify(loaded[key], null, 3)]),
    );
    raw.balanceSummary = raw.balanceSummary!.replace(
      `"customerName": "${PLACEHOLDER_NAMES.customerName}"`,
      '"customerName": "PLACEHOLDER \\"QUOTED\\" \\u0048OLDER"',
    );
    expect(raw.balanceSummary).toContain("\\u0048OLDER");
    const result = parseCollectionResult(
      JSON.stringify({ ok: true, responses: raw }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.failures).toEqual([]);
    expect(result.artifacts.map((artifact) => artifact.dataset)).toEqual([
      ...CAPTURES.map(([, dataset]) => dataset),
      "normalized",
    ]);
    for (const [key, dataset] of CAPTURES) {
      const artifact = result.artifacts.find((entry) => entry.dataset === dataset)!;
      expect(artifact.body).toBe(raw[key]!);
      expect(Object.keys(artifact)).not.toContain("redactedFieldCount");
    }
    const summary = String(
      result.artifacts.find((entry) => entry.dataset === "balance-summary-and-stage")!.body,
    );
    expect(summary).toContain(PLACEHOLDER_NAMES.customerNameKanji);
    expect(summary).toContain(PLACEHOLDER_NAMES.customerNameKana);
    expect(summary).not.toContain("[redacted:name]");
  });

  test("the local diagnostic collector keeps every capture byte for byte, names included", async () => {
    const loaded = await fixtures();
    const byPath: Record<string, unknown> = {
      "/SFC/app/IFCM_CommonAdapter/securityConnect": loaded.securityConnect,
      "/SFC/app/IFCM_CommonAdapter/validateToken": loaded.validateToken,
      "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity": loaded.topBalances,
      "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage": loaded.balanceSummary,
      "/SFC/app/IFCM_CommonAdapter/getExchangeRate": loaded.exchangeRate,
      "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount": loaded.yenDeposit,
    };
    const sent = new Map<string, string>();
    const provider: JscProvider = {
      name: "synthetic",
      acquire: async () => ({
        sourceOrigin: "https://bk.web.sbishinseibank.co.jp",
        userAgent: "Synthetic Chrome User Agent for unit testing only",
        jsc: `synthetic-${"j".repeat(80)}`,
      }),
    };
    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/login_auth_request_url")) {
        return new Response(
          JSON.stringify({ responseJSON: { authStatus: "success", token: "synthetic-initial" } }),
          {
            headers: {
              authorization: "synthetic-authorization",
              "content-type": "application/octet-stream",
            },
          },
        );
      }
      const body = byPath[url.pathname];
      if (body === undefined) throw new Error(`unexpected path ${url.pathname}`);
      const text = JSON.stringify(body, null, 2);
      sent.set(url.pathname, text);
      return new Response(text, { headers: { "content-type": "application/json" } });
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
    const summary = result.artifacts.find(
      (artifact) => artifact.dataset === "balance-summary-and-stage",
    )!;
    expect(summary.body).toBe(sent.get("/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage")!);
    for (const name of Object.values(PLACEHOLDER_NAMES)) expect(summary.body).toContain(name);
    expect(result.artifacts.find((artifact) => artifact.dataset === "exchange-rate")!.body).toBe(
      sent.get("/SFC/app/IFCM_CommonAdapter/getExchangeRate")!,
    );
    for (const artifact of result.artifacts) {
      expect(Object.keys(artifact)).not.toContain("redactedFieldCount");
    }
  });
});
