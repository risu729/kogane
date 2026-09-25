import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { ArtifactMeta, BalanceObservation, Parser, ParseResult } from "../types.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import { readMyJcbStatementPage } from "../../../../packages/domain/src/myjcb-statement-page.ts";
import {
  exactKeys,
  normalizedDate,
  stableFingerprint,
  strictBoolean,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const SOURCE = "myjcb";
const LEDGER_ROOT_KEYS = ["schemaVersion", "detailMonth", "period", "state", "headers", "rows"];
const ROW_KEYS = ["summaryCells", "expanded"];
const PAST_ROOT_KEYS = ["jsonrpc", "id", "result"];
const PAST_RESULT_KEYS = ["errId", "errMessage", "detailPastJsonInfo"];
const PAST_ITEM_KEYS = [
  "detailAvailableFlag",
  "detailMonth",
  "payAmount",
  "payAmountDispFlag",
  "settlementYM",
];
const CONFIRMED_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"];
const UNCONFIRMED_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"];
const CONFIRMED_EXPANDED = new Set(["ご利用金額", "摘要", "今回回数", "備考", "訂正サイン"]);
const UNCONFIRMED_EXPANDED = new Set([
  "今回のお支払い金額",
  "摘要",
  "今回回数",
  "備考",
  "訂正サイン",
]);
const ARTIFACT_KEY = /^([a-z0-9][a-z0-9-]{0,63})\/(credit-ledger-(0[0-9]|1[0-7])\.json)$/u;
const PAST_ARTIFACT_KEY = /^([a-z0-9][a-z0-9-]{0,63})\/credit-past-months\.json$/u;

export const myJcbCreditLedger: Parser = {
  name: "myjcb-credit-ledger",
  version: "1.1.2",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === SOURCE &&
      artifact.dataset === "credit-ledger" &&
      artifact.mime === "application/json"
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    requireSuccessfulRun(artifact);
    const artifactMatch = artifact.artifactKey?.match(ARTIFACT_KEY);
    if (!artifactMatch) throw new Error("myjcb credit-ledger artifact key is invalid");
    const connectionId = artifactMatch[1]!;
    const detailMonth = Number(artifactMatch[3]);
    if (artifact.statementState !== "confirmed" && artifact.statementState !== "unconfirmed") {
      throw new Error("myjcb credit-ledger statement state is missing or unsupported");
    }
    const period = artifact.period;
    if (typeof period !== "string" || period.length === 0 || period.length > 64) {
      throw new Error("myjcb credit-ledger period is missing or invalid");
    }

    const root = strictObject(JSON.parse(decodeUtf8(bytes)), "credit-ledger");
    exactKeys(root, LEDGER_ROOT_KEYS, "credit-ledger");
    if (root["schemaVersion"] !== 1 || root["detailMonth"] !== detailMonth) {
      throw new Error("credit-ledger identity does not match its artifact key");
    }
    if (root["period"] !== period || root["state"] !== artifact.statementState) {
      throw new Error("credit-ledger metadata does not match the collector manifest");
    }
    const state = artifact.statementState;
    const expectedHeaders = state === "confirmed" ? CONFIRMED_HEADERS : UNCONFIRMED_HEADERS;
    if (!sameStringArray(root["headers"], expectedHeaders)) {
      throw new Error("credit-ledger headers do not match the provider contract");
    }
    const rows = root["rows"];
    if (!Array.isArray(rows) || rows.length > 10_000) {
      throw new Error("credit-ledger rows must be a bounded array");
    }

    const occurrences = new Map<string, number>();
    const observations = rows.map((value, index) => {
      const locator = `json:$.rows[${index}]`;
      const row = strictObject(value, `credit-ledger.rows[${index}]`);
      exactKeys(row, ROW_KEYS, `credit-ledger.rows[${index}]`);
      const cells = row["summaryCells"];
      if (
        !Array.isArray(cells) ||
        cells.length !== 4 ||
        cells.some((cell) => typeof cell !== "string" || cell.length > 5_000)
      ) {
        throw new Error(`credit-ledger.rows[${index}].summaryCells is invalid`);
      }
      const expanded = strictObject(row["expanded"], `credit-ledger.rows[${index}].expanded`);
      const allowedExpanded = state === "confirmed" ? CONFIRMED_EXPANDED : UNCONFIRMED_EXPANDED;
      if (
        Object.entries(expanded).some(
          ([key, entry]) =>
            !allowedExpanded.has(key) || typeof entry !== "string" || entry.length > 5_000,
        )
      ) {
        throw new Error(`credit-ledger.rows[${index}].expanded is invalid`);
      }

      const date = providerDate(cells[0], `credit-ledger.rows[${index}].summaryCells[0]`);
      const merchant = nonEmptyText(cells[1], `credit-ledger.rows[${index}].summaryCells[1]`);
      const amountCandidates = [2, 3].flatMap((cellIndex) => {
        const amount = tryJpyAmount(cells[cellIndex]);
        return amount === undefined ? [] : [{ cellIndex, amount }];
      });
      if (amountCandidates.length !== 1) {
        throw new Error(
          `credit-ledger.rows[${index}] does not have exactly one exact JPY amount cell`,
        );
      }
      const amountCellIndex = amountCandidates[0]!.cellIndex;
      const paymentTypeCellIndex = amountCellIndex === 2 ? 3 : 2;
      const paymentType = nonEmptyText(
        cells[paymentTypeCellIndex],
        `credit-ledger.rows[${index}].summaryCells[${paymentTypeCellIndex}]`,
      );
      const providerAmount = amountCandidates[0]!.amount;
      const observationAmount = providerAmount === 0 ? 0 : -providerAmount;
      const usageText = state === "unconfirmed" ? cells[amountCellIndex] : expanded["ご利用金額"];
      const paymentText =
        state === "confirmed" ? cells[amountCellIndex] : expanded["今回のお支払い金額"];
      const fingerprint = stableFingerprint({
        period,
        state,
        cells,
        expanded,
      });
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      return {
        kind: "transaction" as const,
        sourceAccount: `myjcb:${connectionId}:root`,
        externalId: `myjcb-credit-ledger:${state}:${fingerprint}:${occurrence}`,
        status: state,
        amountMinor: observationAmount,
        amountText: String(observationAmount),
        amountScale: 0,
        currency: "JPY",
        description: paymentType,
        counterparty: merchant,
        asOf: date,
        observedAt: artifact.fetchedAt,
        rawLocator: locator,
        extra: {
          summaryCells: [...cells],
          expanded: { ...expanded },
          _kogane: {
            canonicalDataset: "credit-ledger",
            derivedFromArtifactKey: `${connectionId}/credit-detail-${String(detailMonth).padStart(2, "0")}.html`,
            collectorTransform: "myjcb-ledger-parser@v1",
            sourceAccountScope: "root-statement-aggregate",
            subcardIdentity: "not-present-in-canonical-ledger",
            statementState: state,
            period,
            detailMonth,
            amountBasis: state === "confirmed" ? "current-statement-payment" : "unconfirmed-usage",
            amountCellIndex,
            paymentTypeCellIndex,
            providerAmountSign: "credit-liability-positive-refund-negative",
            observationSign: "outflow-negative-inflow-positive",
            ...(usageText === undefined ? {} : { usageAmountText: usageText }),
            ...(paymentText === undefined ? {} : { paymentAmountText: paymentText }),
            identityOrigin: "normalized-row+period+state+occurrence",
          },
        },
      };
    });
    return { observations, warnings: [] };
  },
};

