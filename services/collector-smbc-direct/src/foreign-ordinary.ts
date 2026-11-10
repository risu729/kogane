import type { DateRange, ForeignOrdinaryProgress } from "./types";

export const FOREIGN_EMPTY_CODE = "PC-AIFDDT1-00134-E";
export const FOREIGN_BALANCE_UNIT = "foreign-ordinary-aud-balance";
export const FOREIGN_HISTORY_UNIT = "foreign-ordinary-aud-history";

export function foreignFailureCodes(foreign?: ForeignOrdinaryProgress): string[] {
  return [
    ...new Set(
      [foreign?.balance, foreign?.history].flatMap((unit) =>
        unit?.status === "partial" ? [unit.failureCode ?? "foreign_collection_failed"] : [],
      ),
    ),
  ];
}

export interface ForeignOrdinaryBalance {
  currency: "AUD";
  amount: string;
  yenEquivalent: string;
  referenceRate: string;
}

export interface ForeignOrdinaryHistory {
  currency: "AUD";
  range: DateRange;
  emptyCode: typeof FOREIGN_EMPTY_CODE;
  transactions: [];
}

/** Extract only reviewed financial fields. The HTML, hidden forms, scripts,
 * account labels and session tokens never enter the stored artifact. */
export function sanitizeForeignBalance(html: string): ForeignOrdinaryBalance {
  html = withoutExecutableContent(html);
  const currency = audContainer(html);
  const balance = labelled(currency, "dl", "現在残高");
  const symbol = single(
    elements(balance, "span").filter((span) => classes(span).includes("foreignCurrency")),
  );
  if (visibleText(symbol) !== "A$") refuse("foreign_currency_unreviewed");
  const amount = price(balance);
  const yenEquivalent = price(labelled(currency, "dl", "円貨換算金額"));
  const rate = labelled(currency, "dl", "現在の参考為替レート(外貨→円)");
  const referenceRate = decimal(plainText(single(elements(rate, "dd"))).replace(/円$/u, ""));
  return { currency: "AUD", amount, yenEquivalent, referenceRate };
}

function audContainer(html: string): string {
  const currencies = elements(html, "dl").filter(
    (element) =>
      classes(element).includes("detail-list03") &&
      elements(element, "dt").some((term) => visibleText(term) === "通貨：A$"),
  );
  if (currencies.length !== 1) refuse("foreign_currency_unreviewed");
  return currencies[0]!;
}

