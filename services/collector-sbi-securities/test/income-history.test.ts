import { expect, test } from "bun:test";
import { incomeBundle } from "../../../packages/parsers/test/fixtures/sbi-income.ts";
import {
  collectIncomeHistory,
  incomeHistoryInventoryComplete,
  incomeSourceKey,
  incomeHistoryUrl,
} from "../src/income-history";
import { sbiRunPlan, safeFailureCode } from "../src/shared-run";
import type { Artifact } from "../src/types";

const encode = (text: string) => new TextEncoder().encode(text);
test("requests use the observed full-retention filters and first-page values only", () => {
  const range = { from: "2021-08-01", to: "2099-12-31" };
  const income = incomeHistoryUrl("https://site.invalid/account/assets", "income", "rows", range);
  expect(income.pathname).toBe("/account/api/assets/dividends");
  expect(Object.fromEntries(income.searchParams)).toEqual({
    category: "",
    accountType: "",
    dispositionDateFrom: "2021/08/01",
    dispositionDateTo: "2099/12/31",
    offset: "1",
    limit: "30",
  });
  expect(
    incomeHistoryUrl(income.origin, "income", "summary", range).searchParams.has("offset"),
  ).toBe(false);
  const gains = incomeHistoryUrl(income.origin, "gains", "rows", range);
  expect(gains.pathname).toBe("/account/api/assets/profit-loss");
  expect(Object.fromEntries(gains.searchParams)).toEqual({
    baseDateFrom: "2021/08/01",
    baseDateTo: "2099/12/31",
    baseDateType: "CONTRACT",
    accountType: "",
    product: "DOMESTIC_STOCK",
    domesticCategory: "SPOT",
    countryCode: "",
    bondCategory: "",
    fundCategory: "",
    offset: "1",
    limit: "30",
  });
  const all = incomeHistoryUrl(income.origin, "gains", "all-summary", range);
  expect(all.searchParams.get("product")).toBe("ALL");
  expect(all.searchParams.get("domesticCategory")).toBe("");
  expect(all.searchParams.has("offset")).toBe(false);
});
async function capture(rowsText = incomeBundle("income").rowsText) {
  const bundle = incomeBundle("income");
  const artifacts: Artifact[] = [];
  let failure: unknown;
  try {
    await collectIncomeHistory({
      kind: "income",
      today: "2099-12-31",
      retain: (a) => artifacts.push(a),
      fetch: async (role, range) => {
        expect(range).toEqual({ from: "2021-08-01", to: "2099-12-31" });
        return encode(role === "summary" ? bundle.summaryText : rowsText);
      },
    });
  } catch (error) {
    failure = error;
  }
  return { artifacts, failure };
}

test("all-retention collection preserves exact source bytes, ordered lineage and recomputable inventory", async () => {
  const { artifacts, failure } = await capture();
  expect(failure).toBeUndefined();
  expect(artifacts.map((a) => a.artifactKey ?? `${a.dataset}.json`)).toEqual([
    "income-payments-summary-source.json",
    "income-payments-rows-source.json",
    "income-payments.json",
  ]);
  expect(artifacts[1]!.bytes).toEqual(encode(incomeBundle("income").rowsText));
  expect(artifacts[2]!.inputArtifactKeys).toEqual([
    incomeSourceKey("income", "summary"),
    incomeSourceKey("income", "rows"),
  ]);
  expect(await incomeHistoryInventoryComplete(artifacts)).toBe(true);
  expect(await incomeHistoryInventoryComplete(artifacts.slice(0, 2))).toBe(false);
  const altered = structuredClone(artifacts);
  altered[1]!.bytes = encode("{}");
  expect(await incomeHistoryInventoryComplete(altered)).toBe(false);
  const wrongMedia = structuredClone(artifacts);
  wrongMedia[2]!.mediaType = "text/html";
  expect(await incomeHistoryInventoryComplete(wrongMedia)).toBe(false);
});

test("financial precision, unknown categories and count failures keep raw but no derived publication", async () => {
  for (const [old, replacement, code] of [
    [
      '"receivedAmountLc":0.29',
      '"receivedAmountLc":0.99999999999999999',
      "sbi_income_history_money",
    ],
    ['"category":"DOMESTIC_STOCK_SPOT"', '"category":"FUND"', "sbi_income_history_unknown_code"],
  ]) {
    const text = incomeBundle("income").rowsText.replace(old!, replacement!);
    const { artifacts, failure } = await capture(text);
    expect(safeFailureCode(failure)).toBe(code!);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[1]!.bytes).toEqual(encode(text));
    const plan = await sbiRunPlan({
      runId: `income-partial-${code}`,
      producerVersion: "synthetic",
      attemptId: "attempt",
      startedAt: "2099-12-31T00:00:00Z",
      completedAt: "2099-12-31T00:01:00Z",
      status: "partial",
      scope: "domestic",
      artifacts,
      failures: [{ scope: "domestic", code: safeFailureCode(failure) }],
    });
    expect(plan.run.providerOutcome).toBe("partial");
    expect(plan.run.units[0]!.coverageStatus).toBe("partial");
    expect(plan.artifacts.every((a) => a.role === "provider_response")).toBe(true);
  }
});

test("unknown secret fields, duplicate aliases and malformed syntax refuse original row storage", async () => {
  const original = incomeBundle("income").rowsText;
  for (const text of [
    '{"accessToken":"SYNTHETIC_SENTINEL",' + original.slice(1),
    '{"divid\\u0065nds":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
    original.replace('"quantity":10', '"quantity":10e0e0'),
  ]) {
    const { artifacts, failure } = await capture(text);
    expect(safeFailureCode(failure)).toBe("sbi_income_history_schema");
    expect(artifacts).toHaveLength(1);
    expect(JSON.stringify(artifacts)).not.toContain("SYNTHETIC_SENTINEL");
  }
});

test("invalid UTF-8 refuses raw storage rather than silently rewriting original bytes", async () => {
  const artifacts: Artifact[] = [];
  await expect(
    collectIncomeHistory({
      kind: "income",
      today: "2099-12-31",
      retain: (a) => artifacts.push(a),
      fetch: async () => Uint8Array.of(255),
    }),
  ).rejects.toThrow("sbi_income_history_schema");
  expect(artifacts).toEqual([]);
});

test("gains requests retain independent all-product and domestic controls before refusing continuation", async () => {
  const bundle = incomeBundle("gains");
  const artifacts: Artifact[] = [];
  const roles: string[] = [];
  await collectIncomeHistory({
    kind: "gains",
    today: "2099-12-31",
    retain: (a) => artifacts.push(a),
    fetch: async (role) => {
      roles.push(role);
      return encode(role === "rows" ? bundle.rowsText : bundle.summaryText);
    },
  });
  expect(roles).toEqual(["all-summary", "summary", "rows"]);
  expect(await incomeHistoryInventoryComplete(artifacts)).toBe(true);
  const partial: Artifact[] = [];
  const summary = bundle.summaryText.replaceAll('"total":1', '"total":31');
  await expect(
    collectIncomeHistory({
      kind: "gains",
      today: "2099-12-31",
      retain: (a) => partial.push(a),
      fetch: async (role) => encode(role === "rows" ? bundle.rowsText : summary),
    }),
  ).rejects.toThrow("sbi_income_history_pagination_unobserved");
  expect(partial).toHaveLength(3);
  expect(await incomeHistoryInventoryComplete(partial)).toBe(false);
});
