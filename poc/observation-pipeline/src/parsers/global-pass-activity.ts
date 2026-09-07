import type { ArtifactMeta, Parser, ParseResult, TransactionObservation } from "../types.ts";
import { amountToMinorUnits, decodeUtf8 } from "./util.ts";
import { normalizedDate, stableFingerprint } from "./sbi-strict.ts";

const SOURCE = "global-pass";
const DATASET = "globalpass-activity";
const MEDIA = "text/html";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 250;
const DATE_HEADER = "Transaction Date";
const DETAIL_HEADER = "Transaction Detail";
const AMOUNT_HEADER = "Transaction Currency and Amount";
const REQUIRED_DETAIL_HEADERS = [AMOUNT_HEADER, DETAIL_HEADER] as const;
const REQUIRED_EXPANDED_HEADERS = [
  [AMOUNT_HEADER],
  ["Transaction Fee"],
  ["ATM Fee"],
  ["Status"],
  ["Approval Number"],
] as const;

export interface GlobalPassDomNode {
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: GlobalPassDomNode[];
  parentNode?: GlobalPassDomNode | null;
  value?: string;
}
type Node = GlobalPassDomNode;
type Element = GlobalPassDomNode & {
  tagName: string;
  attrs: Array<{ name: string; value: string }>;
};

interface RecordView {
  date: string;
  compactFields: Record<string, string>;
  expandedFields: Record<string, string>;
  desktopCells: string[];
  responsiveCells: string[];
}

export function createGlobalPassActivity(
  parseDocument: (html: string) => GlobalPassDomNode,
): Parser {
  return {
    name: "global-pass-activity",
    version: "1.0.0",

    accepts(artifact: ArtifactMeta): boolean {
      return (
        artifact.sourceId === SOURCE && artifact.dataset === DATASET && artifact.mime === MEDIA
      );
    },

    parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
      if (!this.accepts(artifact)) throw new Error("global-pass artifact metadata is unsupported");
      if (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) {
        throw new Error("global-pass observations require a successful failure-free fetch run");
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
        throw new Error("global-pass HTML size is outside the Layer-A contract");
      }
      const html = decodeUtf8(bytes);
      if (!/^\s*<!doctype\s+html\b/iu.test(html)) throw new Error("global-pass HTML doctype drift");
      const document = parseDocument(html);
      const selectedMonth = parseMonthSelector(document, artifact.artifactKey);
      const tables = elements(document, "table");
      const outer = tables.filter((table) => owned(table, "th", "table").length === 12);
      const compact = tables.filter((table) => owned(table, "th", "table").length === 4);
      const expanded = tables.filter((table) => owned(table, "th", "table").length === 10);
      if (outer.length !== 1 || compact.length !== expanded.length || compact.length > MAX_ROWS) {
        throw new Error("global-pass activity table cardinality drift");
      }
      if (tables.length !== 1 + compact.length * 2) {
        throw new Error("global-pass contains an unclassified table");
      }

      const outerHeaders = uniqueHeaders(outer[0]!, 12, "activity");
      requireHeaders(outerHeaders, [DATE_HEADER, ...REQUIRED_DETAIL_HEADERS], "activity");
      requireHeaderGroups(outerHeaders, REQUIRED_EXPANDED_HEADERS, "activity");
      requireFeeSchema(outerHeaders, "activity");
      const outerRows = bodyRows(outer[0]!);
      if (outerRows.length !== compact.length * 2) {
        throw new Error("global-pass activity row cardinality drift");
      }
      const desktopRows = outerRows.filter((row) => directCells(row).length === 9);
      const responsiveRows = outerRows.filter((row) => [4, 5].includes(directCells(row).length));
      if (desktopRows.length !== compact.length || responsiveRows.length !== compact.length) {
        throw new Error("global-pass source-view row cardinality drift");
      }

      const dates = desktopRows.map((row, index) => {
        const matches = directCells(row)
          .map(text)
          .filter((value) => /^\d{4}[/-]\d{2}[/-]\d{2}$/u.test(value));
        if (matches.length !== 1)
          throw new Error(`global-pass row ${index + 1} date cardinality drift`);
        const date = normalizedDate(matches[0], `global-pass row ${index + 1} date`);
        if (date.slice(0, 7) !== selectedMonth) {
          throw new Error(`global-pass row ${index + 1} falls outside the selected month`);
        }
        return date;
      });
      for (let index = 1; index < dates.length; index += 1) {
        if (dates[index]! < dates[index - 1]!) {
          throw new Error("global-pass transaction dates are not in provider ascending order");
        }
      }

      const records: RecordView[] = [];
      for (let index = 0; index < compact.length; index += 1) {
        const compactHeaders = uniqueHeaders(compact[index]!, 4, `compact ${index + 1}`);
        const expandedHeaders = uniqueHeaders(expanded[index]!, 10, `expanded ${index + 1}`);
        requireHeaders(compactHeaders, REQUIRED_DETAIL_HEADERS, `compact ${index + 1}`);
        requireHeaderGroups(expandedHeaders, REQUIRED_EXPANDED_HEADERS, `expanded ${index + 1}`);
        requireFeeSchema(expandedHeaders, `expanded ${index + 1}`);
        const compactValues = flattenedValues(compact[index]!, [1, 1, 2], `compact ${index + 1}`);
        const expandedValues = flattenedValues(
          expanded[index]!,
          Array(10).fill(1),
          `expanded ${index + 1}`,
        );
        const compactFields = fields(compactHeaders, compactValues);
        const expandedFields = fields(expandedHeaders, expandedValues);
        if (compactFields[AMOUNT_HEADER] !== expandedFields[AMOUNT_HEADER]) {
          throw new Error(`global-pass row ${index + 1} source views disagree on amount text`);
        }
        records.push({
          date: dates[index]!,
          compactFields,
          expandedFields,
          desktopCells: directCells(desktopRows[index]!).map(text),
          responsiveCells: directCells(responsiveRows[index]!).map(text),
        });
      }

      const occurrences = new Map<string, number>();
      let unsigned = false;
      const observations = records.map((record, index): TransactionObservation => {
        const amount = parseDisplayedAmount(record.compactFields[AMOUNT_HEADER]!);
        const identity = stableFingerprint(record);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        if (!amount.signed) unsigned = true;
        return {
          kind: "transaction",
          sourceAccount: "global-pass:card",
          externalId: `global-pass:${identity}:${occurrence}`,
          ...(amount.minor !== undefined ? { amountMinor: amount.minor } : {}),
          amountText: amount.amountText,
          amountScale: amount.scale,
          currency: amount.currency,
          description: record.compactFields[DETAIL_HEADER]!,
          asOf: record.date,
          rawLocator: `html:activity-record=${index + 1}`,
          extra: {
            compactFields: record.compactFields,
            expandedFields: record.expandedFields,
            sourceViews: {
              desktopCells: record.desktopCells,
              responsiveCells: record.responsiveCells,
            },
            _kogane: {
              selectedMonth,
              sourceView: "single-provider-html-with-responsive-duplicate",
              identityOrigin: "all-provider-fields+occurrence",
              amountDirection: amount.signed ? "provider-signed" : "unresolved-unsigned",
              pendingToConfirmedIdentity: "unproven",
            },
          },
        };
      });
      return {
        observations,
        warnings: unsigned
          ? [
              "global-pass: unsigned provider amounts were preserved without inferred minor-unit direction",
            ]
          : [],
      };
    },
  };
}

