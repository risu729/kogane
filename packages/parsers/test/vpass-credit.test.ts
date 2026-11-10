import { expect, test } from "bun:test";
import { vpassCreditSnapshot } from "../src/parsers/vpass-credit.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { authori, revo } from "./fixtures/vpass-credit.ts";
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "vpass",
  dataset: "credit-snapshot",
  artifactKey: "credit/authori.json",
  fetchUnitKey: "card-001",
  runStatus: "success",
  runFailureCount: 0,
  url: null,
  mime: "application/json",
  fetchedAt: "2099-01-01T10:00:00Z",
  sha256: "0".repeat(64),
};
const parse = (value: unknown, artifact = meta) =>
  vpassCreditSnapshot.parse(new TextEncoder().encode(JSON.stringify(value)), artifact);
test("reported authori units are thousand yen; shared availability is never recomputed", () => {
  const result = parse(authori());
  expect(result.observations).toHaveLength(12);
  expect(
    result.observations.find(
      (row) => "metric" in row && row.metric === "reported_card_outstanding_thousand_yen",
    ),
  ).toMatchObject({
    sourceAccount: "vpass:card-001",
    amountText: "123000",
    amountScale: 0,
    instrument: "JPY",
    extra: { _kogane: { reportedPrecisionJPY: 1000, nonAdditive: true } },
  });
  expect(
    result.observations.find(
      (row) => "metric" in row && row.metric === "reported_card_available_thousand_yen",
    ),
  ).toMatchObject({ amountText: "555000" });
  expect(result.coverage?.[0]?.completeness).toBe("complete");
  expect(result.observations.some((row) => "metric" in row && row.metric.includes("cashing"))).toBe(
    false,
  );
});
test("signed revolving integers are exact reported yen; the raw limit scale is not inferred", () => {
  const result = parse(revo("-123456"), { ...meta, artifactKey: "credit/revo.json" });
  expect(result.observations).toHaveLength(2);
  expect(result.observations[0]).toMatchObject({
    metric: "reported_revolving_outstanding_yen",
    amountText: "-123456",
    extra: { _kogane: { reportedPrecisionJPY: 1 } },
  });
  expect(result.observations[0]?.asOf).toBeUndefined();
});
test("card partitions and unit-independent admission are explicit", () => {
  expect(
    parse(authori(), {
      ...meta,
      fetchUnitKey: "card-002",
      runStatus: "partial",
      unitScopeEligibility: "unit-independent-v1",
    }).observations[0]?.sourceAccount,
  ).toBe("vpass:card-002");
  expect(() => parse(authori(), { ...meta, runStatus: "partial" })).toThrow(
    "vpass_credit_capture_incomplete",
  );
  expect(() => parse(authori(), { ...meta, fetchUnitKey: "other" })).toThrow(
    "vpass_credit_card_invalid",
  );
});
test("unobserved shapes, flags, numbers, dates and sessions fail closed", () => {
  const bad = [
    () => {
      const v = authori();
      v.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiVo["futureField"] = "0";
      return v;
    },
    () => {
      const v = authori();
      v.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiVo["dataNotFindFlag"] = true;
      return v;
    },
    () => {
      const v = authori();
      v.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiVo["shokaiDate"] = NaN;
      return v;
    },
    () => {
      const v = authori();
      v.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiDisplayVo.autoriShokaiDisplayList[0]!.hyoujiFlg =
        "2";
      return v;
    },
    () => {
      const v = authori();
      v.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiDisplayVo.autoriShokaiDisplayList[0]!.possible =
        "55.6";
      return v;
    },
    () => {
      const v = authori();
      v.header.loginFlg = false;
      return v;
    },
  ];
  for (const make of bad) expect(() => parse(make())).toThrow();
  expect(() => parse(revo("1.5"), { ...meta, artifactKey: "credit/revo.json" })).toThrow(
    "vpass_credit_amount_invalid",
  );
});
