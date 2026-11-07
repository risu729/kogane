import { parse } from "parse5";

interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  value?: string;
}
export interface MizuhoAccountContext {
  source: "mizuho";
  accountType: "ordinary-deposit";
  currency: "JPY";
  branchCode: string;
  accountNumber: string;
  branchName?: string;
}
export interface MizuhoAccount extends MizuhoAccountContext {
  sourceIndex: string;
  branchName: string;
  balanceYen: string;
  availableBalanceYen: string;
}
export interface MizuhoTransaction {
  sourceIndex: string;
  date: string;
  description: string;
  amountYen: string;
  balanceAfterYen: string;
}
export interface MizuhoHistory {
  source: "mizuho";
  currency: "JPY";
  accountType: "ordinary-deposit";
  branchCode: string;
  accountNumber: string;
  displayedRange: { from: number; to: number; total: number };
  hasMore: boolean;
  transactions: MizuhoTransaction[];
}

/** All errors are fixed codes; provider text and private values are not copied. */
export class MizuhoParseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "MizuhoParseError";
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new MizuhoParseError(code);
};
const attr = (node: Node, name: string): string | undefined =>
  node.attrs?.find((a) => a.name === name)?.value;
const classes = (node: Node): string[] => (attr(node, "class") ?? "").split(/\s+/u);
function find(node: Node, predicate: (node: Node) => boolean): Node[] {
  const result: Node[] = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (predicate(current)) result.push(current);
    pending.push(...[...(current.childNodes ?? [])].reverse());
  }
  return result;
}
function text(node: Node): string {
  return find(node, (n) => n.nodeName === "#text")
    .map((n) => n.value)
    .join("")
    .trim();
}
function one(nodes: Node[], code: string): Node {
  if (nodes.length !== 1) fail(code);
  return nodes[0]!;
}
function byId(node: Node, id: string): Node[] {
  return find(node, (n) => attr(n, "id") === id);
}
function value(node: Node, id: string): string {
  return text(one(byId(node, id), "missing-or-duplicate-field"));
}
function requiredText(input: string): string {
  if (!input || input.length > 512 || /[\u0000-\u001f\u007f]/u.test(input)) fail("invalid-text");
  return input;
}
function form(html: string, name: string): Node {
  if (typeof html !== "string" || !html || html.length > 1024 * 1024) fail("invalid-html-size");
  const document = parse(html);
  const forms = find(document, (n) => n.tagName === "form");
  if (forms.some((n) => /^LOGBNK/u.test(attr(n, "name") ?? ""))) fail("authentication-required");
  return one(
    forms.filter((n) => attr(n, "name") === name),
    "unrecognized-page",
  );
}
function accountIdentity(input: string): { branchCode: string; accountNumber: string } {
  const match = /^(\d{3})-(\d{7})$/u.exec(input);
  if (!match) fail("invalid-account-identifier");
  return { branchCode: match![1]!, accountNumber: match![2]! };
}
function yen(input: string, signed = false): string {
  const pattern = signed
    ? /^[+-](?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u
    : /^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u;
  if (!pattern.test(input) || input.length > 30) fail("invalid-yen-amount");
  return BigInt(input.replaceAll(",", "")).toString();
}
function indexFrom(node: Node, prefix: string): string {
  const matches = find(node, (n) => (attr(n, "id") ?? "").startsWith(prefix));
  const id = attr(one(matches, "missing-or-duplicate-field"), "id");
  const index = id!.slice(prefix.length);
  if (!/^\d{3}$/u.test(index)) fail("invalid-row-index");
  return index;
}
function uniqueIndexes(rows: readonly { sourceIndex: string }[]): void {
  if (new Set(rows.map((row) => row.sourceIndex)).size !== rows.length) fail("duplicate-row-index");
}

/**
 * Ordinary JPY account records. Amounts are canonical integer yen strings.
 * Returned branch/account identifiers and monetary values are private data.
 */
export function parseAccountPage(html: string): { source: "mizuho"; accounts: MizuhoAccount[] } {
  const page = form(html, "BALINQ_03010B");
  const cards = find(page, (n) => classes(n).includes("btn-account"));
  if (!cards.length) fail("unrecognized-empty-state");
  const accounts = cards.map((card): MizuhoAccount => {
    const sourceIndex = indexFrom(card, "txtAccType_");
    if (
      value(card, `txtAccType_${sourceIndex}`) !== "普通預金" ||
      value(card, `txtCrntBalBrrwBalCrenCode_${sourceIndex}`) !== "円"
    ) {
      fail("unsupported-account-kind");
    }
    return {
      source: "mizuho",
      sourceIndex,
      accountType: "ordinary-deposit",
      currency: "JPY",
      ...accountIdentity(value(card, `txtAccNo_${sourceIndex}`)),
      branchName: requiredText(value(card, `txtBrnch_${sourceIndex}`)),
      balanceYen: yen(value(card, `txtCrntBalBrrwBal_${sourceIndex}`)),
      availableBalanceYen: yen(value(card, `txtBrrwUsblBal_${sourceIndex}`)),
    };
  });
  uniqueIndexes(accounts);
  const identities = accounts.map((a) => `${a.branchCode}-${a.accountNumber}`);
  if (new Set(identities).size !== accounts.length) fail("duplicate-account");
  return { source: "mizuho", accounts };
}

function date(input: string): string {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(input);
  if (!match) fail("invalid-transaction-date");
  const year = Number(match![1]),
    month = Number(match![2]),
    day = Number(match![3]);
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  )
    fail("invalid-transaction-date");
  return result.toISOString().slice(0, 10);
}
function count(input: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(input) || !Number.isSafeInteger(Number(input)))
    fail("invalid-count");
  return Number(input);
}

