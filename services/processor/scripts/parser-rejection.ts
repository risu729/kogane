// Closed rejection categories for the read-only parser diagnostics
// (`diagnose.ts`, `replay-diagnostics.ts`). Pure: no bindings, no I/O, so the
// classification is unit-tested without wrangler (test/parser-rejection.test.ts).
//
// What may leave this module: a parser's fixed message text, the schema label
// the parser built from its own constants and the provider's field names, and
// counts. What never does: a value, a row, an identifier, a currency code the
// payload carried, or an unfiltered exception message. A label is printed only
// for the SBI Shinsei parsers, whose every label is proved (by the test) to be
// assembled from constants, array positions and schema keys; row positions
// are folded to `[]` so a category is closed and does not count rows. For
// `global-pass-activity` a label is one of three view names and a field one of
// the parser's header constants.
import { parse } from "parse5";
import { SKIP_PAYMENT_SCHEDULE_HEADING } from "../../../packages/domain/src/myjcb-skip-payment-schedule.ts";
import type { GlobalPassDomNode } from "../../../packages/parsers/src/parsers/global-pass-activity.ts";
import { SKIP_PAYMENT_SCHEDULE_PARSER_CODES } from "../../../packages/parsers/src/parsers/myjcb-skip-payment-schedule.ts";

/**
 * `myjcb-skip-payment-schedule` throws only closed codes (ADR 0005 amendment
 * e), so its message is its category when it is one of them, and nothing
 * else is printed.
 */
const SKIP_PAYMENT_SCHEDULE_PARSER = "myjcb-skip-payment-schedule";

/** The parsers whose throw sites map one-to-one onto categories. */
export const SBI_SHINSEI_PARSERS = [
  "sbi-shinsei-top-balances-and-activity",
  "sbi-shinsei-yen-deposit-account",
  "sbi-shinsei-exchange-rate",
  "sbi-shinsei-balance-summary-and-stage",
] as const;

export interface RejectionCategory {
  /** The parser's fixed message text, or a closed code for anything else. */
  reason: string;
  /** Schema path the parser named, row positions folded to `[]`. */
  label?: string;
  /** Schema field name, for `unknown field`, `missing field` and `expected a scalar`. */
  field?: string;
}

/**
 * Messages the SBI Shinsei parsers throw with no label. `UTF8_REFUSAL` is the
 * shared `decodeUtf8` of `packages/parsers/src/parsers/util.ts`, which every
 * SBI Shinsei parser calls before its own checks.
 */
const UTF8_REFUSAL =
  "artifact bytes are not valid UTF-8; the artifact's encoding is not recorded, so no decoder can be selected";
const STANDALONE = [
  "SBI Shinsei observations require a successful failure-free parent run",
  "provider timestamp must be a string",
  "provider timestamp format is not recognized",
  "provider timestamp is invalid",
] as const;

/**
 * The `${label}: <text>` messages, as the fixed text. An entry whose text
 * continues with payload content (a field name, a currency code) is matched by
 * prefix and the continuation is either validated as a field name or dropped.
 */
const LABELLED = [
  "invalid JSON",
  "response was not successful",
  "expected an object",
  "expected an array",
  "cardinality exceeds audited bound",
  "expected a scalar",
  "expected a non-empty string",
  "invalid provider currency",
  "expected an exact decimal",
  "invalid date",
  "successful wrapper contains an error",
  "duplicate provider account identity",
  "incomplete activity window",
  "activity window is reversed",
  "duplicate transaction identity",
  "expected exactly one debit or credit",
  "expected an unsigned side amount",
  "outside declared activity window",
  "the exchange-rate board is empty",
  "the exchange-rate board has no quote row",
  // sbi-shinsei-balance-summary-and-stage (ADR 0031)
  "schema is not known",
  "expected a non-empty string or a finite number",
] as const;
const FIELD_PREFIXES = ["unknown field ", "missing field "] as const;
/** Continuations that carry a payload value: the value is dropped. */
const VALUE_SUFFIXED: readonly (readonly [RegExp, string])[] = [
  [/^not exactly representable in \S+$/u, "not exactly representable in the currency"],
  [
    /^the board lists \S+ twice in one customerCategory$/u,
    "the board lists a currency twice in one customerCategory",
  ],
];

/**
 * A schema key: letters and underscores. An `unknown field` key is chosen by
 * the provider, not the parser, so a key that could carry a value is refused:
 * any digit (a date, an account number, a hash) or an all-capital word (a
 * currency code). No key any SBI Shinsei parser accepts has either.
 */
const SCHEMA_KEY = /^[A-Za-z][A-Za-z_]{0,63}$/u;
function isSchemaKey(name: string): boolean {
  return SCHEMA_KEY.test(name) && !/^[A-Z]+$/u.test(name);
}
/**
 * A dataset name or a `json:$.` locator, then dot-separated schema keys and
 * folded positions. Anything else (a label that would carry text the parser
 * did not build from schema) is refused as a whole.
 */
const SAFE_LABEL = /^(?:json:\$|[a-z][a-z-]{0,63})((?:\.[A-Za-z][A-Za-z_]{0,63}|\[\]){0,24})$/u;

function foldLabel(label: string): string | undefined {
  const folded = label.replace(/\[\d{1,6}\]/gu, "[]");
  const keys = SAFE_LABEL.exec(folded)?.[1];
  if (keys === undefined) return undefined;
  for (const key of keys.split(/\.|\[\]/u)) if (key !== "" && !isSchemaKey(key)) return undefined;
  return folded;
}

function labelled(reason: string, rawLabel: string, field?: string): RejectionCategory {
  const label = foldLabel(rawLabel);
  if (label === undefined) return { reason: "label_unrecognized" };
  if (field !== undefined && !isSchemaKey(field))
    return { reason: `${reason} (field name unrecognized)`, label };
  return field === undefined ? { reason, label } : { reason, label, field };
}

/** The category of one SBI Shinsei parser message. */
export function classifySbiShinseiMessage(message: string): RejectionCategory {
  if (message === UTF8_REFUSAL) return { reason: "artifact bytes are not valid UTF-8" };
  for (const text of STANDALONE) if (message === text) return { reason: text };
  const separator = message.indexOf(": ");
  if (separator <= 0) return { reason: "unclassified" };
  const label = message.slice(0, separator);
  const text = message.slice(separator + 2);
  if (text === "expected a scalar") {
    // `${label}.${field}: expected a scalar`
    const dot = label.lastIndexOf(".");
    if (dot <= 0) return { reason: "unclassified" };
    return labelled(text, label.slice(0, dot), label.slice(dot + 1));
  }
  for (const known of LABELLED) if (text === known) return labelled(known, label);
  for (const prefix of FIELD_PREFIXES)
    if (text.startsWith(prefix))
      return labelled(prefix.trimEnd(), label, text.slice(prefix.length));
  for (const [pattern, reason] of VALUE_SUFFIXED)
    if (pattern.test(text)) return labelled(reason, label);
  return { reason: "unclassified" };
}

/** Error classes a runtime defect (not a parser refusal) would throw. */
const RUNTIME_ERRORS = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError"]);

/**
 * The category of a thrown parser error. A plain `Error` from an SBI Shinsei
 * parser or from `global-pass-activity` maps to its throw site; any other
 * parser keeps the older coarse reasons of `legacySafeReason`. A non-`Error` class is a runtime defect, not
 * a refusal, and is named by its standard class only.
 */
export function classifyParserRejection(parserName: string, error: unknown): RejectionCategory {
  if (!(error instanceof Error)) return { reason: "non_error_throw" };
  if (error.constructor !== Error)
    return { reason: `runtime_${RUNTIME_ERRORS.has(error.name) ? error.name : "other"}` };
  if ((SBI_SHINSEI_PARSERS as readonly string[]).includes(parserName))
    return classifySbiShinseiMessage(error.message);
  if (parserName === GLOBAL_PASS_ACTIVITY_PARSER) return classifyGlobalPassMessage(error.message);
  if (parserName === SKIP_PAYMENT_SCHEDULE_PARSER)
    return (SKIP_PAYMENT_SCHEDULE_PARSER_CODES as readonly string[]).includes(error.message)
      ? { reason: error.message }
      : { reason: "parser_rejected_other" };
  const reason = legacySafeReason(error.message);
  const field = error.message.match(
    /(?:unknown|missing) field ([A-Za-z][A-Za-z0-9_]{0,63})$/u,
  )?.[1];
  return field === undefined || !isSchemaKey(field) ? { reason } : { reason, field };
}

/**
 * Parser source positions (`file.ts:line:column`) from an error's stack
 * frames. The message is cut out first: a provider key in an `unknown field`
 * message could itself be shaped like a frame and would otherwise be printed.
 */
export function throwSites(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  const stack = error.stack ?? "";
  const frames = error.message === "" ? stack : stack.replace(error.message, "");
  return [...frames.matchAll(/parsers\/([a-z0-9-]+\.ts:\d+:\d+)/gu)].map((match) => match[1]!);
}