export const myJcbPastMonthBalances: Parser = {
  name: "myjcb-credit-past-month-balances",
  version: "1.1.2",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === SOURCE &&
      artifact.dataset === "credit-past-months" &&
      artifact.mime === "application/json"
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    requireSuccessfulRun(artifact);
    const artifactMatch = artifact.artifactKey?.match(PAST_ARTIFACT_KEY);
    if (!artifactMatch || artifact.statementState !== null || artifact.period !== null) {
      throw new Error("myjcb credit-past-months artifact metadata is invalid");
    }
    const connectionId = artifactMatch[1]!;
    const root = strictObject(JSON.parse(decodeUtf8(bytes)), "credit-past-months");
    exactKeys(root, PAST_ROOT_KEYS, "credit-past-months");
    if (
      root["jsonrpc"] !== "2.0" ||
      typeof root["id"] !== "string" ||
      !/^0301006\d{2}$/u.test(root["id"])
    ) {
      throw new Error("credit-past-months JSON-RPC metadata is invalid");
    }
    const result = strictObject(root["result"], "credit-past-months.result");
    exactKeys(result, PAST_RESULT_KEYS, "credit-past-months.result");
    if (
      ![null, "", 0, "0"].includes(result["errId"] as never) ||
      typeof result["errMessage"] !== "string" ||
      result["errMessage"].length > 500 ||
      !Array.isArray(result["detailPastJsonInfo"]) ||
      result["detailPastJsonInfo"].length > 18
    ) {
      throw new Error("credit-past-months result is invalid");
    }
    const seenMonths = new Set<number>();
    const rankedObservations: { detailMonth: number; observation: BalanceObservation }[] = [];
    const warnings: string[] = [];
    result["detailPastJsonInfo"].forEach((value, index) => {
      const locator = `json:$.result.detailPastJsonInfo[${index}]`;
      const item = strictObject(value, `credit-past-months.result.detailPastJsonInfo[${index}]`);
      exactKeys(item, PAST_ITEM_KEYS, `credit-past-months.result.detailPastJsonInfo[${index}]`);
      const monthText = strictString(item["detailMonth"], `${locator}.detailMonth`, { max: 2 });
      if (!/^(?:[0-9]|1[0-7])$/u.test(monthText)) {
        throw new Error(`${locator}.detailMonth is invalid`);
      }
      const month = Number(monthText);
      if (seenMonths.has(month)) throw new Error(`${locator}: duplicate detailMonth`);
      seenMonths.add(month);
      const available = strictBoolean(
        item["detailAvailableFlag"],
        `${locator}.detailAvailableFlag`,
      );
      const display = strictBoolean(item["payAmountDispFlag"], `${locator}.payAmountDispFlag`);
      const payAmount = strictString(item["payAmount"], `${locator}.payAmount`, {
        empty: true,
        max: 100,
      });
      const period = strictString(item["settlementYM"], `${locator}.settlementYM`, { max: 64 });
      if (!available || !display) return;
      const amount = jpyAmount(payAmount, `${locator}.payAmount`);
      const asOf = providerYearMonth(period, `${locator}.settlementYM`);
      if (asOf === undefined) {
        warnings.push(
          `${locator}.settlementYM has no absolute year-month; current selection falls back to detailMonth`,
        );
      }
      rankedObservations.push({
        detailMonth: month,
        observation: {
          kind: "balance",
          sourceAccount: `myjcb:${connectionId}:root`,
          metric: "credit_statement_payment_amount",
          amountMinor: amount,
          amountText: String(amount),
          amountScale: 0,
          instrument: "JPY",
          ...(asOf === undefined ? {} : { asOf }),
          observedAt: artifact.fetchedAt,
          rawLocator: `${locator}.payAmount`,
          extra: {
            ...item,
            _kogane: {
              canonicalDataset: "credit-past-months",
              sourceAccountScope: "root-statement-aggregate",
              period,
              detailMonth: month,
              amountSign: "provider-statement-total",
              snapshotSemantics: "provider-reported-monthly-payment-amount",
            },
          },
        },
      });
    });
    // The provider returns lower detailMonth values first (newest first). Store
    // oldest first so the append-order tie breaker still picks the newest item
    // when an accepted legacy label has no absolute year-month.
    rankedObservations.sort((left, right) => right.detailMonth - left.detailMonth);
    const observations = rankedObservations.map(({ observation }) => observation);
    return { observations, warnings };
  },
};

