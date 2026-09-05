import type { DiscoveredCard, DiscoveredPeriod, StatementState } from "./types";
import { StopConditionError } from "./types";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

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
  const headers =
    state === "unconfirmed"
      ? ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"]
      : ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"];
  const headerText = header ? normalizeText(nodeText(header)) : "";
  const requiredCoreHeaders = hasEmptyMarker
    ? ["ご利用日", "ご利用先など"]
    : ["ご利用日", "ご利用先など", "支払区分"];
  if (requiredCoreHeaders.some((label) => !headerText.includes(label))) {
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
  return { state, headers, rows };
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