/** The coarse reasons `diagnose.ts` printed before throw sites were closed. */
export function legacySafeReason(message: string): string {
  for (const reason of [
    "MTS payload length disagrees with recordCount",
    "MTS positions payload is incomplete",
    "MTS empty-result layout disagrees with its count fields",
    "Sony history CSV media type drift",
    "Sony history CSV charset drift",
    "Sony history fetch window is missing",
    "Sony WALLET media type drift",
    "Sony WALLET month selector drift",
    "Sony JSON media type drift",
    "unknown field",
    "missing field",
    "expected an object",
    "expected an array",
    "HTML doctype drift",
    "activity table cardinality drift",
    "month selector cardinality drift",
    "provider timestamp format is not recognized",
  ]) {
    if (message.includes(reason)) return reason;
  }
  if (/schema/u.test(message)) return "unsupported_schema";
  if (/fields changed/u.test(message))
    return message.includes("depositRecordList")
      ? "record_fields_changed"
      : message.includes("pages[")
        ? "page_fields_changed"
        : "bundle_fields_changed";
  if (/exact decimal/u.test(message)) return "decimal_shape_rejected";
  if (/pagination|page metadata|page chain|page inventory/u.test(message))
    return "pagination_rejected";
  if (/incomplete|truncated|length|width/u.test(message)) return "incomplete_payload";
  if (/duplicate did/u.test(message)) return "duplicate_record_id";
  if (/must be|is invalid|unsupported|not successful/u.test(message)) return "field_value_rejected";
  return "parser_rejected_other";
}

// ── structural shape of a top-accounts-balance-and-activity capture ─────────
//
// One rejection names only the first failing check. This summary counts the
// shape classes of every value the parser checks semantically, so one replay
// shows every rule a capture would meet. Classes, booleans and counts only.

type Counts = Record<string, number>;

/** Shape class of an amount cell: never its digits. */
export function amountShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? "number_integer" : "number_other";
  if (typeof value !== "string") return "other_type";
  if (value === "") return "empty";
  if (value.trim() !== value) return "padded";
  const unsigned = value.replace(/^[+-]/u, "");
  const sign = value.startsWith("-") ? "negative_" : value.startsWith("+") ? "plus_" : "";
  if (/^\d+$/u.test(unsigned)) return `${sign}plain_integer`;
  if (/^\d+\.\d+$/u.test(unsigned)) return `${sign}plain_fraction`;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(unsigned)) return `${sign}grouped`;
  return "other_string";
}

/** Whether an amount string is a zero in any exact spelling. */
function isZero(value: unknown): boolean {
  return typeof value === "string" && /^[+-]?0+(?:\.0+)?$/u.test(value);
}

/** Shape class of a date cell. */
export function dateShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return "other_type";
  if (value === "") return "empty";
  if (/^\d{8}$/u.test(value)) return "compact8";
  if (/^\d{4}\/\d{2}\/\d{2}$/u.test(value)) return "slashed";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "dashed";
  if (/^\d{4}[/-]\d{2}[/-]\d{2}[ T]/u.test(value)) return "date_with_time";
  return "other_string";
}

/** Shape class of `systemResponseTime`. */
export function timestampShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return "other_type";
  if (value === "") return "empty";
  if (/^\d{14}$/u.test(value)) return "digits14";
  if (/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return "slashed_datetime";
  if (/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d+$/u.test(value))
    return "slashed_datetime_fraction";
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) return "iso_like";
  if (/^\d{17}$/u.test(value)) return "digits17";
  return "other_string";
}

/** Shape class of a currency cell. */
export function currencyShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value !== "string") return value === null ? "null" : "other_type";
  if (value === "") return "empty";
  if (/^[A-Z]{3}$/u.test(value)) return "iso3";
  if (/^[A-Za-z]{3}$/u.test(value)) return "letters3_not_upper";
  return "other_string";
}

/** Shape class of an identifier cell (account number, reference, description). */
export function textShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return "other_type";
  return value === "" ? "empty" : "non_empty_string";
}

/** What a wrapper's `errorInfo` says, in the parser's own terms. */
export function errorInfoShape(wrapper: unknown): string {
  if (!isRecord(wrapper)) return "wrapper_not_object";
  const info = wrapper["errorInfo"];
  if (info === undefined) return "absent";
  if (!isRecord(info)) return "not_object";
  const id = info["statusID"];
  const message = info["statusMessage"];
  if (id === "00000" && typeof message === "string" && message.toLowerCase() === "success")
    return "explicit_success";
  const blank = (value: unknown) => value === undefined || value === null || value === "";
  if (blank(id) && blank(message)) return "blank";
  if (id === "00000") return "success_code_other_message";
  if (typeof message === "string" && message.toLowerCase() === "success")
    return "success_message_other_code";
  return "error_values";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tally(counts: Counts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Rows whose key repeats an earlier row's key: a count, never the key. */
function repeats(keys: readonly unknown[]): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const key of keys) {
    if (typeof key !== "string" && typeof key !== "number") continue;
    const text = JSON.stringify(key);
    if (seen.has(text)) repeated++;
    seen.add(text);
  }
  return repeated;
}

export interface TopActivityShape {
  json: boolean;
  systemResponseTime?: string;
  overviewErrorInfo?: string;
  activityErrorInfo?: string;
  savings?: {
    rows: number;
    repeatedAccountNo: number;
    repeatedAccountNoAndCurrency: number;
    accountNo: Counts;
    currency: Counts;
    productCode: Counts;
    balance: Counts;
    yenEqui: Counts;
  };
  activity?: {
    rows: number;
    fromDate: string;
    toDate: string;
    currentBalance: string;
    accountNo: string;
    currency: string;
    sides: Counts;
    bothSidesOneZero: number;
    txnReferenceNo: Counts;
    repeatedTxnReferenceNo: number;
    description: Counts;
    postingDate: Counts;
    debit: Counts;
    credit: Counts;
    balance: Counts;
  };
}

/**
 * The structural shape of a `top-accounts-balance-and-activity` capture:
 * shape classes and counts of everything the parser checks semantically.
 * It reads the same paths the parser reads and tolerates any structure, so it
 * can run on a capture the parser refused.
 */
export function topActivityShape(bytes: Uint8Array): TopActivityShape {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { json: false };
  }
  const response = isRecord(root) ? root["responseParam"] : undefined;
  if (!isRecord(response)) return { json: true };
  const shape: TopActivityShape = {
    json: true,
    systemResponseTime: timestampShape(response["systemResponseTime"]),
    overviewErrorInfo: errorInfoShape(response["overview"]),
    activityErrorInfo: errorInfoShape(response["activity"]),
  };
  const overview = isRecord(response["overview"])
    ? response["overview"]["responseParam"]
    : undefined;
  const savingsRows =
    isRecord(overview) && Array.isArray(overview["savingsDetails"])
      ? overview["savingsDetails"].filter(isRecord)
      : [];
  const savings = {
    rows: savingsRows.length,
    repeatedAccountNo: repeats(savingsRows.map((row) => row["accountNo"])),
    repeatedAccountNoAndCurrency: repeats(
      savingsRows.map((row) => `${String(row["accountNo"])}\u0000${String(row["currency"])}`),
    ),
    accountNo: {} as Counts,
    currency: {} as Counts,
    productCode: {} as Counts,
    balance: {} as Counts,
    yenEqui: {} as Counts,
  };
  for (const row of savingsRows) {
    tally(savings.accountNo, textShape(row["accountNo"]));
    tally(savings.currency, currencyShape(row["currency"]));
    tally(savings.productCode, textShape(row["productCode"]));
    tally(savings.balance, amountShape(row["balance"]));
    tally(savings.yenEqui, amountShape(row["yenEqui"]));
  }
  shape.savings = savings;

  const activity = isRecord(response["activity"])
    ? response["activity"]["responseParam"]
    : undefined;
  if (!isRecord(activity)) return shape;
  const rows = Array.isArray(activity["activityDetails"])
    ? activity["activityDetails"].filter(isRecord)
    : [];
  const block = {
    rows: rows.length,
    fromDate: dateShape(activity["fromDate"]),
    toDate: dateShape(activity["toDate"]),
    currentBalance: amountShape(activity["currentBalance"]),
    accountNo: textShape(activity["accountNo"]),
    currency: currencyShape(activity["currency"]),
    sides: {} as Counts,
    bothSidesOneZero: 0,
    txnReferenceNo: {} as Counts,
    repeatedTxnReferenceNo: repeats(rows.map((row) => row["txnReferenceNo"])),
    description: {} as Counts,
    postingDate: {} as Counts,
    debit: {} as Counts,
    credit: {} as Counts,
    balance: {} as Counts,
  };
  const present = (value: unknown) => value !== undefined && value !== null && value !== "";
  for (const row of rows) {
    const debit = present(row["debit"]);
    const credit = present(row["credit"]);
    tally(
      block.sides,
      debit && credit ? "both" : debit ? "debit_only" : credit ? "credit_only" : "neither",
    );
    if (debit && credit && (isZero(row["debit"]) || isZero(row["credit"])))
      block.bothSidesOneZero++;
    tally(block.txnReferenceNo, textShape(row["txnReferenceNo"]));
    tally(block.description, textShape(row["description"]));
    tally(block.postingDate, dateShape(row["postingDate"]));
    tally(block.debit, amountShape(row["debit"]));
    tally(block.credit, amountShape(row["credit"]));
    tally(block.balance, amountShape(row["balance"]));
  }
  shape.activity = block;
  return shape;
}

// ── structural shape of a MyJCB ショッピングスキップ払い page ──────────────────
//
// `myjcb-skip-payment-schedule` names only its first failing check. This
// summary shows every structure its reader checks (ADR 0005 amendments e, f
// and i), so one replay of a refused page says what differs. Counts, booleans
// and closed tag and class names only: no text, no attribute value, and no
// class name outside the closed set below.

