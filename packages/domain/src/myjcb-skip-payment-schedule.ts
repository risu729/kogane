// What a MyJCB ショッピングスキップ払い schedule page states, read once for its
// two readers: the collector (`services/collector-myjcb/src/collector.ts`),
// which names the stored page by its kind so that registration gives only
// this kind a parser dataset, and `myjcb-skip-payment-schedule`
// (`packages/parsers/src/parsers/myjcb-skip-payment-schedule.ts`), which reads
// its rows (ADR 0005 amendment e).
//
// Only the shape the round-4 structure survey (2026-09-27, structure and
// counts only) recorded is read: the page's h1, its "as of" heading, and one
// `div.detail-list-01` ledger whose `div.head` has exactly three cells,
// 「ご利用日」 / 「ご利用先など」 and 「お支払日」 on two lines of one cell /
// 「今後のお支払い金額」. The survey did not record the body cells. A row is
// read only when it mirrors that head: one `item-cell` of exactly three
// `cell`s, the middle one exactly two lines. Every other shape is refused with
// a closed code, never guessed (ADR 0004). The ボーナス払い page has never been
// observed with rows and is not read at all.
//
// An empty page (every stored skip-payment page, round-5 survey 2026-09-28)
// shows the same head and exactly one `content` row whose one `item-cell`
// holds one `div.cell.w-100per` with the provider's empty label
// (`EMPTY_LEDGER_LABEL`). That lone row is zero rows; the label next to any
// other row is a mix nobody has observed and is refused (ADR 0005
// amendment f).
//
// The input is a parse5 document; only the structural fields are named here,
// so this module needs no HTML parser of its own.
import { myjcbDisplayInteger } from "./myjcb-amounts.ts";
import { decimalToString, integerDecimal } from "./values.ts";

/** A parse5 node as far as this reading needs it. */
export interface SchedulePageNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly value?: string;
  readonly childNodes?: readonly SchedulePageNode[];
}

/**
 * The h1 of the ショッピングスキップ払い schedule page, as observed at menu
 * position 8. Compared exactly after whitespace removal, never searched for
 * as a substring.
 */
export const SKIP_PAYMENT_SCHEDULE_HEADING = "ショッピングスキップ払いご利用明細(未確定分)";

/**
 * The page's "as of" heading, 「YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細
 * (YYYY年M月以降のお支払い分)」, after whitespace removal.
 */
const AS_OF_HEADING =
  /^(\d{4})年(\d{1,2})月(\d{1,2})日\([月火水木金土日]\)時点のショッピングスキップ払いご利用明細\((\d{4})年(\d{1,2})月以降のお支払い分\)$/u;

/** The observed head cells, whitespace removed. */
const HEAD_CELLS = ["ご利用日", "ご利用先などお支払日", "今後のお支払い金額"] as const;

/** More rows than this on one page is refused, not truncated. */
export const SKIP_PAYMENT_SCHEDULE_ROW_LIMIT = 1_000;

/**
 * Why a schedule page is not read. Closed codes, safe to log; the checks run
 * in this order, so a page always reports the same code:
 *
 * - `schedule_kind_unobserved`: the page has no h1 that is exactly
 *   `SKIP_PAYMENT_SCHEDULE_HEADING`, or more than one (the ボーナス払い page,
 *   or any page not observed);
 * - `schedule_ledger_missing`: no `detail-list-01` ledger;
 * - `schedule_ledger_ambiguous`: more than one ledger has rows;
 * - `schedule_head_unobserved`: the ledger (the one with rows, or, when none
 *   has rows, every ledger) does not have exactly the three observed head
 *   cells; a four-cell head is refused here;
 * - `schedule_row_limit`: more than `SKIP_PAYMENT_SCHEDULE_ROW_LIMIT` rows;
 * - `schedule_as_of_invalid`: rows, and not exactly one readable "as of"
 *   heading; or a heading of that form that does not read as a calendar date
 *   and month, whether or not there are rows;
 * - `schedule_row_shape_unobserved`: a ledger read (the one with rows, or,
 *   when none has rows, every ledger) whose element children are not the one
 *   `head` followed only by `content` rows, so that rows in any other
 *   nesting are refused instead of reading as an empty ledger (INV05); or a
 *   row that is not one `item-cell` of exactly three `cell`s whose middle
 *   cell is exactly two non-empty lines (the empty row beside other rows
 *   included);
 * - `schedule_date_invalid`: a usage date or payment date that is not
 *   `YYYY/MM/DD` on the calendar;
 * - `schedule_amount_invalid`: an amount cell that does not read as an exact
 *   JPY amount (a missing amount included).
 */
export const SKIP_PAYMENT_SCHEDULE_REFUSALS = [
  "schedule_kind_unobserved",
  "schedule_ledger_missing",
  "schedule_ledger_ambiguous",
  "schedule_head_unobserved",
  "schedule_row_limit",
  "schedule_as_of_invalid",
  "schedule_row_shape_unobserved",
  "schedule_date_invalid",
  "schedule_amount_invalid",
] as const;
export type SkipPaymentScheduleRefusal = (typeof SKIP_PAYMENT_SCHEDULE_REFUSALS)[number];

