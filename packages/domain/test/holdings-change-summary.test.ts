// The summary of a reported holdings change (src/holdings-change-summary.ts;
// ADR 0075, amendment 2026-11-19): changed lines only, unchanged ones counted,
// a line whose change cannot be determined never dropped, nothing added, and
// pages bound to the comparison. Every source, account, code, quantity and
// time here is invented; the long key shapes mirror the observed shapes
// (parser and dataset names, a provider account with a deposit type, an
// exchange code), never their values.
import { describe, expect, test } from "bun:test";
import { validReportedHoldingsChangeSummary } from "../../observation-shared/src/reported-holdings-change-contract.ts";
import {
  compareReportedHoldings,
  type HoldingsChange,
  type HoldingsChangeObservation,
  type HoldingsChangeSide,
  type HoldingsChangeSnapshot,
} from "../src/holdings-change.ts";
import {
  HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT,
  HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES,
  holdingsChangeSummaryLines,
  summarizeHoldingsChange,
  type HoldingSummaryLine,
  type HoldingsChangeSummary,
} from "../src/holdings-change-summary.ts";
import { decodeKeysetCursor, encodeKeysetCursor } from "../src/paging.ts";
import { absentQuantity } from "../src/values.ts";
import { q } from "./helpers.ts";

const SOURCE = "synthetic-broker";
const DOMESTIC = {
  sourceId: SOURCE,
  parserName: "synthetic-domestic-positions",
  dataset: "domestic-positions",
};
const FOREIGN = {
  sourceId: SOURCE,
  parserName: "synthetic-foreign-positions",
  dataset: "foreign-positions",
};
type Container = typeof DOMESTIC;

const unit = (code: string, market: string | null) =>
  `instrument:${SOURCE}:${market ?? "-"}:${code}`;

function snapshot(ref: string, capturedAt: string, container: Container): HoldingsChangeSnapshot {
  return {
    ...container,
    ref,
    unitKey: null,
    capturedAt,
    captureDate: capturedAt.slice(0, 10),
    ageDays: 0,
    freshness: "same-day",
  };
}

interface Held {
  code: string;
  /** Decimal text, or the stored status of a quantity that is not exact. */
  quantity: string | "missing" | "unparsed" | "conflict";
  account?: string;
  market?: string | null;
}

let positions = 0;
function holding(snapshotRef: string, held: Held): HoldingsChangeObservation {
  const market = held.market === undefined ? null : held.market;
  const absent =
    held.quantity === "missing" || held.quantity === "unparsed" || held.quantity === "conflict";
  return {
    positionRef: `position:${++positions}`,
    snapshotRef,
    sourceAccount: held.account ?? "broker-a",
    accountId: "acct-broker",
    accountIdentity: "identified",
    market,
    securityCode: held.code,
    instrument: { instrumentId: `inst-${held.code}`, status: "identified" },
    quantityText: absent ? "unreadable" : held.quantity,
    quantity: absent
      ? absentQuantity(
          unit(held.code, market),
          held.quantity as "missing",
          `stored:${held.quantity}`,
        )
      : q(unit(held.code, market), held.quantity),
  };
}

function side(
  date: string,
  captures: { ref: string; at: string; container?: Container; held: Held[] }[],
  containersWithoutSnapshot: Container[] = [],
): HoldingsChangeSide {
  return {
    date,
    reportedContextId: `ctx-${date}-${captures.map((capture) => capture.ref).join("+")}`,
    snapshots: captures.map((capture) =>
      snapshot(capture.ref, capture.at, capture.container ?? DOMESTIC),
    ),
    holdings: captures.flatMap((capture) => capture.held.map((held) => holding(capture.ref, held))),
    containersWithoutSnapshot,
  };
}

async function compare(
  start: HoldingsChangeSide,
  end: HoldingsChangeSide,
  filters: { source: string | null; account: string | null } = { source: null, account: null },
): Promise<HoldingsChange> {
  return compareReportedHoldings({ start, end, filters, quantityPolicy: "decimal-v1" });
}

