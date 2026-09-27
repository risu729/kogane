// Person names are removed from a MyJCB page before it is stored (ADR 0029,
// amendment 2026-09-27: class (d) applies to stored evidence).
//
// Only rows that have been observed to carry a person's name are listed, by
// the label of their header cell; nothing is guessed from other text. The
// statement page's 「カード情報」 table shows the debit account as vertical
// th/td rows, and its 口座名義 row is the account holder's name as the
// provider masks it (a partially masked name is still a name). The row's
// value cell keeps its element and receives a fixed marker, so the table's
// shape — and every other row of it (カード名称, カード発行会社, 金融機関名,
// 支店名, 科目・口座番号, which are not names) — stays as the page had it.
import type { DefaultTreeAdapterMap } from "parse5";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

/** What a stored page carries in place of a person's name. */
export const NAME_REDACTION_MARKER = "[redacted:name]";

/** Header-cell labels whose value cell is a person's name (observed 2026-09-27). */
const PERSON_NAME_ROW_LABELS: readonly string[] = ["口座名義"];

/**
 * Replaces the content of the value cell that follows every listed header
 * cell with the marker, in place. A listed header without a following `td`
 * in its row is a layout nobody has observed: the name could be anywhere, so
 * the page is refused with a stable code rather than stored.
 */
export function redactPersonNameCells(root: HtmlNode): void {
  for (const header of elements(root, "th")) {
    if (!PERSON_NAME_ROW_LABELS.includes(normalizedText(header))) continue;
    const value = nextElementSibling(header);
    if (value === undefined || value.tagName !== "td") {
      throw new Error("artifact_name_redaction_invalid");
    }
    value.childNodes = [
      {
        nodeName: "#text",
        value: NAME_REDACTION_MARKER,
        parentNode: value,
      } as DefaultTreeAdapterMap["textNode"],
    ];
  }
}

/** How many name cells a redacted page carries the marker in: a count only. */
export function nameRedactionCount(html: string): number {
  return html.split(NAME_REDACTION_MARKER).length - 1;
}

function elements(node: HtmlNode, tagName: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  const visit = (current: HtmlNode): void => {
    if ("tagName" in current && current.tagName === tagName) found.push(current);
    // Run after the sanitizer, which has already removed <template>.
    if ("childNodes" in current) for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return found;
}

function nextElementSibling(element: HtmlElement): HtmlElement | undefined {
  const siblings =
    element.parentNode && "childNodes" in element.parentNode ? element.parentNode.childNodes : [];
  for (let index = siblings.indexOf(element) + 1; index < siblings.length; index += 1) {
    const sibling = siblings[index]!;
    if ("tagName" in sibling) return sibling;
  }
  return undefined;
}

function normalizedText(node: HtmlNode): string {
  const parts: string[] = [];
  const visit = (current: HtmlNode): void => {
    if (current.nodeName === "#text") parts.push((current as { value: string }).value);
    if ("childNodes" in current) for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return parts.join("").replace(/\s+/gu, "").trim();
}