function parseMonthSelector(document: Node, artifactKey: string | null | undefined): string {
  const candidates = elements(document, "select").filter((select) => {
    const options = owned(select, "option", "select");
    return options.some((option) => /^\d{8}$/u.test(attribute(option, "value") ?? ""));
  });
  if (candidates.length !== 1) throw new Error("global-pass month selector cardinality drift");
  const allOptions = owned(candidates[0]!, "option", "select");
  const options = allOptions.filter((option) => /^\d{8}$/u.test(attribute(option, "value") ?? ""));
  const nonMonth = allOptions.filter(
    (option) => !/^\d{8}$/u.test(attribute(option, "value") ?? ""),
  );
  if (
    options.length < 1 ||
    options.length > 15 ||
    nonMonth.length > 1 ||
    nonMonth.some((option) => hasAttribute(option, "selected"))
  ) {
    throw new Error(
      "global-pass month selector must contain between one and 15 months and at most one unselected default",
    );
  }
  const values = options.map((option) => attribute(option, "value")!);
  if (new Set(values).size !== values.length)
    throw new Error("global-pass month selector contains duplicates");
  const months = values.map((value, index) => {
    const month = `${value.slice(0, 4)}-${value.slice(4, 6)}`;
    if (!/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(month)) {
      throw new Error(`global-pass month option ${index + 1} is invalid`);
    }
    return month;
  });
  for (let index = 1; index < months.length; index += 1) {
    if (previousMonth(months[index - 1]!) !== months[index]) {
      throw new Error("global-pass month selector is not contiguous reverse chronology");
    }
  }
  const selected = options.filter((option) => hasAttribute(option, "selected"));
  if (selected.length !== 1)
    throw new Error("global-pass month selector must have one selected option");
  const selectedMonth = attribute(selected[0]!, "value")!
    .slice(0, 6)
    .replace(/^(\d{4})(\d{2})$/u, "$1-$2");
  if (artifactKey !== `activity-${selectedMonth}.html`) {
    throw new Error("global-pass artifact key and selected month disagree");
  }
  return selectedMonth;
}

