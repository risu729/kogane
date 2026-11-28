import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  collectCashHistory,
  cashHistoryInventoryComplete,
  readCashHistoryResponse,
} from "../src/cash-history";
import { cashHistoryRequestUrl } from "../src/main-site";
import { safeFailureCode, sbiRunPlan } from "../src/shared-run";
import {
  CashHistoryError,
  cashRetentionRange,
} from "../../../packages/parsers/src/parsers/sbi-cash-history-schema";
import type { Artifact } from "../src/types";

const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/sbi-parser-boundaries/foreign-cash-history.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
async function capture(body = fixture()) {
  const artifacts: Artifact[] = [];
  const calls: unknown[] = [];
  await collectCashHistory({
    kind: "foreign",
    today: "2099-12-31",
    retain: (artifact) => artifacts.push(artifact),
    fetchPage: async (range, number) => {
      calls.push([range, number]);
      return encoded(body.pages[number - 1]);
    },
  });
  return { artifacts, calls };
}
const run = (artifacts: Artifact[]) => ({
  runId: "cash-synthetic",
  producerVersion: "synthetic-v1",
  attemptId: "synthetic-attempt",
  startedAt: "2099-12-31T00:00:00Z",
  completedAt: "2099-12-31T00:01:00Z",
  status: "success" as const,
  scope: "domestic" as const,
  artifacts,
  failures: [],
});

test("requests use observed whole-retention filters and no caller window", () => {
  const yen = cashHistoryRequestUrl("yen", cashRetentionRange("2099-12-31", "yen"), 2);
  expect(yen.pathname).toBe("/banking/api/yen/detail/query");
  expect(Object.fromEntries(yen.searchParams)).toEqual({
    depositDateFrom: "20980101",
    depositDateTo: "20991231",
    payDepKbnList: "1,2,5",
    detailKbnList: "11,12,13,14,15,16,17,18,21,22,23,24",
    sortDateType: "1",
    pageNumber: "2",
    pageSize: "10",
    totalCountKbn: "1",
  });
  const foreign = cashHistoryRequestUrl("foreign", cashRetentionRange("2099-12-31", "foreign"), 1);
  expect(foreign.pathname).toBe("/banking/api/fc/detail-history/search");
  expect(Object.fromEntries(foreign.searchParams)).toEqual({
    startDate: "2095/01/01",
    endDate: "2099/12/31",
    tradeKind: "",
    currencyCode: "011",
    pageNumber: "1",
    pageSize: "10",
    termKind: "1",
    sortType: "1",
  });
});

test("response bytes are bounded even when the server omits Content-Length", async () => {
  const bytes = encoded(fixture().pages[0]);
  expect(await readCashHistoryResponse(new Response(bytes))).toEqual(bytes);
  await expect(
    readCashHistoryResponse(
      new Response("x", { headers: { "content-length": String(256 * 1024 + 1) } }),
    ),
  ).rejects.toThrow("sbi_cash_history_schema");
  await expect(
    readCashHistoryResponse(new Response(new Uint8Array(256 * 1024 + 1))),
  ).rejects.toThrow("sbi_cash_history_schema");
});

test("raw page bytes, complete lineage and requested retention survive terminal planning", async () => {
  const { artifacts, calls } = await capture();
  expect(calls).toEqual([[{ from: "2095-01-01", to: "2099-12-31" }, 1]]);
  expect(artifacts).toHaveLength(2);
  expect(artifacts[0]!.bytes).toEqual(encoded(fixture().pages[0]));
  expect(await cashHistoryInventoryComplete(artifacts)).toBe(true);
  const plan = await sbiRunPlan(run(artifacts));
  expect(plan.run.providerOutcome).toBe("success");
  expect(plan.run.units).toEqual([
    { unitKey: "domestic", unitKind: "scope", artifactCount: 0, coverageStatus: "complete" },
    {
      unitKey: "cash-history-foreign",
      unitKind: "scope",
      artifactCount: 2,
      coverageStatus: "complete",
    },
  ]);
  expect(plan.run.transformations[0]!.inputArtifactKeys).toEqual([
    "foreign-cash-history-page-0001-source.json",
  ]);
  expect(plan.run.ranges[0]).toMatchObject({
    rangeKey: "foreign-cash-history.json:requested",
    startValue: "2095-01-01",
    endValue: "2099-12-31",
    unitKey: "cash-history-foreign",
  });
});