type StatementNode = DefaultTreeAdapterMap["node"];
type StatementElement = DefaultTreeAdapterMap["element"];
function statementElements(
  node: StatementNode,
  predicate: (element: StatementElement) => boolean,
): StatementElement[] {
  const result: StatementElement[] = [];
  if ("tagName" in node && predicate(node)) result.push(node);
  if ("childNodes" in node)
    for (const child of node.childNodes) result.push(...statementElements(child, predicate));
  return result;
}
function statementNodes(node: StatementNode, tag: string): StatementElement[] {
  return statementElements(node, (element) => element.tagName === tag);
}
function statementText(node: StatementNode): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(statementText).join("") : "";
}

/**
 * The statement state the page states about itself (statement parser 1.1.0,
 * docs/observations.md), read by `readMyJcbStatementPage`, which the collector
 * uses too, so the two readings cannot drift:
 *
 * - exactly one `(確定分)` h1, over a confirmed or no amount header: `confirmed`;
 * - no heading, and no ledger or a ledger with no rows: `unknown`. An empty
 *   ledger's header label states nothing about a statement it has no rows of;
 * - no heading, and rows under the unconfirmed header: `unconfirmed`;
 * - no heading, and rows under a confirmed or no amount header: `unknown`. The
 *   page does not state that it is closed, so no total is read from it,
 *   exactly as before;
 * - more than one heading, a header with both labels, ledgers that disagree,
 *   or the heading over an unconfirmed header: the page contradicts itself
 *   and the parse fails.
 *
 * The collector manifest's state is not an input: it is recorded beside the
 * result as a cross-check (`_kogane.manifestStatementState`).
 */
