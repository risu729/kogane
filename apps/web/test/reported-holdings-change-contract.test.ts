// The wire contract of `GET /api/v2/reported-holdings-change` against answers
// the query itself produces (packages/application/test/holdings-change-world.ts):
// a valid answer passes, and an answer that adds a total or a valuation, puts
// a figure on a holding one date lists only or one that is not comparable,
// drops a reason or invents a status is refused rather than displayed. The
// request side is the route's own shape rule, which the page applies too.
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
import {
  holdingsChangeQueryRefusal,
  holdingsChangeSearch,
  validReportedHoldingsChange,
  validReportedHoldingsChangeSummary,
} from "../../../packages/observation-shared/src/reported-holdings-change-contract.ts";
import { summarizeHoldingsChange } from "../../../packages/domain/src/holdings-change-summary.ts";

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

  test("the page's request is the route's own parameters, under the route's shape rule", () => {
    const search = (request: Parameters<typeof holdingsChangeSearch>[0]) =>
      holdingsChangeSearch(request).toString();
    expect(search({ from: "2026-09-01", to: "2026-09-10" })).toBe("from=2026-09-01&to=2026-09-10");
    expect(
      search({
        from: "2026-09-01",
        to: "2026-09-10",
        source: "sbi-securities",
        account: "acct-sbi",
      }),
    ).toBe("from=2026-09-01&to=2026-09-10&source=sbi-securities&account=acct-sbi");
    const refusal = (query: string) => holdingsChangeQueryRefusal(new URLSearchParams(query));
    expect(refusal("from=2026-09-01&to=2026-09-10&source=sbi-securities&account=acct-sbi")).toBe(
      null,
    );
    expect(refusal("from=2026-09-01&to=2026-09-10&source=SBI")).toBe("invalid_query");
    expect(refusal("from=2026-09-01&to=2026-09-10&account=acct%20sbi")).toBe("invalid_query");
    expect(refusal("from=2026-09-01&to=2026-09-10&source=")).toBe("invalid_query");
    expect(refusal("from=2026-09-01&to=2026-09-10&changeSource=sbi-securities")).toBe(
      "invalid_query",
    );
    expect(refusal("from=2026-02-30&to=2026-09-10")).toBe("invalid_date");
  });
});

// The summary (`detail=summary`, ADR 0075 amendment 2026-11-19) of the same
// answers: changed lines only, and every shape that would read a missing or
// inexact value as unchanged, add a figure or hide a line is refused.
async function summaryBody() {
  const page = await summarizeHoldingsChange(await body(), { limit: 10, cursor: null });
  if (!page.ok) throw new Error(page.code);
  return { apiVersion: 2 as const, ...page.summary };
}

