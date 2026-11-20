// The reward expiry read's window and compact summary (ADR 0049, amendment of
// 2026-11-19): which rows, buckets and provider displays fall inside a date
// window, and one answer per programme with its exact total.
//
// Pure: the App's route and `kogane.rewards.read` call the same functions over
// the rows the route reads from one published reward snapshot (ADR 0081).
//
// What it keeps apart:
//   * a bucket is one bucket, not one row per rule. The READ projection
//     writes a row for every rule of the bucket's programme, each with the
//     list deadline under that rule, so a total over rows would count a bucket
//     once per rule (INV06). Rows are grouped by programme, holding and
//     bucket, and a bucket whose rows carry different deadlines is left out
//     with a reason rather than given one of them;
//   * a provider-displayed portion (ADR 0068) is a part of a displayed total,
//     never a bucket: it is listed, never added to a total or to another
//     portion;
//   * an amount that is not exact makes its programme's total not exact, with
//     the statuses that prevented it, never a partial sum or a zero (INV05);
//     amounts are added with `sumQuantities` per programme and unit, so no two
//     units are ever added (INV03);
//   * a bucket or display with no date is never in or out of a window: it is
//     counted under a closed reason.
import type { RewardProviderExpirySection } from "../../../domain/src/reward-expiry-observations.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import {
  decimalToString,
  sumQuantities,
  validExactDecimal,
  type Quantity,
} from "../../../domain/src/values.ts";
import type {
  RewardExpiryLeftOutReason,
  RewardExpirySummary,
  RewardExpirySummaryAmount,
  RewardExpirySummaryDisplay,
  RewardExpirySummaryLine,
  RewardExpirySummaryProgram,
  RewardExpirySummaryTotal,
  RewardExpiryWindow,
  RewardExpiryWindowCounts,
} from "../../../observation-shared/src/reward-contract.ts";
import { REWARD_EXPIRY_LEFT_OUT_REASONS } from "../../../observation-shared/src/reward-contract.ts";

/** The answers `detail` selects; absent is `full`, the page as it was. */
export const REWARD_EXPIRY_DETAILS = ["full", "summary"] as const;
export type RewardExpiryDetail = (typeof REWARD_EXPIRY_DETAILS)[number];

/**
 * The most estimate rows a summary or a windowed page reads from one snapshot.
 * The build refuses more than 200 buckets (`claim_set_too_large`) and writes a
 * row per bucket and rule of its programme; the seeded rules give at most two
 * rules a programme, so a snapshot holds at most 400 rows today. A larger
 * snapshot is refused (`413 result_limit_exceeded`), never cut.
 */
export const REWARD_EXPIRY_WINDOW_ROW_BOUND = 1000;

/** Bucket lines a summary lists, earliest first, across programmes. */
export const REWARD_EXPIRY_SUMMARY_BUCKET_LINES = 20;
/** Provider-displayed portions a summary lists, earliest first. */
export const REWARD_EXPIRY_SUMMARY_DISPLAY_LINES = 3;

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Today's civil date in Asia/Tokyo at `now` (epoch milliseconds): the UTC
 * date of `now + 9 h` (Asia/Tokyo has no daylight saving time). The reward
 * goal search's clock uses the same day (ADR 0049, amendment of 2026-11-18).
 */