/** The head cells the reader expects, whitespace removed (amendment e). */
const SKIP_HEAD_CELLS = ["ご利用日", "ご利用先などお支払日", "今後のお支払い金額"] as const;
/** The provider's empty-ledger label the reader compares (amendment f). */
const SKIP_EMPTY_LABEL = "ご利用明細はございません。";
/** Text the page's "as of" heading contains; its exact form is the reader's to check. */
const SKIP_AS_OF_TEXT = "時点のショッピングスキップ払いご利用明細";
/** Class names the reader looks at; no other class is printed. */
const SKIP_CLASSES = [
  "detail-list-01",
  "head",
  "content",
  "item-cell",
  "cell",
  "w-100per",
  "row",
  "item-more",
] as const;
/** Tag names printed as themselves; any other tag is `other`. */
const SKIP_TAGS = new Set([
  "div",
  "span",
  "p",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "br",
  "a",
  "button",
  "table",
  "tr",
  "td",
  "th",
  "form",
  "input",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

interface ShapeNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly value?: string;
  readonly childNodes?: readonly ShapeNode[];
}

function hasShapeClass(element: ShapeNode, name: string): boolean {
  const value = element.attrs?.find((attribute) => attribute.name === "class")?.value ?? "";
  return value.split(/\s+/u).includes(name);
}

/** An element's closed signature: its tag (or `other`) and the reader's classes it carries. */
function elementSignature(element: ShapeNode): string {
  const tag = SKIP_TAGS.has(element.tagName ?? "") ? element.tagName! : "other";
  const classes = SKIP_CLASSES.filter((name) => hasShapeClass(element, name));
  return [tag, ...classes].join(".");
}

/** Element children, for a skip-payment and a GLOBAL PASS tree alike. */
function shapeChildren<T extends { readonly tagName?: string; readonly childNodes?: readonly T[] }>(
  node: T,
): T[] {
  return (node.childNodes ?? []).filter((child) => child.tagName !== undefined);
}

function shapeElements(node: ShapeNode, predicate: (element: ShapeNode) => boolean): ShapeNode[] {
  const found: ShapeNode[] = [];
  if (node.tagName !== undefined && predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) found.push(...shapeElements(child, predicate));
  return found;
}

/** Text with whitespace removed, as the reader compares it. Never printed. */
function compactShapeText(node: ShapeNode): string {
  const text = (current: ShapeNode): string =>
    current.value !== undefined && current.tagName === undefined
      ? current.value
      : (current.childNodes ?? []).map(text).join(" ");
  return text(node).replace(/\s+/gu, "");
}

/** Signatures with equal neighbours counted: `div.content×3`. */
function runs(signatures: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < signatures.length) {
    let end = index;
    while (end + 1 < signatures.length && signatures[end + 1] === signatures[index]) end++;
    const count = end - index + 1;
    out.push(count === 1 ? signatures[index]! : `${signatures[index]}×${count}`);
    index = end + 1;
  }
  return out;
}

/** One `content` row's closed signature: the structure the reader checks, never what it shows. */
function rowSignature(row: ShapeNode): string {
  const rowChildren = shapeChildren(row);
  const itemCell =
    rowChildren.length === 1 && hasShapeClass(rowChildren[0]!, "item-cell")
      ? rowChildren[0]
      : undefined;
  if (!itemCell) return `children=${runs(rowChildren.map(elementSignature)).join(",")}`;
  const cells = shapeChildren(itemCell);
  const parts = [`item-cell>${runs(cells.map(elementSignature)).join(",")}`];
  if (cells.length === 1)
    parts.push(`emptyLabel=${compactShapeText(cells[0]!) === SKIP_EMPTY_LABEL}`);
  if (cells.length === 3) {
    const middle = cells[1]!;
    parts.push(`middleBr=${shapeElements(middle, (element) => element.tagName === "br").length}`);
    parts.push(`middle>${runs(shapeChildren(middle).map(elementSignature)).join(",")}`);
  }
  return parts.join(" ");
}

export interface SkipScheduleLedgerShape {
  /** Signatures of the ledger's element children, in order. */
  children: string[];
  /** Elements with class `head` anywhere in the ledger. */
  headElements: number;
  /** The first such head, as the reader reads it. */
  head?: {
    /** Signatures of its element children, in order. */
    children: string[];
    /** Its element children are exactly the three expected `cell`s, in order. */
    cellsAsExpected: boolean;
    /** Its whole text, whitespace removed, is the three labels joined. */
    textAsExpected: boolean;
  };
  /** Each `content` child's signature, with how many rows have it. */
  rows: Counts;
}

export interface SkipScheduleShape {
  utf8: boolean;
  /** Every h1, and those exactly the ショッピングスキップ払い heading. */
  h1: number;
  skipH1: number;
  /** h1–h6 whose text contains the "as of" heading's fixed words. */
  asOfLikeHeadings: number;
  /** Every element with class `detail-list-01`, in document order. */
  ledgers: SkipScheduleLedgerShape[];
}

/**
 * The structural shape of a stored skip-payment page. It reads the elements
 * `readMyJcbSkipPaymentSchedule` reads and tolerates any structure, so it
 * runs on a page the parser refused.
 */
export function skipScheduleShape(bytes: Uint8Array): SkipScheduleShape {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { utf8: false, h1: 0, skipH1: 0, asOfLikeHeadings: 0, ledgers: [] };
  }
  const document = parse(html) as unknown as ShapeNode;
  const h1 = shapeElements(document, (element) => element.tagName === "h1");
  return {
    utf8: true,
    h1: h1.length,
    skipH1: h1.filter((element) => compactShapeText(element) === SKIP_PAYMENT_SCHEDULE_HEADING)
      .length,
    asOfLikeHeadings: shapeElements(
      document,
      (element) =>
        /^h[1-6]$/u.test(element.tagName ?? "") &&
        compactShapeText(element).includes(SKIP_AS_OF_TEXT),
    ).length,
    ledgers: shapeElements(document, (element) => hasShapeClass(element, "detail-list-01")).map(
      (ledger) => {
        const heads = shapeElements(ledger, (element) => hasShapeClass(element, "head"));
        const rows: Counts = {};
        for (const child of shapeChildren(ledger))
          if (hasShapeClass(child, "content")) tally(rows, rowSignature(child));
        const shape: SkipScheduleLedgerShape = {
          children: runs(shapeChildren(ledger).map(elementSignature)),
          headElements: heads.length,
          rows,
        };
        const head = heads[0];
        if (head) {
          const cells = shapeChildren(head);
          shape.head = {
            children: runs(cells.map(elementSignature)),
            cellsAsExpected:
              cells.length === SKIP_HEAD_CELLS.length &&
              cells.every(
                (cell, index) =>
                  hasShapeClass(cell, "cell") && compactShapeText(cell) === SKIP_HEAD_CELLS[index],
              ),
            textAsExpected: compactShapeText(head) === SKIP_HEAD_CELLS.join(""),
          };
        }
        return shape;
      },
    ),
  };
}

// ── replay selection ─────────────────────────────────────────────────────────

/**
 * Sources whose stored failures `replay-diagnostics.ts` may replay. MyJCB's
 * parsers throw fixed messages (`legacySafeReason` keeps only closed reasons)
 * or, for `myjcb-skip-payment-schedule`, closed codes (ADR 0005 amendment i).
 */
export const REPLAY_SOURCES = ["sony-bank", "sbi-shinsei-bank", "myjcb"] as const;

/**
 * The read-only selection of `replay-diagnostics.ts`: the newest failed parse
 * of each distinct (parser, raw object) that no parse of the same parser has
 * since published, with the parent run's status the way the processor's own
 * `artifactSql` reads it. The parser filter is applied in SQL, before the
 * limit, so an older parser's failures are not crowded out by newer failures
 * of other parsers. `parser` is an exact registered name; `substring` keeps the
 * earlier `includes` behaviour. Both are restricted to parser-name characters
 * because the text is passed to `wrangler d1 execute --command`. Each row
 * also carries `metadata_projection_json`: the artifact's newest completed
 * (`ok` or `absent`) projection under the extractor release the processor
 * reads for that parser (`active_releases`, else `legacy-metadata-v1`, as
 * `extractorRelease` in the worker), so an `error` row or another release's
 * row from a bounded re-extraction is never taken for the parser's input.
 * A failed parse records no `parse_input_references`, so this is the
 * projection a normal (non-candidate) run reads today, not a recorded link;
 * `replayStatementMetadata` uses it for MyJCB.
 */
export function replaySelectionSql(filter: { parser?: string; substring?: string } = {}): string {
  const clauses: string[] = [];
  for (const value of [filter.parser, filter.substring])
    if (value !== undefined && !/^[a-z0-9-]{1,80}$/u.test(value))
      throw new Error("parser filter must be a parser name");
  if (filter.parser !== undefined) clauses.push(`p.parser_name='${filter.parser}'`);
  if (filter.substring !== undefined) clauses.push(`instr(p.parser_name,'${filter.substring}')>0`);
  const sources = REPLAY_SOURCES.map((source) => `'${source}'`).join(",");
  return `WITH ranked AS (
 SELECT a.*,o.blob_key,o.byte_size,p.parser_name,
 r.status AS run_status,r.failure_count AS run_failure_count,
 (SELECT m.output_json FROM metadata_projections m WHERE m.fetch_artifact_id=a.id AND m.status IN ('ok','absent') AND m.extractor_release=coalesce((SELECT x.metadata_extractor_release FROM active_releases x WHERE x.source_id=a.source_id AND x.dataset=a.dataset AND x.parser_name=p.parser_name),'legacy-metadata-v1') ORDER BY m.id DESC LIMIT 1) AS metadata_projection_json,
 row_number() OVER(PARTITION BY p.parser_name,a.sha256 ORDER BY p.fetch_artifact_id DESC,p.id DESC) AS rank,
 coalesce((SELECT start_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_start) AS window_start,
 coalesce((SELECT end_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_end) AS window_end
 FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
 JOIN raw_objects o ON o.sha256=a.sha256
 WHERE p.status='error' AND a.source_id IN (${sources})${clauses.map((clause) => ` AND ${clause}`).join("")}
 AND NOT EXISTS(SELECT 1 FROM published_parse_runs success WHERE success.fetch_artifact_id=p.fetch_artifact_id AND success.parser_name=p.parser_name)
) SELECT * FROM ranked WHERE rank=1 ORDER BY id DESC LIMIT 50`;
}

