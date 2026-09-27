// What a MyJCB credit detail page states about its own statement state, read
// once for both readers of the page: the collector
// (`services/collector-myjcb/src/parsers.ts` `creditStatementState`), which
// adds the position rules before it records a state, and the statement parser
// (`packages/parsers/src/parsers/myjcb.ts`, `myjcb-credit-statement-total`),
// which reads stored pages. Sharing the reading keeps the two from drifting
// (docs/sources/myjcb.md, 明細状態の判定).
//
// The input is a parse5 document; only the structural fields both trees share
// are named here, so this module needs no HTML parser of its own.
import { myjcbDisplayQuantity, myjcbSinglePayment } from "./myjcb-amounts.ts";
import { compareQuantities, sumQuantities, type Quantity } from "./values.ts";

/** A parse5 node as far as this reading needs it. */
export interface StatementPageNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly value?: string;
  readonly childNodes?: readonly StatementPageNode[];
}

/**
 * The heading of a closed statement page: the page's own statement that its
 * ledger is the confirmed (確定) one. Compared exactly after whitespace
 * removal, never searched for as a substring.
 */
export const CONFIRMED_STATEMENT_HEADING = "カードご利用代金明細(確定分)";
/** The amount label of a confirmed ledger header (the fourth confirmed header). */
const CONFIRMED_AMOUNT_LABEL = "今回のお支払い金額";
/** The amount label of an unconfirmed ledger header (the fourth unconfirmed header). */
const UNCONFIRMED_AMOUNT_LABEL = "ご利用金額";

/** The label of the page's own statement total (`dt`), as the statement parser reads it. */
const STATEMENT_TOTAL_LABEL = "お支払い金額合計";

/**
 * Why a confirmed page whose ledger shows the unconfirmed amount label
 * (「ご利用金額」) is not accepted as confirmed (ADR 0005, amendment d). Closed
 * codes, safe to log; the checks run in this order, so a page always reports
 * the same code:
 *
 * - `usage_header_rows_outside_first_ledger`: a `detail-list-01` other than
 *   the first has rows. The collector stores the first ledger only
 *   (`parseCreditLedger`), so a proof over rows it does not store would
 *   accept a month whose stored rows are incomplete;
 * - `usage_header_payment_type_unproven`: a row whose payment type is not one
 *   single payment by the recognition grammar (`myjcbSinglePayment` on the
 *   combined ご利用先など／支払区分 cell), an empty or unreadable cell, or a row
 *   whose cells cannot be read;
 * - `usage_header_total_missing`: no single readable 「…お支払い金額合計」
 *   total on the page;
 * - `usage_header_total_mismatch`: a row amount that does not read as an
 *   exact JPY amount, or row amounts whose exact sum is not the total.
 */
export const USAGE_HEADER_REFUSALS = [
  "usage_header_rows_outside_first_ledger",
  "usage_header_payment_type_unproven",
  "usage_header_total_missing",
  "usage_header_total_mismatch",
] as const;
export type UsageHeaderRefusal = (typeof USAGE_HEADER_REFUSALS)[number];

/** The provider's empty-ledger wording, as the collector has always detected it. */
const EMPTY_LEDGER_MARKER = /(?:ご利用|明細)[^<>]{0,80}(?:ありません|ございません)/u;

type AmountHeader = "confirmed" | "unconfirmed" | "both";

/**
 * The page's own reading, before any position rule:
 *
 * - `conflict`: more than one heading, a header with both amount labels,
 *   ledgers that disagree, or the heading over an unconfirmed header that the
 *   page does not prove (`usageHeader` names why);
 * - `confirmed`: exactly one heading, over a confirmed or no amount header,
 *   or over an unconfirmed header the page proves is also this statement's
 *   payment (`usageHeader: "proven"`, `provenUsageHeader`);
 * - `unknown`: no heading, and no ledger or no ledger row. An empty ledger's
 *   header label states nothing about a statement it has no rows of;
 * - `unconfirmed`: no heading, and rows under the unconfirmed header;
 * - `unstated-rows`: no heading, and rows under a confirmed or no amount
 *   header. The rows claim a statement the page does not state.
 */