async function summary(
  change: HoldingsChange,
  limit: number = HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT,
  cursor: string | null = null,
): Promise<HoldingsChangeSummary> {
  const page = await summarizeHoldingsChange(change, { limit, cursor });
  if (!page.ok) throw new Error(page.code);
  expect(validReportedHoldingsChangeSummary({ apiVersion: 2, ...page.summary })).toBe(true);
  return page.summary;
}

const codes = (items: HoldingSummaryLine[]) => items.map((item) => item.securityCode);

/** Every kind of line: changed, unchanged, added, removed and not comparable. */
async function mixedChange(): Promise<HoldingsChange> {
  return compare(
    side("2026-09-01", [
      {
        ref: "artifact:1",
        at: "2026-09-01T01:00:00.000Z",
        held: [
          { code: "1001", quantity: "10" },
          { code: "1002", quantity: "3" },
          { code: "1003", quantity: "5" },
          { code: "1004", quantity: "7" },
          { code: "1005", quantity: "unparsed" },
          { code: "1006", quantity: "2" },
          { code: "1008", quantity: "4.50" },
        ],
      },
    ]),
    side(
      "2026-09-10",
      [
        {
          ref: "artifact:2",
          at: "2026-09-10T01:00:00.000Z",
          held: [
            { code: "1001", quantity: "12.25" },
            { code: "1002", quantity: "3.000" },
            { code: "1004", quantity: "missing" },
            { code: "1005", quantity: "6" },
            { code: "1006", quantity: "conflict" },
            { code: "1007", quantity: "0.5" },
            { code: "1008", quantity: "4.5" },
          ],
        },
      ],
      [FOREIGN],
    ),
  );
}