/**
 * The statement state and period a replay hands the parser. The processor
 * hands every parser its metadata projection (`hydrateMeta`). Under
 * `legacy-metadata-v1` that equals the artifact row (both come from
 * `observation_artifact_metadata`); under `manifest-metadata-v2` the MyJCB
 * projection reads the collector manifest (ADR 0025) and can differ, so a
 * MyJCB replay uses the projection `replaySelectionSql` selected (newest
 * completed one of the release the processor reads). Without one, or with an
 * `errorCode`, and for every other source, the artifact row's values stand,
 * as before.
 */
export function replayStatementMetadata(row: {
  source_id: string;
  statement_state: string | null;
  period: string | null;
  metadata_projection_json?: string | null;
}): { statementState: string | null; period: string | null } {
  const stored = { statementState: row.statement_state, period: row.period };
  if (row.source_id !== "myjcb" || typeof row.metadata_projection_json !== "string") return stored;
  let projection: unknown;
  try {
    projection = JSON.parse(row.metadata_projection_json);
  } catch {
    return stored;
  }
  if (!isRecord(projection) || projection["errorCode"] !== undefined) return stored;
  const output = projection;
  const value = (key: string) => {
    const item = output[key];
    return typeof item === "string" ? item : null;
  };
  return { statementState: value("statementState"), period: value("period") };
}

// ── global-pass-activity: one closed code per throw site ─────────────────────
//
// `global-pass-activity` throws fixed English sentences, some with a row
// number or a view label (`activity`, `compact N`, `expanded N`) and, for a
// missing header, one of the parser's own header constants. The table below is
// keyed by those sentences, written as the parser writes them with each
// interpolation as a pattern, so the parser's messages stay the one source of
// truth: a reworded message falls to `other` and the closure test
// (test/global-pass-rejection.test.ts) fails. The code is a fixed token; row
// numbers are dropped, a view label keeps only its kind, and a header is kept
// only when it is one of the parser's constants.

export const GLOBAL_PASS_ACTIVITY_PARSER = "global-pass-activity";

const GP_ROW = String.raw`row \d{1,6}`;
const GP_VIEW = String.raw`(activity|compact \d{1,6}|expanded \d{1,6})`;
/** The header constants `global-pass-activity` requires and names in `schema is missing …`. */
const GLOBAL_PASS_REQUIRED_HEADERS = [
  "Transaction Date",
  "Transaction Detail",
  "Transaction Currency and Amount",
  "Transaction Fee",
  "ATM Fee",
  "Status",
  "Approval Number",
] as const;

/**
 * Every message `global-pass-activity` can throw, including those of the
 * helpers it calls on the page (`decodeUtf8`, `normalizedDate`), with its
 * closed code. No two patterns match one message.
 */
export const GLOBAL_PASS_REJECTIONS: readonly (readonly [code: string, message: RegExp])[] = (
  [
    ["artifact_metadata_unsupported", "global-pass artifact metadata is unsupported"],
    ["run_not_admitted", "global-pass observations require a successful failure-free fetch run"],
    ["html_size_out_of_range", "global-pass HTML size is outside the Layer-A contract"],
    [
      "utf8_invalid",
      "artifact bytes are not valid UTF-8; the artifact's encoding is not recorded, so no decoder can be selected",
    ],
    ["doctype_drift", "global-pass HTML doctype drift"],
    // Two sites: a key that is not `activity-YYYY-MM(-pN).html`, and a key
    // whose month is not the selected one. `sites` tells them apart.
    ["artifact_key_month_mismatch", "global-pass artifact key and selected month disagree"],
    ["pager_unreadable", "global-pass pager is unreadable"],
    ["pager_missing_on_later_page", "global-pass later page has no pager"],
    ["pager_page_mismatch", "global-pass pager and artifact key name different pages"],
    ["month_selector_cardinality", "global-pass month selector cardinality drift"],
    [
      "month_selector_range",
      "global-pass month selector must contain between one and 15 months and at most one unselected default",
    ],
    ["month_selector_duplicates", "global-pass month selector contains duplicates"],
    ["month_option_invalid", String.raw`global-pass month option \d{1,6} is invalid`],
    [
      "month_selector_not_contiguous",
      "global-pass month selector is not contiguous reverse chronology",
    ],
    [
      "month_selector_selected_cardinality",
      "global-pass month selector must have one selected option",
    ],
    ["table_cardinality", "global-pass activity table cardinality drift"],
    ["unclassified_table", "global-pass contains an unclassified table"],
    ["header_schema", `global-pass ${GP_VIEW} header schema drift`],
    ["header_missing", `global-pass ${GP_VIEW} schema is missing (.+)`],
    ["fee_schema", `global-pass ${GP_VIEW} must have exactly three fee fields`],
    ["row_cardinality", "global-pass activity row cardinality drift"],
    ["source_view_row_cardinality", "global-pass source-view row cardinality drift"],
    ["date_cardinality", `global-pass ${GP_ROW} date cardinality drift`],
    // `normalizedDate` (sbi-strict.ts) under the label `global-pass row N date`.
    [
      "date_invalid",
      `global-pass ${GP_ROW} date (?:must be a string|is empty|is too long|has an unsupported value|is not a calendar date)`,
    ],
    ["date_outside_month", `global-pass ${GP_ROW} falls outside the selected month`],
    ["date_order", "global-pass transaction dates are not in provider ascending order"],
    ["value_cardinality", `global-pass ${GP_VIEW} value cardinality drift`],
    ["field_too_long", `global-pass ${GP_VIEW} field is too long`],
    ["header_value_cardinality", "global-pass header/value cardinality drift"],
    ["source_view_amount_mismatch", `global-pass ${GP_ROW} source views disagree on amount text`],
    ["amount_format", "global-pass transaction amount format drift"],
    ["amount_inexact", "global-pass signed amount is not exactly representable"],
  ] as const
).map(([code, message]) => [code, new RegExp(`^${message}$`, "u")] as const);

/**
 * The category of one `global-pass-activity` message: its code, the view kind
 * (`activity`, `compact`, `expanded`) when the message names one, and the
 * missing header when it is one of the parser's constants. Anything else is
 * `other`, with nothing taken from the message.
 */
export function classifyGlobalPassMessage(message: string): RejectionCategory {
  for (const [code, pattern] of GLOBAL_PASS_REJECTIONS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const view = match[1]?.split(" ")[0];
    const category: RejectionCategory = { reason: code };
    if (view === "activity" || view === "compact" || view === "expanded") category.label = view;
    if (code === "header_missing") {
      const header = match[2] ?? "";
      const known = header
        .split(" or ")
        .every((name) => (GLOBAL_PASS_REQUIRED_HEADERS as readonly string[]).includes(name));
      if (known) category.field = header;
    }
    return category;
  }
  return { reason: "other" };
}

// ── structural shape of a stored GLOBAL PASS activity page ──────────────────
//
// One rejection names only the first failing check. This summary counts every
// structure the parser's admission checks read, so one replay of a refused
// page shows each of them: booleans and counts only. No header text, cell
// text, option value, date or amount is printed; header labels are compared
// with fixed lists and only how many match is printed.
//
// Since ADR 0026's amendment of 2026-10-08 it also compares the page with
// itself, for a page the parser refuses as `unclassified_table`: the detail
// tables' common parent as a list of closed child signatures, every table of
// another `th` count, which activity record each detail table carries, and
// the records no detail table carries. Those comparisons print indices,
// booleans, counts, closed tag and attribute-name classes and the pattern
// class of a cell (`GlobalPassCellPattern`); two texts are only ever tested for
// exact equality, and only the positions of equal cells are printed.
//
// The parser's DOM helpers are private to `global-pass-activity.ts`, and
// exporting them would change its code digest and so need a parser release
// (migration 0028 refuses a new digest under the same version). The few lines
// below read the tree the way those helpers do (`owned`, `closest`,
// `directCells`, `text`, `bodyRows`) and validate nothing. The tree is
// parse5's, as the registered parser's. Two guards keep the copy honest
// (test/global-pass-rejection.test.ts): the date and amount patterns must
// appear verbatim in the parser's source, and on pages the parser accepts the
// records, header lists and value cells read here must equal those the parser
// emits (`extra.sourceViews`, `compactFields`, `expandedFields`).