/** One row as the page shows it. Text stays text; the amount is an exact decimal. */
export interface SkipPaymentScheduleRow {
  /** 0-based position among the ledger's `content` rows. */
  readonly index: number;
  /** The three cells, whitespace collapsed, as displayed. */
  readonly cells: readonly [string, string, string];
  /** ご利用日, `YYYY-MM-DD`. */
  readonly usageDate: string;
  /** The first line of the middle cell (ご利用先など). */
  readonly merchantText: string;
  /** The second line of the middle cell (お支払日), `YYYY-MM-DD`. */
  readonly paymentDate: string;
  /** 今後のお支払い金額 as an exact integer decimal string, the sign as displayed. */
  readonly amountText: string;
}

export interface SkipPaymentSchedule {
  /** The "as of" date the page names, `YYYY-MM-DD`; null only for a page with no rows and no heading. */
  readonly asOf: string | null;
  /** The first payment month the page names (「YYYY年M月以降のお支払い分」), `YYYY-MM`. */
  readonly paymentFromMonth: string | null;
  readonly rows: readonly SkipPaymentScheduleRow[];
}

export type SkipPaymentScheduleReading =
  | { readonly ok: true; readonly schedule: SkipPaymentSchedule }
  | { readonly ok: false; readonly code: SkipPaymentScheduleRefusal };

/**
 * The kind of a menu schedule page, from its h1 only: `skip-payment` when
 * exactly one h1 is the observed ショッピングスキップ払い heading, otherwise
 * `unobserved` (the ボーナス払い page and anything else). The collector names
 * the stored page by this; nothing else on the page is read for it.
 */
export function myjcbSchedulePageKind(document: SchedulePageNode): "skip-payment" | "unobserved" {
  return skipHeadingCount(document) === 1 ? "skip-payment" : "unobserved";
}

/** Reads a ショッピングスキップ払い page, or refuses it with a closed code. */
export function readMyJcbSkipPaymentSchedule(
  document: SchedulePageNode,
): SkipPaymentScheduleReading {
  const refuse = (code: SkipPaymentScheduleRefusal): SkipPaymentScheduleReading => ({
    ok: false,
    code,
  });
  if (skipHeadingCount(document) !== 1) return refuse("schedule_kind_unobserved");
  const ledgers = elements(document, (element) => hasClass(element, "detail-list-01"));
  if (ledgers.length === 0) return refuse("schedule_ledger_missing");
  const withRows = ledgers.filter((ledger) => ledgerRows(ledger).length > 0);
  if (withRows.length > 1) return refuse("schedule_ledger_ambiguous");
  const read = withRows.length === 1 ? withRows : ledgers;
  if (!read.every(observedHead)) return refuse("schedule_head_unobserved");
  const rows = withRows.length === 1 ? ledgerRows(withRows[0]!) : [];
  if (rows.length > SKIP_PAYMENT_SCHEDULE_ROW_LIMIT) return refuse("schedule_row_limit");

  const asOfHeadings = elements(
    document,
    (element) =>
      /^h[1-6]$/u.test(element.tagName ?? "") && AS_OF_HEADING.test(compact(text(element))),
  ).map((element) => AS_OF_HEADING.exec(compact(text(element)))!);
  if (asOfHeadings.length > 1 || (rows.length > 0 && asOfHeadings.length !== 1))
    return refuse("schedule_as_of_invalid");
  let asOf: string | null = null;
  let paymentFromMonth: string | null = null;
  if (asOfHeadings.length === 1) {
    const match = asOfHeadings[0]!;
    asOf = calendarDate(match[1]!, match[2]!, match[3]!);
    paymentFromMonth = calendarMonth(match[4]!, match[5]!);
    if (asOf === null || paymentFromMonth === null) return refuse("schedule_as_of_invalid");
  }

  if (!read.every(onlyHeadAndRows)) return refuse("schedule_row_shape_unobserved");
  const readRows: SkipPaymentScheduleRow[] = [];
  for (const [index, row] of rows.entries()) {
    const rowChildren = children(row);
    if (rowChildren.length !== 1 || !hasClass(rowChildren[0]!, "item-cell"))
      return refuse("schedule_row_shape_unobserved");
    const cellNodes = children(rowChildren[0]!);
    if (cellNodes.length !== 3 || !cellNodes.every((cell) => hasClass(cell, "cell")))
      return refuse("schedule_row_shape_unobserved");
    const lines = cellLines(cellNodes[1]!);
    if (lines.length !== 2) return refuse("schedule_row_shape_unobserved");
    const cells = cellNodes.map((cell) => collapse(text(cell))) as [string, string, string];
    const usageDate = slashDate(cells[0]);
    const paymentDate = slashDate(lines[1]!);
    if (usageDate === null || paymentDate === null) return refuse("schedule_date_invalid");
    const amount = myjcbDisplayInteger(cells[2]);
    if (amount === null) return refuse("schedule_amount_invalid");
    readRows.push({
      index,
      cells,
      usageDate,
      merchantText: lines[0]!,
      paymentDate,
      amountText: decimalToString(integerDecimal(amount)),
    });
  }
  return { ok: true, schedule: { asOf, paymentFromMonth, rows: readRows } };
}