describe("summarizeHoldingsChange", () => {
  test("lists changed, removed, added and not comparable lines, and counts unchanged ones", async () => {
    const change = await mixedChange();
    const page = await summary(change);
    // 1002 (3 → 3.000) and 1008 (4.50 → 4.5) are exact zero changes: counted, not listed.
    expect(page.unchanged).toBe(2);
    expect(codes(page.items)).toEqual(["1001", "1003", "1007", "1004", "1005", "1006"]);
    expect(page.items.map((item) => item.status)).toEqual([
      "compared",
      "listed_at_start_only",
      "listed_at_end_only",
      "not_comparable",
      "not_comparable",
      "not_comparable",
    ]);
    expect(page.counts).toEqual(change.counts);
    expect(page.counts).toEqual({
      compared: 3,
      listed_at_start_only: 1,
      listed_at_end_only: 1,
      not_comparable: 3,
    });
    expect(page.page).toEqual({
      offset: 0,
      limit: HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT,
      listed: 6,
      hasMore: false,
      nextCursor: null,
    });
    const [grown, removed, added] = page.items;
    expect(grown).toMatchObject({
      container: "c1",
      unitRef: unit("1001", null),
      change: "2.25",
      reasons: [],
      start: { state: "listed", quantity: "10", quantityStatus: "exact" },
      end: { state: "listed", quantity: "12.25", quantityStatus: "exact" },
    });
    // A removed holding: the capture that no longer lists it is its evidence.
    expect(removed).toMatchObject({
      change: null,
      start: { state: "listed", quantity: "5" },
      end: { state: "not_listed", snapshotRef: "artifact:2" },
    });
    expect(added).toMatchObject({
      change: null,
      start: { state: "not_listed", snapshotRef: "artifact:1" },
      end: { state: "listed", quantity: "0.5" },
    });
    expect(page.containers).toEqual({ c1: DOMESTIC });
    // The coverage of the full answer, with no total and no valuation.
    expect(page.coverage).toEqual(change.coverage);
    expect(page.coverage.total).toBe("not-computed");
    expect(page.contextId).toBe(change.contextId);
  });

  test("a missing, non-exact or conflicting quantity on either side is listed under its reason, never unchanged", async () => {
    const page = await summary(await mixedChange());
    const byCode = new Map(page.items.map((item) => [item.securityCode, item]));
    expect(byCode.get("1004")).toMatchObject({
      status: "not_comparable",
      reasons: ["quantity_not_exact_at_end"],
      change: null,
      start: { state: "listed", quantity: "7", quantityStatus: "exact" },
      end: { state: "listed", quantity: null, quantityStatus: "missing" },
    });
    expect(byCode.get("1005")).toMatchObject({
      reasons: ["quantity_not_exact_at_start"],
      start: { quantity: null, quantityStatus: "unparsed" },
      end: { quantity: "6", quantityStatus: "exact" },
    });
    expect(byCode.get("1006")).toMatchObject({
      reasons: ["quantity_not_exact_at_end"],
      end: { quantity: null, quantityStatus: "conflict" },
    });
    expect(page.reasonCounts).toEqual({
      quantity_not_exact_at_start: 1,
      quantity_not_exact_at_end: 2,
    });
  });

  test("a date without a capture, or the same capture on both dates, is listed with its reason", async () => {
    const change = await compare(
      side("2026-09-01", [
        {
          ref: "artifact:1",
          at: "2026-09-01T01:00:00.000Z",
          held: [{ code: "1001", quantity: "10" }],
        },
      ]),
      side("2026-09-10", [
        {
          ref: "artifact:1",
          at: "2026-09-01T01:00:00.000Z",
          held: [{ code: "1001", quantity: "10" }],
        },
        {
          ref: "artifact:3",
          at: "2026-09-09T01:00:00.000Z",
          container: FOREIGN,
          held: [{ code: "VTX", quantity: "2", market: "SYNX" }],
        },
      ]),
    );
    // Equal quantities, but no capture between the dates: not "unchanged".
    const page = await summary(change);
    expect(page.unchanged).toBe(0);
    expect(page.items.map((item) => [item.securityCode, item.status, item.reasons])).toEqual([
      ["1001", "not_comparable", ["same_capture_both_dates"]],
      ["VTX", "not_comparable", ["no_snapshot_at_start"]],
    ]);
    expect(page.items[1]!.start).toEqual({ state: "no_snapshot" });
    expect(page.containers).toEqual({ c1: DOMESTIC, c2: FOREIGN });
    expect(page.items.map((item) => item.container)).toEqual(["c1", "c2"]);
  });

  test("holdings in different units are listed apart and never added", async () => {
    const change = await compare(
      side("2026-09-01", [
        {
          ref: "artifact:1",
          at: "2026-09-01T01:00:00.000Z",
          held: [
            { code: "1001", quantity: "10", market: "SYNA" },
            { code: "1001", quantity: "4", market: "SYNB" },
            { code: "1001", quantity: "1", account: "broker-b", market: "SYNA" },
          ],
        },
      ]),
      side("2026-09-10", [
        {
          ref: "artifact:2",
          at: "2026-09-10T01:00:00.000Z",
          held: [
            { code: "1001", quantity: "11", market: "SYNA" },
            { code: "1001", quantity: "6", market: "SYNB" },
            { code: "1001", quantity: "3", account: "broker-b", market: "SYNA" },
          ],
        },
      ]),
    );
    const page = await summary(change);
    expect(page.items.map((item) => [item.sourceAccount, item.unitRef, item.change])).toEqual([
      ["broker-a", unit("1001", "SYNA"), "1"],
      ["broker-a", unit("1001", "SYNB"), "2"],
      // The same unit in another provider account is its own line too.
      ["broker-b", unit("1001", "SYNA"), "2"],
    ]);
    expect(page.coverage.total).toBe("not-computed");
    expect(page.coverage.valuation).toBe("not-computed");
    expect(Object.keys(page)).not.toContain("total");
  });

  test("a comparison without a change lists nothing and counts everything", async () => {
    const held = [
      { code: "1001", quantity: "10" },
      { code: "1002", quantity: "0.125" },
    ];
    const page = await summary(
      await compare(
        side("2026-09-01", [{ ref: "artifact:1", at: "2026-09-01T01:00:00.000Z", held }]),
        side("2026-09-10", [{ ref: "artifact:2", at: "2026-09-10T01:00:00.000Z", held }]),
      ),
    );
    expect(page.items).toEqual([]);
    expect(page.containers).toEqual({});
    expect(page.unchanged).toBe(2);
    expect(page.reasonCounts).toEqual({});
    expect(page.page).toMatchObject({ listed: 0, hasMore: false, nextCursor: null });
  });

  test("the account filter is the comparison's: the summary lists only its kept holdings", async () => {
    const change = await compare(
      side("2026-09-01", [
        {
          ref: "artifact:1",
          at: "2026-09-01T01:00:00.000Z",
          held: [{ code: "1001", quantity: "10" }],
        },
      ]),
      side("2026-09-10", [
        {
          ref: "artifact:2",
          at: "2026-09-10T01:00:00.000Z",
          held: [{ code: "1001", quantity: "12" }],
        },
      ]),
      { source: null, account: "acct-other" },
    );
    const page = await summary(change);
    expect(page.filters).toEqual({ source: null, account: "acct-other" });
    expect(page.items).toEqual([]);
    expect(page.unchanged).toBe(0);
  });
});

