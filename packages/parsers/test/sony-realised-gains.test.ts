import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sonyBankRealisedGains } from "../src/parsers/sony-realised-gains";
import type { ArtifactMeta } from "../src/types";
const body = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/sony-bank-parser-boundaries/realised-gains.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "sony-bank",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "realised-gains",
  artifactKey: "realised-gains-2099.json",
  fetchUnitKey: "realised-year-2099",
  url: null,
  mime: "application/json",
  fetchedAt: "2099-06-01T00:00:00Z",
  sha256: "a".repeat(64),
};
function parse(value = body, overrides: Partial<ArtifactMeta> = {}) {
  return sonyBankRealisedGains.parse(new TextEncoder().encode(JSON.stringify(value)), {
    ...meta,
    ...overrides,
  });
}
test("annual provider gains and after-tax interest are valuations, never movements", () => {
  const result = parse();
  expect(
    result.observations.map((row) => [
      row.kind,
      "subject" in row ? row.subject : null,
      "metric" in row ? row.metric : null,
      "amountMinor" in row ? row.amountMinor : null,
    ]),
  ).toEqual([
    ["valuation", "sony-bank:realised:2099:USD", "annual_realised_fx_gain", -123],
    ["valuation", "sony-bank:realised:2099:USD", "annual_after_tax_interest", 7],
  ]);
  expect(
    parse(body, {
      artifactKey: "realised-gains-2098.json",
      fetchUnitKey: "realised-year-2098",
    }).observations.map((row) => ("amountMinor" in row ? row.amountMinor : null)),
  ).toEqual([456, 8]);
  expect(result.coverage?.[0]).toMatchObject({
    completeness: "complete",
    expectedCount: 2,
    observedCount: 2,
  });
});
test("counts, unknown currencies, duplicates, malformed money and year scope fail closed", () => {
  const bads = [
    { ...body, cyCcySepRliztnPrftLsCnt: 2 },
    { ...body, rliztnPrftLsLy: "2097" },
    {
      ...body,
      cyCcySepRliztnPrftLsFcplSi: [{ currencyCd: "XXX", cyRliztnPrftLs: "1", cyItrAmt: "1" }],
    },
    {
      ...body,
      cyCcySepRliztnPrftLsFcplSi: [{ currencyCd: "USD", cyRliztnPrftLs: "", cyItrAmt: "1" }],
    },
  ];
  for (const bad of bads) expect(() => parse(bad)).toThrow();
  expect(() => parse(body, { fetchUnitKey: "realised-year-2098" })).toThrow();
  expect(() => parse(body, { runStatus: "partial", runFailureCount: 1 })).toThrow();
});
test("long detail history cannot enlarge the bounded annual parse output", () => {
  const result = parse({
    ...body,
    totalDtlFcplSi: Array.from({ length: 100_000 }, () => body.totalDtlFcplSi[0]),
  });
  expect(result.observations).toHaveLength(2);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(4096);
});
