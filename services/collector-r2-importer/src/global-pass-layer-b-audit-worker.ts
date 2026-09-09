import { validateGlobalPassRun } from "./global-pass";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  createGlobalPassActivity,
  type GlobalPassDomNode,
} from "../../../packages/parsers/src/parsers/global-pass-activity";

type AuditEnv = Pick<Env, "GLOBAL_PASS_SNAPSHOTS">;
const PREFIX = "raw/prestia-globalpass/";
const globalPassActivity = createGlobalPassActivity(
  (html) => parse(html) as unknown as GlobalPassDomNode,
);

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return json({ ok: true, service: "global-pass-layer-b-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return json({ error: "not_found" }, 404);
    }
    try {
      const input = (await request.json()) as unknown;
      if (!record(input) || Object.keys(input).some((key) => key !== "cursor")) {
        return json({ error: "cursor_invalid" }, 400);
      }
      const cursor = input.cursor;
      if (cursor !== undefined && !safeCursor(cursor)) {
        return json({ error: "cursor_invalid" }, 400);
      }
      const listed = await env.GLOBAL_PASS_SNAPSHOTS.list({
        prefix: PREFIX,
        limit: 1,
        ...(typeof cursor === "string" ? { cursor } : {}),
      });
      if (listed.objects.length > 1) throw new Error("prefix_page_too_large");
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && (!nextCursor || nextCursor === cursor)) {
        throw new Error(nextCursor ? "prefix_cursor_did_not_advance" : "prefix_cursor_missing");
      }
      const object = listed.objects[0];
      if (!object) return response({ scanned: 0, nextCursor: null });
      if (!object.key.endsWith("/manifest.json")) {
        return response({ scanned: 1, skipped: 1, nextCursor: nextCursor ?? null });
      }
      try {
        const { loaded, verified } = await validateGlobalPassRun(
          env.GLOBAL_PASS_SNAPSHOTS,
          object.key,
          new Set(),
        );
        const manifest = loaded.manifest;
        const shape = {
          activityArtifactCount: 0,
          tableCount: 0,
          headerCellCount: 0,
          exactHeaderTableCount: 0,
          bodyRowCount: 0,
          oneCellRowCount: 0,
          twoCellRowCount: 0,
          threeCellRowCount: 0,
          otherCellRowCount: 0,
          dateCellCount: 0,
          currencyAmountCellCount: 0,
          pendingMarkerCount: 0,
          confirmedMarkerCount: 0,
          eightDigitOptionCount: 0,
          sixDigitOptionCount: 0,
          activitySelectCount: 0,
          selectedOptionCount: 0,
          selectedMonthMatchCount: 0,
          recognizedHeaderCount: 0,
          unknownHeaderCount: 0,
          exactRecognizedTableCount: 0,
          parsedObservationCount: 0,
          unsignedObservationCount: 0,
          dateLabelHitCount: 0,
          detailLabelHitCount: 0,
          amountLabelHitCount: 0,
          feeLabelHitCount: 0,
          authorizationLabelHitCount: 0,
          statusLabelHitCount: 0,
          familyLabelHitCount: 0,
          dateLabeledTableCount: 0,
          dateLabeledRowCount: 0,
          detailLabeledTableCount: 0,
          detailLabeledRowCount: 0,
          amountLabeledTableCount: 0,
          amountLabeledRowCount: 0,
          feeLabeledTableCount: 0,
          feeLabeledRowCount: 0,
          statusLabeledTableCount: 0,
          statusLabeledRowCount: 0,
          authorizationLabeledTableCount: 0,
          authorizationLabeledRowCount: 0,
          tableShapeHistogram: {} as Record<string, number>,
          rowShapeHistogram: {} as Record<string, number>,
        };
        if (manifest.status === "success" && manifest.failures.length === 0) {
          for (const item of verified) {
            const html = new TextDecoder("utf-8", { fatal: true }).decode(item.centralBytes);
            shape.activityArtifactCount += 1;
            inspectHtml(html, item.artifact.month, shape);
            const parsed = globalPassActivity.parse(item.centralBytes, {
              id: 0,
              sourceId: "global-pass",
              runStatus: "success",
              runFailureCount: 0,
              dataset: "globalpass-activity",
              artifactKey: `activity-${item.artifact.month}.html`,
              url: null,
              mime: "text/html",
              fetchedAt: manifest.completedAt,
              sha256: item.centralSha256,
            });
            shape.parsedObservationCount += parsed.observations.length;
            shape.unsignedObservationCount += parsed.observations.filter(
              (observation) =>
                observation.kind === "transaction" && observation.amountMinor === undefined,
            ).length;
          }
        }
        return response({
          scanned: 1,
          audited: 1,
          manifestStatus: manifest.status,
          failureCount: manifest.failures.length,
          ...shape,
          nextCursor: nextCursor ?? null,
        });
      } catch (error) {
        return response({
          scanned: 1,
          failed: 1,
          failureCode: safeFailureCode(error),
          nextCursor: nextCursor ?? null,
        });
      }
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : "request_failed";
      return json({ error: code }, 502);
    }
  },
};

