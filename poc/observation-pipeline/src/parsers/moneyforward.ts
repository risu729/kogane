import type { ArtifactMeta, Parser, ParseResult, TransactionObservation } from "../types.ts";
import { decodeUtf8 } from "./util.ts";
import { normalizedDate, stableFingerprint } from "./sbi-strict.ts";

export interface MoneyForwardDomNode {
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: MoneyForwardDomNode[];
  content?: MoneyForwardDomNode;
  value?: string;
  sourceCodeLocation?: { startOffset?: number; endTag?: unknown };
}

export type MoneyForwardHtmlParser = (
  html: string,
  options?: { sourceCodeLocationInfo?: boolean },
) => MoneyForwardDomNode;

type HtmlNode = MoneyForwardDomNode;
type HtmlElement = MoneyForwardDomNode & { tagName: string };

const SOURCE = "moneyforward-me";
const MIME = "text/html; charset=utf-8";
const MONTHLY_KEY = /^account-(0[1-9]|[1-5]\d|6[0-4])-month-(\d{4}-(?:0[1-9]|1[0-2]))\.html$/u;
const DETAIL_KEY = /^account-detail-(0[1-9]|[1-5]\d|6[0-4])\.html$/u;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/gu;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_TABLES = 1_000;
const MAX_ROWS_PER_TABLE = 1_000;
const ACCOUNT_IDENTITY = /^moneyforward-account-v1-[0-9a-f]{64}$/u;
// The provider emits an escaped dialog template alongside the empty calendar.
// Compare only audited tag/attribute-name structure, never provider text or values.
const EMPTY_SURFACE = [
  "html[]",
  "head[]",
  "body[]",
  'div[class,js-transfer-switch-dialog,is-hidden\\"]',
  "div[class]",
  'p[class,js-transfer-switch-dialog-action-msg\\"]',
  "div[class]",
  'a[class,btn-default,btn-footer,js-transfer-switch-dialog-btn-cancel\\"]',
  'a[class,btn-footer,btn-proceed,js-transfer-switch-dialog-btn-proceed\\",data-method,data-remote]',
  "div[id]",
  "select[]",
  "option[]",
  "option[]",
  "select[]",
  "option[]",
].join("/");