export function tokyoToday(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export type RewardExpiryWindowRefusal = "invalid_date" | "invalid_date_range";

/**
 * The window a request names, or null when it names neither bound. `from` is
 * inclusive and defaults to today's Asia/Tokyo date; `before` is exclusive and
 * has no default. A value that is not a calendar date is `invalid_date`; a
 * window with no day in it (`from` on or after `before`) is
 * `invalid_date_range`.
 */
export function parseRewardExpiryWindow(
  from: string | null,
  before: string | null,
  now: number,
):
  | { ok: true; window: RewardExpiryWindow | null }
  | { ok: false; refusal: RewardExpiryWindowRefusal } {
  if (from === null && before === null) return { ok: true, window: null };
  for (const value of [from, before])
    if (value !== null && (!DATE.test(value) || parseLocalDate(value) === null))
      return { ok: false, refusal: "invalid_date" };
  const today = tokyoToday(now);
  const start = from ?? today;
  if (before !== null && start >= before) return { ok: false, refusal: "invalid_date_range" };
  return {
    ok: true,
    window: {
      from: start,
      before,
      fromBasis: from === null ? "today" : "request",
      today,
      calendar: "Asia/Tokyo",
    },
  };
}

export type WindowPlace = "before-window" | "in-window" | "after-window";

/** Where a calendar date lies against the window; dates compare as text (YYYY-MM-DD). */
export function windowPlace(date: string, window: RewardExpiryWindow | null): WindowPlace {
  if (window === null) return "in-window";
  if (date < window.from) return "before-window";
  if (window.before !== null && date >= window.before) return "after-window";
  return "in-window";
}

/** One estimate row of the READ snapshot, as the summary needs it. */
export interface RewardExpiryWindowRow {
  rowSeq: number;
  programId: string;
  holdingRef: string;
  bucketRef: string;
  bucketKind: string;
  basis: "provider-observed" | "policy-estimated" | "unknown";
  /** The list deadline under the row's rule (ADR 0049), or null when none is established. */
  expiresOn: string | null;
  quantity: Quantity;
}

function tally() {
  const left = new Map<RewardExpiryLeftOutReason, number>();
  const counts = { inWindow: 0, beforeWindow: 0, afterWindow: 0 };
  return {
    place(place: WindowPlace) {
      if (place === "in-window") counts.inWindow += 1;
      else if (place === "before-window") counts.beforeWindow += 1;
      else counts.afterWindow += 1;
    },
    leave(reason: RewardExpiryLeftOutReason, count = 1) {
      left.set(reason, (left.get(reason) ?? 0) + count);
    },
    done(): RewardExpiryWindowCounts {
      return {
        ...counts,
        // Closed order, and only the reasons that occurred.
        leftOut: REWARD_EXPIRY_LEFT_OUT_REASONS.filter((reason) => left.has(reason)).map(
          (reason) => ({ reasonCode: reason, count: left.get(reason)! }),
        ),
      };
    },
  };
}

/**
 * The rows of a windowed full page and how every row of the read fell: a row
 * with no date (`dateOf` null) is left out as `deadline_unknown`. Rows keep
 * their order. A full page counts rows, one per bucket and rule, as it lists
 * them; the summary counts buckets.
 */
export function rowsInRewardExpiryWindow<T>(
  rows: readonly T[],
  window: RewardExpiryWindow,
  dateOf: (row: T) => string | null,
): { rows: T[]; counts: RewardExpiryWindowCounts } {
  const counts = tally();
  const inside: T[] = [];
  for (const row of rows) {
    const date = dateOf(row);
    if (date === null) {
      counts.leave("deadline_unknown");
      continue;
    }
    const place = windowPlace(date, window);
    counts.place(place);
    if (place === "in-window") inside.push(row);
  }
  return { rows: inside, counts: counts.done() };
}

/**
 * A stored quantity as the summary adds it: an "exact" value that is not a
 * canonical decimal-v1 decimal is not read as a number, but as unparsed
 * (`decimal-v1:invalid`), so no malformed text is summed or shown as exact.
 */
function checked(quantity: Quantity): Quantity {
  return quantity.value.status !== "exact" || validExactDecimal(quantity.value.value)
    ? quantity
    : {
        unitRef: quantity.unitRef,
        value: { status: "unparsed", reasonCode: "decimal-v1:invalid" },
      };
}

function amountOf(quantity: Quantity): RewardExpirySummaryAmount {
  return quantity.value.status === "exact"
    ? { status: "exact", value: decimalToString(quantity.value.value) }
    : { status: quantity.value.status, value: null, reasonCode: quantity.value.reasonCode };
}

function totalOf(unitRef: string, quantities: readonly Quantity[]): RewardExpirySummaryTotal {
  const sum = sumQuantities(unitRef, quantities);
  if (sum.ok && sum.quantity.value.status === "exact")
    return { status: "exact", value: decimalToString(sum.quantity.value.value) };
  // `value_not_exact` names each operand's status and reason; any other
  // refusal (a unit mismatch cannot occur: a group has one unit) is its code.
  const reasons = sum.ok
    ? ["value_not_exact"]
    : sum.error.code === "value_not_exact"
      ? sum.error.refs
      : [sum.error.code];
  return { status: "not-exact", value: null, reasonCodes: [...new Set(reasons)].sort() };
}

interface DatedBucket {
  programId: string;
  unitRef: string;
  line: RewardExpirySummaryLine;
  quantity: Quantity;
}

const byLine = (left: DatedBucket, right: DatedBucket) =>
  left.line.expiresOn < right.line.expiresOn
    ? -1
    : left.line.expiresOn > right.line.expiresOn
      ? 1
      : `${left.programId}\u0000${left.line.holdingRef}\u0000${left.line.bucketRef}` <
          `${right.programId}\u0000${right.line.holdingRef}\u0000${right.line.bucketRef}`
        ? -1
        : 1;

/**
 * The compact answer over one snapshot's rows and provider sections (already
 * narrowed to the request's programme): per programme and unit the buckets
 * inside the window, their exact total and the earliest lines; the provider
 * displays inside it; and how many buckets and displays fell outside or were
 * left out, and why. `snapshot` is passed through.
 */
export function rewardExpirySummary(
  rows: readonly RewardExpiryWindowRow[],
  sections: readonly RewardProviderExpirySection[],
  window: RewardExpiryWindow | null,
  snapshot: RewardExpirySummary["snapshot"],
): RewardExpirySummary {
  // One bucket, its rows in snapshot order.
  const buckets = new Map<string, RewardExpiryWindowRow[]>();
  for (const row of [...rows].sort((left, right) => left.rowSeq - right.rowSeq)) {
    const key = JSON.stringify([row.programId, row.holdingRef, row.bucketRef]);
    const group = buckets.get(key);
    if (group) group.push(row);
    else buckets.set(key, [row]);
  }
  const bucketCounts = tally();
  const dated: DatedBucket[] = [];
  for (const group of buckets.values()) {
    const first = group[0]!;
    const dates = new Set(group.map((row) => row.expiresOn));
    if (dates.size === 1 && first.expiresOn === null) {
      bucketCounts.leave("deadline_unknown");
      continue;
    }
    if (dates.size !== 1) {
      bucketCounts.leave("deadline_differs_by_rule");
      continue;
    }
    // READ refuses a date whose basis is `unknown` (a CHECK), so a dated row
    // always names its basis; one that did not would establish no deadline.
    if (first.basis === "unknown") {
      bucketCounts.leave("deadline_unknown");
      continue;
    }
    const expiresOn = first.expiresOn!;
    const place = windowPlace(expiresOn, window);
    bucketCounts.place(place);
    if (place !== "in-window") continue;
    // Every row of a bucket carries the bucket's own quantity.
    const quantity = checked(first.quantity);
    dated.push({
      programId: first.programId,
      unitRef: quantity.unitRef,
      quantity,
      line: {
        holdingRef: first.holdingRef,
        bucketRef: first.bucketRef,
        kind: first.bucketKind,
        expiresOn,
        basis: first.basis,
        amount: amountOf(quantity),
      },
    });
  }
  dated.sort(byLine);
  const listed = new Set(dated.slice(0, REWARD_EXPIRY_SUMMARY_BUCKET_LINES));
  const groups = new Map<string, DatedBucket[]>();
  for (const bucket of dated) {
    const key = JSON.stringify([bucket.programId, bucket.unitRef]);
    const group = groups.get(key);
    if (group) group.push(bucket);
    else groups.set(key, [bucket]);
  }
  const programs: RewardExpirySummaryProgram[] = [...groups.values()]
    .map((group) => ({
      programId: group[0]!.programId,
      unitRef: group[0]!.unitRef,
      buckets: group.length,
      total: totalOf(
        group[0]!.unitRef,
        group.map((bucket) => bucket.quantity),
      ),
      lines: group.filter((bucket) => listed.has(bucket)).map((bucket) => bucket.line),
    }))
    .sort((left, right) =>
      left.programId !== right.programId
        ? left.programId < right.programId
          ? -1
          : 1
        : left.unitRef < right.unitRef
          ? -1
          : 1,
    );

  const displayCounts = tally();
  const displays: RewardExpirySummaryDisplay[] = [];
  for (const section of sections) {
    if (section.coverage !== "observed") {
      displayCounts.leave(
        section.reasonCode === "provider_expiry_unavailable"
          ? "provider_expiry_unavailable"
          : "provider_expiry_not_displayed",
      );
      continue;
    }
    for (const display of section.displays) {
      // A display's date is a provider `local-date` or `unknown` (validated
      // when the section is read).
      const date = display.expires.kind === "local-date" ? display.expires.value : null;
      if (date === null || !DATE.test(date)) {
        displayCounts.leave("display_date_unknown");
        continue;
      }
      const place = windowPlace(date, window);
      displayCounts.place(place);
      if (place !== "in-window") continue;
      displays.push({
        programId: section.programId,
        holdingRef: section.holdingRef,
        parentBucketRef: section.parentBucketRef,
        displayRef: display.displayRef,
        unitRef: section.unitRef,
        expiresOn: date,
        amount: amountOf(checked(display.quantity)),
      });
    }
  }
  displays.sort((left, right) =>
    left.expiresOn !== right.expiresOn
      ? left.expiresOn < right.expiresOn
        ? -1
        : 1
      : `${left.programId}\u0000${left.parentBucketRef}\u0000${left.displayRef}` <
          `${right.programId}\u0000${right.parentBucketRef}\u0000${right.displayRef}`
        ? -1
        : 1,
  );

  return {
    detail: "summary",
    window,
    programs,
    providerDisplays: displays.slice(0, REWARD_EXPIRY_SUMMARY_DISPLAY_LINES),
    counts: { buckets: bucketCounts.done(), providerDisplays: displayCounts.done() },
    lineLimit: {
      buckets: REWARD_EXPIRY_SUMMARY_BUCKET_LINES,
      providerDisplays: REWARD_EXPIRY_SUMMARY_DISPLAY_LINES,
    },
    snapshot,
  };
}
