import type { DiscoveredCard, DiscoveredPeriod, StatementState } from "./types";
import { StopConditionError } from "./types";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import {
  CONFIRMED_STATEMENT_HEADING,
  readMyJcbStatementPage,
} from "../../../packages/domain/src/myjcb-statement-page";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

export interface CreditLedgerSnapshot {
  readonly state: "confirmed" | "unconfirmed";
  readonly headers: readonly string[];
  readonly rows: readonly {
    readonly summaryCells: readonly string[];
    readonly expanded: Readonly<Record<string, string>>;
  }[];
}

/** The statement state the collector records for one credit detail page. */
export type CreditStatementState = "confirmed" | "unconfirmed" | "unknown";

/**
 * The heading a closed MyJCB credit statement page carries. The page reading
 * (heading, ledger rows, amount labels) lives in
 * packages/domain/src/myjcb-statement-page.ts, shared with the
 * statement parser so the two cannot drift.
 */
export { CONFIRMED_STATEMENT_HEADING };

/**
 * The ledger header sets of a confirmed and of an unconfirmed page. The fourth
 * label is the one amount the summary row displays: this statement's payment
 * on a confirmed page, the usage amount on an unconfirmed one
 * (docs/sources/myjcb.md; the Layer B contract is `CONFIRMED_HEADERS` and
 * `UNCONFIRMED_HEADERS` in packages/parsers/src/parsers/myjcb.ts).
 */
const CONFIRMED_LEDGER_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"];
const UNCONFIRMED_LEDGER_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"];

export interface PastMonthAvailability {
  readonly detailMonth: number;
  readonly available: boolean;
  readonly settlementYM?: string;
}

const ALLOWED_PRODUCT_HINTS = [
  "JCB W",
  "リクルートカード",
  "みずほJCBデビット",
  "京銀JCBデビット",
] as const;

export function parseCardInventory(html: string): DiscoveredCard[] {
  const candidates = [
    ...html.matchAll(
      /<(?:option|a)\b[^>]*(?:data-card-index|value|href)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:option|a)>/giu,
    ),
  ];
  const cards: DiscoveredCard[] = [];
  for (const [index, match] of candidates.entries()) {
    const text = normalizeText(stripTags(match[2] ?? ""));
    if (!/(?:カード|JCB|デビット)/u.test(text)) continue;
    cards.push({
      localId: `card-${String(index + 1).padStart(3, "0")}`,
      ...(productHint(text) ? { productHint: productHint(text) } : {}),
      switchCandidate: /(?:切替|おまとめ|card)/iu.test(`${match[1] ?? ""} ${text}`),
    });
  }
  return dedupeCards(cards);
}

export function parseStatementPeriods(html: string): DiscoveredPeriod[] {
  const periods = new Map<string, DiscoveredPeriod>();
  for (const match of html.matchAll(
    /<(?:option|a)\b[^>]*(?:value|href)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:option|a)>/giu,
  )) {
    const target = decodeHtml(match[1] ?? "");
    const label = normalizeText(stripTags(match[2] ?? ""));
    const sequence =
      target.match(/[?&]seq=(\d{1,2})(?:&|$)/u)?.[1] ??
      (/^\d{1,2}$/u.test(target) ? target : undefined);
    if (sequence === undefined && !/(?:\d{4}年\d{1,2}月|未確定|確定)/u.test(label)) continue;
    const numericSequence = sequence === undefined ? undefined : Number(sequence);
    if (numericSequence !== undefined && (numericSequence < 0 || numericSequence > 14)) continue;
    const key = `${numericSequence ?? "label"}:${label}`;
    periods.set(key, {
      ...(numericSequence === undefined ? {} : { sequence: numericSequence }),
      label,
      state: statementState(label),
      exportKinds: exportKindsNear(html, match.index ?? 0),
    });
  }
  return [...periods.values()];
}