interface Shape {
  exactHeaderTableCount: number;
  tableCount: number;
  headerCellCount: number;
  bodyRowCount: number;
  oneCellRowCount: number;
  twoCellRowCount: number;
  threeCellRowCount: number;
  otherCellRowCount: number;
  dateCellCount: number;
  currencyAmountCellCount: number;
  pendingMarkerCount: number;
  confirmedMarkerCount: number;
  eightDigitOptionCount: number;
  sixDigitOptionCount: number;
  activitySelectCount: number;
  selectedOptionCount: number;
  selectedMonthMatchCount: number;
  recognizedHeaderCount: number;
  unknownHeaderCount: number;
  exactRecognizedTableCount: number;
  parsedObservationCount: number;
  unsignedObservationCount: number;
  dateLabelHitCount: number;
  detailLabelHitCount: number;
  amountLabelHitCount: number;
  feeLabelHitCount: number;
  authorizationLabelHitCount: number;
  statusLabelHitCount: number;
  familyLabelHitCount: number;
  dateLabeledTableCount: number;
  dateLabeledRowCount: number;
  detailLabeledTableCount: number;
  detailLabeledRowCount: number;
  amountLabeledTableCount: number;
  amountLabeledRowCount: number;
  feeLabeledTableCount: number;
  feeLabeledRowCount: number;
  statusLabeledTableCount: number;
  statusLabeledRowCount: number;
  authorizationLabeledTableCount: number;
  authorizationLabeledRowCount: number;
  tableShapeHistogram: Record<string, number>;
  rowShapeHistogram: Record<string, number>;
}

