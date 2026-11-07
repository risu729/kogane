// What kind of MyJCB menu schedule page a page is, from its h1 only, read once
// for its two readers: the collector (`services/collector-myjcb/src/collector.ts`),
// which stores a schedule page as one wherever it was shown, and
// `myjcb-credit-statement-total` (`packages/parsers/src/parsers/myjcb.ts`),
// which never reads a schedule page as a statement (ADR 0005 amendment j).
//
// Two h1 forms were observed on the live site (round 9, 2026-10-04, shapes and
// fixed labels only): the ショッピングスキップ払い page at menu position 8,
// 「ショッピングスキップ払いご利用明細(未確定分)」 (amendment e, read by
// `myjcbSchedulePageKind`, unchanged), and the ボーナス払い page at menu
// position 7, 「ボーナス#回払いご利用代金明細(未確定分)」, where # is a digit.
// Nothing else on the page is read for the kind. The ボーナス払い page is
// recognised, never read: no parser reads its rows (ADR 0004).
//
// This module is separate from `myjcb-skip-payment-schedule.ts` so that the
// skip-payment parser's digest, which covers that module, does not move.
import { myjcbSchedulePageKind, type SchedulePageNode } from "./myjcb-skip-payment-schedule.ts";

/**
 * The h1 of the ボーナス払い schedule page, compared after whitespace removal,
 * never searched for as a substring. The `#` in the observed
 * 「ボーナス#回払い」 is a digit, so any run of ASCII or full-width digits is
 * accepted there; every other character, the ASCII parentheses included, must
 * match exactly.
 */
export const BONUS_SCHEDULE_HEADING = /^ボーナス[0-9０-９]+回払いご利用代金明細\(未確定分\)$/u;

/**
 * - `skip-payment`: exactly one h1 is the observed ショッピングスキップ払い
 *   heading (`myjcbSchedulePageKind`, amendment e). This decision is checked
 *   first, as before amendment (j);
 * - `bonus`: otherwise, exactly one h1 is the observed ボーナス払い heading;
 * - `unobserved`: anything else, a statement page included.
 */
export type MyJcbSchedulePageKind = "skip-payment" | "bonus" | "unobserved";

/** The kind of a menu schedule page, from its h1 only. */
export function myjcbSchedulePageHeadingKind(document: SchedulePageNode): MyJcbSchedulePageKind {
  if (myjcbSchedulePageKind(document) === "skip-payment") return "skip-payment";
  return elements(
    document,
    (element) => element.tagName === "h1" && BONUS_SCHEDULE_HEADING.test(compact(text(element))),
  ).length === 1
    ? "bonus"
    : "unobserved";
}

function elements(
  node: SchedulePageNode,
  predicate: (element: SchedulePageNode) => boolean,
): SchedulePageNode[] {
  const result: SchedulePageNode[] = [];
  if (node.tagName !== undefined && predicate(node)) result.push(node);
  for (const child of node.childNodes ?? []) result.push(...elements(child, predicate));
  return result;
}

/** Text with a space between nodes, as the skip-payment reading reads its h1. */
function text(node: SchedulePageNode): string {
  if (node.value !== undefined && node.tagName === undefined) return node.value;
  return (node.childNodes ?? []).map(text).join(" ");
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