type StatementPageReading = "conflict" | "confirmed" | "unknown" | "unconfirmed" | "unstated-rows";

interface StatementPage {
  readonly headings: number;
  readonly ledgerCount: number;
  readonly rowCount: number;
  /** Sorted label codes, safe to log. */
  readonly amountHeaders: readonly AmountHeader[];
  readonly reading: StatementPageReading;
  /**
   * Only for exactly one heading over ledgers that all show the unconfirmed
   * amount label: `proven` when the page proves that label's amounts are this
   * statement's payment, otherwise the closed refusal. `null` for every other
   * page.
   */
  readonly usageHeader: "proven" | UsageHeaderRefusal | null;
}

export function readMyJcbStatementPage(document: StatementPageNode): StatementPage {
  const headings = elements(
    document,
    (element) => element.tagName === "h1" && compact(text(element)) === CONFIRMED_STATEMENT_HEADING,
  ).length;
  const ledgers = elements(document, (element) => hasClass(element, "detail-list-01"));
  const rowCount = ledgers.reduce((count, ledger) => count + ledgerRows(ledger).length, 0);
  const headers = new Set(
    ledgers.flatMap((ledger): AmountHeader[] => {
      const head = elements(ledger, (element) => hasClass(element, "head"))[0];
      const label = head ? compact(text(head)) : "";
      const confirmed = label.includes(CONFIRMED_AMOUNT_LABEL);
      const unconfirmed = label.includes(UNCONFIRMED_AMOUNT_LABEL);
      if (confirmed && unconfirmed) return ["both"];
      return confirmed ? ["confirmed"] : unconfirmed ? ["unconfirmed"] : [];
    }),
  );
  const usageHeader =
    headings === 1 && headers.size === 1 && headers.has("unconfirmed")
      ? provenUsageHeader(document, ledgers)
      : null;
  const reading: StatementPageReading =
    headings > 1 ||
    headers.has("both") ||
    headers.size > 1 ||
    (headings === 1 && headers.has("unconfirmed") && usageHeader !== "proven")
      ? "conflict"
      : headings === 1
        ? "confirmed"
        : rowCount === 0
          ? "unknown"
          : headers.has("unconfirmed")
            ? "unconfirmed"
            : "unstated-rows";
  return {
    headings,
    ledgerCount: ledgers.length,
    rowCount,
    amountHeaders: [...headers].sort(),
    reading,
    usageHeader,
  };
}

/**
 * Whether a page with the `(確定分)` heading, whose ledgers show 「ご利用金額」
 * (the usage amount) where a confirmed ledger shows 「今回のお支払い金額」, proves
 * from its own content that those amounts are also this statement's payment
 * (ADR 0005, amendment d). For an installment, revolving or bonus row the
 * usage amount and this statement's payment differ, so the label alone never
 * says so. The rows must all be in the first ledger, the one the collector
 * stores, and both of these must hold:
 *
 * 1. every row's payment type is one single payment, by the grammar card
 *    purchase recognition reads the same cell with (`myjcbSinglePayment` on
 *    the combined ご利用先など／支払区分 cell, `1回払` as every production row
 *    shows it); and
 * 2. the exact sum of the row amounts (`sumQuantities`, INV03) equals the
 *    page's one 「YYYY年M月D日(曜)お支払い金額合計」 total.
 *
 * A row's cells are read as the collector stores them (the `cell` children of
 * its `item-cell`, whitespace collapsed), and its amount is the one of the
 * third and fourth cells that reads as an exact JPY amount, as the ledger
 * parser reads it. An empty ledger proves only a zero total.
 */
