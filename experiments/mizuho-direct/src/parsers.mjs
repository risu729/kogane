import { parse } from "parse5";

/** All errors are fixed codes; provider text and private values are not copied. */
export class MizuhoParseError extends Error {
  constructor(code) {
    super(code);
    this.name = "MizuhoParseError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new MizuhoParseError(code);
};
const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const classes = (node) => (attr(node, "class") ?? "").split(/\s+/u);
function find(node, predicate) {
  const result = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop();
    if (predicate(current)) result.push(current);
    pending.push(...(current.childNodes ?? []).toReversed());
  }
  return result;
}
function text(node) {
  return find(node, (n) => n.nodeName === "#text")
    .map((n) => n.value)
    .join("")
    .trim();
}
function one(nodes, code) {
  if (nodes.length !== 1) fail(code);
  return nodes[0];
}
function byId(node, id) {
  return find(node, (n) => attr(n, "id") === id);
}
function value(node, id) {
  return text(one(byId(node, id), "missing-or-duplicate-field"));
}
function requiredText(input) {
  if (!input || input.length > 512 || /[\u0000-\u001f\u007f]/u.test(input)) fail("invalid-text");
  return input;
}
function form(html, name) {
  if (typeof html !== "string" || !html || html.length > 1024 * 1024) fail("invalid-html-size");
  const document = parse(html);
  const forms = find(document, (n) => n.tagName === "form");
  if (forms.some((n) => /^LOGBNK/u.test(attr(n, "name") ?? ""))) fail("authentication-required");
  return one(
    forms.filter((n) => attr(n, "name") === name),
    "unrecognized-page",
  );
}
function accountIdentity(input) {
  const match = /^(\d{3})-(\d{7})$/u.exec(input);
  if (!match) fail("invalid-account-identifier");
  return { branchCode: match[1], accountNumber: match[2] };
}
function yen(input, signed = false) {
  const pattern = signed
    ? /^[+-](?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u
    : /^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u;
  if (!pattern.test(input) || input.length > 30) fail("invalid-yen-amount");
  return BigInt(input.replaceAll(",", "")).toString();
}
function indexFrom(node, prefix) {
  const matches = find(node, (n) => (attr(n, "id") ?? "").startsWith(prefix));
  const id = attr(one(matches, "missing-or-duplicate-field"), "id");
  const index = id.slice(prefix.length);
  if (!/^\d{3}$/u.test(index)) fail("invalid-row-index");
  return index;
}
function uniqueIndexes(rows) {
  if (new Set(rows.map((row) => row.sourceIndex)).size !== rows.length) fail("duplicate-row-index");
}

/**
 * Ordinary JPY account records. Amounts are canonical integer yen strings.
 * Returned branch/account identifiers and monetary values are private data.
 */
export function parseAccountPage(html) {
  const page = form(html, "BALINQ_03010B");
  const cards = find(page, (n) => classes(n).includes("btn-account"));
  if (!cards.length) fail("unrecognized-empty-state");
  const accounts = cards.map((card) => {
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

function date(input) {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(input);
  if (!match) fail("invalid-transaction-date");
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
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
function count(input) {
  if (!/^(?:0|[1-9]\d*)$/u.test(input) || !Number.isSafeInteger(Number(input)))
    fail("invalid-count");
  return Number(input);
}

/**
 * Parse one observed history page and verify its account against discovery.
 * sourceIndex is page-local, never a stable transaction ID. Separate rows are
 * preserved even when date, description and amount are identical.
 */
export function parseHistoryPage(html, account) {
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
  if (expected.accountNumber !== observedNumber || value(page, "txtBrnch") !== account.branchName)
    fail("account-mismatch");
  if (value(page, "txtTransType") !== "普通") fail("unsupported-account-kind");
  const rows = find(page, (n) => classes(n).includes("box-row-tx-ditails"));
  if (!rows.length) fail("unrecognized-empty-state");
  const transactions = rows.map((row) => {
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
      balanceAfterYen: balanceValues[0],
    };
  });
  uniqueIndexes(transactions);
  const range = /^(\d+)\s*-\s*(\d+)\s*件$/u.exec(value(page, "txtDispDetails"));
  if (!range) fail("invalid-displayed-range");
  const from = count(range[1]),
    to = count(range[2]),
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