/** The twelve English labels of the live survey of 2026-10-04 (docs/sources/prestia.md). */
const GLOBAL_PASS_SURVEYED_ENGLISH = [
  "Transaction Date",
  "Transaction Detail",
  "Transaction Currency and Amount",
  "Transaction Fee",
  "ATM Fee",
  "FX commissions",
  "Status",
  "Approval Number",
  "Remarks",
  "Local Currency and Amount",
  "Local Fee",
  "Applicable Rate",
] as const;
/** The twelve Japanese labels of the same survey, a line break read as a space. */
const GLOBAL_PASS_SURVEYED_JAPANESE = [
  "お取引日",
  "お取引内容",
  "お取引通貨 金額",
  "お取引手数料",
  "ATM手数料",
  "為替手数料",
  "確定状態",
  "承認番号",
  "備考",
  "ご利用通貨 金額",
  "ご利用手数料",
  "換算レート",
] as const;
/** The pager text `global-pass-activity` reads (`requirePagerPage`). */
const GLOBAL_PASS_PAGER = /^\[\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:pages?|ページ)\s*\]$/iu;
const EIGHT_DIGITS = /^\d{8}$/u;
/** The date form the parser looks for in a desktop row (`global-pass-activity.ts`, `dates`). */
export const GLOBAL_PASS_DATE_CELL = /^\d{4}[/-]\d{2}[/-]\d{2}$/u;
/** The displayed amount the parser reads (`parseDisplayedAmount`), on trimmed text. */
export const GLOBAL_PASS_AMOUNT_CELL = /^([A-Z]{3})\s+([+\-△▲]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)$/u;

type GpNode = GlobalPassDomNode;

function digits(length: number): number {
  return length <= 0 ? 0 : String(Math.floor(length)).length;
}

function gpElements(root: GpNode, tagName: string): GpNode[] {
  const found: GpNode[] = [];
  const visit = (node: GpNode): void => {
    if (node.tagName === tagName) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return found;
}
function gpClosest(node: GpNode, tagName: string): GpNode | null {
  let parent = node.parentNode ?? null;
  while (parent) {
    if (parent.tagName === tagName) return parent;
    parent = parent.parentNode ?? null;
  }
  return null;
}
function gpOwned(root: GpNode, tagName: string, ownerTag: string): GpNode[] {
  return gpElements(root, tagName).filter((node) => gpClosest(node, ownerTag) === root);
}
/** Text as the parser compares it. Never printed. */
function gpText(node: GpNode): string {
  const values: string[] = [];
  const visit = (current: GpNode): void => {
    if (typeof current.value === "string") values.push(current.value);
    for (const child of current.childNodes ?? []) visit(child);
  };
  visit(node);
  return values.join(" ").replace(/\s+/gu, " ").trim();
}
function gpAttribute(node: GpNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}
function gpHasAttribute(node: GpNode, name: string): boolean {
  return node.attrs?.some((item) => item.name.toLowerCase() === name) ?? false;
}
function gpDirectCells(row: GpNode): GpNode[] {
  return gpElements(row, "td").filter((cell) => gpClosest(cell, "tr") === row);
}

export interface GlobalPassActivityShape {
  utf8: boolean;
  /**
   * Number of decimal digits of the page's byte length (0 for an empty page),
   * as the sanitizer's refusal shape reduces it: an exact length is not
   * needed to read a size refusal, which has its own code.
   */
  byteMagnitude: number;
  /** The page starts with `<!doctype html`, as the parser requires. */
  doctype?: boolean;
  select?: number;
  option?: number;
  optionSelected?: number;
  optionEightDigit?: number;
  /** `select`s owning an eight-digit option: the parser needs exactly one. */
  monthSelects?: number;
  /** The month select's own options, when there is exactly one such select. */
  monthSelect?: {
    options: number;
    eightDigit: number;
    other: number;
    selected: number;
    selectedEightDigit: number;
    selectedOther: number;
  };
  /** Tables by the number of `th` each owns (a nested table's are its own). */
  tables?: { total: number; th12: number; th4: number; th10: number; other: number };
  /** The first table owning twelve `th`, read as the parser reads it. */
  activityTable?: {
    trOwned: number;
    /** Owned rows outside `thead`: the parser's body rows. */
    bodyRows: number;
    /** A row holding the table's own `th` lies outside `thead`, so it counts as a body row. */
    headerRowInBody: boolean;
    bodyRowsByCells: { cells9: number; cells4: number; cells5: number; other: number };
    /** Nine-cell rows by how many of their direct cells have the date form. */
    nineCellRowsByDateCells: { one: number; none: number; several: number };
    headers: {
      empty: number;
      unique: boolean;
      /** How many of the seven headers the parser requires are present. */
      parserRequired: number;
      /** Headers ending in ` Fee`; the parser requires exactly three. */
      feeSuffixed: number;
      /** How many of the twelve English labels of the 2026-10-04 survey are present. */
      surveyedEnglish: number;
      /** How many of the twelve Japanese labels of that survey are present. */
      surveyedJapanese: number;
    };
  };
  /** `div.nablarch_currentPageNumber` blocks. */
  pager?: {
    blocks: number;
    /** Blocks whose whole text has the form the parser reads. */
    readable: number;
    english: number;
    japanese: number;
    /** Every readable block names the page the artifact key names; null for a key of another form. */
    agreesWithKey: boolean | null;
  };
  /**
   * Whether the 4-`th` (compact) and the 10-`th` (expanded) tables agree among
   * themselves on their header lists and on their class token sets; null when
   * there is no such table.
   */
  detailTables?: {
    compactHeadersUniform: boolean | null;
    expandedHeadersUniform: boolean | null;
    compactClassTokensUniform: boolean | null;
    expandedClassTokensUniform: boolean | null;
  };
  /** The one parent element of every 4-`th` table; null when they have none or several. */
  detailContainer?: GlobalPassDetailContainer | null;
  /** Every table whose owned `th` count is not 12, 4 or 10, in document order. */
  otherTables?: GlobalPassOtherTable[];
  /** Which activity record each detail table carries (present when a 12-`th` table is). */
  recordDetailAlignment?: GlobalPassAlignment;
  /** The records no compact table carries, cell by cell (present when a 12-`th` table is). */
  unmatchedRecords?: GlobalPassUnmatchedRecord[];
}

/**
 * The pattern class of one cell's text, as the parser normalises it: never
 * the text. `dateLike` and `amountLike` are the parser's own patterns
 * (`GLOBAL_PASS_DATE_CELL`, `GLOBAL_PASS_AMOUNT_CELL`); `asciiOnly` is
 * printable ASCII only (true for an empty cell); `hasJapanese` is a Hiragana,
 * Katakana or Han character, CJK punctuation or a full-width form; the length
 * is in code points.
 */
export interface GlobalPassCellPattern {
  empty: boolean;
  digitsOnly: boolean;
  dateLike: boolean;
  amountLike: boolean;
  asciiOnly: boolean;
  hasJapanese: boolean;
  lengthBucket: "0" | "1-4" | "5-16" | "17-64" | "65+";
}

/** A cell of an activity record: record index, row (`desktop` 9 cells, `responsive` 4 or 5) and cell index. */
export interface GlobalPassRecordCell {
  record: number;
  row: "desktop" | "responsive";
  cell: number;
}

export interface GlobalPassDetailContainer {
  /** Element children of the parent. */
  childCount: number;
  /** One closed signature per element child, in order. */
  children: {
    /** The tag from a closed list, else `other`. */
    tag: string;
    /** The owned `th` count of the child when it is a table, or of the one table it wraps; else null. */
    th: number | null;
    /** The child is not a table and holds exactly one table outside any other table. */
    wrapped: boolean;
    /** `th` is one the parser classifies (12, 4 or 10). */
    known: boolean;
    /** Tables anywhere in the child, itself included. */
    tables: number;
  }[];
  /**
   * Of the children that are or wrap one table, how many leading pairs are
   * a 4-`th` table followed by a 10-`th` table.
   */
  pairsInOrder: number;
}

export interface GlobalPassOtherTable {
  th: number;
  td: number;
  /** Owned rows outside `thead`, as the parser counts body rows. */
  bodyRows: number;
  /** Direct cells of each body row, in order. */
  cellsPerRow: number[];
  /** The largest `colspan` of an owned cell; null when no cell has a numeric one. */
  colspanMax: number | null;
  theadPresent: boolean;
  /** Tables inside this one. */
  nestedTables: number;
  /** Index among its parent's element children. */
  positionInParent: number | null;
  parentIsDetailContainer: boolean;
  /** Distinct class tokens. */
  classTokenCount: number;
  /** Its class tokens equal, as a set, those every compact table shares; null when compact tables are absent or differ. */
  classTokensEqualCompact: boolean | null;
  classTokensEqualExpanded: boolean | null;
  /** Its attribute names, sorted and deduplicated, each a closed name or `data-*`, `aria-*`, `on*`, `other`. */
  attributeNames: string[];
  /**
   * The rank (0-based, ascending, among the distinct numbers) of the digits
   * ending its id or name among those of itself and the detail tables; null
   * when it or every detail table has none. The numbers are never printed.
   */
  idNumericSuffixRank: number | null;
  /** How many distinct numbers that rank is among; null with the rank. */
  idNumericSuffixDistinct: number | null;
  /** How many detail tables carry such a number. */
  idNumericSuffixPeers: number;
  /** Per owned `th`: the index of an equal header in each other table kind's header list, and whether it is a surveyed label. */
  headerMatches: {
    activity: number | null;
    compact: number | null;
    expanded: number | null;
    surveyed: boolean;
  }[];
  /** Per owned `td`: its pattern and the activity record cells with exactly its (non-empty) text. */
  cells: (GlobalPassCellPattern & { equalsRecordCell: GlobalPassRecordCell[] })[];
}

/** One detail table compared with every activity record. */
export interface GlobalPassDetailMatch {
  /** Index among the tables of its kind, as the parser pairs them with records. */
  table: number;
  /** Its non-empty value cells (the parser's body-row cells). */
  valueCells: number;
  /** Records whose desktop or responsive row has a non-empty cell equal to one of its value cells. */
  records: number[];
  /** The most of its value cells one record has. */
  matchedCells: number;
  /** The one record with that most; null on a tie or no match. */
  best: number | null;
}

export interface GlobalPassAlignment {
  compact: GlobalPassDetailMatch[];
  expanded: GlobalPassDetailMatch[];
  /** Records that are no compact table's `best`. */
  unmatchedRecords: number[];
  /** Every compact table has a `best`, strictly increasing with the table index. */
  monotonic: boolean;
  /** Compact and expanded table i name the same `best`, for every i both kinds have. */
  pairsAgree: boolean;
  /** Every compact table i has `best` i: the parser's pairing by index. */
  indexAligned: boolean;
}

export interface GlobalPassUnmatchedCell extends GlobalPassCellPattern {
  /**
   * The pattern equals the one more than half of the carried records (those
   * some compact table carries) have at this cell; null when no pattern has
   * such a majority or no carried record has this cell.
   */
  patternEqualsMajority: boolean | null;
  /** Cells of `otherTables` with exactly its (non-empty) text. */
  equalsOtherTableCell: { table: number; cell: number }[];
}

export interface GlobalPassUnmatchedRecord {
  record: number;
  desktop: GlobalPassUnmatchedCell[];
  responsive: GlobalPassUnmatchedCell[];
}

/**
 * The structural shape of a stored `globalpass-activity` page, from the
 * elements `global-pass-activity` reads. It tolerates any structure, so it
 * runs on a page the parser refused. `artifactKey` only says which page the
 * key names; nothing of it is printed.
 */
export function globalPassActivityShape(
  bytes: Uint8Array,
  artifactKey?: string | null,
): GlobalPassActivityShape {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { utf8: false, byteMagnitude: digits(bytes.byteLength) };
  }
  const document = parse(html) as unknown as GpNode;
  const options = gpElements(document, "option");
  const eightDigit = (option: GpNode) => EIGHT_DIGITS.test(gpAttribute(option, "value") ?? "");
  const selected = (option: GpNode) => gpHasAttribute(option, "selected");
  const monthSelects = gpElements(document, "select").filter((select) =>
    gpOwned(select, "option", "select").some(eightDigit),
  );
  const shape: GlobalPassActivityShape = {
    utf8: true,
    byteMagnitude: digits(bytes.byteLength),
    doctype: /^\s*<!doctype\s+html\b/iu.test(html),
    select: gpElements(document, "select").length,
    option: options.length,
    optionSelected: options.filter(selected).length,
    optionEightDigit: options.filter(eightDigit).length,
    monthSelects: monthSelects.length,
  };
  if (monthSelects.length === 1) {
    const owned = gpOwned(monthSelects[0]!, "option", "select");
    const chosen = owned.filter(selected);
    shape.monthSelect = {
      options: owned.length,
      eightDigit: owned.filter(eightDigit).length,
      other: owned.filter((option) => !eightDigit(option)).length,
      selected: chosen.length,
      selectedEightDigit: chosen.filter(eightDigit).length,
      selectedOther: chosen.filter((option) => !eightDigit(option)).length,
    };
  }

  const tables = gpElements(document, "table");
  const thCount = (table: GpNode) => gpOwned(table, "th", "table").length;
  const grouped = { total: tables.length, th12: 0, th4: 0, th10: 0, other: 0 };
  for (const table of tables) {
    const count = thCount(table);
    if (count === 12) grouped.th12++;
    else if (count === 4) grouped.th4++;
    else if (count === 10) grouped.th10++;
    else grouped.other++;
  }
  shape.tables = grouped;
  const activity = tables.find((table) => thCount(table) === 12);
  if (activity) {
    const rows = gpOwned(activity, "tr", "table");
    const body = gpBodyRows(activity);
    const headerCells = gpOwned(activity, "th", "table");
    const headers = headerCells.map(gpText);
    const byCells = { cells9: 0, cells4: 0, cells5: 0, other: 0 };
    const byDates = { one: 0, none: 0, several: 0 };
    for (const row of body) {
      const cells = gpDirectCells(row);
      if (cells.length === 9) {
        byCells.cells9++;
        const dates = cells.map(gpText).filter((value) => GLOBAL_PASS_DATE_CELL.test(value)).length;
        if (dates === 1) byDates.one++;
        else if (dates === 0) byDates.none++;
        else byDates.several++;
      } else if (cells.length === 4) byCells.cells4++;
      else if (cells.length === 5) byCells.cells5++;
      else byCells.other++;
    }
    const present = (labels: readonly string[]) =>
      labels.filter((label) => headers.includes(label)).length;
    shape.activityTable = {
      trOwned: rows.length,
      bodyRows: body.length,
      headerRowInBody: headerCells.some((th) => {
        const row = gpClosest(th, "tr");
        return row !== null && gpClosest(row, "thead") === null;
      }),
      bodyRowsByCells: byCells,
      nineCellRowsByDateCells: byDates,
      headers: {
        empty: headers.filter((header) => header === "").length,
        unique: new Set(headers).size === headers.length,
        parserRequired: present(GLOBAL_PASS_REQUIRED_HEADERS),
        feeSuffixed: headers.filter((header) => / Fee$/u.test(header)).length,
        surveyedEnglish: present(GLOBAL_PASS_SURVEYED_ENGLISH),
        surveyedJapanese: present(GLOBAL_PASS_SURVEYED_JAPANESE),
      },
    };
  }

  const pagers = gpElements(document, "div").filter((div) =>
    (gpAttribute(div, "class") ?? "").split(/\s+/u).includes("nablarch_currentPageNumber"),
  );
  const key = /^activity-\d{4}-\d{2}(?:-p([2-9]))?\.html$/u.exec(artifactKey ?? "");
  const keyPage = key ? (key[1] === undefined ? 1 : Number(key[1])) : null;
  const readable = pagers
    .map((pager) => GLOBAL_PASS_PAGER.exec(gpText(pager)))
    .filter((match) => match !== null);
  shape.pager = {
    blocks: pagers.length,
    readable: readable.length,
    english: readable.filter((match) => /page/iu.test(match[0])).length,
    japanese: readable.filter((match) => match[0].includes("ページ")).length,
    agreesWithKey:
      keyPage === null ? null : readable.every((match) => Number(match[1]) === keyPage),
  };
  return { ...shape, ...globalPassComparisons(readGpPage(document)) };
}

