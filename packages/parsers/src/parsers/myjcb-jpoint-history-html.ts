import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  JPOINT_HISTORY_SCHEMA,
  JPOINT_HISTORY_MAX_ROWS,
  jpointHistoryFailure as fail,
  readJPointHistory,
  type JPointAcquisitionRow,
  type JPointHistory,
} from "../../../domain/src/myjcb-jpoint-history.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";

export const JPOINT_HISTORY_HTML_VERSION = "myjcb-jpoint-history-html-v1";
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const kids = (node: Node): Node[] => ("childNodes" in node ? node.childNodes : []);
const elements = (node: Node): Element[] => kids(node).filter((n): n is Element => "tagName" in n);
const all = (node: Node): Element[] => [
  ...("tagName" in node ? [node as Element] : []),
  ...kids(node).flatMap(all),
];
const cls = (node: Element, name: string): boolean =>
  (node.attrs.find((a) => a.name === "class")?.value ?? "").split(/\s+/u).includes(name);
const text = (node: Node): string => ("value" in node ? node.value : kids(node).map(text).join(""));
const plain = (node: Element): string => {
  if (elements(node).length) return fail("cell_shape_unsupported");
  return text(node).trim();
};
const quantity = (node: Element): string => {
  const value = plain(node);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value) || value.length > 40) return fail("quantity_unparsed");
  return BigInt(value).toString();
};
const HEADERS = [
  ["獲得月（支払月）", "獲得ポイント", "使用済ポイント", "失効ポイント", "ポイント残高"],
  ["獲得月（支払月）", "当月獲得ポイント合計", "詳細"],
  ["獲得月（支払月）", "失効予定ポイント", "失効予定月", "ステータス"],
] as const;
const headerKey = (values: readonly string[]): string =>
  values.map((v) => v.normalize("NFKC")).join("|");
function acquisition(cell: Element): { acquiredOn: string; paymentText: string } {
  if (!cls(cell, "sp-fnt10px")) return fail("date_cell_unsupported");
  const nodes = kids(cell).filter((n) => !("value" in n && n.value.trim() === ""));
  if (
    nodes.length !== 3 ||
    !("value" in nodes[0]!) ||
    !("tagName" in nodes[1]!) ||
    nodes[1].tagName !== "br" ||
    !cls(nodes[1] as Element, "sp-block") ||
    !("tagName" in nodes[2]!) ||
    nodes[2].tagName !== "span"
  )
    return fail("date_cell_unsupported");
  const date = (nodes[0] as DefaultTreeAdapterMap["textNode"]).value.trim();
  if (!/^\d{4}\/\d{2}\/\d{2}$/u.test(date)) return fail("acquisition_date_unparsed");
  const acquiredOn = date.replaceAll("/", "-");
  if (!parseLocalDate(acquiredOn)) return fail("acquisition_date_unparsed");
  const paymentText = plain(nodes[2] as Element);
  if (!paymentText || paymentText.length > 32) return fail("payment_month_unparsed");
  return { acquiredOn, paymentText };
}
function tableRows(table: Element, width: number): Element[][] {
  if (all(table).some((n) => n.tagName !== "br" && !n.sourceCodeLocation?.endTag))
    return fail("table_incomplete");
  const sections = elements(table);
  if (sections.length !== 2 || sections[0]?.tagName !== "thead" || sections[1]?.tagName !== "tbody")
    return fail("table_shape_unsupported");
  const rows = elements(sections[1]!);
  if (rows.length < 1 || rows.length > JPOINT_HISTORY_MAX_ROWS)
    return fail("row_count_unsupported");
  return rows.map((row) => {
    const cells = elements(row);
    if (row.tagName !== "tr" || cells.length !== width || cells.some((n) => n.tagName !== "td"))
      return fail("row_shape_unsupported");
    return cells;
  });
}
function detail(cell: Element): {
  total: string;
  normal: string;
  preferential: string;
  bonus: string;
} {
  const parts = elements(cell);
  if (
    parts.length !== 2 ||
    parts.some((n) => n.tagName !== "div") ||
    !cls(parts[0]!, "inner") ||
    !cls(parts[1]!, "js-toggle-content")
  )
    return fail("detail_shape_unsupported");
  const lists = elements(parts[1]!);
  if (lists.length !== 1 || lists[0]?.tagName !== "dl" || !cls(lists[0], "detail"))
    return fail("detail_shape_unsupported");
  const entries = elements(lists[0]);
  const labels = ["通常獲得ポイント", "優遇ポイント", "ボーナスポイント"];
  if (entries.length !== 6) return fail("detail_shape_unsupported");
  const values = labels.map((label, i) => {
    if (
      entries[i * 2]?.tagName !== "dt" ||
      entries[i * 2 + 1]?.tagName !== "dd" ||
      plain(entries[i * 2]!) !== label
    )
      return fail("detail_label_unsupported");
    return quantity(entries[i * 2 + 1]!);
  });
  return {
    total: quantity(parts[0]!),
    normal: values[0]!,
    preferential: values[1]!,
    bonus: values[2]!,
  };
}
/** Raw HTTP HTML, before the site's JavaScript inserts scrolling wrappers and
 * toggle buttons. Never parse browser-generated duplicate header tables. */
