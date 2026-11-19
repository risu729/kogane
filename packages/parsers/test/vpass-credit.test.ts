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
test("the normal Authori module transition preserves the empty-transition observations", () => {
  const value = authori();
  value.header.transitTo = "vp.member.pages.info";
  expect(parse(value)).toEqual(parse(authori()));
});

test("only Authori admits its exact public module and all session guards remain closed", () => {
  for (const transition of [
    "vp.member.pages.unknown",
    "vp.member.pages.info ",
    " vp.member.pages.info",
    "vp.member.pages.info.extra",
    "VP.member.pages.info",
    "/memx/authori/shokai/index.html",
    null,
    true,
    0,
  ]) {
    const value = authori();
    Object.assign(value.header, { transitTo: transition });
    expect(() => parse(value)).toThrow("vpass_credit_session_invalid");
  }
  const wrongEndpoint = revo();
  wrongEndpoint.header.transitTo = "vp.member.pages.info";
  expect(() => parse(wrongEndpoint, { ...meta, artifactKey: "credit/revo.json" })).toThrow(
    "vpass_credit_session_invalid",
  );
  for (const header of [{ loginFlg: false }, { resultCode: "synthetic_failure" }]) {
    const value = authori();
    Object.assign(value.header, { transitTo: "vp.member.pages.info", ...header });
    expect(() => parse(value)).toThrow("vpass_credit_session_invalid");
  }
});

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

// #1357: the card's product name as a display label. Every name is invented.
const kogane = (row: { extra?: Record<string, unknown> }) =>
  row.extra?.["_kogane"] as Record<string, unknown>;
const revoMeta = { ...meta, artifactKey: "credit/revo.json" };
test("every Authori observation carries Authori's card name", () => {
  const result = parse(authori("123", "テストカードA"));
  expect(result.observations).toHaveLength(12);
  for (const row of result.observations) expect(kogane(row)["cardName"]).toBe("テストカードA");
});
test("Revo carries its own card name, so a card with no visible Authori row is still named", () => {
  const hidden = authori("123", "テストカードA");
  const display = hidden.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiDisplayVo;
  display.hyoujiFlg = "1";
  for (const row of display.autoriShokaiDisplayList) row.hyoujiFlg = "1";
  expect(parse(hidden).observations).toEqual([]);
  const result = parse(revo("+1", "テストカードB"), revoMeta);
  expect(result.observations).toHaveLength(2);
  for (const row of result.observations) expect(kogane(row)["cardName"]).toBe("テストカードB");
});
test("a name that could hold a card number, or is not a name, is omitted and the snapshot kept", () => {
  for (const name of [
    "テストカード1234",
    "テスト****-1234",
    // Full-width digits are digits too.
    "テスト１２３４",
    "",
    "   ",
    "テスト\u0007カード",
    // A format character hides a digit run or reorders the text.
    "テスト1\u200b2\u200b3\u200b4",
    "テスト\u202eカード",
    "x".repeat(65),
  ]) {
    for (const [value, artifact, count] of [
      [authori("123", name), meta, 12],
      [revo("+1", name), revoMeta, 2],
    ] as const) {
      const result = parse(value, artifact);
      expect(result.observations, name).toHaveLength(count);
      expect(result.coverage?.[0]?.completeness).toBe("complete");
      for (const row of result.observations) expect(kogane(row)).not.toHaveProperty("cardName");
    }
  }
  // Three digits are not a card number; surrounding space is not the name.
  const kept = parse(authori("123", " テストカード123 ")).observations[0]!;
  expect(kogane(kept)["cardName"]).toBe("テストカード123");
  // A non-string name is a shape change and still fails closed.
  const numeric = authori();
  numeric.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiVo["cardName"] = 1;
  expect(() => parse(numeric)).toThrow("vpass_credit_vo_type");
});
test("the Revo holder name is never copied", () => {
  const value = revo("+1", "テストカードA");
  value.body.content.CustomizedRevoShokaiAnsPcDisplayServiceBean.userName = "テスト太郎";
  const result = parse(value, revoMeta);
  expect(JSON.stringify(result)).not.toContain("テスト太郎");
  expect(JSON.stringify(result)).not.toContain("userName");
  expect(JSON.stringify(parse(revo(), revoMeta))).not.toContain("Synthetic person");
});