/** `count` holdings, each changing, in two captures of one container. */
async function manyChanges(count: number, endQuantity = (index: number) => `${index + 1}`) {
  const keys = Array.from({ length: count }, (_, index) => String(1000 + index));
  return compare(
    side("2026-09-01", [
      {
        ref: "artifact:1",
        at: "2026-09-01T01:00:00.000Z",
        held: keys.map((code) => ({ code, quantity: "0.5" })),
      },
    ]),
    side("2026-09-10", [
      {
        ref: "artifact:2",
        at: "2026-09-10T01:00:00.000Z",
        held: keys.map((code, index) => ({ code, quantity: endQuantity(index) })),
      },
    ]),
  );
}

describe("summary pages", () => {
  test("pages join into every listed line once, in order, at any offered size", async () => {
    const change = await manyChanges(65);
    const all = holdingsChangeSummaryLines(change).map((holding) => holding.key.securityCode);
    expect(all).toHaveLength(65);
    const walked: string[] = [];
    let cursor: string | null = null;
    // A walk that changes its page size between pages.
    for (const limit of [25, 10, 50, 100]) {
      const page = await summary(change, limit, cursor);
      expect(page.page.offset).toBe(walked.length);
      walked.push(...codes(page.items));
      cursor = page.page.nextCursor;
      if (cursor === null) break;
    }
    expect(walked).toEqual(all);
  });

  test("a cursor is refused when it does not decode, belongs to other dates or filters, or the comparison moved", async () => {
    const change = await manyChanges(25);
    const first = await summary(change);
    const cursor = first.page.nextCursor!;
    expect(cursor).not.toBeNull();
    const refusal = async (target: HoldingsChange, text: string) => {
      const page = await summarizeHoldingsChange(target, { limit: 25, cursor: text });
      return page.ok ? "ok" : page.code;
    };
    expect(await refusal(change, cursor)).toBe("ok");
    expect(await refusal(change, "not-a-cursor")).toBe("invalid_cursor");
    // Other filters over the same holdings: another request.
    const filtered = { ...change, filters: { source: SOURCE, account: null } };
    expect(await refusal(filtered, cursor)).toBe("cursor_mismatch");
    const later = { ...change, to: "2026-09-11" };
    expect(await refusal(later, cursor)).toBe("cursor_mismatch");
    // The same request over a comparison whose inputs moved.
    const moved = await manyChanges(25, (index) => `${index + 2}`);
    expect(moved.contextId).not.toBe(change.contextId);
    expect(await refusal(moved, cursor)).toBe("context_expired");
    // A forged position past the lines, or at the start, is not a cursor this server wrote.
    const decoded = decodeKeysetCursor(cursor)!;
    for (const t of [0, 25, 26])
      expect(
        await refusal(change, encodeKeysetCursor({ s: decoded.s, f: decoded.f, k: "", t })),
      ).toBe("invalid_cursor");
    expect(
      await refusal(change, encodeKeysetCursor({ s: decoded.s, f: decoded.f, k: "x", t: 20 })),
    ).toBe("invalid_cursor");
    expect(
      await refusal(
        change,
        encodeKeysetCursor({ s: decoded.s, f: decoded.f, k: "", t: 20, r: "read-instance" }),
      ),
    ).toBe("invalid_cursor");
  });

  test("only the offered page sizes are taken", async () => {
    const change = await manyChanges(3);
    expect(HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES).toContain(HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT);
    for (const limit of [0, 7, 20, 1000])
      await expect(summarizeHoldingsChange(change, { limit, cursor: null })).rejects.toThrow(
        "invalid_limit",
      );
  });
});