export function createMoneyForwardMonthlyTransactions(parseHtml: MoneyForwardHtmlParser): Parser {
  return {
    name: "moneyforward-monthly-transactions",
    version: "2.0.0",

    accepts(artifact: ArtifactMeta): boolean {
      return (
        artifact.sourceId === SOURCE &&
        artifact.dataset === "monthly-transactions" &&
        artifact.mime === MIME
      );
    },

    parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
      requireSuccessfulRun(artifact);
      requireBaseMetadata(artifact);
      const match = artifact.artifactKey?.match(MONTHLY_KEY);
      if (!match) throw new Error("moneyforward monthly artifact key is invalid");
      const accountOrdinal = match[1]!;
      const accountIdentity = requireAccountIdentity(artifact);
      const selectedMonth = match[2]!;
      const html = strictHtml(bytes);
      if (/<(?:!doctype|html)(?:\s|>)/iu.test(html)) {
        throw new Error("moneyforward monthly artifact must be an HTML fragment");
      }
      const document = parseHtml(html, { sourceCodeLocationInfo: true });
      const elements = allElements(document);
      const tables = elements.filter(isTooltipTable);
      if (
        elements.filter(
          (element) => element.tagName === "div" && attribute(element, "id") === "calendar",
        ).length !== 1 ||
        elements.some(
          (element) =>
            element.tagName === "script" ||
            (element.tagName === "table" && !isTooltipTable(element)),
        )
      ) {
        throw new Error("moneyforward monthly calendar surface marker is invalid");
      }
      if (tables.length > MAX_TABLES) throw new Error("moneyforward monthly table limit exceeded");
      if (
        tables.length === 0 &&
        elements
          .map(
            (element) =>
              `${element.tagName}[${(element.attrs ?? []).map((attr) => attr.name).join(",")}]`,
          )
          .join("/") !== EMPTY_SURFACE
      ) {
        throw new Error("moneyforward monthly empty surface marker is invalid");
      }
      const dateTokens = [...html.matchAll(ISO_DATE)].map((dateMatch) => ({
        value: normalizedDate(dateMatch[0], "moneyforward monthly tooltip date"),
        offset: dateMatch.index,
      }));
      if (dateTokens.length !== tables.length) {
        throw new Error("moneyforward monthly tooltip and date cardinality disagree");
      }

      const observations: TransactionObservation[] = [];
      const occurrences = new Map<string, number>();
      const usedDateOffsets = new Set<number>();
      tables.forEach((table, tableIndex) => {
        const startOffset = table.sourceCodeLocation?.startOffset;
        if (!Number.isSafeInteger(startOffset)) {
          throw new Error("moneyforward monthly tooltip source location is unavailable");
        }
        const dateToken = dateTokens.filter((token) => token.offset < startOffset!).at(-1);
        if (
          !dateToken ||
          startOffset! - dateToken.offset > 100 ||
          usedDateOffsets.has(dateToken.offset)
        ) {
          throw new Error("moneyforward monthly tooltip date binding is invalid");
        }
        usedDateOffsets.add(dateToken.offset);
        const monthDistance =
          Number(dateToken.value.slice(0, 4)) * 12 +
          Number(dateToken.value.slice(5, 7)) -
          (Number(selectedMonth.slice(0, 4)) * 12 + Number(selectedMonth.slice(5, 7)));
        if (Math.abs(monthDistance) > 1) {
          throw new Error(
            "moneyforward monthly tooltip date is outside the declared calendar month",
          );
        }
        if (allElements(table).some((element) => !element.sourceCodeLocation?.endTag)) {
          throw new Error("moneyforward monthly tooltip contains an incomplete element");
        }
        const rows = directTableRows(table);
        if (rows.length < 1 || rows.length > MAX_ROWS_PER_TABLE + 1) {
          throw new Error("moneyforward monthly tooltip row cardinality is invalid");
        }
        requireHeader(rows[0]!);
        rows.slice(1).forEach((row, rowIndex) => {
          const cells = directCells(row);
          if (
            cells.length !== 2 ||
            cells.some((cell) => cell.tagName !== "td" || childElements(cell).length !== 0)
          ) {
            throw new Error("moneyforward monthly transaction row shape is invalid");
          }
          const description = nonEmptyText(cells[0], "moneyforward monthly description");
          const amountText = nonEmptyText(cells[1], "moneyforward monthly amount");
          const amountMinor = signedJpy(amountText);
          if (!dateToken.value.startsWith(`${selectedMonth}-`)) return;
          const fingerprint = stableFingerprint({
            accountIdentity,
            selectedMonth,
            date: dateToken.value,
            description,
            amountText,
          });
          const occurrence = occurrences.get(fingerprint) ?? 0;
          occurrences.set(fingerprint, occurrence + 1);
          observations.push({
            kind: "transaction",
            sourceAccount: `moneyforward-me:${accountIdentity}`,
            externalId: `moneyforward-monthly:${fingerprint}:${occurrence}`,
            amountMinor,
            amountText: String(amountMinor),
            amountScale: 0,
            currency: "JPY",
            description,
            asOf: dateToken.value,
            rawLocator: `html:tooltip=${tableIndex}:row=${rowIndex}`,
            extra: {
              cells: [description, amountText],
              _kogane: {
                canonicalDataset: "monthly-transactions",
                sourceView: "monthly-calendar-tooltip",
                accountOrdinal,
                selectedMonth,
                amountDirection: "provider-signed-cashflow",
                adjacentCalendarRows: "validated-but-not-emitted",
                identityOrigin: "hmac-account+month+date+description+amount+occurrence",
              },
            },
          });
        });
      });
      return { observations, warnings: [] };
    },
  };
}

