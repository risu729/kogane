// Flag-don't-guess pins for the PayPay CSV parser (ADR 0004). The CSV
// header is the documented export header the existing fixture uses; rows are
// synthetic.
import { describe, expect, test } from "bun:test";
import { paypayCsv } from "../src/parsers/paypay-csv.ts";
import type { ArtifactMeta } from "../src/types.ts";

const HEADER =
  "取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号";
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "paypay",
  runStatus: "success",
  runFailureCount: 0,
  dataset: null,
  url: null,
  mime: "text/csv",
  fetchedAt: "2026-08-20T21:01:42Z",
  sha256: "0".repeat(64),
};
const parse = (csv: string) => paypayCsv.parse(new TextEncoder().encode(csv), meta);
const row = (datetime: string, outgoing: string, incoming: string) =>
  `${datetime},${outgoing},${incoming},,,,,支払い,店,PayPay残高,一括払い,本人,t-1`;
const only = (csv: string) => {
  const result = parse(csv);
  const observation = result.observations[0];
  if (observation?.kind !== "transaction") throw new Error("expected transaction");
  return { observation, warnings: result.warnings };
};

describe("paypay-csv refuses or flags what it cannot read exactly", () => {
  test("an empty file or a header without 取引日 is refused", () => {
    expect(() => parse("")).toThrow("PayPay CSV is empty");
    expect(() => parse("\n\n")).toThrow("PayPay CSV is empty");
    expect(() => parse(HEADER.replace("取引日", "日付"))).toThrow(/取引日/u);
    expect(() => paypayCsv.parse(new Uint8Array([0x82, 0xa0]), meta)).toThrow("not valid UTF-8");
  });

  test("amounts that are not exact whole yen are warned about and left unset", () => {
    for (const [outgoing, incoming, warning] of [
      ['"1,00"', "", 'row 2: outgoing "1,00" unparseable'],
      ["100.5", "", 'row 2: outgoing "100.5" unparseable'],
      ["", "abc", 'row 2: incoming "abc" unparseable'],
      // A sign marker is refused before the value is read (0.2.2), so a
      // doubly signed cell gets the closed sign warning, not "unparseable".
      [
        "",
        "△-5",
        "row 2: incoming amount carries a sign; provider-signed amounts are unsupported, amount left empty",
      ],
    ] as const) {
      const { observation, warnings } = only(
        `${HEADER}\n${row("2026/08/01 00:00:00", outgoing, incoming)}\n`,
      );
      expect(observation.amountMinor).toBeUndefined();
      expect(warnings).toEqual([warning]);
    }
  });

  test("an amount with no decimal form keeps its display text; a signed one keeps none", () => {
    // The display-text fallback holds for an unsigned value that has no
    // decimal form.
    const { observation } = only(`${HEADER}\n${row("2026/08/01 00:00:00", "", '"1,00"')}\n`);
    expect(observation.amountText).toBe("1,00");
    expect(observation.amountScale).toBeUndefined();
    // A sign in a directional column is unobserved provider semantics
    // (ADR 0004): since 0.2.2 such a row carries no amount at all, and only
    // its verbatim cells keep the value.
    const signed = only(`${HEADER}\n${row("2026/08/01 00:00:00", "", "△5")}\n`).observation;
    expect(signed.amountMinor).toBeUndefined();
    expect(signed.amountText).toBeUndefined();
    expect(signed.amountScale).toBeUndefined();
    expect(signed.extra["cells"]).toContain("△5");
    // A zero outgoing amount is zero, never negative zero.
    const zero = only(`${HEADER}\n${row("2026/08/01 00:00:00", "0", "")}\n`).observation;
    expect(Object.is(zero.amountMinor, 0)).toBe(true);
  });

  test("an unrecognized datetime is warned about and no asOf is invented", () => {
    for (const datetime of ["2026-08-01 00:00:00", "08/01/2026 00:00", "2026/08/01"]) {
      const { observation, warnings } = only(`${HEADER}\n${row(datetime, "100", "")}\n`);
      expect(observation.asOf).toBeUndefined();
      expect(observation.extra["datetimeVerbatim"]).toBe(datetime);
      expect(warnings).toEqual([`row 2: datetime ${JSON.stringify(datetime)} not recognized`]);
    }
    // A datetime without seconds is completed with :00 (the stated JST step).
    expect(only(`${HEADER}\n${row("2026/08/01 9:05", "100", "")}\n`).observation.asOf).toBe(
      "2026-08-01T09:05:00+09:00",
    );
  });

  test("row width drift is warned about but the row is kept", () => {
    const { observation, warnings } = only(`${HEADER}\n2026/08/01 00:00:00,100,\n`);
    expect(warnings).toEqual(["row 2: expected 13 columns, got 3"]);
    expect(observation.amountMinor).toBe(-100);
    expect(observation.externalId).toBeUndefined();
    expect(observation).not.toHaveProperty("description");
  });

  test("an unlabelled documented column is flagged when position is used", () => {
    const relabelled = HEADER.replace("取引番号", "番号");
    const { observation, warnings } = only(
      `${relabelled}\n${row("2026/08/01 00:00:00", "100", "")}\n`,
    );
    expect(observation.externalId).toBe("t-1");
    expect(warnings).toEqual([
      'header: no label matched transactionNumber; fell back to documented column 13 ("番号")',
    ]);
    // A header too short to have the documented position names the field.
    const short = only("取引日,出金金額（円）\n2026/08/01 00:00:00,100\n");
    expect(short.observation.externalId).toBeUndefined();
    expect(short.warnings).toContain("header: no column found for transactionNumber");
    expect(short.warnings).toContain("header: no column found for incomingJpy");
  });
});
