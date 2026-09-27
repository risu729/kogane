// ADR 0029, amendment 2026-09-27: person names are removed from a provider
// response before it is stored. Synthetic data only: the names below are
// made-up placeholders, not anyone's name.
import { describe, expect, test } from "bun:test";
import { collectHybridLocalSbiShinsei } from "../src/local/collector";
import { parseCollectionResult } from "../src/local/windows-chrome-collector";
import {
  NAME_REDACTION_MARKER,
  PERSON_NAME_FIELDS,
  redactPersonNames,
} from "../src/name-redaction";
import { validateKnownResponse } from "../src/response-schemas";
import type { JscProvider, ResponseSchemaId } from "../src/types";

const fixturePath = `${import.meta.dir}/fixtures/core-responses.json`;
const schemaSource = `${import.meta.dir}/../src/response-schemas.ts`;

const PLACEHOLDER_NAMES = {
  customerName: "PLACEHOLDER HOLDER",
  customerNameKanji: "見本　名前",
  customerNameKana: "ミホン　ナマエ",
} as const;

type Fixtures = Record<string, Record<string, unknown>>;

async function fixtures(): Promise<Fixtures> {
  const loaded = (await Bun.file(fixturePath).json()) as Fixtures;
  withPlaceholderNames(loaded.balanceSummary!);
  return loaded;
}

function summaryOf(balanceSummary: Record<string, unknown>): Record<string, unknown> {
  const response = balanceSummary.responseParam as Record<string, Record<string, unknown>>;
  return response.summary!.responseParam as Record<string, unknown>;
}

function withPlaceholderNames(balanceSummary: Record<string, unknown>): void {
  Object.assign(summaryOf(balanceSummary), PLACEHOLDER_NAMES);
}

function expectNoPlaceholderName(text: string): void {
  for (const name of Object.values(PLACEHOLDER_NAMES)) expect(text).not.toContain(name);
}