export function createMoneyForwardEvidenceOnly(parseHtml: MoneyForwardHtmlParser): Parser {
  return {
    name: "moneyforward-canonical-evidence-boundary",
    version: "1.0.0",

    accepts(artifact: ArtifactMeta): boolean {
      return (
        artifact.sourceId === SOURCE &&
        (artifact.dataset === "accounts-index" || artifact.dataset === "account-detail") &&
        artifact.mime === MIME
      );
    },

    parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
      requireSuccessfulRun(artifact);
      requireBaseMetadata(artifact);
      const html = strictHtml(bytes);
      if (
        !/^\s*(?:<!doctype\s+html(?:\s+[^>]*)?>\s*)?<html\b/iu.test(html) ||
        !/<body\b/iu.test(html)
      ) {
        throw new Error("moneyforward evidence-only artifact must be a complete HTML document");
      }
      const document = parseHtml(html);
      const elements = allElements(document);
      if (artifact.dataset === "accounts-index") {
        if (artifact.artifactKey !== "accounts.html") {
          throw new Error("moneyforward accounts-index artifact key is invalid");
        }
        const tables = elements.filter(
          (element) => element.tagName === "table" && attribute(element, "id") === "account-table",
        );
        if (tables.length !== 1 || accountLinks(tables[0]!).length > 64) {
          throw new Error("moneyforward accounts-index surface marker is invalid");
        }
      } else {
        requireAccountIdentity(artifact);
        if (!artifact.artifactKey?.match(DETAIL_KEY)) {
          throw new Error("moneyforward account-detail artifact key is invalid");
        }
        requireUniqueMarker(
          elements,
          (element) =>
            element.tagName === "meta" &&
            attribute(element, "name") === "csrf-token" &&
            validOpaque(attribute(element, "content")),
          "csrf",
        );
        for (const name of ["account[id_hash]", "service[id]"]) {
          requireUniqueMarker(
            elements,
            (element) =>
              element.tagName === "input" &&
              attribute(element, "name") === name &&
              validOpaque(attribute(element, "value")),
            name,
          );
        }
        requireUniqueMarker(
          elements,
          (element) =>
            element.tagName === "table" && attribute(element, "id") === "cf-detail-table",
          "recent transaction table",
        );
      }
      return { observations: [], warnings: [] };
    },
  };
}

function requireSuccessfulRun(artifact: ArtifactMeta): void {
  if (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) {
    throw new Error("moneyforward observations require a successful failure-free run");
  }
}

function requireAccountIdentity(artifact: ArtifactMeta): string {
  if (typeof artifact.fetchUnitKey !== "string" || !ACCOUNT_IDENTITY.test(artifact.fetchUnitKey)) {
    throw new Error("moneyforward account identity metadata is invalid");
  }
  return artifact.fetchUnitKey;
}

function requireBaseMetadata(artifact: ArtifactMeta): void {
  if (
    artifact.sourceId !== SOURCE ||
    artifact.mime !== MIME ||
    artifact.statementState !== null ||
    artifact.period !== null ||
    artifact.url !== null
  ) {
    throw new Error("moneyforward artifact metadata is invalid");
  }
}

function strictHtml(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HTML_BYTES) {
    throw new Error("moneyforward HTML size is invalid");
  }
  const html = decodeUtf8(bytes);
  if (html.includes("\0")) throw new Error("moneyforward HTML contains NUL");
  return html;
}

function isTooltipTable(element: HtmlElement): boolean {
  return (
    element.tagName === "table" &&
    attribute(element, "id") === "tooltip" &&
    sameStrings(classTokens(element), ["calendar-tooltip-table"])
  );
}

function directTableRows(table: HtmlElement): HtmlElement[] {
  const sections = childElements(table);
  if (
    sections.length !== 2 ||
    sections[0]?.tagName !== "thead" ||
    !sameStrings(classTokens(sections[0]), ["orange"]) ||
    sections[1]?.tagName !== "tbody"
  ) {
    throw new Error("moneyforward monthly tooltip table structure is invalid");
  }
  const headerRows = childElements(sections[0]).filter((element) => element.tagName === "tr");
  const bodyRows = childElements(sections[1]).filter((element) => element.tagName === "tr");
  if (
    headerRows.length !== 1 ||
    headerRows.length !== childElements(sections[0]).length ||
    bodyRows.length !== childElements(sections[1]).length
  ) {
    throw new Error("moneyforward monthly tooltip contains an unsupported child");
  }
  return [...headerRows, ...bodyRows];
}