function previousMonth(month: string): string {
  const [year, value] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function uniqueHeaders(table: Element, count: number, label: string): string[] {
  const headers = owned(table, "th", "table").map(text);
  if (
    headers.length !== count ||
    headers.some((header) => header === "") ||
    new Set(headers).size !== count
  ) {
    throw new Error(`global-pass ${label} header schema drift`);
  }
  return headers;
}

function requireHeaders(actual: string[], required: readonly string[], label: string): void {
  for (const header of required) {
    if (!actual.includes(header))
      throw new Error(`global-pass ${label} schema is missing ${header}`);
  }
}
function requireHeaderGroups(
  actual: string[],
  groups: readonly (readonly string[])[],
  label: string,
): void {
  for (const alternatives of groups) {
    if (!alternatives.some((header) => actual.includes(header))) {
      throw new Error(`global-pass ${label} schema is missing ${alternatives.join(" or ")}`);
    }
  }
}
function requireFeeSchema(actual: string[], label: string): void {
  if (actual.filter((header) => / Fee$/u.test(header)).length !== 3) {
    throw new Error(`global-pass ${label} must have exactly three fee fields`);
  }
}

function flattenedValues(table: Element, shape: number[], label: string): string[] {
  const rows = bodyRows(table);
  const actual = rows.map((row) => directCells(row).length);
  if (
    !same(
      [...actual].sort((left, right) => left - right),
      [...shape].sort((left, right) => left - right),
    )
  ) {
    throw new Error(`global-pass ${label} value cardinality drift`);
  }
  const values = rows.flatMap((row) => directCells(row).map(text));
  if (values.some((value) => value.length > 2_048))
    throw new Error(`global-pass ${label} field is too long`);
  return values;
}

function fields(headers: string[], values: string[]): Record<string, string> {
  if (headers.length !== values.length)
    throw new Error("global-pass header/value cardinality drift");
  return Object.fromEntries(headers.map((header, index) => [header, values[index]!]));
}

function parseDisplayedAmount(value: string): {
  amountText: string;
  currency: string;
  scale: number;
  signed: boolean;
  minor?: number;
} {
  const match = /^([A-Z]{3})\s+([+\-△▲]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)$/u.exec(value.trim());
  if (!match) throw new Error("global-pass transaction amount format drift");
  const currency = match[1]!;
  const amountText = match[2]!;
  const signed = /^[+\-△▲]/u.test(amountText);
  const scale = (amountText.split(".")[1] ?? "").length;
  const minor = signed ? amountToMinorUnits(amountText, currency) : undefined;
  if (signed && minor === undefined)
    throw new Error("global-pass signed amount is not exactly representable");
  return { amountText, currency, scale, signed, ...(minor !== undefined ? { minor } : {}) };
}

function bodyRows(table: Element): Element[] {
  return owned(table, "tr", "table").filter((row) => closest(row, "thead") === null);
}
function directCells(row: Element): Element[] {
  return elements(row, "td").filter((cell) => closest(cell, "tr") === row);
}
function elements(root: Node, tagName: string): Element[] {
  const result: Element[] = [];
  const visit = (node: Node): void => {
    if (node.tagName === tagName) result.push(node as Element);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return result;
}
function owned(root: Element, tagName: string, ownerTag: string): Element[] {
  return elements(root, tagName).filter((node) => closest(node, ownerTag) === root);
}
function closest(node: Node, tagName: string): Element | null {
  let parent = "parentNode" in node ? node.parentNode : null;
  while (parent) {
    if (parent.tagName === tagName) return parent as Element;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return null;
}
function text(node: Node): string {
  const values: string[] = [];
  const visit = (current: Node): void => {
    if (typeof current.value === "string") values.push(current.value);
    if ("childNodes" in current) for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return values.join(" ").replace(/\s+/gu, " ").trim();
}
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name.toLowerCase() === name)?.value;
}
function hasAttribute(node: Element, name: string): boolean {
  return node.attrs.some((item) => item.name.toLowerCase() === name);
}
function same<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
