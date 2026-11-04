import { describe, expect, spyOn, test } from "bun:test";
import {
  diagnoseStatementCounts,
  logStatementCountDiagnostic,
} from "../src/statement-count-diagnostic";

const SENTINEL = "SYNTHETIC_PRIVATE_TEXT_DO_NOT_RETURN";
function row(primary: string, secondary: string, length: number) {
  return { rowType: primary, data: [primary, secondary, ...Array(length - 2).fill(SENTINEL)] };
}
function finalized(rows: unknown[], total: unknown, cursor: unknown = "101") {
  return {
    rawJson: JSON.stringify({
      body: {
        content: {
          WebMeisaiTopDisplayServiceBean: {
            cardName: SENTINEL,
            meisaiList: rows,
            webMeisaiTopK3Vo: { allCnt: total, nextPageRow: cursor, payTotal: SENTINEL },
          },
        },
      },
    }),
  };
}
function customized(rows: unknown[], total: unknown) {
  return {
    rawJson: JSON.stringify({
      body: { content: { CustomizedMeisaiAnsDisplayServiceBean: { meisaiList: rows, total } } },
    }),
  };
}

describe("statement count diagnostic", () => {
  test("distinguishes display rows from detail rows without asserting provider semantics", () => {
    const report = diagnoseStatementCounts([
      {
        pages: [
          finalized(
            [
              row("45", SENTINEL, 5),
              row("4C", "", 4),
              row("4K", "002", 4),
              row("4K", "005", 11),
              row("4K", "007", 14),
            ],
            "2",
          ),
        ],
      },
    ]);
    expect(report.finalized.rows).toBe(5);
    expect(report.finalized.rowKinds).toEqual({
      "45": 1,
      "4C": 1,
      "4K002": 1,
      "4K005": 1,
      "4K007": 1,
      other: 0,
    });
    expect(report.finalized.rawRowsVersusLastTotal.excess).toBe(1);
    expect(report.finalized.detailRowsVersusLastTotal.equal).toBe(1);
    expect(report.finalized.finalTotalBeforeNextCursor.yes).toBe(1);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(JSON.stringify(report)).not.toContain("coverage");
  });

  test("aggregates equal, short and excess without returning totals or per-month data", () => {
    const report = diagnoseStatementCounts(
      [0, 1, 2].map((total) => ({ pages: [finalized([row("4K", "005", 11)], total, 1)] })),
    );
    expect(report.finalized.rawRowsVersusLastTotal).toEqual({
      equal: 1,
      short: 1,
      excess: 1,
      unverified: 0,
    });
    expect(report.finalized.finalTotalBeforeNextCursor).toEqual({ yes: 1, no: 2, unverified: 0 });
    expect(report.finalized.months).toBe(3);
  });

  test("retains unknown rows and does not treat their exclusion as proof", () => {
    const report = diagnoseStatementCounts([
      { pages: [finalized([row(SENTINEL, SENTINEL, 5), row("4K", "005", 10)], "0")] },
    ]);
    expect(report.finalized.rowKinds.other).toBe(2);
    expect(report.finalized.detailRowsVersusLastTotal.unverified).toBe(1);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  test("reports changed totals and numeric-string stability across ordered pages", () => {
    const report = diagnoseStatementCounts([
      { pages: [finalized([], 1), finalized([], "1")] },
      { pages: [finalized([], 1), finalized([], 2)] },
      { pages: [finalized([], SENTINEL)] },
    ]);
    expect(report.finalized.totalStability).toEqual({ stable: 1, changed: 1, unverified: 1 });
    expect(report.finalized.rawRowsVersusLastTotal.unverified).toBe(1);
  });

  test("keeps customized row semantics separate", () => {
    const report = diagnoseStatementCounts([{ pages: [customized([{ merchant: SENTINEL }], 1)] }]);
    expect(report.customized.rawRowsVersusLastTotal.equal).toBe(1);
    expect(report.customized.detailRowsVersusLastTotal.unverified).toBe(1);
    expect(report.customized.finalTotalBeforeNextCursor.unverified).toBe(1);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  test("malformed, missing and mixed families remain unknown and closed", () => {
    const report = diagnoseStatementCounts([
      { pages: [{ rawJson: SENTINEL }] },
      { pages: [{ rawJson: "{}" }] },
      { pages: [finalized([], 0), customized([], 0)] },
      { pages: [] },
    ]);
    expect(report.unknown.months).toBe(4);
    expect(report.unknown.rawRowsVersusLastTotal.unverified).toBe(4);
    expect(report.unknown.unreadablePages).toBe(1);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  test("rejects out-of-bounds input without a partial report or input text", () => {
    expect(() =>
      diagnoseStatementCounts(Array.from({ length: 25 }, () => ({ pages: [] }))),
    ).toThrow("vpass_count_diagnostic_bounds");
    expect(() =>
      diagnoseStatementCounts([{ pages: Array.from({ length: 101 }, () => finalized([], 0)) }]),
    ).toThrow("vpass_count_diagnostic_bounds");
    expect(() =>
      diagnoseStatementCounts([{ pages: [{ rawJson: "x".repeat(5_000_001) }] }]),
    ).toThrow("vpass_count_diagnostic_bounds");
    expect(() =>
      diagnoseStatementCounts([
        { pages: Array.from({ length: 5 }, () => ({ rawJson: "x".repeat(4_000_001) })) },
      ]),
    ).toThrow("vpass_count_diagnostic_bounds");
    expect(() =>
      diagnoseStatementCounts([
        {
          pages: [
            finalized(
              Array.from({ length: 100_001 }, () => ({})),
              0,
            ),
          ],
        },
      ]),
    ).toThrow("vpass_count_diagnostic_bounds");
  });

  test("unreadable earlier totals never imply stable totals even when the final count matches", () => {
    const report = diagnoseStatementCounts([
      { pages: [finalized([], SENTINEL), finalized([], 0)] },
    ]);
    expect(report.finalized.totalStability.unverified).toBe(1);
    expect(report.finalized.rawRowsVersusLastTotal.equal).toBe(1);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  test.each([false, true])(
    "the log boundary catches diagnostic and logger failures (logger throws=%s)",
    (loggerThrows) => {
      const records: unknown[] = [];
      const logger = spyOn(console, "log").mockImplementation((value) => {
        records.push(JSON.parse(String(value)));
        if (loggerThrows) throw new Error(SENTINEL);
      });
      const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          () => {
            throw new Error("unexpected_fetch");
          },
          {
            preconnect: () => {
              throw new Error("unexpected_preconnect");
            },
          },
        ),
      );
      try {
        expect(() =>
          logStatementCountDiagnostic({ [SENTINEL]: { pages: [finalized([], 0)] } }),
        ).not.toThrow();
        expect(() =>
          logStatementCountDiagnostic(
            Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), { pages: [] }])),
          ),
        ).not.toThrow();
        expect(() =>
          logStatementCountDiagnostic({
            get privateMonth(): never {
              throw new Error(SENTINEL);
            },
          }),
        ).not.toThrow();
        expect(records).toHaveLength(3);
        expect(records[0]).toMatchObject({
          event: "vpass-statement-count-shapes",
          status: "available",
        });
        for (const record of records.slice(1))
          expect(record).toEqual({
            event: "vpass-statement-count-shapes",
            status: "unavailable",
            code: "count_diagnostic_unavailable",
          });
        expect(JSON.stringify(records)).not.toContain(SENTINEL);
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
        logger.mockRestore();
      }
    },
  );
});
