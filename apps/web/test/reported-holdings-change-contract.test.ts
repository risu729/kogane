// The wire contract of `GET /api/v2/reported-holdings-change` against answers
// the query itself produces (packages/application/test/holdings-change-world.ts):
// a valid answer passes, and an answer that adds a total or a valuation, puts
// a figure on a holding one date lists only or one that is not comparable,
// drops a reason or invents a status is refused rather than displayed.
import { describe, expect, test } from "bun:test";
import {
  holdingsChangeBody,
  holdingsChangeWorld,
} from "../../../packages/application/test/holdings-change-world.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import type {
  HoldingChangeReason,
  HoldingChangeStatus,
} from "../../../packages/domain/src/holdings-change.ts";
import { validReportedHoldingsChange } from "../../../packages/observation-shared/src/reported-holdings-change-contract.ts";

const PATH = "/api/v2/reported-holdings-change";

async function body() {
  return holdingsChangeBody(holdingsChangeWorld(), { from: "2026-09-01", to: "2026-09-10" });
}

describe("reported holdings change HTTP contract", () => {
  test("the query's answers are valid, every status among them", async () => {
    const store = holdingsChangeWorld();
    for (const [from, to] of [
      ["2026-09-01", "2026-09-10"],
      ["2026-08-30", "2026-09-01"],
      ["2026-09-02", "2026-09-05"],
      ["2026-09-06", "2026-09-12"],
    ] as const) {
      const answer = await holdingsChangeBody(store, { from, to });
      expect(validApiResponse(PATH, answer)).toBe(true);
    }
    const answer = await body();
    expect(answer.counts).toEqual({
      compared: 3,
      listed_at_start_only: 1,
      listed_at_end_only: 1,
      not_comparable: 2,
    });
    const narrowed = await holdingsChangeBody(store, {
      from: "2026-09-01",
      to: "2026-09-10",
      account: "acct-sbi",
    });
    expect(validApiResponse(PATH, narrowed)).toBe(true);
    expect(narrowed.filters).toEqual({ source: null, account: "acct-sbi" });
  });

  test("a figure the contract does not name is refused", async () => {
    const answer = await body();
    const index = (status: HoldingChangeStatus, reason?: HoldingChangeReason): number =>
      answer.holdings.findIndex(
        (holding) =>
          holding.status === status && (reason === undefined || holding.reasons.includes(reason)),
      );
    const compared = index("compared");
    const startOnly = index("listed_at_start_only");
    const endOnly = index("listed_at_end_only");
    const unreadable = index("not_comparable", "quantity_not_exact_at_end");
    const missing = index("not_comparable", "no_snapshot_at_start");
    const figure = structuredClone(answer.holdings[compared]!.change);
    const mutate = (change: (copy: Record<string, any>) => void): boolean => {
      const copy = structuredClone(answer) as Record<string, any>;
      change(copy);
      return validReportedHoldingsChange(copy);
    };
    expect(mutate(() => {})).toBe(true);
    // No totals, valuations or sums, anywhere.
    expect(mutate((copy) => (copy["total"] = "15"))).toBe(false);
    expect(mutate((copy) => (copy["coverage"]["total"] = "15"))).toBe(false);
    expect(mutate((copy) => (copy["coverage"]["valuation"] = "12000"))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][compared]["valuation"] = "1"))).toBe(false);
    expect(mutate((copy) => (copy["counts"]["total"] = 7))).toBe(false);
    // A figure only where both dates list the holding with exact quantities.
    expect(mutate((copy) => (copy["holdings"][startOnly]["change"] = figure))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][endOnly]["change"] = figure))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][unreadable]["change"] = figure))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][missing]["change"] = figure))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][compared]["change"] = null))).toBe(false);
    // The change is an exact decimal in the holding's own unit.
    expect(
      mutate((copy) => (copy["holdings"][compared]["change"]["unitRef"] = "instrument:other")),
    ).toBe(false);
    expect(
      mutate(
        (copy) =>
          (copy["holdings"][compared]["change"]["value"] = { status: "unparsed", reasonCode: "x" }),
      ),
    ).toBe(false);
    expect(
      mutate(
        (copy) => (copy["holdings"][compared]["change"]["value"]["value"]["coefficient"] = 25),
      ),
    ).toBe(false);
    // Closed statuses, reasons and side states, consistent with each other.
    expect(mutate((copy) => (copy["holdings"][compared]["status"] = "increased"))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][unreadable]["reasons"] = []))).toBe(false);
    expect(mutate((copy) => (copy["holdings"][missing]["reasons"] = ["no_snapshot_at_end"]))).toBe(
      false,
    );
    expect(
      mutate((copy) => (copy["holdings"][unreadable]["reasons"] = ["quantity_unreadable"])),
    ).toBe(false);
    expect(
      mutate(
        (copy) =>
          (copy["holdings"][unreadable]["reasons"] = [
            "quantity_not_exact_at_end",
            "quantity_not_exact_at_start",
          ]),
      ),
    ).toBe(false);
    expect(mutate((copy) => (copy["holdings"][startOnly]["end"] = { state: "no_snapshot" }))).toBe(
      false,
    );
    expect(mutate((copy) => (copy["holdings"][startOnly]["end"]["state"] = "held_zero"))).toBe(
      false,
    );
    expect(mutate((copy) => (copy["holdings"][compared]["start"]["quantity"] = figure))).toBe(true);
    expect(
      mutate((copy) => (copy["holdings"][compared]["start"]["quantity"]["unitRef"] = "JPY")),
    ).toBe(false);
    // Counts follow the holdings; the manifest and the coverage are kept.
    expect(mutate((copy) => (copy["counts"]["compared"] = 2))).toBe(false);
    expect(mutate((copy) => copy["holdings"].pop())).toBe(false);
    expect(mutate((copy) => delete copy["coverage"])).toBe(false);
    expect(mutate((copy) => (copy["manifest"]["to"] = "2026-09-11"))).toBe(false);
    // The manifest describes the body it came with, holding by holding.
    expect(mutate((copy) => (copy["manifest"]["filters"]["account"] = "acct-sbi"))).toBe(false);
    expect(
      mutate((copy) => (copy["manifest"]["holdings"][compared]["status"] = "not_comparable")),
    ).toBe(false);
    expect(mutate((copy) => (copy["manifest"]["holdings"][startOnly]["end"] = "listed"))).toBe(
      false,
    );
    // (A fresh key object: the query's manifest shares the holding's key until serialized.)
    expect(
      mutate(
        (copy) =>
          (copy["manifest"]["holdings"][compared]["key"] = {
            ...copy["manifest"]["holdings"][compared]["key"],
            securityCode: "9999",
          }),
      ),
    ).toBe(false);
    expect(mutate((copy) => (copy["manifest"]["holdings"][unreadable]["reasons"] = []))).toBe(
      false,
    );
    expect(mutate((copy) => copy["manifest"]["holdings"].reverse())).toBe(false);
    expect(mutate((copy) => (copy["from"] = "2026-09-10"))).toBe(false);
    expect(mutate((copy) => (copy["contextId"] = "not-a-digest"))).toBe(false);
  });
});