// ── GLOBAL PASS: detail tables, unclassified tables and records compared ────
//
// The parser pairs compact table i and expanded table i with activity record
// i by index, and refuses a page with any table it does not classify. These
// comparisons say, for such a page, which record each detail table carries,
// which record none does, and how an unclassified table relates to both. They
// read the tree as the parser does and print what the shape above may print.

/** Tags printed as themselves; any other tag is `other`. */
const GP_TAGS = new Set([
  "a",
  "br",
  "button",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "label",
  "li",
  "noscript",
  "ol",
  "p",
  "script",
  "section",
  "select",
  "span",
  "style",
  "table",
  "tbody",
  "td",
  "template",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
/** Attribute names printed as themselves; any other is `data-*`, `aria-*`, `on*` or `other`. */
const GP_ATTRIBUTE_NAMES = new Set([
  "align",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "dir",
  "frame",
  "height",
  "hidden",
  "id",
  "lang",
  "name",
  "role",
  "rules",
  "style",
  "summary",
  "tabindex",
  "title",
  "valign",
  "width",
]);
/** Digits ending an id or name; the number is compared, never printed. */
const GP_ID_SUFFIX = /(\d{1,15})$/u;
/** Hiragana, Katakana, Han, CJK punctuation (U+3000–U+303F) or a full-width or half-width form (U+FF01–U+FF9F). */
const GP_JAPANESE =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u3000-\u303f\uff01-\uff9f]/u;

export interface GpRecord {
  desktop: string[];
  responsive: string[];
}
interface GpPage {
  thOf: (table: GpNode) => number;
  activity: GpNode | undefined;
  compact: GpNode[];
  expanded: GpNode[];
  others: GpNode[];
  /** Record i is desktop row i and responsive row i, as the parser pairs them; a missing row is []. */
  records: GpRecord[];
}

function gpBodyRows(table: GpNode): GpNode[] {
  return gpOwned(table, "tr", "table").filter((row) => gpClosest(row, "thead") === null);
}
/** The tables in `root` (itself, when a table) that lie inside no other table of `root`. */
function gpTopTables(root: GpNode): GpNode[] {
  if (root.tagName === "table") return [root];
  const found: GpNode[] = [];
  const visit = (node: GpNode): void => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName === "table") found.push(child);
      else visit(child);
    }
  };
  visit(root);
  return found;
}
/** Distinct class tokens, sorted, so two sets compare as lists. */
function gpClassTokens(node: GpNode): string[] {
  const tokens = (gpAttribute(node, "class") ?? "").split(/\s+/u).filter((token) => token !== "");
  return [...new Set(tokens)].sort();
}
/** Whether every list is equal to the first; null for none. */
function uniform<T>(items: readonly T[], equal: (left: T, right: T) => boolean): boolean | null {
  return items.length === 0 ? null : items.every((item) => equal(item, items[0]!));
}
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
/** A table's owned `th` texts, as the parser's `uniqueHeaders` reads them. */
function gpHeaders(table: GpNode | undefined): string[] {
  return table ? gpOwned(table, "th", "table").map(gpText) : [];
}
/** A detail table's value cells, as the parser's `flattenedValues` reads them. */
function gpValueCells(table: GpNode): string[] {
  return gpBodyRows(table).flatMap(gpDirectCells).map(gpText);
}
function indexOrNull(list: readonly string[], value: string): number | null {
  const index = list.indexOf(value);
  return index < 0 ? null : index;
}