function inspectHtml(html: string, artifactMonth: string, shape: Shape): void {
  const expected = new Set([
    "Transaction Date|Transaction Detail|Transaction Fee",
    "Transaction Currency and Amount|Transaction Detail",
    "Transaction Currency and Amount|Transaction Fee",
  ]);
  const document = parse(html);
  const tables = elements(document, "table");
  for (const table of tables) {
    const headers = owned(table, "th", "table").map(nodeText);
    shape.tableCount += 1;
    shape.headerCellCount += headers.length;
    const recognized = headers.filter(isRecognizedHeader).length;
    shape.recognizedHeaderCount += recognized;
    shape.unknownHeaderCount += headers.length - recognized;
    if (recognized === headers.length && new Set(headers).size === headers.length) {
      shape.exactRecognizedTableCount += 1;
    }
    if (expected.has(headers.join("|"))) shape.exactHeaderTableCount += 1;
    const rows = owned(table, "tr", "table").filter((row) => closest(row, "thead") === null);
    const label = headers.join(" ");
    const roles = [
      [/Transaction Date|ご利用日|利用日/iu, "date"],
      [/Transaction Detail|ご利用先|利用先|利用内容/iu, "detail"],
      [/Transaction Currency and Amount|ご利用金額|利用金額|決済金額/iu, "amount"],
      [/Transaction Fee|手数料|fee/iu, "fee"],
      [/Status|ステータス|確定状況/iu, "status"],
      [/Authorization|Approval|承認番号/iu, "authorization"],
      [/Family|家族/iu, "family"],
    ] as const;
    const roleKey =
      roles
        .filter(([pattern]) => pattern.test(label))
        .map(([, role]) => role)
        .join("+") || "none";
    const cellCounts = rows.map((row) => owned(row, "td", "tr").length);
    const rowShape =
      [...new Set(cellCounts)].sort((left, right) => left - right).join("+") || "empty";
    const signature = `${tableDepth(table)}:${headers.length}:${roleKey}:${rows.length}:${rowShape}`;
    shape.tableShapeHistogram[signature] = (shape.tableShapeHistogram[signature] ?? 0) + 1;
    for (const [pattern, tableField, rowField] of [
      [/Transaction Date|ご利用日|利用日/iu, "dateLabeledTableCount", "dateLabeledRowCount"],
      [
        /Transaction Detail|ご利用先|利用先|利用内容/iu,
        "detailLabeledTableCount",
        "detailLabeledRowCount",
      ],
      [
        /Transaction Currency and Amount|ご利用金額|利用金額|決済金額/iu,
        "amountLabeledTableCount",
        "amountLabeledRowCount",
      ],
      [/Transaction Fee|手数料|fee/iu, "feeLabeledTableCount", "feeLabeledRowCount"],
      [/Status|ステータス|確定状況/iu, "statusLabeledTableCount", "statusLabeledRowCount"],
      [
        /Authorization|Approval|承認番号/iu,
        "authorizationLabeledTableCount",
        "authorizationLabeledRowCount",
      ],
    ] as const) {
      if (pattern.test(label)) {
        shape[tableField] += 1;
        shape[rowField] += rows.length;
      }
    }
    for (const row of rows) {
      const cells = owned(row, "td", "tr").map(nodeText);
      const nested =
        elements(row, "table")
          .filter((candidate) => closest(candidate, "tr") === row)
          .map((candidate) => {
            const text = owned(candidate, "th", "table").map(nodeText).join(" ");
            return (
              roles
                .filter(([pattern]) => pattern.test(text))
                .map(([, role]) => role)
                .join("+") || "none"
            );
          })
          .sort()
          .join(",") || "none";
      const rowSignature = `${cells.length}:${nested}`;
      shape.rowShapeHistogram[rowSignature] = (shape.rowShapeHistogram[rowSignature] ?? 0) + 1;
      shape.bodyRowCount += 1;
      if (cells.length === 1) shape.oneCellRowCount += 1;
      else if (cells.length === 2) shape.twoCellRowCount += 1;
      else if (cells.length === 3) shape.threeCellRowCount += 1;
      else shape.otherCellRowCount += 1;
      shape.dateCellCount += cells.filter((cell) =>
        /^20\d{2}[/-]\d{2}[/-]\d{2}$/u.test(cell),
      ).length;
      shape.currencyAmountCellCount += cells.filter((cell) =>
        /(?:^|\s)[A-Z]{3}(?:\s|$)|(?:^|\s)[+\-△▲]?[\d,]+(?:\.\d+)?(?:\s|$)/u.test(cell),
      ).length;
      shape.pendingMarkerCount += cells.filter((cell) => /pending|未確定/iu.test(cell)).length;
      shape.confirmedMarkerCount += cells.filter((cell) => /confirmed|確定/iu.test(cell)).length;
    }
  }
  const labels = elements(document, "th").map(nodeText);
  shape.dateLabelHitCount += labels.filter((label) =>
    /Transaction Date|ご利用日|利用日/iu.test(label),
  ).length;
  shape.detailLabelHitCount += labels.filter((label) =>
    /Transaction Detail|ご利用先|利用先|利用内容/iu.test(label),
  ).length;
  shape.amountLabelHitCount += labels.filter((label) =>
    /Transaction Currency and Amount|ご利用金額|利用金額|決済金額/iu.test(label),
  ).length;
  shape.feeLabelHitCount += labels.filter((label) =>
    /Transaction Fee|手数料|fee/iu.test(label),
  ).length;
  shape.authorizationLabelHitCount += labels.filter((label) =>
    /Authorization|承認番号/iu.test(label),
  ).length;
  shape.statusLabelHitCount += labels.filter((label) =>
    /Status|ステータス|確定状況/iu.test(label),
  ).length;
  shape.familyLabelHitCount += labels.filter((label) => /Family|家族/iu.test(label)).length;
  for (const option of elements(document, "option")) {
    const value = option.attrs.find((item) => item.name.toLowerCase() === "value")?.value;
    if (/^\d{8}$/u.test(value ?? "")) shape.eightDigitOptionCount += 1;
    if (/^\d{6}$/u.test(value ?? "")) shape.sixDigitOptionCount += 1;
  }
  const activitySelects = elements(document, "select").filter((select) =>
    elements(select, "option").some((option) => /^\d{8}$/u.test(attribute(option, "value") ?? "")),
  );
  shape.activitySelectCount += activitySelects.length;
  for (const select of activitySelects) {
    for (const option of elements(select, "option")) {
      if (attribute(option, "selected") === undefined) continue;
      shape.selectedOptionCount += 1;
      if (attribute(option, "value")?.slice(0, 6) === artifactMonth.replace("-", "")) {
        shape.selectedMonthMatchCount += 1;
      }
    }
  }
}
function isRecognizedHeader(value: string): boolean {
  return /^(?:Transaction Date|Transaction Detail|Transaction Currency and Amount|Transaction Fee|ATM Fee|(?:FX|Foreign Exchange) Fee|Status|(?:Authorization|Approval) Number|Remarks|Local Currency and Amount|Applicable Rate|(?:Funding|Funded) Currency and Amount)$/u.test(
    value,
  );
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function elements(root: Node, tagName: string): Element[] {
  const found: Element[] = [];
  const visit = (node: Node): void => {
    if ("tagName" in node && node.tagName === tagName) found.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
function owned(root: Element, tagName: string, ownerTag: string): Element[] {
  return elements(root, tagName).filter((node) => closest(node, ownerTag) === root);
}
function closest(node: Node, tagName: string): Element | null {
  let parent = "parentNode" in node ? node.parentNode : null;
  while (parent) {
    if ("tagName" in parent && parent.tagName === tagName) return parent;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return null;
}
function tableDepth(node: Node): number {
  let depth = 0;
  let parent = "parentNode" in node ? node.parentNode : null;
  while (parent) {
    if ("tagName" in parent && parent.tagName === "table") depth += 1;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return depth;
}
function nodeText(node: Node): string {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    if ("value" in current && typeof current.value === "string") parts.push(current.value);
    if ("childNodes" in current) for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name.toLowerCase() === name)?.value;
}

function response(input: {
  scanned: 0 | 1;
  audited?: 1;
  skipped?: 1;
  failed?: 1;
  failureCode?: string;
  manifestStatus?: "success" | "partial" | "failed";
  failureCount?: number;
  activityArtifactCount?: number;
  exactHeaderTableCount?: number;
  tableCount?: number;
  headerCellCount?: number;
  bodyRowCount?: number;
  oneCellRowCount?: number;
  twoCellRowCount?: number;
  threeCellRowCount?: number;
  otherCellRowCount?: number;
  dateCellCount?: number;
  currencyAmountCellCount?: number;
  pendingMarkerCount?: number;
  confirmedMarkerCount?: number;
  eightDigitOptionCount?: number;
  sixDigitOptionCount?: number;
  activitySelectCount?: number;
  selectedOptionCount?: number;
  selectedMonthMatchCount?: number;
  recognizedHeaderCount?: number;
  unknownHeaderCount?: number;
  exactRecognizedTableCount?: number;
  parsedObservationCount?: number;
  unsignedObservationCount?: number;
  dateLabelHitCount?: number;
  detailLabelHitCount?: number;
  amountLabelHitCount?: number;
  feeLabelHitCount?: number;
  authorizationLabelHitCount?: number;
  statusLabelHitCount?: number;
  familyLabelHitCount?: number;
  dateLabeledTableCount?: number;
  dateLabeledRowCount?: number;
  detailLabeledTableCount?: number;
  detailLabeledRowCount?: number;
  amountLabeledTableCount?: number;
  amountLabeledRowCount?: number;
  feeLabeledTableCount?: number;
  feeLabeledRowCount?: number;
  statusLabeledTableCount?: number;
  statusLabeledRowCount?: number;
  authorizationLabeledTableCount?: number;
  authorizationLabeledRowCount?: number;
  tableShapeHistogram?: Record<string, number>;
  rowShapeHistogram?: Record<string, number>;
  nextCursor: string | null;
}): Response {
  return json({
    schemaVersion: "global-pass-layer-b-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.manifestStatus
      ? {
          manifestStatus: input.manifestStatus,
          failureCount: input.failureCount,
          activityArtifactCount: input.activityArtifactCount,
          tableCount: input.tableCount,
          headerCellCount: input.headerCellCount,
          exactHeaderTableCount: input.exactHeaderTableCount,
          bodyRowCount: input.bodyRowCount,
          oneCellRowCount: input.oneCellRowCount,
          twoCellRowCount: input.twoCellRowCount,
          threeCellRowCount: input.threeCellRowCount,
          otherCellRowCount: input.otherCellRowCount,
          dateCellCount: input.dateCellCount,
          currencyAmountCellCount: input.currencyAmountCellCount,
          pendingMarkerCount: input.pendingMarkerCount,
          confirmedMarkerCount: input.confirmedMarkerCount,
          eightDigitOptionCount: input.eightDigitOptionCount,
          sixDigitOptionCount: input.sixDigitOptionCount,
          activitySelectCount: input.activitySelectCount,
          selectedOptionCount: input.selectedOptionCount,
          selectedMonthMatchCount: input.selectedMonthMatchCount,
          recognizedHeaderCount: input.recognizedHeaderCount,
          unknownHeaderCount: input.unknownHeaderCount,
          exactRecognizedTableCount: input.exactRecognizedTableCount,
          parsedObservationCount: input.parsedObservationCount,
          unsignedObservationCount: input.unsignedObservationCount,
          dateLabelHitCount: input.dateLabelHitCount,
          detailLabelHitCount: input.detailLabelHitCount,
          amountLabelHitCount: input.amountLabelHitCount,
          feeLabelHitCount: input.feeLabelHitCount,
          authorizationLabelHitCount: input.authorizationLabelHitCount,
          statusLabelHitCount: input.statusLabelHitCount,
          familyLabelHitCount: input.familyLabelHitCount,
          dateLabeledTableCount: input.dateLabeledTableCount,
          dateLabeledRowCount: input.dateLabeledRowCount,
          detailLabeledTableCount: input.detailLabeledTableCount,
          detailLabeledRowCount: input.detailLabeledRowCount,
          amountLabeledTableCount: input.amountLabeledTableCount,
          amountLabeledRowCount: input.amountLabeledRowCount,
          feeLabeledTableCount: input.feeLabeledTableCount,
          feeLabeledRowCount: input.feeLabeledRowCount,
          statusLabeledTableCount: input.statusLabeledTableCount,
          statusLabeledRowCount: input.statusLabeledRowCount,
          authorizationLabeledTableCount: input.authorizationLabeledTableCount,
          authorizationLabeledRowCount: input.authorizationLabeledRowCount,
          tableShapeHistogram: input.tableShapeHistogram,
          rowShapeHistogram: input.rowShapeHistogram,
        }
      : {}),
  });
}
function safeCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error) || !error.message.startsWith("global-pass ")) {
    return "layer_a_contract_validation_failed";
  }
  if (error.message.includes("month selector") || error.message.includes("month option")) {
    return "parser_month_contract_failed";
  }
  if (error.message.includes("header") || error.message.includes("schema")) {
    return "parser_schema_contract_failed";
  }
  if (error.message.includes("cardinality") || error.message.includes("unclassified table")) {
    return "parser_cardinality_contract_failed";
  }
  if (error.message.includes("date") || error.message.includes("selected month")) {
    return "parser_date_contract_failed";
  }
  if (error.message.includes("amount")) return "parser_amount_contract_failed";
  return "parser_contract_failed";
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
