// The debit account a MyJCB credit detail page states about itself, in its
// 「カード情報」 table (ADR 0032, 2026-09-27 amendment;
// docs/sources/myjcb.md, カード情報). Observed on the confirmed statement page
// and on the ショッピングスキップ払い page, live and in the stored redacted
// HTML: an `h3.hdg-H3` heading 「カード情報」 after the ledger, followed by a
// `table.table-data` of vertical th/td rows:
//
//   カード名称       product name            never read
//   カード発行会社   issuer                  never read
//   金融機関名       bank name               read
//   支店名           branch name             read
//   科目・口座番号   「普通 ####***」          read: type, leading digits, mask
//   口座名義         holder name, masked     never read (ADR 0029 class d)
//
// Only the three rows Kogane uses are read. The other rows' labels are
// checked, so a changed table is refused, but their values are never looked
// at. Any other shape is a closed refusal code (INV05), never a partial
// reading.
//
// The input is a parse5 document, as for `readMyJcbStatementPage`, so this
// module needs no HTML parser of its own.
import type { StatementPageNode } from "./myjcb-statement-page.ts";

const CARD_INFORMATION_HEADING = "カード情報";
const READ_LABELS = {
  bankName: "金融機関名",
  branchName: "支店名",
  account: "科目・口座番号",
} as const;
/** Labels whose value is never read, only their presence checked. */
const UNREAD_LABELS = ["カード名称", "カード発行会社", "口座名義"] as const;
const ALL_LABELS = new Set<string>([...Object.values(READ_LABELS), ...UNREAD_LABELS]);
/**
 * 科目 + one space + exactly four ASCII digits + the masked rest as `*`. The
 * observed mask is three; any count from one to twelve is read and recorded.
 */
const ACCOUNT_VALUE = /^(普通|当座) ([0-9]{4})(\*{1,12})$/u;
const MAX_NAME_LENGTH = 64;

const CARD_INFORMATION_REFUSALS = [
  /** No 「カード情報」 heading on the page. */
  "card_information_absent",
  /** More than one heading. */
  "card_information_ambiguous",
  /** No `table.table-data` follows the heading. */
  "card_information_table_missing",
  /** A row that is not one th and one td, an unknown or repeated label, or a
   * missing read label. */
  "card_information_table_invalid",
  /** The bank or branch name is empty, too long, or contains digits or `*`. */
  "card_information_name_invalid",
  /** The account value is not 「普通|当座 ####*…」. */
  "card_information_account_invalid",
] as const;
type CardInformationRefusal = (typeof CARD_INFORMATION_REFUSALS)[number];

interface CardInformation {
  bankName: string;
  branchName: string;
  /** The 科目 text as displayed. */
  accountType: "普通" | "当座";
  /** Exactly four ASCII digits: the first digits of the account number. */
  leadingDigits: string;
  /** How many `*` follow the leading digits. */
  maskedDigitCount: number;
}

export type CardInformationReading =
  | { outcome: "read"; information: CardInformation }
  | { outcome: "refused"; code: CardInformationRefusal };

export function readMyJcbCardInformation(document: StatementPageNode): CardInformationReading {
  const refused = (code: CardInformationRefusal): CardInformationReading => ({
    outcome: "refused",
    code,
  });
  const ordered = elements(document);
  const headings = ordered.filter(
    (element) =>
      element.tagName === "h3" &&
      hasClass(element, "hdg-H3") &&
      compact(text(element)) === CARD_INFORMATION_HEADING,
  );
  if (headings.length === 0) return refused("card_information_absent");
  if (headings.length > 1) return refused("card_information_ambiguous");
  const headingIndex = ordered.indexOf(headings[0]!);
  // The first table after the heading, in document order, is the heading's
  // table; the heading itself contains no table.
  const table = ordered.slice(headingIndex + 1).find((element) => element.tagName === "table");
  if (table === undefined || !hasClass(table, "table-data"))
    return refused("card_information_table_missing");

  const values = new Map<string, StatementPageNode>();
  for (const row of elements(table).filter((element) => element.tagName === "tr")) {
    const cells = children(row);
    if (cells.length !== 2 || cells[0]!.tagName !== "th" || cells[1]!.tagName !== "td")
      return refused("card_information_table_invalid");
    const label = compact(text(cells[0]!));
    if (!ALL_LABELS.has(label) || values.has(label))
      return refused("card_information_table_invalid");
    values.set(label, cells[1]!);
  }
  const cell = (label: string): StatementPageNode | undefined => values.get(label);
  const bankCell = cell(READ_LABELS.bankName);
  const branchCell = cell(READ_LABELS.branchName);
  const accountCell = cell(READ_LABELS.account);
  if (bankCell === undefined || branchCell === undefined || accountCell === undefined)
    return refused("card_information_table_invalid");

  const bankName = spaced(text(bankCell));
  const branchName = spaced(text(branchCell));
  if (!validName(bankName) || !validName(branchName))
    return refused("card_information_name_invalid");
  const account = ACCOUNT_VALUE.exec(spaced(text(accountCell)));
  if (account === null) return refused("card_information_account_invalid");
  return {
    outcome: "read",
    information: {
      bankName,
      branchName,
      accountType: account[1] as "普通" | "当座",
      leadingDigits: account[2]!,
      maskedDigitCount: account[3]!.length,
    },
  };
}

function validName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    !/[0-9０-９*＊]/u.test(value) &&
    // Control characters would never be page text a person reads.
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** Every element in document order. */
function elements(node: StatementPageNode): StatementPageNode[] {
  const result: StatementPageNode[] = [];
  if (node.tagName !== undefined) result.push(node);
  for (const child of node.childNodes ?? []) result.push(...elements(child));
  return result;
}

function children(node: StatementPageNode): StatementPageNode[] {
  return (node.childNodes ?? []).filter((child) => child.tagName !== undefined);
}

function hasClass(element: StatementPageNode, className: string): boolean {
  const value = element.attrs?.find((attribute) => attribute.name === "class")?.value ?? "";
  return value.split(/\s+/u).includes(className);
}

function text(node: StatementPageNode): string {
  if (node.value !== undefined) return node.value;
  return (node.childNodes ?? []).map(text).join(" ");
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

/** Runs of whitespace (including U+3000 and U+00A0) as one space, trimmed. */
function spaced(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
