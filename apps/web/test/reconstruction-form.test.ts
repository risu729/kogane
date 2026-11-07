import { describe, expect, test } from "bun:test";
import { formProblem } from "../src/reconstruction-form.ts";
import type { ReconstructedStateQuery } from "../src/reconstructed-state-api.ts";

const TODAY = "2400-01-01";
const BASE = { account: "synthetic-account", from: "2026-03-01", to: "2026-03-31" };
const INSTANT_PROBLEM = "時刻を 2026-04-01T00:00:00Z のように UTC で入力してください。";
const SEQUENCE_PROBLEM = "コミット番号は1以上の整数で入力してください。";
const pad = (value: number) => String(value).padStart(2, "0");

function instantProblem(instant: string): string | null {
  return formProblem({ ...BASE, cut: { kind: "instant", coreEpoch: "synthetic-epoch", instant } }, TODAY);
}

/** Independent oracle: the platform's UTC calendar must round-trip without normalization. */
function roundTrips(instant: string): boolean {
  const milliseconds = Date.parse(instant);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === instant.replace("Z", ".000Z");
}

describe("reconstruction form knowledge cuts", () => {
  test("rejects impossible UTC instants and unsafe commit sequences before sending", () => {
    for (const instant of [
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-03-01T24:00:00Z",
      "2026-03-01T00:60:00Z",
      "2026-03-01T00:00:60Z",
    ])
      expect([instant, instantProblem(instant)]).toEqual([instant, INSTANT_PROBLEM]);
    for (const commitSeq of ["9007199254740992", "9007199254740993", "9999999999999999"])
      expect(formProblem({ ...BASE, cut: { kind: "sequence", coreEpoch: "epoch", commitSeq } }, TODAY)).toBe(SEQUENCE_PROBLEM);
  });

  test("every month/day slot over a Gregorian 400-year cycle agrees with the UTC calendar", () => {
    // All 400 years, months 0..13 and days 0..32: valid calendar slots plus each
    // adjacent invalid boundary, including all leap-year and century cases.
    let checked = 0;
    for (let year = 2000; year < 2400; year++)
      for (let month = 0; month <= 13; month++)
        for (let day = 0; day <= 32; day++) {
          const instant = `${year}-${pad(month)}-${pad(day)}T00:00:00Z`;
          const expected = roundTrips(instant);
          const actual = instantProblem(instant) === null;
          if (actual !== expected) expect({ instant, actual }).toEqual({ instant, actual: expected });
          checked++;
        }
    expect(checked).toBe(184800);
  });

  test("every hour/minute/second slot and adjacent upper boundary agrees with UTC", () => {
    let checked = 0;
    for (let hour = 0; hour <= 24; hour++)
      for (let minute = 0; minute <= 60; minute++)
        for (let second = 0; second <= 60; second++) {
          const instant = `2026-03-01T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
          const expected = roundTrips(instant);
          const actual = instantProblem(instant) === null;
          if (actual !== expected) expect({ instant, actual }).toEqual({ instant, actual: expected });
          checked++;
        }
    expect(checked).toBe(93025);
  });

  test("UTC syntax, fractional precision and exact safe sequence boundaries", () => {
    for (let digits = 1; digits <= 9; digits++)
      expect(instantProblem(`2026-03-01T12:34:56.${"1".repeat(digits)}Z`)).toBeNull();
    for (const instant of [
      "2026-03-01T12:34:56.Z",
      "2026-03-01T12:34:56.1234567890Z",
      "2026-03-01T12:34:56+00:00",
      "2026-03-01T12:34:56z",
      "2026-3-1T12:34:56Z",
      " 2026-03-01T12:34:56Z",
    ])
      expect(instantProblem(instant)).toBe(INSTANT_PROBLEM);
    const sequences: [string, boolean][] = [
      ["1", true], ["9", true], ["10", true], ["9007199254740990", true],
      ["9007199254740991", true], ["9007199254740992", false],
      ["9007199254740993", false], ["9999999999999999", false],
      ["10000000000000000", false], ["0", false], ["-1", false], ["01", false],
      ["1.0", false], ["1e3", false], [" 1", false], ["1 ", false], ["", false],
    ];
    for (const [commitSeq, valid] of sequences)
      expect([commitSeq, formProblem({ ...BASE, cut: { kind: "sequence", coreEpoch: "epoch", commitSeq } }, TODAY)]).toEqual([commitSeq, valid ? null : SEQUENCE_PROBLEM]);
  });

  test("the other form checks keep their messages and the three cut modes", () => {
    const latest = { kind: "latest" } as const;
    const cases: [Partial<ReconstructedStateQuery>, string | null][] = [
      [{}, null],
      [{ account: "" }, "口座 ID を選ぶか入力してください。"],
      [{ from: "2026-02-30" }, "日付を 2026-03-31 のように指定してください。"],
      [{ from: BASE.to }, "開始日は終了日より前にしてください。"],
      [{ to: "2400-01-02" }, "終了日は今日（日本時間）以前にしてください。"],
      [{ from: "2024-03-01", to: "2025-03-02" }, null],
      [{ from: "2024-03-01", to: "2025-03-03" }, "期間は366日以内にしてください。"],
      [{ cut: { kind: "sequence", coreEpoch: "", commitSeq: "1" } }, "コミット記録の世代を入力してください。"],
      [{ cut: { kind: "sequence", coreEpoch: "epoch", commitSeq: "1" } }, null],
      [{ cut: { kind: "instant", coreEpoch: "epoch", instant: "2024-02-29T00:00:00Z" } }, null],
    ];
    for (const [change, expected] of cases)
      expect(formProblem({ ...BASE, cut: latest, ...change }, TODAY)).toBe(expected);
  });
});