export function foreignHistoryIndex(html: string): "0" {
  const link = single(
    elements(audContainer(withoutExecutableContent(html)), "a").filter((element) =>
      /\bdata-event=["']\/accountinquiry\/AIFDDTLmeisai["']/u.test(element),
    ),
  );
  if (!/\bid=["']0["']/u.test(link)) refuse("foreign_account_selection_unreviewed");
  return "0";
}

/** Named account radio choices are unrelated to the selected AUD context.
 * Bind the server-selected page to its visible account and AUD heading. */
export function assertForeignHistoryContext(html: string, accountNo: string, amount: string): void {
  // The observed heading is unique in the visible main, not an arbitrary
  // matching account elsewhere in the document or an inert template.
  html = single(elements(visibleMarkup(html), "main"));
  const headers = elements(html, "dl").filter((element) => classes(element).includes("item"));
  if (headers.length !== 1) refuse("foreign_history_account_mismatch");
  const titles = elements(headers[0]!, "dt").filter((term) => classes(term).includes("title"));
  const firstTitle = elements(html, "dt").find((term) => classes(term).includes("title"));
  if (
    titles.length !== 1 ||
    titles[0] !== firstTitle ||
    /外貨([0-9]+)$/u.exec(visibleText(titles[0]!))?.[1] !== accountNo
  )
    refuse("foreign_history_account_mismatch");
  const heading = single(
    elements(html, "dl").filter((element) => {
      const names = classes(element);
      return (
        names.includes("detail-list07") &&
        names.includes("-flexEnd") &&
        names.includes("-account") &&
        elements(element, "dt").some((term) => visibleText(term) === "通貨・現在残高")
      );
    }),
  );
  const current = single(elements(heading, "dd"));
  const priceText = plainText(
    single(elements(current, "span").filter((element) => classes(element).includes("price"))),
  );
  if (visibleText(current) !== `A$${priceText}` || decimal(priceText) !== amount)
    refuse("foreign_history_currency_mismatch");
}

export function sanitizeForeignHistory(html: string, range: DateRange): ForeignOrdinaryHistory {
  const definitions = [...html.matchAll(/\bfunction\s+getData\s*\(\s*\)\s*\{([^{}]*)\}/gu)];
  if (
    definitions.length !== 1 ||
    !/^returnJSON\.parse\(""\.replace\(\/&quot;\/g,'\\"'\)\);$/u.test(
      definitions[0]![1]!.replace(/\s+/gu, ""),
    ) ||
    !/\bvar\s+meisaiListJSONData\s*=\s*getData\(\s*\)\s*;/u.test(html)
  ) {
    refuse("foreign_history_response_unreviewed");
  }
  html = withoutExecutableContent(html);
  // No nonempty row/table layout has been observed. Even an empty marker
  // alongside a table cannot prove that no movements were omitted.
  if (/<(?:table|tbody)\b/iu.test(html)) refuse("foreign_nonempty_unreviewed");
  const alert = single(
    elements(html, "div").filter((element) => {
      const names = classes(element);
      return names.includes("card-box03") && names.includes("-alert01");
    }),
  );
  if (
    visibleText(single(elements(alert, "dt"))) !== `エラーコード:${FOREIGN_EMPTY_CODE}` ||
    visibleText(single(elements(alert, "dd"))) !== "指定期間の入出金はございません。"
  ) {
    refuse("foreign_history_response_unreviewed");
  }
  const period = `${displayDate(range.start)}-${displayDate(range.end)}の明細`;
  if (elements(html, "p").filter((element) => visibleText(element) === period).length !== 1) {
    refuse("foreign_history_range_mismatch");
  }
  return { currency: "AUD", range, emptyCode: FOREIGN_EMPTY_CODE, transactions: [] };
}

function displayDate(value: string): string {
  return `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}

function withoutExecutableContent(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/giu, "");
}

/** Hidden ancestors and templates cannot supply evidence for a visible page. */
function visibleMarkup(html: string): string {
  html = withoutExecutableContent(html).replace(/<!--[\s\S]*?-->/gu, "");
  for (const template of elements(html, "template").sort(
    (left, right) => right.length - left.length,
  ))
    html = html.replace(template, "");
  for (const opening of [...html.matchAll(/<([a-z][a-z0-9:-]*)(?=[\s>])[^>]*>/giu)]) {
    const tag = opening[1]!;
    const attributes = new Map(
      [
        ...opening[0]
          .slice(tag.length + 1, -1)
          .matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu),
      ].map((attribute) => [
        attribute[1]!.toLowerCase(),
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      ]),
    );
    const hidden =
      attributes.has("hidden") ||
      attributes.get("aria-hidden")?.toLowerCase() === "true" ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(
        attributes.get("style") ?? "",
      );
    if (!hidden) continue;
    if (/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/iu.test(tag))
      html = html.replace(opening[0], "");
    else {
      const hiddenElement = elements(html, tag).find((element) => element.startsWith(opening[0]));
      if (hiddenElement) html = html.replace(hiddenElement, "");
    }
  }
  return html;
}

function price(html: string): string {
  return decimal(
    plainText(single(elements(html, "span").filter((span) => classes(span).includes("price")))),
  );
}

function decimal(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,14}|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,8})?$/u.test(value)) {
    refuse("foreign_decimal_invalid");
  }
  return value.replaceAll(",", "");
}

function labelled(html: string, tag: string, label: string): string {
  // A nested definition list is the smallest list carrying this exact term.
  const candidates = elements(html, tag).filter((element) =>
    elements(element, "dt").some((term) => visibleText(term) === label),
  );
  const leaves = candidates.filter(
    (candidate) => !candidates.some((nested) => nested !== candidate && candidate.includes(nested)),
  );
  return single(leaves);
}

function single(values: string[]): string {
  if (values.length !== 1) refuse("foreign_html_shape_unreviewed");
  return values[0]!;
}

function classes(element: string): string[] {
  return (/^[^>]*\bclass=["']([^"']*)["']/iu.exec(element)?.[1] ?? "").split(/\s+/u);
}

/** Balanced extraction keeps the bank's nested definition lists distinct. */
function elements(html: string, tag: string): string[] {
  const pattern = new RegExp(`<(/?)${tag}(?=[\\s>])[^>]*>`, "giu");
  const stack: number[] = [];
  const found: string[] = [];
  for (const match of html.matchAll(pattern)) {
    if (match[1] === "") stack.push(match.index);
    else {
      const start = stack.pop();
      if (start === undefined) refuse("foreign_html_shape_unreviewed");
      found.push(html.slice(start, match.index + match[0].length));
    }
  }
  if (stack.length !== 0) refuse("foreign_html_shape_unreviewed");
  return found;
}

function visibleText(html: string): string {
  return plainText(html).replace(/\s+/gu, "");
}

function plainText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/giu, "")
    .replace(/<[^>]*>/gu, "")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .trim();
}

function refuse(code: string): never {
  throw new Error(code);
}