function provenUsageHeader(
  document: StatementPageNode,
  ledgers: readonly StatementPageNode[],
): "proven" | UsageHeaderRefusal {
  // The proof is over the rows the collector stores, which are the first
  // ledger's; rows anywhere else leave the stored ledger incomplete.
  if (ledgers.slice(1).some((ledger) => ledgerRows(ledger).length > 0))
    return "usage_header_rows_outside_first_ledger";
  const rows = ledgers.flatMap((ledger) => ledgerRows(ledger));
  const cells = rows.map((row) => {
    const itemCell = elements(row, (element) => hasClass(element, "item-cell"))[0];
    return itemCell
      ? children(itemCell)
          .filter((element) => hasClass(element, "cell"))
          .map((element) => text(element).replace(/\s+/gu, " ").trim())
      : [];
  });
  if (cells.some((row) => row.length !== 4 || !myjcbSinglePayment(row[1] ?? null)))
    return "usage_header_payment_type_unproven";
  const total = statementTotal(document);
  if (total === null) return "usage_header_total_missing";
  const amounts: Quantity[] = [];
  for (const row of cells) {
    const readable = [row[2] ?? null, row[3] ?? null]
      .map(myjcbDisplayQuantity)
      .filter((quantity) => quantity.value.status === "exact");
    if (readable.length !== 1) return "usage_header_total_mismatch";
    amounts.push(readable[0]!);
  }
  const sum = sumQuantities("JPY", amounts);
  if (!sum.ok) return "usage_header_total_mismatch";
  const order = compareQuantities(sum.quantity, total);
  return order.ok && order.order === 0 ? "proven" : "usage_header_total_mismatch";
}

/**
 * The page's own statement total: the `dd` of the one `dl` whose one `dt`
 * shows 「お支払い金額合計」, as the statement parser reads it; `null` when there
 * is no such `dt`, more than one, a `dl` with more than one term or value, or
 * a value that does not read as an exact JPY amount.
 */
function statementTotal(document: StatementPageNode): Quantity | null {
  const labelled = (element: StatementPageNode) =>
    element.tagName === "dt" && compact(text(element)).includes(STATEMENT_TOTAL_LABEL);
  if (elements(document, labelled).length !== 1) return null;
  const list = elements(
    document,
    (element) => element.tagName === "dl" && children(element).some(labelled),
  )[0];
  if (!list) return null;
  const terms = children(list).filter((element) => element.tagName === "dt");
  const values = children(list).filter((element) => element.tagName === "dd");
  if (terms.length !== 1 || values.length !== 1) return null;
  const total = myjcbDisplayQuantity(text(values[0]!));
  return total.value.status === "exact" ? total : null;
}

/**
 * The `.content` rows of a ledger, without the structurally known empty-ledger
 * row (one `w-100per` cell under the empty marker). A row of any other shape
 * counts, so a changed row shape is never mistaken for an empty ledger.
 */
function ledgerRows<T extends StatementPageNode>(ledger: T): T[] {
  const hasEmptyMarker = EMPTY_LEDGER_MARKER.test(text(ledger));
  return (children(ledger) as T[])
    .filter((element) => hasClass(element, "content"))
    .filter((row) => !(hasEmptyMarker && isEmptyLedgerRow(row)));
}

function isEmptyLedgerRow(row: StatementPageNode): boolean {
  const itemCell = elements(row, (element) => hasClass(element, "item-cell"))[0];
  if (!itemCell) return false;
  const cells = children(itemCell);
  return (
    cells.filter((element) => hasClass(element, "cell")).length === 1 &&
    cells.some((element) => hasClass(element, "w-100per"))
  );
}

function children(node: StatementPageNode): StatementPageNode[] {
  return (node.childNodes ?? []).filter((child) => child.tagName !== undefined);
}

function elements(
  node: StatementPageNode,
  predicate: (element: StatementPageNode) => boolean,
): StatementPageNode[] {
  const result: StatementPageNode[] = [];
  if (node.tagName !== undefined && predicate(node)) result.push(node);
  for (const child of node.childNodes ?? []) result.push(...elements(child, predicate));
  return result;
}

function hasClass(element: StatementPageNode, className: string): boolean {
  const value = element.attrs?.find((attribute) => attribute.name === "class")?.value ?? "";
  return value.split(/\s+/u).includes(className);
}

/** Text with a space between nodes, as the collector has always read it. */
function text(node: StatementPageNode): string {
  if (node.value !== undefined) return node.value;
  return (node.childNodes ?? []).map(text).join(" ");
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
