// The heading a closed MyJCB statement page names its payment in, read by the
// collector (`statedPaymentMonths` in services/collector-myjcb/src/parsers.ts)
// and by `myjcb-credit-statement-total` (packages/parsers/src/parsers/myjcb.ts),
// so the month the collector records and the month the statement total
// carries are one reading (ADR 0005 amendment g).
import { parseLocalDate } from "./time.ts";

/**
 * The two observed forms of the `h2`, compared after all whitespace is
 * removed and never searched for as a substring:
 *
 * - 「YYYY年M月お支払い分のカードご利用明細」 (stored pages up to 2026-09);
 * - 「YYYY年M月D日(曜)お支払い分のカードご利用明細」, the weekday one of
 *   月火水木金土日 in ASCII parentheses, as the page's own
 *   「YYYY年M月D日(曜)お支払い金額合計」 writes it (round-5 survey, 2026-09-28).
 *
 * The text is not NFKC-normalized: full-width parentheses or digits are not
 * an observed form and do not match.
 */
const STATEMENT_HEADING =
  /^(\d{4})年(\d{1,2})月(?:(\d{1,2})日\([月火水木金土日]\))?お支払い分のカードご利用明細$/u;

export interface MyJcbStatementHeading {
  /** The payment month, `YYYY-MM`. */
  readonly month: string;
  /** The payment day, `YYYY-MM-DD`, when the heading carries one. */
  readonly date: string | null;
}

/**
 * The payment month (and day, when stated) a statement heading names, from
 * the heading's text with all whitespace removed; null for any other text,
 * including a month outside 1..12 or a day that is not in that month. The
 * weekday is checked for shape only, not against the date.
 */
export function readMyJcbStatementHeading(compacted: string): MyJcbStatementHeading | null {
  const match = STATEMENT_HEADING.exec(compacted);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const yearMonth = `${match[1]}-${String(month).padStart(2, "0")}`;
  if (match[3] === undefined) return { month: yearMonth, date: null };
  const date = `${yearMonth}-${match[3].padStart(2, "0")}`;
  return parseLocalDate(date) === null ? null : { month: yearMonth, date };
}