describe("reported holdings change summary contract", () => {
  test("the summary of the query's answers is valid, and each detail refuses the other's shape", async () => {
    const summary = await summaryBody();
    expect(validApiResponse(PATH, summary)).toBe(true);
    expect(validReportedHoldingsChangeSummary(summary)).toBe(true);
    // The page asks for `full` and accepts nothing else.
    expect(validReportedHoldingsChange(summary)).toBe(false);
    expect(validReportedHoldingsChangeSummary(await body())).toBe(false);
    // 1005 (4 → 4) is the one unchanged holding; every other one is listed.
    expect(summary.unchanged).toBe(1);
    expect(summary.items.map((item) => [item.securityCode, item.status])).toEqual([
      ["1001", "compared"],
      ["1006", "compared"],
      ["1002", "listed_at_start_only"],
      ["1003", "listed_at_end_only"],
      ["1004", "not_comparable"],
      ["VTX", "not_comparable"],
    ]);
    const store = holdingsChangeWorld();
    for (const [from, to] of [
      ["2026-08-30", "2026-09-01"],
      ["2026-09-02", "2026-09-05"],
      ["2026-09-06", "2026-09-12"],
    ] as const) {
      const page = await summarizeHoldingsChange(await holdingsChangeBody(store, { from, to }), {
        limit: 10,
        cursor: null,
      });
      expect(page.ok && validApiResponse(PATH, { apiVersion: 2, ...page.summary })).toBe(true);
    }
  });

  test("a figure, an unchanged line or a hidden reason is refused", async () => {
    const summary = await summaryBody();
    const at = (code: string) => summary.items.findIndex((item) => item.securityCode === code);
    const mutate = (change: (copy: Record<string, any>) => void): boolean => {
      const copy = structuredClone(summary) as Record<string, any>;
      change(copy);
      return validReportedHoldingsChangeSummary(copy);
    };
    expect(mutate(() => {})).toBe(true);
    // No totals or valuations.
    expect(mutate((copy) => (copy["total"] = "15"))).toBe(false);
    expect(mutate((copy) => (copy["coverage"]["total"] = "15"))).toBe(false);
    expect(mutate((copy) => (copy["items"][at("1001")]["valuation"] = "1"))).toBe(false);
    // An exact zero change is counted, never listed.
    expect(mutate((copy) => (copy["items"][at("1001")]["change"] = "0"))).toBe(false);
    // The change is the canonical exact decimal, only on `compared`.
    for (const text of ["2.50", "-0", "1e3", "+2.5", 2.5, null])
      expect(mutate((copy) => (copy["items"][at("1001")]["change"] = text))).toBe(false);
    expect(mutate((copy) => (copy["items"][at("1002")]["change"] = "-5"))).toBe(false);
    expect(mutate((copy) => (copy["items"][at("1004")]["change"] = "1"))).toBe(false);
    // A quantity that is not exact is its status, never a number, and its reason.
    const unreadable = at("1004");
    expect(summary.items[unreadable]!.end).toMatchObject({
      quantity: null,
      quantityStatus: "unparsed",
    });
    expect(mutate((copy) => (copy["items"][unreadable]["end"]["quantity"] = "0"))).toBe(false);
    expect(mutate((copy) => (copy["items"][unreadable]["end"]["quantityStatus"] = "exact"))).toBe(
      false,
    );
    expect(mutate((copy) => (copy["items"][at("1001")]["start"]["quantity"] = null))).toBe(false);
    expect(mutate((copy) => (copy["items"][unreadable]["reasons"] = []))).toBe(false);
    expect(
      mutate(
        (copy) =>
          (copy["items"][at("1001")]["end"] = {
            ...copy["items"][at("1001")]["end"],
            quantity: null,
            quantityStatus: "missing",
          }),
      ),
    ).toBe(false);
    // A side's own reason, closed codes and states.
    expect(mutate((copy) => (copy["items"][at("VTX")]["reasons"] = ["no_snapshot_at_end"]))).toBe(
      false,
    );
    expect(mutate((copy) => (copy["items"][at("1002")]["end"] = { state: "no_snapshot" }))).toBe(
      false,
    );
    expect(mutate((copy) => (copy["items"][at("1001")]["status"] = "increased"))).toBe(false);
    expect(mutate((copy) => (copy["items"][at("1002")]["end"]["state"] = "held_zero"))).toBe(false);
    // Counts: what is not listed is unchanged, and each reason counts its holdings.
    expect(mutate((copy) => (copy["unchanged"] = 0))).toBe(false);
    expect(mutate((copy) => (copy["unchanged"] = 9))).toBe(false);
    expect(mutate((copy) => (copy["reasonCounts"] = {}))).toBe(false);
    expect(mutate((copy) => (copy["reasonCounts"]["quantity_unreadable"] = 1))).toBe(false);
    expect(mutate((copy) => (copy["reasonCounts"]["quantity_not_exact_at_end"] = 3))).toBe(false);
    expect(mutate((copy) => (copy["counts"]["listed_at_end_only"] = 0))).toBe(false);
    // Every line it can, in status order; the page says whether more follow.
    expect(mutate((copy) => copy["items"].pop())).toBe(false);
    expect(mutate((copy) => copy["items"].reverse())).toBe(false);
    expect(mutate((copy) => (copy["page"]["hasMore"] = true))).toBe(false);
    expect(mutate((copy) => (copy["page"]["nextCursor"] = "abc"))).toBe(false);
    expect(mutate((copy) => (copy["page"]["limit"] = 20))).toBe(false);
    expect(mutate((copy) => (copy["page"]["listed"] = 7))).toBe(false);
    // Container refs: each defined once, each used, in order of first use.
    expect(mutate((copy) => (copy["items"][0]["container"] = "c9"))).toBe(false);
    expect(mutate((copy) => (copy["containers"]["c9"] = copy["containers"]["c1"]))).toBe(false);
    expect(
      mutate((copy) => {
        copy["containers"] = { c2: copy["containers"]["c1"], c1: copy["containers"]["c2"] };
      }),
    ).toBe(false);
    expect(mutate((copy) => (copy["containers"]["c2"] = { ...copy["containers"]["c1"] }))).toBe(
      false,
    );
    expect(mutate((copy) => (copy["detail"] = "full"))).toBe(false);
    expect(mutate((copy) => (copy["contextId"] = "not-a-digest"))).toBe(false);
  });

  test("the detail, the page size and the cursor are the route's own parameters", () => {
    expect(
      holdingsChangeSearch({ from: "2026-09-01", to: "2026-09-10", detail: "full" }).toString(),
    ).toBe("from=2026-09-01&to=2026-09-10&detail=full");
    const refusal = (query: string) => holdingsChangeQueryRefusal(new URLSearchParams(query));
    const range = "from=2026-09-01&to=2026-09-10";
    for (const accepted of [
      `${range}&detail=summary`,
      `${range}&detail=full`,
      `${range}&limit=25`,
      `${range}&detail=summary&limit=100&cursor=eyJ2IjoiIn0`,
    ])
      expect(refusal(accepted), accepted).toBe(null);
    for (const refused of [
      `${range}&detail=compact`,
      `${range}&detail=`,
      `${range}&limit=20`,
      `${range}&limit=10.0`,
      `${range}&cursor=a%2Bb`,
      `${range}&cursor=${"a".repeat(513)}`,
      `${range}&detail=full&limit=10`,
      `${range}&detail=full&cursor=abc`,
    ])
      expect(refusal(refused), refused).toBe("invalid_query");
  });
});
