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
// are folded to `[]` so a category is closed and does not count rows.
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
 * parser maps to its throw site; any other parser keeps the older coarse
 * reasons of `legacySafeReason`. A non-`Error` class is a runtime defect, not
 * a refusal, and is named by its standard class only.
 */
export function classifyParserRejection(parserName: string, error: unknown): RejectionCategory {
  if (!(error instanceof Error)) return { reason: "non_error_throw" };
  if (error.constructor !== Error)
    return { reason: `runtime_${RUNTIME_ERRORS.has(error.name) ? error.name : "other"}` };
  if ((SBI_SHINSEI_PARSERS as readonly string[]).includes(parserName))
    return classifySbiShinseiMessage(error.message);
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

// ── replay selection ─────────────────────────────────────────────────────────

/** Sources whose stored failures `replay-diagnostics.ts` may replay. */
export const REPLAY_SOURCES = ["sony-bank", "sbi-shinsei-bank"] as const;

/**
 * The read-only selection of `replay-diagnostics.ts`: the newest failed parse
 * of each distinct (parser, raw object) that no parse of the same parser has
 * since published, with the parent run's status the way the processor's own
 * `artifactSql` reads it. The parser filter is applied in SQL, before the
 * limit, so an older parser's failures are not crowded out by newer failures
 * of other parsers. `parser` is an exact registered name; `substring` keeps the
 * earlier `includes` behaviour. Both are restricted to parser-name characters
 * because the text is passed to `wrangler d1 execute --command`.
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