export function extractCreditMenuLinkId(html: string): string | undefined {
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/giu)) {
    const url = new URL(decodeHtml(match[1] ?? ""), "https://my.jcb.co.jp");
    if (url.pathname !== "/iss-pc/member/details_inquiry/detailMenu.html") continue;
    const linkId = url.searchParams.get("link_id");
    if (linkId && /^[A-Za-z0-9_-]{1,128}$/u.test(linkId)) return linkId;
  }
  return undefined;
}

export function parseCreditMenuMonths(html: string): number[] {
  const months = new Set<number>();
  for (const match of html.matchAll(/(?:[?&]|\b)detailMonth(?:=|["']?\s+value=["'])(\d{1,2})/giu)) {
    const month = Number(match[1]);
    if (Number.isInteger(month) && month >= 0 && month <= 17) months.add(month);
  }
  return [...months].sort((left, right) => left - right);
}

export function extractGeneralJsonDiscriminator(html: string): string {
  const patterns = [
    /<input\b[^>]*\bname=["']generalJsonShikibetuId["'][^>]*\bvalue=["']([^"']+)["']/iu,
    /<input\b[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']generalJsonShikibetuId["']/iu,
  ];
  for (const pattern of patterns) {
    const value = html.match(pattern)?.[1];
    if (value && value.length <= 512) return decodeHtml(value);
  }
  throw new StopConditionError("MyJCB detail page omitted generalJsonShikibetuId");
}

export function parsePastMonthAvailability(json: string): PastMonthAvailability[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StopConditionError("MyJCB past-month response was not valid JSON");
  }
  if (!isRecord(parsed) || !isRecord(parsed.result)) {
    throw new StopConditionError("MyJCB past-month response omitted result");
  }
  if (parsed.result.errId !== undefined && !isSuccessErrorId(parsed.result.errId)) {
    throw new StopConditionError("MyJCB past-month response reported an error");
  }
  const items = parsed.result.detailPastJsonInfo;
  if (!Array.isArray(items)) {
    throw new StopConditionError("MyJCB past-month response omitted detailPastJsonInfo");
  }
  const seen = new Set<number>();
  return items
    .map((item, index) => {
      if (!isRecord(item)) {
        throw new StopConditionError(`MyJCB past-month item ${index + 1} was malformed`);
      }
      const detailMonth = numericMonth(item.detailMonth);
      if (seen.has(detailMonth)) {
        throw new StopConditionError("MyJCB past-month response contained duplicate months");
      }
      seen.add(detailMonth);
      const available = availabilityFlag(item.detailAvailableFlag);
      const settlementYM = item.settlementYM;
      if (settlementYM !== undefined && typeof settlementYM !== "string") {
        throw new StopConditionError("MyJCB past-month settlementYM was malformed");
      }
      return {
        detailMonth,
        available,
        ...(typeof settlementYM === "string" && safeSettlementLabel(settlementYM)
          ? { settlementYM }
          : {}),
      };
    })
    .sort((left, right) => left.detailMonth - right.detailMonth);
}

export function discoverCreditExports(
  html: string,
  detailMonth: number,
): readonly ("csv" | "pdf" | "ofx")[] {
  const found = new Set<"csv" | "pdf" | "ofx">();
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/giu)) {
    const url = new URL(decodeHtml(match[1] ?? ""), "https://my.jcb.co.jp");
    if (Number(url.searchParams.get("detailMonth")) !== detailMonth) continue;
    if (
      url.pathname === "/iss-pc/member/details_inquiry/detail.html" &&
      url.searchParams.get("output") === "csv"
    )
      found.add("csv");
    if (
      url.pathname === "/iss-pc/member/details_inquiry/detail.html" &&
      url.searchParams.get("output") === "money"
    )
      found.add("ofx");
    if (
      url.pathname === "/iss-pc/member/details_inquiry/detailDbPdf.html" &&
      url.searchParams.get("output") === "pdf"
    )
      found.add("pdf");
  }
  return [...found];
}

export function parseCreditLedger(
  html: string,
  state: "confirmed" | "unconfirmed",
): CreditLedgerSnapshot | undefined {
  const document = parse(html);
  const ledger = findElements(document, (element) => hasClass(element, "detail-list-01"))[0];
  if (!ledger) return undefined;
  const header = findElements(ledger, (element) => hasClass(element, "head"))[0];
  const hasEmptyMarker = /(?:ご利用|明細)[^<>]{0,80}(?:ありません|ございません)/u.test(
    nodeText(ledger),
  );
  const headers = state === "unconfirmed" ? UNCONFIRMED_LEDGER_HEADERS : CONFIRMED_LEDGER_HEADERS;
  const headerText = header ? normalizeText(nodeText(header)) : "";
  // A ledger with rows must display the whole header set of its state: the
  // fourth label says which amount the summary cell holds, so `headers` in the
  // stored ledger is a checked fact about the page, not an assumption. An
  // empty ledger only has to be recognisably the same component.
  const requiredHeaders = hasEmptyMarker ? ["ご利用日", "ご利用先など"] : headers;
  if (requiredHeaders.some((label) => !headerText.includes(label))) {
    throw new StopConditionError(`MyJCB ${state} ledger headers changed`, "credit-ledger-headers");
  }
  const expandedLabels =
    state === "unconfirmed"
      ? ["今回のお支払い金額", "摘要", "今回回数", "備考", "訂正サイン"]
      : ["ご利用金額", "摘要", "今回回数", "備考", "訂正サイン"];
  const rows = directElementChildren(ledger)
    .filter((element) => hasClass(element, "content"))
    .flatMap((row) => {
      const itemCell = findElements(row, (element) => hasClass(element, "item-cell"))[0];
      if (!itemCell) {
        console.warn(
          JSON.stringify({
            event: "myjcb-credit-ledger-row-shape",
            state,
            rowClasses: safeClassNames(row),
            childClasses: directElementChildren(row).flatMap(safeClassNames),
          }),
        );
        throw new StopConditionError(
          `MyJCB ${state} ledger row omitted item-cell`,
          "credit-ledger-item-cell",
        );
      }
      const summaryCells = directElementChildren(itemCell)
        .filter((element) => hasClass(element, "cell"))
        .map((element) => normalizeText(nodeText(element)));
      if (
        hasEmptyMarker &&
        summaryCells.length === 1 &&
        directElementChildren(itemCell).some((element) => hasClass(element, "w-100per"))
      ) {
        return [];
      }
      if (summaryCells.length !== 4) {
        console.warn(
          JSON.stringify({
            event: "myjcb-credit-ledger-cell-shape",
            state,
            summaryCellCount: summaryCells.length,
            childClasses: directElementChildren(itemCell).flatMap(safeClassNames),
          }),
        );
        throw new StopConditionError(
          `MyJCB ${state} ledger row changed its direct cell count`,
          "credit-ledger-cell-count",
        );
      }
      const itemMore = findElements(row, (element) => hasClass(element, "item-more"))[0];
      const list = itemMore
        ? findElements(itemMore, (element) => hasClass(element, "list"))[0]
        : undefined;
      const expanded: Record<string, string> = {};
      if (list) {
        for (const label of expandedLabels) {
          const value = findLabelValue(list, label);
          if (value !== undefined) expanded[label] = value;
        }
      }
      return [{ summaryCells, expanded }];
    });
  return { state, headers: [...headers], rows };
}

/**
 * The statement state of the credit detail page fetched as `detailMonth=N`,
 * decided from the page itself and never from whether it offers export links.
 *
 * The page states its state twice: a closed statement carries exactly one
 * `CONFIRMED_STATEMENT_HEADING` h1, and every ledger header displays the
 * amount label of one state (`今回のお支払い金額` confirmed, `ご利用金額`
 * unconfirmed). The heading is the only statement that a page is closed:
 *
 * - `detailMonth=0` is the mutable current month and is always `unconfirmed`;
 *   a position-0 page that shows the heading stops the collection;
 * - the heading, with a confirmed (or no) amount header: `confirmed`;
 * - no heading and no ledger: `unknown`, as before;
 * - no heading and a ledger without rows: `unknown`. Production captures of
 *   older closed months (positions 7 and 8 of the surveyed connection) are
 *   exactly this; recording them as `unconfirmed` would put an empty capture
 *   in the connection's one unconfirmed snapshot slot after position 0;
 * - no heading and rows under the unconfirmed header: `unconfirmed` at
 *   position 1 (a closed month not yet confirmed), `unknown` at an older
 *   position, which cannot be the mutable month;
 * - no heading and rows under a confirmed or no amount header: the rows claim
 *   a statement the page does not state. Position 1, which every closed
 *   statement passes through and where production always showed the heading,
 *   stops the collection; an older position is `unknown`, so one old page
 *   never halts the daily run.
 *
 * The page reading is `readMyJcbStatementPage`, the one the statement parser
 * uses; the position rules are the collector's own.
 * `unknown` stores the page as evidence and no ledger artifact. A page that
 * contradicts itself stops the collection at every position
 * (`credit-statement-state`): more than one heading, a header with both
 * labels, ledgers that disagree, or the heading over an unconfirmed header.
 */
export function creditStatementState(html: string, detailMonth: number): CreditStatementState {
  const page = readMyJcbStatementPage(parse(html));
  // Counts and label codes only: the page's text never reaches the log.
  const shape = (event: string) =>
    JSON.stringify({
      event,
      detailMonth,
      confirmedHeadings: page.headings,
      ledgerCount: page.ledgerCount,
      rowCount: page.rowCount,
      amountHeaders: page.amountHeaders,
    });
  const stop = (message: string): never => {
    console.warn(shape("myjcb-credit-statement-state"));
    throw new StopConditionError(message, "credit-statement-state");
  };
  const unstated = (): "unknown" => {
    console.warn(shape("myjcb-credit-statement-unstated"));
    return "unknown";
  };
  if (page.reading === "conflict") {
    return stop("MyJCB credit detail heading and ledger headers disagree on the statement state");
  }
  if (detailMonth === 0) {
    if (page.reading === "confirmed")
      return stop("MyJCB detailMonth 0 stated a confirmed statement");
    return "unconfirmed";
  }
  switch (page.reading) {
    case "confirmed":
      return "confirmed";
    case "unknown":
      return page.ledgerCount === 0 ? "unknown" : unstated();
    case "unconfirmed":
      return detailMonth === 1 ? "unconfirmed" : unstated();
    case "unstated-rows":
      if (detailMonth === 1) {
        return stop("MyJCB credit detail ledger rows have no stated statement state");
      }
      return unstated();
  }
}

/**
 * The heading a closed statement page names its payment month in, compared
 * after whitespace removal. `myjcb-credit-statement-total` reads the same
 * heading (packages/parsers/src/parsers/myjcb.ts), so the month the collector
 * records and the month the statement total carries are one reading.
 */
const STATEMENT_MONTH_HEADING = /^(\d{4})年(\d{1,2})月お支払い分のカードご利用明細$/u;

/** Every payment month (`YYYY-MM`) a page's `h2` headings state: normally none or one. */
export function statedPaymentMonths(html: string): string[] {
  return findElements(parse(html), (element) => element.tagName === "h2").flatMap((element) => {
    const match = STATEMENT_MONTH_HEADING.exec(nodeText(element).replace(/\s+/gu, ""));
    return match ? yearMonth(match[1]!, match[2]!) : [];
  });
}

/**
 * The payment month (`YYYY-MM`) of a past-months API `settlementYM`, in the
 * shapes the past-month parser reads (`YYYYMM`, `YYYY-MM`, `YYYY年M月お支払い分`
 * and their day and 度 variants), or null for any other text.
 */
export function settlementMonth(value: string): string | null {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "");
  const match =
    /^(\d{4})年(\d{1,2})月(?:\d{1,2}日)?(?:度)?(?:お支払い分)?$/u.exec(normalized) ??
    /^(\d{4})[/.-](\d{1,2})(?:[/.-]\d{1,2})?(?:度)?(?:お支払い分)?$/u.exec(normalized) ??
    /^(\d{4})(\d{2})(?:\d{2})?(?:度)?(?:お支払い分)?$/u.exec(normalized);
  return (match ? yearMonth(match[1]!, match[2]!) : [])[0] ?? null;
}

function yearMonth(year: string, month: string): string[] {
  const number = Number(month);
  return number >= 1 && number <= 12 ? [`${year}-${String(number).padStart(2, "0")}`] : [];
}

/**
 * The period the collector records for one credit month: the statement's own
 * name, so that a statement keeps one period, and each of its ledger rows one
 * external id, while its position in the provider's list moves
 * (docs/sources/myjcb.md, 明細の月). The ledger parser hashes the period into
 * every row's fingerprint; the position stays recorded beside it, in the
 * artifact key and the ledger's `detailMonth`.
 *
 * - A month the past-months API labels keeps its `settlementYM` verbatim, as
 *   before. When the page is a confirmed statement that also states its
 *   payment month, the two must name the same month.
 * - Any other confirmed page records the payment month its heading states,
 *   `YYYY-MM`. Only a page with the `(確定分)` heading is confirmed, and a
 *   closed statement page names its payment month: a confirmed page that
 *   names none, or more than one, stops the collection
 *   (`credit-statement-period`), as the statement parser rejects it.
 * - Every other page (`unconfirmed`, `unknown`) keeps the relative
 *   `detailMonth-N`. It states no month; the label stays evidence and is
 *   resolved afterwards from the capture time (docs/observations.md,
 *   "Relative period labels are resolved from the capture time").
 */
export function creditStatementPeriod(input: {
  readonly html: string;
  readonly detailMonth: number;
  readonly state: CreditStatementState;
  readonly settlementYM: string | undefined;
}): string {
  const { html, detailMonth, state, settlementYM } = input;
  if (state !== "confirmed") return settlementYM ?? `detailMonth-${detailMonth}`;
  const stated = statedPaymentMonths(html);
  const stop = (message: string): never => {
    // Counts and codes only: the page's month never reaches the log.
    console.warn(
      JSON.stringify({
        event: "myjcb-credit-statement-period",
        detailMonth,
        statedMonths: stated.length,
        settlementLabelled: settlementYM !== undefined,
      }),
    );
    throw new StopConditionError(message, "credit-statement-period");
  };
  if (stated.length > 1) return stop("MyJCB confirmed statement page names more than one month");
  if (settlementYM !== undefined) {
    const labelled = settlementMonth(settlementYM);
    if (stated.length === 1 && labelled !== null && labelled !== stated[0])
      return stop("MyJCB confirmed statement month disagrees with its past-months label");
    return settlementYM;
  }
  if (stated.length === 0) return stop("MyJCB confirmed statement page names no payment month");
  return stated[0]!;
}

function safeClassNames(element: HtmlElement): string[] {
  return (element.attrs.find((attribute) => attribute.name === "class")?.value ?? "")
    .split(/\s+/u)
    .filter((value) => /^[a-z0-9_-]{1,64}$/iu.test(value))
    .slice(0, 16);
}

export function statementState(value: string): StatementState {
  const normalized = normalizeText(value);
  if (/未確定/u.test(normalized)) return "unconfirmed";
  if (/確定/u.test(normalized)) return "confirmed";
  if (/(?:お振替日|差額発生日|デビット)/u.test(normalized)) return "debit";
  return "unknown";
}

export function redactedStatementHtml(html: string): string {
  const document = parse(html);
  sanitizeHtmlTree(document);
  return serialize(document);
}

const REMOVED_HTML_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "meta",
  "base",
  "link",
  "textarea",
]);