describe("person names are replaced before a response is stored", () => {
  test("the balance summary's three name fields become the marker; nothing else changes", async () => {
    const loaded = await fixtures();
    const raw = JSON.stringify(loaded.balanceSummary);
    const parsed = validateKnownResponse("sbi-shinsei-balance-summary-v1", JSON.parse(raw));
    const result = redactPersonNames("sbi-shinsei-balance-summary-v1", raw, parsed);

    expect(result.redactedFieldCount).toBe(3);
    expectNoPlaceholderName(result.body);
    const stored = JSON.parse(result.body) as Record<string, unknown>;
    // The stored shape is one the schema accepts: the marker is a scalar.
    expect(() => validateKnownResponse("sbi-shinsei-balance-summary-v1", stored)).not.toThrow();
    const summary = summaryOf(stored);
    expect(summary.customerName).toBe(NAME_REDACTION_MARKER);
    expect(summary.customerNameKanji).toBe(NAME_REDACTION_MARKER);
    expect(summary.customerNameKana).toBe(NAME_REDACTION_MARKER);
    // Every other value, including the branch name (not a person), is kept.
    const expected = JSON.parse(raw) as Record<string, unknown>;
    Object.assign(summaryOf(expected), {
      customerName: NAME_REDACTION_MARKER,
      customerNameKanji: NAME_REDACTION_MARKER,
      customerNameKana: NAME_REDACTION_MARKER,
    });
    expect(stored).toEqual(expected);
    // The in-memory object the caller validated is not mutated.
    expect(summaryOf(parsed).customerName).toBe(PLACEHOLDER_NAMES.customerName);
  });

  test("absent, null and empty name fields are not counted and keep the provider bytes", async () => {
    const loaded = await fixtures();
    const summary = summaryOf(loaded.balanceSummary!);
    delete summary.customerName;
    summary.customerNameKanji = null;
    summary.customerNameKana = "";
    const raw = JSON.stringify(loaded.balanceSummary);
    const parsed = validateKnownResponse("sbi-shinsei-balance-summary-v1", JSON.parse(raw));
    expect(redactPersonNames("sbi-shinsei-balance-summary-v1", raw, parsed)).toEqual({
      body: raw,
      redactedFieldCount: 0,
    });
  });

  test("only the three values change: numbers, spacing and escapes keep the provider's text", async () => {
    const loaded = await fixtures();
    const summary = summaryOf(loaded.balanceSummary!);
    summary.customerName = 'PLACEHOLDER "QUOTED" \\ HOLDER';
    // Indented, with placeholders for number texts JSON.stringify would rewrite.
    const raw = JSON.stringify(loaded.balanceSummary, null, 2)
      .replace('"savingsBalance": "300000"', '"savingsBalance": 1.50')
      .replace('"odLimit": "0"', '"odLimit": 1e3')
      .replace('"totalCredit": "300000"', '"totalCredit": 12345678901234567890');
    const parsed = validateKnownResponse("sbi-shinsei-balance-summary-v1", JSON.parse(raw));
    const result = redactPersonNames("sbi-shinsei-balance-summary-v1", raw, parsed);
    expect(result.redactedFieldCount).toBe(3);
    // The stored text is the input with exactly the three values replaced.
    let expected = raw;
    for (const [field, value] of [
      ["customerName", summary.customerName],
      ["customerNameKanji", PLACEHOLDER_NAMES.customerNameKanji],
      ["customerNameKana", PLACEHOLDER_NAMES.customerNameKana],
    ] as const) {
      const before = `"${field}": ${JSON.stringify(value)}`;
      expect(expected).toContain(before);
      expected = expected.replace(before, `"${field}": "${NAME_REDACTION_MARKER}"`);
    }
    expect(result.body).toBe(expected);
    expect(result.body).toContain('"savingsBalance": 1.50');
    expect(result.body).toContain('"odLimit": 1e3');
    expect(result.body).toContain('"totalCredit": 12345678901234567890');
    expectNoPlaceholderName(result.body);
  });

  test("a name key elsewhere or a name that is not a string is refused, not altered", async () => {
    const loaded = await fixtures();
    // The same key in an open request echo would also be rewritten by a text
    // match: the result no longer equals the expected object, so it is refused.
    const echoed = structuredClone(loaded.balanceSummary!) as {
      responseParam: Record<string, { requestParam: Record<string, unknown> }>;
    };
    echoed.responseParam.branchFetch!.requestParam.customerName = "PLACEHOLDER ECHO";
    const notString = structuredClone(loaded.balanceSummary!);
    summaryOf(notString).customerName = 12345;
    for (const value of [echoed, notString]) {
      const raw = JSON.stringify(value);
      const parsed = validateKnownResponse("sbi-shinsei-balance-summary-v1", JSON.parse(raw));
      expect(() => redactPersonNames("sbi-shinsei-balance-summary-v1", raw, parsed)).toThrow(
        "name redaction did not match the response",
      );
    }
  });

  test("a response whose schema names no person is stored byte for byte", async () => {
    const loaded = await fixtures();
    const cases = [
      ["topBalances", "sbi-shinsei-top-balances-v1"],
      ["exchangeRate", "sbi-shinsei-exchange-rate-v1"],
      ["yenDeposit", "sbi-shinsei-yen-deposit-account-v1"],
    ] as const;
    for (const [key, schema] of cases) {
      // Indented text: proves the provider's own bytes are kept, not re-serialized.
      const raw = JSON.stringify(loaded[key], null, 3);
      const parsed = validateKnownResponse(schema, JSON.parse(raw));
      expect(redactPersonNames(schema, raw, parsed)).toEqual({ body: raw, redactedFieldCount: 0 });
    }
  });

  test("every Name field a response schema admits is either redacted or not a person", async () => {
    // A new name-like field in a schema must be classified here before it can
    // be stored: the response objects are exact, so the provider cannot add
    // one unseen. (`requestParam` echoes are open objects and are not covered;
    // ADR 0029's amendment lists that as a limit.) Case-insensitive, so a
    // `name`, `holderName` or `NAME` key is caught as well as `customerName`.
    const source = await Bun.file(schemaSource).text();
    const named = new Set(
      [...source.matchAll(/"([A-Za-z_]*name[A-Za-z_]*)"/giu)].map((m) => m[1]!),
    );
    const redacted = new Set(
      Object.values(PERSON_NAME_FIELDS).flatMap((targets) =>
        (targets ?? []).flatMap((target) => [...target.fields]),
      ),
    );
    const notPersons = new Set(["branchName", "productName"]);
    expect([...named].sort()).toEqual([...new Set([...redacted, ...notPersons])].sort());
    expect(Object.keys(PERSON_NAME_FIELDS)).toEqual([
      "sbi-shinsei-balance-summary-v1",
    ] satisfies ResponseSchemaId[]);
  });
});