export function normalizeJPointHistoryHtml(html: string, reportedTotal: string): JPointHistory {
  if (!html || new TextEncoder().encode(html).byteLength > 8 * 1024 * 1024 || html.includes("\0"))
    return fail("html_size_invalid");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const nodes = all(document);
  for (const tag of ["html", "body"]) {
    const roots = nodes.filter((n) => n.tagName === tag);
    if (roots.length !== 1 || !roots[0]!.sourceCodeLocation?.endTag)
      return fail("document_incomplete");
  }
  const panels = nodes.filter((n) => cls(n, "tab-panel"));
  if (panels.length !== 3) return fail("tab_count_unsupported");
  if (panels.some((panel) => all(panel).filter((node) => cls(node, "tab-panel")).length !== 1))
    return fail("tab_nesting_unsupported");
  const tables = new Map<number, Element>();
  for (const panel of panels) {
    if (!panel.sourceCodeLocation?.endTag) return fail("panel_incomplete");
    const wrappers = elements(panel).filter((n) => cls(n, "js-scrollable-tbl"));
    if (wrappers.length !== 1 || !wrappers[0]!.sourceCodeLocation?.endTag)
      return fail("raw_table_wrapper_unsupported");
    const contained = elements(wrappers[0]!);
    if (contained.length !== 1 || contained[0]?.tagName !== "table")
      return fail("raw_table_wrapper_unsupported");
    const table = contained[0];
    const sections = elements(table);
    const heads = sections[0] ? elements(sections[0]) : [];
    if (sections[0]?.tagName !== "thead" || heads.length !== 1 || heads[0]?.tagName !== "tr")
      return fail("header_unsupported");
    const headCells = elements(heads[0]);
    if (headCells.some((n) => n.tagName !== "th")) return fail("header_unsupported");
    const key = headerKey(headCells.map((n) => text(n).trim()));
    const kind = HEADERS.findIndex((headers) => headerKey(headers) === key);
    if (kind < 0 || tables.has(kind)) return fail("header_unsupported");
    tables.set(kind, table);
  }
  const overview = tableRows(tables.get(0)!, 5),
    details = tableRows(tables.get(1)!, 3),
    expiry = tableRows(tables.get(2)!, 4);
  if (overview.length !== details.length || overview.length !== expiry.length)
    return fail("tab_membership_mismatch");
  const rows = overview.map((cells, i): JPointAcquisitionRow => {
    const date = acquisition(cells[0]!);
    const detailDate = acquisition(details[i]![0]!),
      expiryDate = acquisition(expiry[i]![0]!);
    if (
      JSON.stringify(date) !== JSON.stringify(detailDate) ||
      JSON.stringify(date) !== JSON.stringify(expiryDate)
    )
      return fail("tab_acquisition_mismatch");
    const values = cells.slice(1).map((cell) => {
      if (!cls(cell, "num") || !cls(cell, "sp-fnt10px")) return fail("numeric_cell_unsupported");
      return quantity(cell);
    });
    const components = detail(details[i]![1]!);
    if (plain(details[i]![2]!) !== "開く" || components.total !== values[0])
      return fail("detail_total_mismatch");
    if (quantity(expiry[i]![1]!) !== values[3]) return fail("expiry_remaining_mismatch");
    const expiryText = plain(expiry[i]![2]!);
    if (expiryText !== "-" && !/^\d{4}\/(?:0[1-9]|1[0-2])$/u.test(expiryText))
      return fail("expiry_month_unparsed");
    const status = plain(expiry[i]![3]!);
    if (status !== "-" && status !== "有効") return fail("status_unobserved");
    return {
      ...date,
      earned: values[0]!,
      used: values[1]!,
      expired: values[2]!,
      remaining: values[3]!,
      normal: components.normal,
      preferential: components.preferential,
      bonus: components.bonus,
      expiryMonth: expiryText === "-" ? null : expiryText.replace("/", "-"),
      status,
    };
  });
  return readJPointHistory({ schemaVersion: JPOINT_HISTORY_SCHEMA, reportedTotal, rows });
}