const REMOVED_HTML_ATTRIBUTES = new Set([
  "style",
  "srcdoc",
  "srcset",
  "integrity",
  "nonce",
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "ping",
  "manifest",
]);

function sanitizeHtmlTree(node: HtmlNode): void {
  if ("childNodes" in node) {
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index]!;
      if (
        child.nodeName === "#comment" ||
        (isElement(child) && REMOVED_HTML_ELEMENTS.has(child.tagName))
      ) {
        node.childNodes.splice(index, 1);
      } else {
        sanitizeHtmlTree(child);
      }
    }
  }
  if (isElement(node)) {
    node.attrs = node.attrs.flatMap((attribute) => {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name.startsWith("data-") ||
        name.endsWith(":href") ||
        REMOVED_HTML_ATTRIBUTES.has(name)
      ) {
        return [];
      }
      if (
        name === "value" ||
        /(?:token|csrf|session|auth|credential|secret|password|nonce|userid|user-id|user_id|cookie)/u.test(
          name,
        )
      )
        return [{ ...attribute, value: "[redacted]" }];
      return [attribute];
    });
  } else if (node.nodeName === "#text") {
    node.value = node.value.replace(
      /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/gu,
      "[card-number-redacted]",
    );
  }
}

function exportKindsNear(html: string, index: number): readonly ("csv" | "pdf" | "ofx")[] {
  const nearby = html.slice(Math.max(0, index - 600), index + 1200);
  const result: ("csv" | "pdf" | "ofx")[] = [];
  if (/CSV/iu.test(nearby)) result.push("csv");
  if (/PDF/iu.test(nearby)) result.push("pdf");
  if (/OFX/iu.test(nearby)) result.push("ofx");
  return result;
}