// ── answer size ──────────────────────────────────────────────────────────
//
// An MCP client shows the first 8 KB of a tool result: the result's text is
// `{ schemaVersion: "kogane-page-read-v1", data: <the route's body> }`.

const MCP_SHOWN = 8192;
const bytes = (data: unknown) =>
  new TextEncoder().encode(JSON.stringify({ schemaVersion: "kogane-page-read-v1", data }))
    .byteLength;

/**
 * The longest line shapes seen so far, at the side bound: a provider account
 * with a deposit type, a market code, a 12-character code, seven-digit
 * position ids, eight fraction digits on both sides, and every listed status.
 */
async function worstCase(count: number): Promise<HoldingsChange> {
  const account = "synthetic-broker:domestic:deposit-type=99";
  const keys = Array.from(
    { length: count },
    (_, index) => `SYNTH${String(index).padStart(7, "0")}`,
  );
  positions = 9_000_000;
  const container = {
    sourceId: "synthetic-securities",
    parserName: "synthetic-domestic-cash-positions",
    dataset: "domestic-cash-positions",
  };
  const start: Held[] = [];
  const end: Held[] = [];
  keys.forEach((code, index) => {
    const kind = index % 4;
    const market = "SYNX";
    // Changed both ways, removed, added, and not comparable with a reason.
    if (kind !== 2) start.push({ code, account, market, quantity: "123456.12345678" });
    if (kind !== 1)
      end.push({
        code,
        account,
        market,
        quantity: kind === 3 ? "unparsed" : index % 8 === 0 ? "0.00000001" : "234567.87654321",
      });
  });
  return compare(
    side("2026-09-01", [
      { ref: "artifact:9000001", at: "2026-09-01T01:00:00.000Z", container, held: start },
    ]),
    side(
      "2026-09-10",
      [{ ref: "artifact:9000002", at: "2026-09-10T01:00:00.000Z", container, held: end }],
      [DOMESTIC, FOREIGN],
    ),
  );
}

describe("summary size", () => {
  test("every default page is under 8 KB at the side bound with the longest line shape", async () => {
    const change = await worstCase(500);
    const full = bytes({ apiVersion: 2, ...change });
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await summary(change, HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT, cursor);
      sizes.push(bytes({ apiVersion: 2, ...page }));
      cursor = page.page.nextCursor;
    } while (cursor !== null);
    console.info(
      `holdings change, 500 holdings at the longest shape: full ${full} B; summary ${sizes.length} pages of ${HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT}, ${Math.min(...sizes)}–${Math.max(...sizes)} B`,
    );
    expect(sizes).toHaveLength(Math.ceil(500 / HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT));
    expect(Math.max(...sizes)).toBeLessThan(MCP_SHOWN);
    expect(full).toBeGreaterThan(40 * MCP_SHOWN);
    // A page of 25 such lines is past what a client shows: the caller asked for it.
    const wide = await summary(change, 25);
    console.info(`the first page of 25 such lines: ${bytes({ apiVersion: 2, ...wide })} B`);
    expect(bytes({ apiVersion: 2, ...wide })).toBeGreaterThan(MCP_SHOWN);
  });

  test("sixty-five changed holdings: a default page is under 8 KB, the full answer is not", async () => {
    const change = await worstCase(65);
    const page = await summary(change);
    const full = bytes({ apiVersion: 2, ...change });
    console.info(
      `holdings change, 65 holdings at the longest shape: full ${full} B; first summary page ${bytes({ apiVersion: 2, ...page })} B`,
    );
    expect(bytes({ apiVersion: 2, ...page })).toBeLessThan(MCP_SHOWN);
    expect(full).toBeGreaterThan(5 * MCP_SHOWN);
  });
});
