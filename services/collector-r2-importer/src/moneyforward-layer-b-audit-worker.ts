import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  createMoneyForwardEvidenceOnly,
  createMoneyForwardMonthlyTransactions,
  type MoneyForwardDomNode,
} from "../../../packages/parsers/src/parsers/moneyforward";
import { validateMoneyForwardRun } from "./moneyforward";
import { moneyForwardAccountKeys } from "./moneyforward-account-identity";

type AuditEnv = Pick<Env, "MONEYFORWARD_SNAPSHOTS">;
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
const PREFIX = "raw/moneyforward/";
const parseHtml = (
  html: string,
  options?: { sourceCodeLocationInfo?: boolean },
): MoneyForwardDomNode => parse(html, options) as unknown as MoneyForwardDomNode;
const moneyForwardMonthlyTransactions = createMoneyForwardMonthlyTransactions(parseHtml);
const moneyForwardEvidenceOnly = createMoneyForwardEvidenceOnly(parseHtml);

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return json({ ok: true, service: "moneyforward-layer-b-audit" });
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
      const listed = await env.MONEYFORWARD_SNAPSHOTS.list({
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
        const validated = await validateMoneyForwardRun(env.MONEYFORWARD_SNAPSHOTS, object.key);
        // Audit identities are ephemeral and never returned; central import uses its secret HMAC key.
        const accountKeys = await moneyForwardAccountKeys(validated.artifacts, "00".repeat(32));
        let monthlyArtifactCount = 0;
        let evidenceArtifactCount = 0;
        let tooltipBodyRowCount = 0;
        let parsedObservationCount = 0;
        let inflowObservationCount = 0;
        let outflowObservationCount = 0;
        if (validated.manifest.status === "success" && validated.manifest.failures.length === 0) {
          for (const verified of validated.artifacts) {
            const meta = {
              id: 0,
              sourceId: "moneyforward-me",
              runStatus: "success" as const,
              runFailureCount: 0,
              dataset: verified.artifact.dataset,
              artifactKey: verified.artifact.filename,
              fetchUnitKey: accountKeys.get(verified.artifact.accountOrdinal ?? 0) ?? null,
              statementState: null,
              period: null,
              url: null,
              mime: "text/html; charset=utf-8",
              fetchedAt: validated.manifest.completedAt,
              sha256: verified.artifact.sha256,
            };
            if (verified.artifact.dataset === "monthly-transactions") {
              monthlyArtifactCount += 1;
              tooltipBodyRowCount += countTooltipBodyRows(verified.bytes);
              const parsed = moneyForwardMonthlyTransactions.parse(verified.bytes, meta);
              parsedObservationCount += parsed.observations.length;
              for (const observation of parsed.observations) {
                if (observation.kind !== "transaction" || observation.amountMinor === undefined) {
                  throw new Error("moneyforward parser emitted unsupported observation");
                }
                if (observation.amountMinor > 0) inflowObservationCount += 1;
                else if (observation.amountMinor < 0) outflowObservationCount += 1;
              }
            } else {
              evidenceArtifactCount += 1;
              const parsed = moneyForwardEvidenceOnly.parse(verified.bytes, meta);
              if (parsed.observations.length !== 0) {
                throw new Error("moneyforward evidence-only parser emitted observations");
              }
            }
          }
        }
        return response({
          scanned: 1,
          audited: 1,
          manifestStatus: validated.manifest.status,
          failureCount: validated.manifest.failures.length,
          artifactCount: validated.artifacts.length,
          monthlyArtifactCount,
          evidenceArtifactCount,
          tooltipBodyRowCount,
          parsedObservationCount,
          inflowObservationCount,
          outflowObservationCount,
          adjacentCalendarRowCount: tooltipBodyRowCount - parsedObservationCount,
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

function countTooltipBodyRows(bytes: Uint8Array): number {
  const document = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  let count = 0;
  for (const table of allElements(document)) {
    if (
      table.tagName !== "table" ||
      attribute(table, "id") !== "tooltip" ||
      !(attribute(table, "class") ?? "").split(/\s+/u).includes("calendar-tooltip-table")
    ) {
      continue;
    }
    const tbody = table.childNodes.find(
      (child): child is HtmlElement => "tagName" in child && child.tagName === "tbody",
    );
    if (tbody)
      count += tbody.childNodes.filter(
        (child) => "tagName" in child && child.tagName === "tr",
      ).length;
  }
  return count;
}

function allElements(root: HtmlNode): HtmlElement[] {
  const result: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if ("tagName" in node) result.push(node as HtmlElement);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
    if ("content" in node && node.content) visit(node.content);
  };
  visit(root);
  return result;
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function response(input: {
  scanned: number;
  audited?: number;
  skipped?: number;
  failed?: number;
  failureCode?: string;
  manifestStatus?: string;
  failureCount?: number;
  artifactCount?: number;
  monthlyArtifactCount?: number;
  evidenceArtifactCount?: number;
  tooltipBodyRowCount?: number;
  parsedObservationCount?: number;
  inflowObservationCount?: number;
  outflowObservationCount?: number;
  adjacentCalendarRowCount?: number;
  nextCursor: string | null;
}): Response {
  return json({
    schemaVersion: "moneyforward-layer-b-aggregate-audit-v1",
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
          artifactCount: input.artifactCount,
          monthlyArtifactCount: input.monthlyArtifactCount,
          evidenceArtifactCount: input.evidenceArtifactCount,
          tooltipBodyRowCount: input.tooltipBodyRowCount,
          parsedObservationCount: input.parsedObservationCount,
          inflowObservationCount: input.inflowObservationCount,
          outflowObservationCount: input.outflowObservationCount,
          adjacentCalendarRowCount: input.adjacentCalendarRowCount,
        }
      : {}),
  });
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error) || !error.message.startsWith("moneyforward ")) {
    return "layer_a_contract_validation_failed";
  }
  if (error.message.includes("artifact key is invalid")) return "parser_artifact_key_failed";
  if (error.message.includes("must be an HTML fragment")) return "parser_fragment_boundary_failed";
  if (error.message.includes("tooltip and date cardinality"))
    return "parser_date_cardinality_failed";
  if (error.message.includes("calendar date")) return "parser_date_calendar_failed";
  if (error.message.includes("date binding")) return "parser_date_binding_failed";
  if (error.message.includes("amount has a trailing sign")) return "parser_amount_trailing_sign";
  if (error.message.includes("amount has no explicit sign")) return "parser_amount_unsigned";
  if (error.message.includes("amount has unsupported digit grouping"))
    return "parser_amount_digit_grouping";
  if (error.message.includes("amount has a decimal marker")) return "parser_amount_decimal_marker";
  if (error.message.includes("amount has a yen suffix")) return "parser_amount_yen_suffix";
  if (error.message.includes("amount")) return "parser_amount_contract_failed";
  if (error.message.includes("cardinality")) return "parser_cardinality_contract_failed";
  if (
    error.message.includes("row") ||
    error.message.includes("table") ||
    error.message.includes("header")
  ) {
    return "parser_schema_contract_failed";
  }
  if (error.message.includes("metadata")) return "parser_metadata_contract_failed";
  if (error.message.includes("surface marker")) return "parser_surface_contract_failed";
  if (error.message.includes("document")) return "parser_document_contract_failed";
  return "parser_contract_failed";
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