test("missing, changed or repeated raw inputs cannot seal successful cash coverage", async () => {
  const { artifacts } = await capture();
  for (const changed of [
    artifacts.slice(1),
    [artifacts[0]!],
    [...artifacts, artifacts[0]!],
    [{ ...artifacts[0]!, bytes: encoded({}) }, artifacts[1]!],
  ]) {
    expect(await cashHistoryInventoryComplete(changed)).toBe(false);
    const plan = await sbiRunPlan(run(changed));
    expect(plan.run.providerOutcome).toBe("partial");
    expect(plan.run.safeErrorCode).toBe("sbi_cash_history_source_inventory");
    expect(
      plan.run.units.find((unit) => unit.unitKey === "cash-history-foreign")!.coverageStatus,
    ).toBe("partial");
  }
});

/** Twelve synthetic USD rows as the provider pages them: ten, then two, newest first. */
function twoPageForeign(inserted = false) {
  const body = fixture();
  const row = body.pages[0].items[2];
  const page = (rows: number, first: number, totalCount: number) => ({
    pageCount: 2,
    totalCount,
    businessErrorMessage: null,
    items: Array.from({ length: rows }, (_, index) => ({
      ...row,
      valueDate: `2099${String(12 - Math.floor((first + index) / 2)).padStart(2, "0")}01`,
    })),
  });
  body.totalCount = 12;
  // A row inserted after page 1 pushes one more row onto page 2.
  body.pages = [page(10, 0, 12), inserted ? page(3, 9, 13) : page(2, 10, 12)];
  return body;
}

test("a USD statement over ten rows is collected page by page, like the yen statement", async () => {
  const body = twoPageForeign();
  const { artifacts, calls } = await capture(body);
  expect(calls.map((call) => (call as [unknown, number])[1])).toEqual([1, 2]);
  const sources = artifacts.filter((a) => a.role === "provider_response");
  expect(sources.map((a) => a.artifactKey)).toEqual([
    "foreign-cash-history-page-0001-source.json",
    "foreign-cash-history-page-0002-source.json",
  ]);
  const bundle = artifacts.find((a) => a.dataset === "foreign-cash-history")!;
  expect(bundle.inputArtifactKeys).toEqual([
    "foreign-cash-history-page-0001-source.json",
    "foreign-cash-history-page-0002-source.json",
  ]);
  expect((bundle.body as { pages: unknown[] }).pages).toHaveLength(2);
  expect(await cashHistoryInventoryComplete(artifacts)).toBe(true);
  // Page 2 differs from the observed page-1 request only in its page number.
  const range = cashRetentionRange("2099-12-31", "foreign");
  const first = Object.fromEntries(cashHistoryRequestUrl("foreign", range, 1).searchParams);
  const second = Object.fromEntries(cashHistoryRequestUrl("foreign", range, 2).searchParams);
  expect(second).toEqual({ ...first, pageNumber: "2" });
});

test("a USD row arriving between page requests fails closed after keeping both pages", async () => {
  // Without row ids, a moved page boundary shows as a total that changed
  // between pages (and here also as a date repeated across the boundary).
  const retained: Artifact[] = [];
  const body = twoPageForeign(true);
  await expect(
    collectCashHistory({
      kind: "foreign",
      today: "2099-12-31",
      retain: (artifact) => retained.push(artifact),
      fetchPage: async (_, number) => encoded(body.pages[number - 1]),
    }),
  ).rejects.toThrow("sbi_cash_history_pagination");
  expect(retained.map((a) => a.role)).toEqual(["provider_response", "provider_response"]);
  expect(safeFailureCode(new CashHistoryError("sbi_cash_history_pagination"))).toBe(
    "sbi_cash_history_pagination",
  );
});

test("unknown fields and private error envelopes never enter raw financial storage", async () => {
  const retained: Artifact[] = [];
  const body = fixture();
  body.pages[0].items[0].syntheticToken = "synthetic-private";
  await expect(
    collectCashHistory({
      kind: "foreign",
      today: "2099-12-31",
      retain: (artifact) => retained.push(artifact),
      fetchPage: async () => encoded(body.pages[0]),
    }),
  ).rejects.toThrow("sbi_cash_history_schema");
  expect(retained).toEqual([]);
});
