import { expect, test } from "bun:test";
import { sbiShinseiSavingsActivity as parser } from "../src/parsers/sbi-shinsei-savings-activity.ts";
import type { ArtifactMeta } from "../src/types.ts";

const file = `${import.meta.dir}/../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/savings-activity.json`;
const fixture = () => Bun.file(file).json();
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "sbi-shinsei-bank",
  dataset: "savings-activity",
  mime: "application/json",
  runStatus: "success",
  runFailureCount: 0,
  fetchedAt: "2099-01-15T03:00:00Z",
  url: null,
  sha256: "0".repeat(64),
};
const parse = (value: unknown, artifact = meta) =>
  parser.parse(new TextEncoder().encode(JSON.stringify(value)), artifact);

test("reads all money rows beyond the visible enrichment page with exact native amounts", async () => {
  const input = await fixture(),
    result = parse(input);
  expect(result.observations).toHaveLength(31);
  expect(result.coverage?.[0]).toMatchObject({
    completeness: "complete",
    observedCount: 31,
    expectedCount: null,
  });
  expect(result.observations[1]).toMatchObject({
    amountText: "-200",
    amountMinor: -200,
    currency: "JPY",
    externalId: "synthetic-ref-1",
    sourceAccount: "sbi-shinsei:000000000000001",
    extra: { _kogane: { identityOrigin: "provider-id", sourceView: "historical" } },
  });
  input.scope.currency = "USD";
  input.scope.productCode = "621";
  input.response.responseParam.activity.responseParam.currency = "USD";
  input.response.responseParam.activity.responseParam.activityDetails[0].credit = "1.23";
  expect(parse(input).observations[0]).toMatchObject({
    currency: "USD",
    amountText: "1.23",
    amountMinor: 123,
  });
});

test("observed empty status binds the no-echo response to its requested account and range", async () => {
  const input = await fixture();
  const block = input.response.responseParam.activity;
  block.errorInfo.statusID = "30024";
  for (const field of Object.keys(block.responseParam))
    block.responseParam[field] = field === "activityDetails" ? [] : "";
  delete input.response.responseParam.memoInquiry;
  delete input.response.responseParam.summaryColumnTransformation;
  expect(parse(input).coverage?.[0]).toMatchObject({
    completeness: "complete",
    observedCount: 0,
    absenceMeaning: "complete-empty",
  });
  block.errorInfo.statusID = "30224";
  expect(() => parse(input)).toThrow();
});

test("rejects changed status, unknown keys, duplicates, invalid rows and mismatched request context", async () => {
  const mutations = [
    (i: any) => {
      i.response.responseParam.activity.errorInfo.statusID = "99999";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.purgeflag = "N";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.total = "32";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.accountNo = "000000000000002";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.currency = "EUR";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.activityDetails[0].postingDate = "2096/12/31";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.activityDetails[0].credit = "-1";
    },
    (i: any) => {
      i.response.responseParam.activity.responseParam.activityDetails.push(
        i.response.responseParam.activity.responseParam.activityDetails[0],
      );
    },
    (i: any) => {
      i.response.responseParam.memoInquiry.responseParam.memoInquiryDetails.pop();
    },
  ];
  for (const change of mutations) {
    const input = await fixture();
    change(input);
    expect(() => parse(input)).toThrow();
  }
});

test("successful unit survives another account's partial parent, but an unadmitted run does not", async () => {
  const input = await fixture();
  expect(() => parse(input, { ...meta, runStatus: "partial", runFailureCount: 1 })).toThrow();
  expect(
    parse(input, {
      ...meta,
      runStatus: "partial",
      runFailureCount: 1,
      unitScopeEligibility: "unit-independent-v1",
      fetchUnitKey: "savings-synthetic",
    }).observations,
  ).toHaveLength(31);
});
