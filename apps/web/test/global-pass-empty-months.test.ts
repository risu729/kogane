import { expect, test } from "bun:test";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { globalPassEmptyMonthsMessage } from "../src/global-pass-empty-months.tsx";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const metadata = {
  apiVersion: 1,
  source: { kind: "central-store", classification: "financial" },
  capabilities: CENTRAL_STORE_CAPABILITIES,
};
const month = {
  source: "global-pass",
  month: "2099-01",
  currentFetchRunId: 12,
  supersededFetchRunId: 9,
  supersededRuns: 1,
};

test("the empty-month notice is optional, identifiers only, and rejects malformed entries", () => {
  expect(validApiResponse("/api/meta", metadata)).toBe(true);
  expect(
    validApiResponse("/api/meta", {
      ...metadata,
      globalPassEmptyMonths: { months: [], truncated: false },
    }),
  ).toBe(true);
  expect(
    validApiResponse("/api/meta", {
      ...metadata,
      globalPassEmptyMonths: { months: [month, { ...month, month: "2098-12" }], truncated: true },
    }),
  ).toBe(true);
  for (const bad of [
    { ...month, month: "2099-1" },
    { ...month, month: "January" },
    { ...month, supersededRuns: 0 },
    { ...month, currentFetchRunId: -1 },
    { ...month, supersededFetchRunId: 1.5 },
    { ...month, source: 7 },
  ]) {
    expect(
      validApiResponse("/api/meta", {
        ...metadata,
        globalPassEmptyMonths: { months: [bad], truncated: false },
      }),
    ).toBe(false);
  }
  expect(
    validApiResponse("/api/meta", { ...metadata, globalPassEmptyMonths: { months: [month] } }),
  ).toBe(false);
});

test("the notice names the month and both runs, asks for a check, and claims no freshness", () => {
  expect(globalPassEmptyMonthsMessage(undefined)).toBeNull();
  expect(globalPassEmptyMonthsMessage({ months: [], truncated: false })).toBeNull();
  const one = globalPassEmptyMonthsMessage({ months: [month], truncated: false })!;
  expect(one).toContain("1か月");
  expect(one).toContain("2099-01");
  expect(one).toContain("run 12");
  expect(one).toContain("run 9");
  expect(one).not.toContain("ほか");
  expect(one).toContain("以前の明細は自動では戻しません");
  expect(one).toContain("確認が必要");
  expect(one).toContain("データの新しさを示しません");
  const several = globalPassEmptyMonthsMessage({
    months: [
      { ...month, supersededRuns: 3 },
      { ...month, month: "2098-12" },
      { ...month, month: "2098-11" },
      { ...month, month: "2098-10" },
      { ...month, month: "2098-09" },
    ],
    truncated: false,
  })!;
  expect(several).toContain("5か月");
  expect(several).toContain("ほか2回");
  expect(several).toContain("ほか2か月");
  expect(several).not.toContain("2098-10");
  const truncated = globalPassEmptyMonthsMessage({ months: [month], truncated: true })!;
  expect(truncated).toContain("1+か月");
  expect(truncated).toContain("上限");
});