function productHint(value: string): string | undefined {
  return ALLOWED_PRODUCT_HINTS.find((name) => value.includes(name));
}

function dedupeCards(cards: readonly DiscoveredCard[]): DiscoveredCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.productHint ?? "unknown"}:${card.switchCandidate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/gu, " "));
}

function decodeHtml(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
  };
  return value.replace(
    /&(amp|lt|gt|quot|#39);/gu,
    (entity, name: string) => entities[name] ?? entity,
  );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function findElements(node: HtmlNode, predicate: (element: HtmlElement) => boolean): HtmlElement[] {
  const result: HtmlElement[] = [];
  if (isElement(node) && predicate(node)) result.push(node);
  for (const child of childNodes(node)) result.push(...findElements(child, predicate));
  return result;
}

function directElementChildren(node: HtmlNode): HtmlElement[] {
  return childNodes(node).filter(isElement);
}

function childNodes(node: HtmlNode): DefaultTreeAdapterMap["childNode"][] {
  return "childNodes" in node ? node.childNodes : [];
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function hasClass(element: HtmlElement, className: string): boolean {
  const value = element.attrs.find((attribute) => attribute.name === "class")?.value ?? "";
  return value.split(/\s+/u).includes(className);
}

function nodeText(node: HtmlNode): string {
  if ("value" in node) return node.value;
  return childNodes(node).map(nodeText).join(" ");
}

function findLabelValue(root: HtmlElement, label: string): string | undefined {
  const candidates = findElements(root, (element) => {
    const text = normalizeText(nodeText(element));
    return text.startsWith(label) && text.length > label.length;
  })
    .map((element) => normalizeText(nodeText(element)))
    .sort((left, right) => left.length - right.length);
  const candidate = candidates[0];
  return candidate === undefined ? undefined : candidate.slice(label.length).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericMonth(value: unknown): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,2}$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(number) || number < 0 || number > 17) {
    throw new StopConditionError("MyJCB past-month detailMonth was outside 0..17");
  }
  return number;
}

function availabilityFlag(value: unknown): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new StopConditionError("MyJCB past-month availability flag was malformed");
}

function isSuccessErrorId(value: unknown): boolean {
  return value === null || value === "" || value === 0 || value === "0";
}

function safeSettlementLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 32 &&
    /^[0-9０-９年月日度お支払い分／/().（）.\-\s]+$/u.test(value)
  );
}