/**
 * Parse one observed history page and verify its account against discovery.
 * sourceIndex is page-local, never a stable transaction ID. Separate rows are
 * preserved even when date, description and amount are identical.
 */
export function parseHistoryPage(html: string, account: MizuhoAccountContext): MizuhoHistory {
  if (
    !account ||
    account.source !== "mizuho" ||
    account.accountType !== "ordinary-deposit" ||
    account.currency !== "JPY"
  )
    fail("invalid-account-context");
  const expected = accountIdentity(`${account.branchCode}-${account.accountNumber}`);
  const page = form(html, "ACCHST_04110B");
  const observedNumber = value(page, "txtAccNo");
  if (!/^\d{7}$/u.test(observedNumber)) fail("invalid-account-identifier");
  const branchName = requiredText(value(page, "txtBrnch"));
  if (
    expected.accountNumber !== observedNumber ||
    (account.branchName !== undefined && branchName !== account.branchName)
  )
    fail("account-mismatch");
  if (value(page, "txtTransType") !== "普通") fail("unsupported-account-kind");
  const rows = find(page, (n) => classes(n).includes("box-row-tx-ditails"));
  if (!rows.length) fail("unrecognized-empty-state");
  const transactions = rows.map((row): MizuhoTransaction => {
    const sourceIndex = indexFrom(row, "txtTransCntnt_");
    const amountColumn = one(
      find(row, (n) => classes(n).includes("t1-2")),
      "invalid-amount-column",
    );
    const amountNode = one(
      find(amountColumn, (n) => classes(n).includes("amount")),
      "invalid-amount-column",
    );
    const currency = one(
      find(amountNode, (n) => n.tagName === "small"),
      "invalid-transaction-currency",
    );
    if (text(currency) !== "円") fail("unsupported-transaction-currency");
    const amountText = (amountNode.childNodes ?? [])
      .filter((n) => n.nodeName === "#text")
      .map((n) => n.value)
      .join("")
      .trim()
      .replace(/^([+-]) +(?=\d)/u, "$1");
    const balances = byId(row, `txtEachBal_${sourceIndex}`);
    if (balances.length < 1 || balances.length > 2) fail("missing-or-duplicate-balance");
    const balanceValues = balances.map((node) => yen(text(node)));
    if (new Set(balanceValues).size !== 1) fail("conflicting-responsive-balances");
    return {
      sourceIndex,
      date: date(value(row, `txtDate_${sourceIndex}`)),
      description: requiredText(value(row, `txtTransCntnt_${sourceIndex}`)),
      amountYen: yen(amountText, true),
      balanceAfterYen: balanceValues[0]!,
    };
  });
  uniqueIndexes(transactions);
  const range = /^(\d+)\s*-\s*(\d+)\s*件$/u.exec(value(page, "txtDispDetails"));
  if (!range) fail("invalid-displayed-range");
  const from = count(range![1]!),
    to = count(range![2]!),
    total = count(value(page, "txtAllDispDetails"));
  if (from < 1 || to < from || to > total || to - from + 1 !== transactions.length)
    fail("inconsistent-row-count");
  return {
    source: "mizuho",
    currency: "JPY",
    accountType: "ordinary-deposit",
    ...expected,
    displayedRange: { from, to, total },
    hasMore: to < total,
    transactions,
  };
}

const PRESERVED_FIELDS =
  /^(?:txt(?:AccType|Brnch|AccNo|CrntBalBrrwBal|CrntBalBrrwBalCrenCode|BrrwUsblBal|TransCntnt|Date|EachBal)_\d{3}|txt(?:Brnch|TransType|AccNo|DispDetails|AllDispDetails))$/u;
const PRESERVED_CLASSES = new Set(["btn-account", "box-row-tx-ditails", "t1-2", "amount"]);
const PRESERVED_TAGS = new Set(["form", "button", "div", "p", "span", "small"]);
const escapeHtml = (input: string): string =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A minimized provider capture: financial fields retained, auth/URLs removed. */
export function sanitizeMizuhoPage(html: string): string {
  if (typeof html !== "string" || !html || html.length > 1024 * 1024) fail("invalid-html-size");
  const document: Node = parse(html);
  const forms = find(document, (node) => node.tagName === "form");
  if (forms.some((node) => /^LOGBNK/u.test(attr(node, "name") ?? "")))
    fail("authentication-required");
  const target = one(
    forms.filter((node) => ["BALINQ_03010B", "ACCHST_04110B"].includes(attr(node, "name") ?? "")),
    "unrecognized-page",
  );
  function render(node: Node, currencyChild = false): string {
    if (!node.tagName || !PRESERVED_TAGS.has(node.tagName)) return "";
    if (attr(node, "hidden") !== undefined) return "";
    const id = attr(node, "id") ?? "";
    const knownId = PRESERVED_FIELDS.test(id);
    const keptClasses = classes(node).filter((name) => PRESERVED_CLASSES.has(name));
    // Amount columns include the signed amount and its currency; responsive
    // balance values are retained independently through their known field IDs.
    const isAmount = keptClasses.includes("amount");
    const retainText = knownId || isAmount || (node.tagName === "small" && currencyChild);
    const children = (node.childNodes ?? [])
      .map((child) =>
        child.nodeName === "#text"
          ? retainText
            ? escapeHtml(child.value ?? "")
            : ""
          : render(child, isAmount && child.tagName === "small"),
      )
      .join("");
    if (!children && node.tagName !== "form") return "";
    const attributes =
      (knownId ? ` id="${id}"` : "") +
      (keptClasses.length ? ` class="${keptClasses.join(" ")}"` : "") +
      (node.tagName === "form" ? ` name="${attr(node, "name")}"` : "");
    return `<${node.tagName}${attributes}>${children}</${node.tagName}>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${render(target)}</body></html>`;
}