function skipHeadingCount(document: SchedulePageNode): number {
  return elements(
    document,
    (element) =>
      element.tagName === "h1" && compact(text(element)) === SKIP_PAYMENT_SCHEDULE_HEADING,
  ).length;
}

/** The ledger's first `div.head` has exactly the three observed cells. */
function observedHead(ledger: SchedulePageNode): boolean {
  const head = elements(ledger, (element) => hasClass(element, "head"))[0];
  if (!head) return false;
  const cells = children(head);
  return (
    cells.length === HEAD_CELLS.length &&
    cells.every(
      (cell, index) => hasClass(cell, "cell") && compact(text(cell)) === HEAD_CELLS[index],
    )
  );
}

/**
 * The ledger's element children are its `head` first and then only `content`
 * rows, as the survey recorded the grid. Zero rows is then a reading of the
 * page, never the result of rows nested where this reader does not look.
 */
function onlyHeadAndRows(ledger: SchedulePageNode): boolean {
  const [head, ...rest] = children(ledger);
  return (
    head !== undefined &&
    hasClass(head, "head") &&
    rest.every((element) => hasClass(element, "content") && !hasClass(element, "head"))
  );
}

/**
 * The provider's empty-ledger label, as the stored skip-payment and ボーナス払い
 * pages show it (a provider label, compared after whitespace removal).
 */
const EMPTY_LEDGER_LABEL = "ご利用明細はございません。";

/**
 * The `.content` rows of a ledger. A ledger whose only `content` row is the
 * observed empty row has none; in every other ledger each `content` row
 * counts, the empty row included, so it is refused by the row-shape check
 * instead of hiding the rows beside it.
 */
function ledgerRows(ledger: SchedulePageNode): SchedulePageNode[] {
  const rows = children(ledger).filter((element) => hasClass(element, "content"));
  return rows.length === 1 && isEmptyLedgerRow(rows[0]!) ? [] : rows;
}

/**
 * The observed empty row: its only element child an `item-cell`, whose only
 * element child is one `div.cell.w-100per` showing exactly `EMPTY_LEDGER_LABEL`.
 */
function isEmptyLedgerRow(row: SchedulePageNode): boolean {
  const rowChildren = children(row);
  if (rowChildren.length !== 1 || !hasClass(rowChildren[0]!, "item-cell")) return false;
  const cells = children(rowChildren[0]!);
  return (
    cells.length === 1 &&
    cells[0]!.tagName === "div" &&
    hasClass(cells[0]!, "cell") &&
    hasClass(cells[0]!, "w-100per") &&
    compact(text(cells[0]!)) === EMPTY_LEDGER_LABEL
  );
}

/** Elements that start and end a rendered line. */
const BLOCK_TAGS = new Set(["div", "p", "li", "ul", "ol", "dl", "dt", "dd", "table", "tr"]);

/**
 * The rendered lines of a cell: a `br` ends a line, and a block element starts
 * and ends one. Each line's whitespace is collapsed; empty lines are dropped.
 */
function cellLines(cell: SchedulePageNode): string[] {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    const line = collapse(current);
    if (line !== "") lines.push(line);
    current = "";
  };
  const walk = (node: SchedulePageNode) => {
    if (node.value !== undefined && node.tagName === undefined) {
      current += node.value;
      return;
    }
    if (node.tagName === "br") {
      flush();
      return;
    }
    const block = node.tagName !== undefined && BLOCK_TAGS.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes ?? []) walk(child);
    if (block) flush();
  };
  for (const child of cell.childNodes ?? []) walk(child);
  flush();
  return lines;
}

/** `YYYY/MM/DD` (whitespace removed) on the calendar, as `YYYY-MM-DD`; otherwise null. */
function slashDate(value: string): string | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/u.exec(compact(value));
  return match ? calendarDate(match[1]!, match[2]!, match[3]!) : null;
}

function calendarDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function calendarMonth(year: string, month: string): string | null {
  const m = Number(month);
  return m >= 1 && m <= 12 ? `${year}-${String(m).padStart(2, "0")}` : null;
}

function children(node: SchedulePageNode): SchedulePageNode[] {
  return (node.childNodes ?? []).filter((child) => child.tagName !== undefined);
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

function hasClass(element: SchedulePageNode, className: string): boolean {
  const value = element.attrs?.find((attribute) => attribute.name === "class")?.value ?? "";
  return value.split(/\s+/u).includes(className);
}

/** Text with a space between nodes. */
function text(node: SchedulePageNode): string {
  if (node.value !== undefined && node.tagName === undefined) return node.value;
  return (node.childNodes ?? []).map(text).join(" ");
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