function requireHeader(row: HtmlElement): void {
  const cells = directCells(row);
  if (
    cells.length !== 2 ||
    cells[0]?.tagName !== "th" ||
    cells[1]?.tagName !== "th" ||
    compactText(cells[0]) !== "内容" ||
    compactText(cells[1]) !== "金額（円）"
  ) {
    throw new Error("moneyforward monthly tooltip header is invalid");
  }
}

function directCells(row: HtmlElement): HtmlElement[] {
  if (row.tagName !== "tr") throw new Error("moneyforward monthly row element is invalid");
  return childElements(row);
}

function signedJpy(value: string): number {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replaceAll("−", "-")
    .replaceAll("▲", "-")
    .replaceAll("△", "-");
  const digits = "(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)";
  const direct = new RegExp(`^([+-])(${digits})$`, "u").exec(normalized);
  const negativeTemplate = new RegExp(
    `^'\\s*\\+\\s*""\\s*\\+\\s*'-(${digits})'\\s*\\+\\s*'$`,
    "u",
  ).exec(normalized);
  const positiveTemplate = new RegExp(
    `^'\\s*\\+\\s*"\\+"\\s*\\+\\s*'(${digits})'\\s*\\+\\s*'$`,
    "u",
  ).exec(normalized);
  const sign = direct?.[1] ?? (negativeTemplate ? "-" : positiveTemplate ? "+" : undefined);
  const magnitude = direct?.[2] ?? negativeTemplate?.[1] ?? positiveTemplate?.[1];
  if (!sign || !magnitude) {
    throw new Error("moneyforward monthly amount is not an exact signed JPY integer");
  }
  const amount = Number(`${sign}${magnitude.replaceAll(",", "")}`);
  if (!Number.isSafeInteger(amount)) throw new Error("moneyforward monthly amount exceeds range");
  return Object.is(amount, -0) ? 0 : amount;
}

function nonEmptyText(element: HtmlElement | undefined, label: string): string {
  const value = compactText(element);
  if (value.length === 0 || value.length > 5_000) throw new Error(`${label} is invalid`);
  return value;
}

function compactText(element: HtmlElement | undefined): string {
  if (!element) return "";
  const values: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (typeof node.value === "string") values.push(node.value);
    if (node.childNodes) for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return values.join(" ").replace(/\s+/gu, " ").trim();
}

function allElements(root: HtmlNode): HtmlElement[] {
  const output: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (typeof node.tagName === "string") output.push(node as HtmlElement);
    if (node.childNodes) for (const child of node.childNodes) visit(child);
    if (node.content) visit(node.content);
  };
  visit(root);
  return output;
}

function childElements(element: HtmlElement): HtmlElement[] {
  return (element.childNodes ?? []).filter(isHtmlElement);
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs?.find((entry) => entry.name === name)?.value;
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return typeof node.tagName === "string";
}

function classTokens(element: HtmlElement): string[] {
  return (attribute(element, "class") ?? "").split(/\s+/u).filter(Boolean);
}

function sameStrings(left: string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function accountLinks(root: HtmlElement): HtmlElement[] {
  return allElements(root).filter(
    (element) =>
      element.tagName === "a" &&
      /^\/accounts\/show\/[A-Za-z0-9_-]+(?:[?#].*)?$/u.test(attribute(element, "href") ?? ""),
  );
}

function validOpaque(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function requireUniqueMarker(
  elements: HtmlElement[],
  predicate: (element: HtmlElement) => boolean,
  label: string,
): void {
  if (elements.filter(predicate).length !== 1) {
    throw new Error(`moneyforward ${label} surface marker is invalid`);
  }
}