describe("the collectors write only redacted captures", () => {
  test("the Chrome handoff's balance summary carries the marker and its count", async () => {
    const loaded = await fixtures();
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(loaded.topBalances),
          balanceSummary: JSON.stringify(loaded.balanceSummary),
          exchangeRate: JSON.stringify(loaded.exchangeRate),
          yenDeposit: JSON.stringify(loaded.yenDeposit),
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.failures).toEqual([]);
    expect(
      result.artifacts.map((artifact) => [artifact.dataset, artifact.redactedFieldCount]),
    ).toEqual([
      ["top-accounts-balance-and-activity", 0],
      ["balance-summary-and-stage", 3],
      ["exchange-rate", 0],
      ["yen-deposit-account", 0],
      ["normalized", undefined],
    ]);
    const summary = result.artifacts.find(
      (artifact) => artifact.dataset === "balance-summary-and-stage",
    )!;
    expect(summary.body).toContain(NAME_REDACTION_MARKER);
    for (const artifact of result.artifacts) expectNoPlaceholderName(String(artifact.body));
  });

  test("a balance summary the redaction cannot match is a closed failure, not a stored capture", async () => {
    const loaded = await fixtures();
    summaryOf(loaded.balanceSummary!).customerName = 12345;
    const result = parseCollectionResult(
      JSON.stringify({
        ok: true,
        responses: {
          topBalances: JSON.stringify(loaded.topBalances),
          balanceSummary: JSON.stringify(loaded.balanceSummary),
          exchangeRate: JSON.stringify(loaded.exchangeRate),
          yenDeposit: JSON.stringify(loaded.yenDeposit),
        },
      }),
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(result.failures).toEqual([
      {
        operation: "read:balance-summary-and-stage",
        errorType: "ResponseSchemaError",
        message: "provider_response_invalid",
      },
    ]);
    expect(result.artifacts.map((artifact) => artifact.dataset)).not.toContain(
      "balance-summary-and-stage",
    );
    for (const artifact of result.artifacts) expectNoPlaceholderName(String(artifact.body));
  });

  test("the local diagnostic collector redacts the same field set", async () => {
    const loaded = await fixtures();
    const byPath: Record<string, unknown> = {
      "/SFC/app/IFCM_CommonAdapter/securityConnect": loaded.securityConnect,
      "/SFC/app/IFCM_CommonAdapter/validateToken": loaded.validateToken,
      "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity": loaded.topBalances,
      "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage": loaded.balanceSummary,
      "/SFC/app/IFCM_CommonAdapter/getExchangeRate": loaded.exchangeRate,
      "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount": loaded.yenDeposit,
    };
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
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
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
    expect(
      result.artifacts.map((artifact) => [artifact.dataset, artifact.redactedFieldCount]),
    ).toEqual([
      ["top-accounts-balance-and-activity", 0],
      ["balance-summary-and-stage", 3],
      ["exchange-rate", 0],
      ["yen-deposit-account", 0],
      ["normalized", undefined],
    ]);
    for (const artifact of result.artifacts) expectNoPlaceholderName(String(artifact.body));
  });
});