function statementPageState(document: StatementNode): "confirmed" | "unconfirmed" | "unknown" {
  const { reading } = readMyJcbStatementPage(document);
  if (reading === "conflict") throw new Error("myjcb statement confirmation conflicts");
  if (reading === "confirmed" || reading === "unconfirmed") return reading;
  return "unknown";
}

/**
 * HTML has the exact due date that the past-month summary intentionally lacks.
 * Since 1.1.0 the statement state is the page's own (`statementPageState`),
 * so a closed statement the collector's manifest recorded as `unconfirmed`
 * (every position-1 page before the collector decided from the page) is read
 * as the confirmed statement it is.
 */
export const myJcbCreditStatement: Parser = {
  name: "myjcb-credit-statement-total",
  version: "1.1.0",
  accepts: (artifact) =>
    artifact.sourceId === SOURCE &&
    artifact.dataset === "credit-detail" &&
    // CORE normalizes media types by removing parameters. Both forms carry
    // sanitized UTF-8 HTML; parse still rejects invalid UTF-8 bytes.
    (artifact.mime === "text/html" || artifact.mime === "text/html; charset=utf-8"),
  parse(bytes, artifact) {
    requireSuccessfulRun(artifact);
    if (bytes.byteLength > 3_000_000) throw new Error("myjcb statement HTML is too large");
    validateSanitizedHtml(bytes, artifact, true);
    const document = parse(decodeUtf8(bytes));
    const headings = statementNodes(document, "h2").map((node) =>
      statementText(node).replace(/\s+/gu, ""),
    );
    const pageState = statementPageState(document);
    const manifestState = artifact.statementState ?? null;
    // The manifest alone disagreeing never fails the parse: it is the
    // collector's earlier reading of these same bytes. People see it here,
    // and a total records it in `_kogane.manifestStatementState`. Only the
    // decision this parser makes is compared, confirmed or not: the collector
    // records an older page without the heading as `unknown` even when its
    // ledger header reads unconfirmed, and that is agreement.
    const stateWarnings =
      manifestState !== null && (manifestState === "confirmed") !== (pageState === "confirmed")
        ? ["statement_state_differs_from_manifest"]
        : [];
    if (pageState !== "confirmed")
      return { observations: [], warnings: ["statement_total_not_confirmed", ...stateWarnings] };
    if (/\/credit-detail-00\.html$/u.test(artifact.artifactKey ?? ""))
      throw new Error("myjcb detailMonth 0 cannot be finalized");
    const periods = headings.flatMap((text) => {
      const match = /^(\d{4})年(\d{1,2})月お支払い分のカードご利用明細$/u.exec(text);
      return match ? [`${match[1]}-${match[2]!.padStart(2, "0")}`] : [];
    });
    if (periods.length !== 1) throw new Error("myjcb statement period missing or ambiguous");
    const totals = statementNodes(document, "dt").filter((node) =>
      statementText(node).includes("お支払い金額合計"),
    );
    if (totals.length === 0)
      return { observations: [], warnings: ["statement_total_missing", ...stateWarnings] };
    if (totals.length !== 1) throw new Error("myjcb statement total is ambiguous");
    const total = totals[0]!;
    const label = statementText(total).replace(/\s+/gu, "");
    const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日\([月火水木金土日]\)お支払い金額合計$/u.exec(
      label,
    );
    if (!match) throw new Error("myjcb statement total date is invalid");
    const paymentDate = normalizedDate(
      `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
      "myjcb statement payment date",
    );
    const period = paymentDate.slice(0, 7);
    if (period !== periods[0]) throw new Error("myjcb statement date and month conflict");
    if (artifact.period != null) {
      const metadataMonth = providerYearMonth(artifact.period, "myjcb statement metadata period");
      if (metadataMonth !== undefined && metadataMonth.slice(0, 7) !== period)
        throw new Error("myjcb statement metadata and month conflict");
    }
    const parent = total.parentNode;
    if (!parent || !("tagName" in parent) || parent.tagName !== "dl")
      throw new Error("myjcb statement total has no definition list");
    const values = parent.childNodes.filter((node) => "tagName" in node && node.tagName === "dd");
    const labels = parent.childNodes.filter((node) => "tagName" in node && node.tagName === "dt");
    if (values.length !== 1 || labels.length !== 1)
      throw new Error("myjcb statement total value is ambiguous");
    const amount = jpyAmount(statementText(values[0]!), "myjcb statement total");
    const connection = artifact.artifactKey!.split("/")[0]!;
    return {
      observations: [
        {
          kind: "balance",
          sourceAccount: `myjcb:${connection}:root`,
          metric: "credit_statement_payment_amount",
          amountMinor: amount,
          amountText: String(amount),
          amountScale: 0,
          instrument: "JPY",
          asOf: paymentDate,
          observedAt: artifact.fetchedAt,
          rawLocator: "html:dt[exact-statement-payment-total]+dd",
          extra: {
            _kogane: {
              canonicalDataset: "credit-detail",
              period,
              statementMonth: period.replace("-", ""),
              paymentDate,
              statementState: "confirmed",
              statementStateBasis: "page-heading",
              manifestStatementState: manifestState,
              sourceAccountScope: "root-statement-aggregate",
              amountSign: "provider-statement-total",
              snapshotSemantics: "provider-reported-monthly-payment-amount",
            },
          },
        },
      ],
      warnings: stateWarnings,
    };
  },
};

export const myJcbEvidenceOnly: Parser = {
  name: "myjcb-canonical-evidence-boundary",
  version: "1.1.2",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === SOURCE &&
      ((artifact.dataset === "credit-menu" && artifact.mime === "text/html; charset=utf-8") ||
        (artifact.dataset === "discovery" && artifact.mime === "application/json"))
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    requireSuccessfulRun(artifact);
    if (artifact.dataset === "discovery") validateDiscovery(bytes, artifact);
    else validateSanitizedHtml(bytes, artifact);
    return { observations: [], warnings: [] };
  },
};

function requireSuccessfulRun(artifact: ArtifactMeta): void {
  if (
    (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
    !unitScopeAdmitted(artifact)
  ) {
    throw new Error("myjcb observations require a successful, failure-free fetch run");
  }
}

function providerDate(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/gu, "") : "";
  if (!/^\d{4}\/\d{2}\/\d{2}$/u.test(normalized)) {
    throw new Error(`${label} must use YYYY/MM/DD`);
  }
  return normalizedDate(normalized.replaceAll("/", "-"), label);
}

function nonEmptyText(value: unknown, label: string): string {
  return strictString(value, label, { max: 5_000 });
}

function jpyAmount(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be a JPY display string`);
  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/^[￥¥\\]/u, "")
    .replace(/円$/u, "");
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u.test(normalized)) {
    throw new Error(`${label} is not an exact JPY display amount`);
  }
  const amount = Number(normalized.replaceAll(",", ""));
  if (!Number.isSafeInteger(amount)) throw new Error(`${label} exceeds the exact integer range`);
  return Object.is(amount, -0) ? 0 : amount;
}