function readGpPage(document: GpNode): GpPage {
  const tables = gpElements(document, "table");
  const counts = new Map(tables.map((table) => [table, gpOwned(table, "th", "table").length]));
  const thOf = (table: GpNode) => counts.get(table) ?? gpOwned(table, "th", "table").length;
  const activity = tables.find((table) => thOf(table) === 12);
  const records: GpRecord[] = [];
  if (activity) {
    const body = gpBodyRows(activity);
    const texts = (row: GpNode) => gpDirectCells(row).map(gpText);
    const desktop = body.filter((row) => gpDirectCells(row).length === 9).map(texts);
    const responsive = body.filter((row) => [4, 5].includes(gpDirectCells(row).length)).map(texts);
    for (let index = 0; index < Math.max(desktop.length, responsive.length); index++)
      records.push({ desktop: desktop[index] ?? [], responsive: responsive[index] ?? [] });
  }
  return {
    thOf,
    activity,
    compact: tables.filter((table) => thOf(table) === 4),
    expanded: tables.filter((table) => thOf(table) === 10),
    others: tables.filter((table) => ![12, 4, 10].includes(thOf(table))),
    records,
  };
}

/**
 * The texts the comparisons above read: activity records, and each detail
 * table's headers and value cells. Never printed; exported only for the
 * differential test that proves this reading equals what the parser emits
 * on pages it accepts.
 */
export function globalPassPageText(bytes: Uint8Array): {
  records: GpRecord[];
  compact: { headers: string[]; values: string[] }[];
  expanded: { headers: string[]; values: string[] }[];
} {
  const page = readGpPage(
    parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown as GpNode,
  );
  const detail = (table: GpNode) => ({ headers: gpHeaders(table), values: gpValueCells(table) });
  return {
    records: page.records,
    compact: page.compact.map(detail),
    expanded: page.expanded.map(detail),
  };
}

/** The pattern class of a cell's text (`GlobalPassCellPattern`). */
export function globalPassCellPattern(text: string): GlobalPassCellPattern {
  const length = [...text].length;
  return {
    empty: text === "",
    digitsOnly: /^\d+$/u.test(text),
    dateLike: GLOBAL_PASS_DATE_CELL.test(text),
    amountLike: GLOBAL_PASS_AMOUNT_CELL.test(text.trim()),
    asciiOnly: /^[\x20-\x7e]*$/u.test(text),
    hasJapanese: GP_JAPANESE.test(text),
    lengthBucket:
      length === 0
        ? "0"
        : length <= 4
          ? "1-4"
          : length <= 16
            ? "5-16"
            : length <= 64
              ? "17-64"
              : "65+",
  };
}

/** Every record cell with exactly `text`; nothing for an empty text. */
function recordCellsEqual(records: readonly GpRecord[], text: string): GlobalPassRecordCell[] {
  if (text === "") return [];
  const found: GlobalPassRecordCell[] = [];
  records.forEach((record, index) => {
    for (const row of ["desktop", "responsive"] as const)
      record[row].forEach((cell, position) => {
        if (cell === text) found.push({ record: index, row, cell: position });
      });
  });
  return found;
}

/**
 * The number ending a table's id or name: the first of its own `id`, its own
 * `name`, and, when its parent element wraps only it, the parent's `id` and
 * `name` that ends in digits.
 */
