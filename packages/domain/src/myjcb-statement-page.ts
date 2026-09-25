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

/** The provider's empty-ledger wording, as the collector has always detected it. */
const EMPTY_LEDGER_MARKER = /(?:ご利用|明細)[^<>]{0,80}(?:ありません|ございません)/u;

type AmountHeader = "confirmed" | "unconfirmed" | "both";

/**
 * The page's own reading, before any position rule:
 *
 * - `conflict`: more than one heading, a header with both amount labels,
 *   ledgers that disagree, or the heading over an unconfirmed header;
 * - `confirmed`: exactly one heading, over a confirmed or no amount header;
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
  const reading: StatementPageReading =
    headings > 1 ||
    headers.has("both") ||
    headers.size > 1 ||
    (headings === 1 && headers.has("unconfirmed"))
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
  };
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