function providerYearMonth(value: string, label: string): string | undefined {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "");
  const match =
    /^(\d{4})年(\d{1,2})月(?:\d{1,2}日)?(?:度)?(?:お支払い分)?$/u.exec(normalized) ??
    /^(\d{4})[/.-](\d{1,2})(?:[/.-]\d{1,2})?(?:度)?(?:お支払い分)?$/u.exec(normalized) ??
    /^(\d{4})(\d{2})(?:\d{2})?(?:度)?(?:お支払い分)?$/u.exec(normalized);
  if (!match) return undefined;
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`${label} has an invalid month`);
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function tryJpyAmount(value: unknown): number | undefined {
  try {
    return jpyAmount(value, "credit-ledger amount candidate");
  } catch {
    return undefined;
  }
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function validateSanitizedHtml(
  bytes: Uint8Array,
  artifact: ArtifactMeta,
  allowMissingStatementMeta = false,
): void {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    !/^\s*(?:<!doctype\s+html(?:\s+[^>]*)?>\s*)?<html\b/iu.test(html) ||
    !/<body\b/iu.test(html) ||
    !/<\/html\s*>\s*$/iu.test(html)
  ) {
    throw new Error("myjcb sanitized HTML is not a complete document");
  }
  if (
    /<(?:script|style|noscript|template|iframe|object|embed|meta|base|link|textarea)\b/iu.test(
      html,
    ) ||
    /\s(?:on[a-z0-9_-]+|style|srcdoc|srcset|integrity|nonce|data-[a-z0-9_-]+|href|src|action|formaction)\s*=/iu.test(
      html,
    ) ||
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/u.test(html) ||
    /\svalue\s*=\s*(?!["']\[redacted\]["'])/iu.test(html)
  ) {
    throw new Error("myjcb sanitized HTML crossed the active-content or sensitive-value boundary");
  }
  const key = artifact.artifactKey;
  if (artifact.dataset === "credit-menu") {
    if (
      !key?.match(/^[a-z0-9][a-z0-9-]{0,63}\/credit-menu\.html$/u) ||
      artifact.statementState !== null ||
      artifact.period !== null ||
      !/MyJCB/iu.test(html) ||
      !/\bgeneralJsonShikibetuId\b/u.test(html)
    ) {
      throw new Error("myjcb credit-menu metadata is invalid");
    }
  } else {
    const match = key?.match(/^([a-z0-9][a-z0-9-]{0,63})\/credit-detail-(0[0-9]|1[0-7])\.html$/u);
    if (
      !match ||
      (!(allowMissingStatementMeta && artifact.period == null) &&
        (typeof artifact.period !== "string" ||
          artifact.period.length === 0 ||
          artifact.period.length > 64)) ||
      (!(allowMissingStatementMeta && artifact.statementState == null) &&
        !["confirmed", "unconfirmed", "unknown"].includes(artifact.statementState ?? ""))
    ) {
      throw new Error("myjcb credit-detail metadata is invalid");
    }
    if (
      Number(match[2]) === 0 &&
      artifact.statementState !== "unconfirmed" &&
      !(allowMissingStatementMeta && artifact.statementState == null)
    ) {
      throw new Error("myjcb detailMonth 0 must remain unconfirmed");
    }
    if (
      !/MyJCB/iu.test(html) ||
      (!/\/iss-pc\/member\/details_inquiry\/|\bdetail-list-01\b/u.test(html) &&
        !(/ご利用/u.test(html) && /お支払い/u.test(html) && /明細/u.test(html)))
    ) {
      throw new Error("myjcb credit-detail surface marker is invalid");
    }
  }
}

function validateDiscovery(bytes: Uint8Array, artifact: ArtifactMeta): void {
  if (
    !artifact.artifactKey?.match(/^[a-z0-9][a-z0-9-]{0,63}\/discovery\.json$/u) ||
    artifact.statementState !== null ||
    artifact.period !== null
  ) {
    throw new Error("myjcb discovery metadata is invalid");
  }
  const root = strictObject(JSON.parse(decodeUtf8(bytes)), "myjcb discovery");
  exactKeys(
    root,
    ["schemaVersion", "bootstrapMode", "cards", "periodCount", "cookieCount", "limitations"],
    "myjcb discovery",
  );
  if (
    root["schemaVersion"] !== 1 ||
    !["password", "session", "passkey"].includes(String(root["bootstrapMode"]))
  ) {
    throw new Error("myjcb discovery header is invalid");
  }
  strictSafeInteger(root["periodCount"], "myjcb discovery.periodCount", {
    minimum: 0,
    maximum: 33,
  });
  strictSafeInteger(root["cookieCount"], "myjcb discovery.cookieCount", {
    minimum: 1,
    maximum: 100,
  });
  if (
    !Array.isArray(root["cards"]) ||
    root["cards"].length > 16 ||
    !Array.isArray(root["limitations"]) ||
    root["limitations"].some((entry) => typeof entry !== "string")
  ) {
    throw new Error("myjcb discovery collections are invalid");
  }
  const localIds = new Set<string>();
  for (const [index, value] of root["cards"].entries()) {
    const card = strictObject(value, `myjcb discovery.cards[${index}]`);
    if (
      Object.keys(card).some(
        (key) => !["localId", "productHint", "issuerHint", "switchCandidate"].includes(key),
      ) ||
      !Object.hasOwn(card, "localId") ||
      !Object.hasOwn(card, "switchCandidate")
    ) {
      throw new Error(`myjcb discovery.cards[${index}] schema drift`);
    }
    const localId = strictString(card["localId"], `myjcb discovery.cards[${index}].localId`, {
      max: 64,
    });
    if (!/^card-(?:\d{3}|[0-9a-f]{8,32})$/u.test(localId) || localIds.has(localId)) {
      throw new Error("myjcb discovery card identity is invalid or duplicated");
    }
    localIds.add(localId);
    strictBoolean(card["switchCandidate"], `myjcb discovery.cards[${index}].switchCandidate`);
    if (card["issuerHint"] !== undefined)
      throw new Error("myjcb discovery issuerHint is unobserved");
    if (
      card["productHint"] !== undefined &&
      !["JCB W", "リクルートカード", "みずほJCBデビット", "京銀JCBデビット"].includes(
        String(card["productHint"]),
      )
    ) {
      throw new Error("myjcb discovery productHint is unsupported");
    }
  }
}