function idNumber(table: GpNode): number | null {
  const parent = table.parentNode ?? null;
  const values = [gpAttribute(table, "id"), gpAttribute(table, "name")];
  if (parent && parent.tagName !== undefined && gpTopTables(parent).length === 1)
    values.push(gpAttribute(parent, "id"), gpAttribute(parent, "name"));
  for (const value of values) {
    const match = GP_ID_SUFFIX.exec(value ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

function detailMatches(tables: readonly GpNode[], records: readonly GpRecord[]) {
  const recordCells = records.map(
    (record) => new Set([...record.desktop, ...record.responsive].filter((cell) => cell !== "")),
  );
  return tables.map((table, index): GlobalPassDetailMatch => {
    const values = gpValueCells(table).filter((value) => value !== "");
    const scores = recordCells.map((cells) => values.filter((value) => cells.has(value)).length);
    const most = scores.reduce((top, score) => Math.max(top, score), 0);
    const leaders = scores.flatMap((score, record) => (most > 0 && score === most ? [record] : []));
    return {
      table: index,
      valueCells: values.length,
      records: scores.flatMap((score, record) => (score > 0 ? [record] : [])),
      matchedCells: most,
      best: leaders.length === 1 ? leaders[0]! : null,
    };
  });
}

/** Which record each detail table carries; see `GlobalPassAlignment`. */
function alignment(page: GpPage): GlobalPassAlignment {
  const compact = detailMatches(page.compact, page.records);
  const expanded = detailMatches(page.expanded, page.records);
  const carried = new Set(compact.flatMap((match) => (match.best === null ? [] : [match.best])));
  return {
    compact,
    expanded,
    unmatchedRecords: page.records.flatMap((_, record) => (carried.has(record) ? [] : [record])),
    monotonic: compact.every(
      (match, index) =>
        match.best !== null && (index === 0 || match.best > (compact[index - 1]!.best ?? Infinity)),
    ),
    pairsAgree: compact.every(
      (match, index) =>
        index >= expanded.length || (match.best !== null && match.best === expanded[index]!.best),
    ),
    indexAligned: compact.every((match, index) => match.best === index),
  };
}

function detailContainer(page: GpPage): GlobalPassDetailContainer | null {
  const parents = new Set(page.compact.map((table) => table.parentNode ?? null));
  const parent = parents.size === 1 ? [...parents][0] : null;
  if (!parent) return null;
  const children = shapeChildren(parent).map((child) => {
    const top = gpTopTables(child);
    const th = top.length === 1 ? page.thOf(top[0]!) : null;
    return {
      tag: GP_TAGS.has(child.tagName ?? "") ? child.tagName! : "other",
      th,
      wrapped: child.tagName !== "table" && top.length === 1,
      known: th !== null && [12, 4, 10].includes(th),
      tables: gpElements(child, "table").length,
    };
  });
  const sequence = children.flatMap((child) => (child.th === null ? [] : [child.th]));
  let pairs = 0;
  while (sequence[pairs * 2] === 4 && sequence[pairs * 2 + 1] === 10) pairs++;
  return { childCount: children.length, children, pairsInOrder: pairs };
}

function attributeNameClass(name: string): string {
  const lower = name.toLowerCase();
  if (GP_ATTRIBUTE_NAMES.has(lower)) return lower;
  if (lower.startsWith("data-")) return "data-*";
  if (lower.startsWith("aria-")) return "aria-*";
  if (lower.startsWith("on")) return "on*";
  return "other";
}

function otherTables(
  page: GpPage,
  container: GpNode | null,
  headerLists: { activity: string[]; compact: string[]; expanded: string[] },
): GlobalPassOtherTable[] {
  const compactTokens = page.compact.map(gpClassTokens);
  const expandedTokens = page.expanded.map(gpClassTokens);
  const sharedCompact = uniform(compactTokens, sameList) ? compactTokens[0]! : null;
  const sharedExpanded = uniform(expandedTokens, sameList) ? expandedTokens[0]! : null;
  const peers = [...page.compact, ...page.expanded].map(idNumber).filter((value) => value !== null);
  const surveyed = new Set<string>([
    ...GLOBAL_PASS_SURVEYED_ENGLISH,
    ...GLOBAL_PASS_SURVEYED_JAPANESE,
  ]);
  return page.others.map((table): GlobalPassOtherTable => {
    const parent = table.parentNode ?? null;
    const position = parent ? shapeChildren(parent).indexOf(table) : -1;
    const tokens = gpClassTokens(table);
    const own = idNumber(table);
    const numbers = own === null || peers.length === 0 ? [] : [...new Set([...peers, own])];
    numbers.sort((left, right) => left - right);
    const spans = [...gpOwned(table, "th", "table"), ...gpOwned(table, "td", "table")]
      .map((cell) => gpAttribute(cell, "colspan") ?? "")
      .filter((value) => /^\d{1,4}$/u.test(value))
      .map(Number);
    return {
      th: page.thOf(table),
      td: gpOwned(table, "td", "table").length,
      bodyRows: gpBodyRows(table).length,
      cellsPerRow: gpBodyRows(table).map((row) => gpDirectCells(row).length),
      colspanMax: spans.length === 0 ? null : Math.max(...spans),
      theadPresent: gpOwned(table, "thead", "table").length > 0,
      nestedTables: gpElements(table, "table").length - 1,
      positionInParent: position < 0 ? null : position,
      parentIsDetailContainer: container !== null && parent === container,
      classTokenCount: tokens.length,
      classTokensEqualCompact: sharedCompact === null ? null : sameList(tokens, sharedCompact),
      classTokensEqualExpanded: sharedExpanded === null ? null : sameList(tokens, sharedExpanded),
      attributeNames: [
        ...new Set((table.attrs ?? []).map((item) => attributeNameClass(item.name))),
      ].sort(),
      idNumericSuffixRank: numbers.length === 0 ? null : numbers.indexOf(own!),
      idNumericSuffixDistinct: numbers.length === 0 ? null : numbers.length,
      idNumericSuffixPeers: peers.length,
      headerMatches: gpOwned(table, "th", "table")
        .map(gpText)
        .map((header) => ({
          activity: indexOrNull(headerLists.activity, header),
          compact: indexOrNull(headerLists.compact, header),
          expanded: indexOrNull(headerLists.expanded, header),
          surveyed: surveyed.has(header),
        })),
      cells: gpOwned(table, "td", "table")
        .map(gpText)
        .map((text) => ({
          ...globalPassCellPattern(text),
          equalsRecordCell: recordCellsEqual(page.records, text),
        })),
    };
  });
}

/** The records no compact table carries, with each cell's pattern set against the carried records'. */
function unmatchedRecords(page: GpPage, aligned: GlobalPassAlignment): GlobalPassUnmatchedRecord[] {
  const carried = [
    ...new Set(aligned.compact.flatMap((match) => (match.best === null ? [] : [match.best]))),
  ];
  const otherCells = page.others.map((table) => gpOwned(table, "td", "table").map(gpText));
  const key = (text: string) => JSON.stringify(globalPassCellPattern(text));
  const majority = (row: "desktop" | "responsive", position: number): string | null => {
    const keys = carried
      .map((record) => page.records[record]![row][position])
      .filter((text) => text !== undefined)
      .map(key);
    const tally = new Map<string, number>();
    for (const item of keys) tally.set(item, (tally.get(item) ?? 0) + 1);
    for (const [item, count] of tally) if (count * 2 > keys.length) return item;
    return null;
  };
  const describe = (row: "desktop" | "responsive", text: string, position: number) => {
    const common = majority(row, position);
    return {
      ...globalPassCellPattern(text),
      patternEqualsMajority: common === null ? null : key(text) === common,
      equalsOtherTableCell:
        text === ""
          ? []
          : otherCells.flatMap((cells, table) =>
              cells.flatMap((cell, index) => (cell === text ? [{ table, cell: index }] : [])),
            ),
    };
  };
  return aligned.unmatchedRecords.map((record) => ({
    record,
    desktop: page.records[record]!.desktop.map((text, index) => describe("desktop", text, index)),
    responsive: page.records[record]!.responsive.map((text, index) =>
      describe("responsive", text, index),
    ),
  }));
}

function globalPassComparisons(
  page: GpPage,
): Pick<
  GlobalPassActivityShape,
  "detailTables" | "detailContainer" | "otherTables" | "recordDetailAlignment" | "unmatchedRecords"
> {
  const container = detailContainer(page);
  const parent = container === null ? null : (page.compact[0]!.parentNode ?? null);
  const comparisons: ReturnType<typeof globalPassComparisons> = {
    detailTables: {
      compactHeadersUniform: uniform(page.compact.map(gpHeaders), sameList),
      expandedHeadersUniform: uniform(page.expanded.map(gpHeaders), sameList),
      compactClassTokensUniform: uniform(page.compact.map(gpClassTokens), sameList),
      expandedClassTokensUniform: uniform(page.expanded.map(gpClassTokens), sameList),
    },
    detailContainer: container,
    otherTables: otherTables(page, parent, {
      activity: gpHeaders(page.activity),
      compact: gpHeaders(page.compact[0]),
      expanded: gpHeaders(page.expanded[0]),
    }),
  };
  if (page.activity) {
    const aligned = alignment(page);
    comparisons.recordDetailAlignment = aligned;
    comparisons.unmatchedRecords = unmatchedRecords(page, aligned);
  }
  return comparisons;
}

// ── GLOBAL PASS replay selection ─────────────────────────────────────────────

/** The `replay-diagnostics.ts` selection name for GLOBAL PASS activity pages. */
export const GLOBAL_PASS_SELECTION = "globalpass-activity";

/**
 * The read-only selection of `replay-diagnostics.ts globalpass-activity`: the
 * stored `globalpass-activity` artifacts whose latest `global-pass-activity`
 * parse (of any version, or of `version` when given) is `error` with
 * `parser_rejected`, one per raw object (its newest artifact), newest fetch
 * run first. An artifact a later parse accepted is not selected. The columns
 * are those of `replaySelectionSql`, so the replay builds the same
 * `ArtifactMeta`. `GLOBAL PASS` is outside `REPLAY_SOURCES`, which this
 * selection does not widen.
 */
export function globalPassReplaySelectionSql(filter: { version?: string } = {}): string {
  if (filter.version !== undefined && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(filter.version))
    throw new Error("parser version must be MAJOR.MINOR.PATCH");
  const version = filter.version === undefined ? "" : ` AND p.parser_version='${filter.version}'`;
  return `WITH latest AS (
 SELECT p.fetch_artifact_id,p.parser_name,p.parser_version,p.status,p.error,
 row_number() OVER(PARTITION BY p.fetch_artifact_id ORDER BY p.id DESC) AS parse_rank
 FROM parse_runs p WHERE p.parser_name='${GLOBAL_PASS_ACTIVITY_PARSER}'${version}
), failed AS (
 SELECT a.*,o.blob_key,o.byte_size,l.parser_name,l.parser_version AS failed_parser_version,
 r.status AS run_status,r.failure_count AS run_failure_count,
 NULL AS metadata_projection_json,
 row_number() OVER(PARTITION BY a.sha256 ORDER BY a.fetch_run_id DESC,a.id DESC) AS rank,
 coalesce((SELECT start_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_start) AS window_start,
 coalesce((SELECT end_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_end) AS window_end
 FROM latest l JOIN observation_fetch_artifacts a ON a.id=l.fetch_artifact_id
 JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
 JOIN raw_objects o ON o.sha256=a.sha256
 WHERE l.parse_rank=1 AND l.status='error' AND l.error='parser_rejected'
 AND a.source_id='global-pass' AND a.dataset='globalpass-activity'
) SELECT * FROM failed WHERE rank=1 ORDER BY fetch_run_id DESC,id DESC LIMIT 50`;
}

// ── GLOBAL PASS: the same page in the newest published capture ──────────────

/** A page-1 or walked-page key of `globalpass-activity` (the parser's own key form). */
const GLOBAL_PASS_ARTIFACT_KEY = /^activity-\d{4}-\d{2}(?:-p[2-9])?\.html$/u;

/**
 * The read-only lookup `replay-diagnostics.ts` runs for each replayed
 * GLOBAL PASS rejection: the newest other `globalpass-activity` artifact with
 * the same artifact key (the same month and page) that has a published
 * `global-pass-activity` parse (`published_parse_runs`, the adoption pointer
 * the replay's selection also reads), with what the replay needs to read and
 * verify its raw object. Null for an artifact id or key of another form,
 * which is never put into SQL.
 */
export function globalPassLatestOkSql(artifact: {
  id: number;
  artifactKey: string | null | undefined;
}): string | null {
  const key = artifact.artifactKey ?? "";
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || !GLOBAL_PASS_ARTIFACT_KEY.test(key))
    return null;
  return `SELECT a.id,a.sha256,o.blob_key,o.byte_size
 FROM published_parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN raw_objects o ON o.sha256=a.sha256
 WHERE p.parser_name='${GLOBAL_PASS_ACTIVITY_PARSER}'
 AND a.source_id='global-pass' AND a.dataset='globalpass-activity'
 AND a.artifact_key='${key}' AND a.id<>${artifact.id}
 ORDER BY a.fetch_run_id DESC,a.id DESC LIMIT 1`;
}

export interface GlobalPassLatestOkCapture {
  /** A capture of the same key with a published parse exists. */
  found: boolean;
  /** Its internal artifact id; null when none was found. */
  artifact: number | null;
  /** Its bytes match the stored SHA-256 and size; null when none was found. */
  intact: boolean | null;
  /** Its desktop (nine-cell) rows; null when none was found or it is not intact. */
  records: number | null;
  /** Records of the refused page whose desktop row equals, cell for cell, one of its desktop rows. */
  recordsAlsoPresent: number | null;
  /** Every record no compact table carries is among those; null without such a record or capture. */
  unmatchedRecordPresent: boolean | null;
}

/**
 * The refused page's records compared with the newest capture of the same key
 * that has a published parse, by exact desktop-row equality. Counts and
 * booleans only.
 */
export function globalPassLatestOkComparison(
  refused: Uint8Array,
  ok: { artifact: number; bytes: Uint8Array; intact: boolean } | null,
): GlobalPassLatestOkCapture {
  const none = { records: null, recordsAlsoPresent: null, unmatchedRecordPresent: null };
  if (ok === null) return { found: false, artifact: null, intact: null, ...none };
  if (!ok.intact) return { found: true, artifact: ok.artifact, intact: false, ...none };
  const page = (bytes: Uint8Array): GpPage | null => {
    try {
      const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return readGpPage(parse(html) as unknown as GpNode);
    } catch {
      return null;
    }
  };
  const desktopKey = (record: GpRecord) => JSON.stringify(record.desktop);
  // A record without a desktop row (more responsive rows than desktop ones) has none to compare.
  const withDesktop = (records: readonly GpRecord[]) =>
    records.filter((record) => record.desktop.length === 9);
  const acceptedRows = withDesktop(page(ok.bytes)?.records ?? []);
  const present = new Set(acceptedRows.map(desktopKey));
  const mine = page(refused);
  const unmatched = mine?.activity ? alignment(mine).unmatchedRecords : [];
  return {
    found: true,
    artifact: ok.artifact,
    intact: true,
    records: acceptedRows.length,
    recordsAlsoPresent: withDesktop(mine?.records ?? []).filter((record) =>
      present.has(desktopKey(record)),
    ).length,
    unmatchedRecordPresent:
      unmatched.length === 0
        ? null
        : unmatched.every((record) => present.has(desktopKey(mine!.records[record]!))),
  };
}
