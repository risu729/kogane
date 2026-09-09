import { ImportError } from "./error";
import { validateVpassRun } from "./vpass";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass";

interface AuditEnv {
  VPASS_SNAPSHOTS: R2Bucket;
}

type Counts = Record<string, number>;

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "vpass-r2-layer-b-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return response({ error: "not_found" }, 404);
    }
    try {
      const input = (await request.json()) as unknown;
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== "cursor") ||
        !(input.cursor === undefined || safeCursor(input.cursor))
      ) {
        throw new ImportError(400, "cursor_invalid");
      }
      const listed = await env.VPASS_SNAPSHOTS.list({
        prefix: "vpass/",
        // Keep each local-worker request below the remote R2/Workers wall-time
        // boundary; the harness follows the opaque cursor until completion.
        limit: 50,
        ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
      });
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && !nextCursor) throw new ImportError(409, "prefix_cursor_missing");
      if (listed.truncated && nextCursor === input.cursor) {
        throw new ImportError(409, "prefix_cursor_did_not_advance");
      }
      const aggregate = emptyAggregate();
      aggregate.scanned = listed.objects.length;
      for (const object of listed.objects) {
        if (!/(?:\/manifest|\/error)\.json$/u.test(object.key)) {
          aggregate.skipped += 1;
          continue;
        }
        try {
          const audited = await auditRecord(env.VPASS_SNAPSHOTS, object.key);
          aggregate.audited += 1;
          increment(aggregate.statuses, audited.recordStatus);
          increment(aggregate.schemas, audited.recordSchemaVersion);
          aggregate.artifacts += audited.artifactCount;
          aggregate.statementArtifacts += audited.statementArtifactCount;
          aggregate.rows += audited.statementRowCount;
          aggregate.webRows += audited.webRowCount;
          aggregate.customizedRows += audited.customizedRowCount;
          aggregate.parsedStatementArtifacts += audited.parsedStatementArtifactCount;
          aggregate.parsedTransactions += audited.parsedTransactionCount;
          aggregate.parserWarnings += audited.parserWarningCount;
          aggregate.blockedStatementArtifacts += audited.blockedStatementArtifactCount;
          mergeCounts(aggregate.webShapes, audited.webShapes);
          mergeCounts(aggregate.customizedShapes, audited.customizedShapes);
          mergeCounts(aggregate.webPresentationShapes, audited.webPresentationShapes);
          mergeCounts(aggregate.customizedPageShapes, audited.customizedPageShapes);
          mergeCounts(aggregate.webRowKeyShapes, audited.webRowKeyShapes);
          mergeCounts(aggregate.customizedRowKeyShapes, audited.customizedRowKeyShapes);
          mergeCounts(aggregate.webBeanKeyShapes, audited.webBeanKeyShapes);
          mergeCounts(aggregate.customizedBeanKeyShapes, audited.customizedBeanKeyShapes);
          mergeCounts(aggregate.rootKeyShapes, audited.rootKeyShapes);
          mergeCounts(aggregate.headerKeyShapes, audited.headerKeyShapes);
          mergeCounts(aggregate.bodyKeyShapes, audited.bodyKeyShapes);
          mergeCounts(aggregate.contentKeyShapes, audited.contentKeyShapes);
        } catch (error) {
          aggregate.failed += 1;
          increment(aggregate.failures, safeCode(error));
        }
      }
      return auditResponse({ ...aggregate, nextCursor: nextCursor ?? null });
    } catch (error) {
      return response(
        { error: safeCode(error) },
        error instanceof ImportError ? error.status : 502,
      );
    }
  },
};

async function auditRecord(bucket: R2Bucket, recordKey: string) {
  const validated = await validateVpassRun(bucket, recordKey);
  const webShapes: Counts = {};
  const customizedShapes: Counts = {};
  const webPresentationShapes: Counts = {};
  const customizedPageShapes: Counts = {};
  const webRowKeyShapes: Counts = {};
  const customizedRowKeyShapes: Counts = {};
  const webBeanKeyShapes: Counts = {};
  const customizedBeanKeyShapes: Counts = {};
  const rootKeyShapes: Counts = {};
  const headerKeyShapes: Counts = {};
  const bodyKeyShapes: Counts = {};
  const contentKeyShapes: Counts = {};
  let statementArtifactCount = 0;
  let statementRowCount = 0;
  let webRowCount = 0;
  let customizedRowCount = 0;
  let parsedStatementArtifactCount = 0;
  let parsedTransactionCount = 0;
  let parserWarningCount = 0;
  for (const artifact of validated.artifacts) {
    if (artifact.dataset !== "statement-page") continue;
    statementArtifactCount += 1;
    const root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes));
    if (!isRecord(root)) throw new Error("statement_root_invalid");
    increment(rootKeyShapes, Object.keys(root).sort().join(","));
    const header = objectAt(root, "header");
    const body = objectAt(root, "body");
    const content = objectAt(root, "body", "content");
    if (!header || !body || !content) throw new Error("statement_content_invalid");
    increment(headerKeyShapes, Object.keys(header).sort().join(","));
    increment(bodyKeyShapes, Object.keys(body).sort().join(","));
    increment(contentKeyShapes, Object.keys(content).sort().join(","));
    const web = objectAt(content, "WebMeisaiTopDisplayServiceBean");
    const customized = objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean");
    if ((web === undefined) === (customized === undefined)) {
      throw new Error("statement_family_invalid");
    }
    if (validated.record.status === "success") {
      const parsed = vpassStatementPage.parse(artifact.bytes, {
        id: 0,
        sourceId: "vpass",
        runStatus: "success",
        runFailureCount: 0,
        dataset: artifact.dataset,
        artifactKey: artifact.artifactKey,
        fetchUnitKey: validated.record.cardLabel,
        statementState: null,
        period: null,
        url: null,
        mime: "application/json",
        fetchedAt: validated.record.completedAt,
        sha256: artifact.sha256,
      });
      parsedStatementArtifactCount += 1;
      parsedTransactionCount += parsed.observations.length;
      parserWarningCount += parsed.warnings.length;
    }
    if (web) {
      increment(webBeanKeyShapes, Object.keys(web).sort().join(","));
      const rows = statementRows(web.meisaiList, "web_rows_invalid");
      const transit = safeProviderCode(header?.transitTo);
      webRowCount += rows.length;
      statementRowCount += rows.length;
      for (const value of rows) {
        if (!isRecord(value)) throw new Error("web_row_invalid");
        increment(webRowKeyShapes, Object.keys(value).sort().join(","));
        const data = boundedStringArray(value.data, "web_row_data_invalid");
        const shape = [
          transit,
          safeProviderCode(value.rowType),
          safeProviderCode(data[0]),
          safeProviderCode(data[1]),
          String(data.length),
          dateShape(data[3]),
          amountShape(data[3]),
          dateShape(data[5]),
          amountShape(data[5]),
          safeProviderCode(data[6]),
        ].join("|");
        increment(webShapes, shape);
        if (data[0] === "45" || data[0] === "4C" || (data[0] === "4K" && data[1] === "002")) {
          increment(
            webPresentationShapes,
            [
              safeProviderCode(value.rowType),
              safeProviderCode(data[0]),
              safeProviderCode(data[1]),
              String(data.length),
              safeIntegerCode(value.columnsSize),
              safeProviderCode(value.columnsSizeS),
              safeProviderCode(value.maxIndex),
              safeIntegerCode(value.shiharaiPatternFlag),
            ].join("|"),
          );
        }
      }
    } else {
      increment(customizedBeanKeyShapes, Object.keys(customized!).sort().join(","));
      const rows = statementRows(customized!.meisaiList, "customized_rows_invalid");
      customizedRowCount += rows.length;
      statementRowCount += rows.length;
      const scope = statementArtifactScope(artifact.artifactKey);
      increment(
        customizedPageShapes,
        [
          scope.kind,
          scope.index === 0 ? "index_zero" : "index_positive",
          rows.length === 0 ? "rows_empty" : "rows_nonempty",
          safeProviderCode(customized!.pageFlg),
          scalarShape(customized!.pageSize),
          scalarShape(customized!.responseCnt),
          scalarShape(customized!.total),
          integerRelation(customized!.responseCnt, rows.length),
          integerLowerBoundRelation(customized!.total, rows.length),
          statementMonthRelation(customized!.seikyuYM, scope.month),
        ].join("|"),
      );
      for (const value of rows) {
        if (!isRecord(value)) throw new Error("customized_row_invalid");
        increment(customizedRowKeyShapes, Object.keys(value).sort().join(","));
        const shape = [
          safeProviderCode(value.uriageKbn),
          dateShape(value.riyouDate),
          amountShape(value.riyouKin),
          amountShape(value.shiharaiTotal),
          amountShape(value.tesuWariKin),
          amountShape(value.genchiKin),
          safeProviderCode(value.tukaRyaku),
        ].join("|");
        increment(customizedShapes, shape);
      }
    }
  }
  return {
    recordStatus: validated.record.status,
    recordSchemaVersion: validated.record.schemaVersion,
    artifactCount: validated.artifacts.length,
    statementArtifactCount,
    statementRowCount,
    webRowCount,
    customizedRowCount,
    parsedStatementArtifactCount,
    parsedTransactionCount,
    parserWarningCount,
    blockedStatementArtifactCount:
      validated.record.status === "success" ? 0 : statementArtifactCount,
    webShapes,
    customizedShapes,
    webPresentationShapes,
    customizedPageShapes,
    webRowKeyShapes,
    customizedRowKeyShapes,
    webBeanKeyShapes,
    customizedBeanKeyShapes,
    rootKeyShapes,
    headerKeyShapes,
    bodyKeyShapes,
    contentKeyShapes,
  };
}

function statementArtifactScope(artifactKey: string): {
  month: string;
  kind: "top" | "answer";
  index: number;
} {
  const match = /^(?:cards\/card-\d{3}\/)?months\/(\d{6})\/(top|answer)-(\d{3})\.json$/u.exec(
    artifactKey,
  );
  if (!match) throw new Error("statement_artifact_key_invalid");
  return { month: match[1]!, kind: match[2] as "top" | "answer", index: Number(match[3]) };
}

function safeIntegerCode(value: unknown): string {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000
    ? String(value)
    : "other";
}

function scalarShape(value: unknown): string {
  if (value === "") return "empty";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return "integer";
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) return "digit_string";
  return "other";
}

function providerInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const result = Number(value);
    if (Number.isSafeInteger(result)) return result;
  }
  return undefined;
}

function integerRelation(value: unknown, expected: number): string {
  const parsed = providerInteger(value);
  return parsed === undefined ? "invalid" : parsed === expected ? "equals_rows" : "differs_rows";
}

function integerLowerBoundRelation(value: unknown, minimum: number): string {
  const parsed = providerInteger(value);
  return parsed === undefined ? "invalid" : parsed >= minimum ? "covers_rows" : "below_rows";
}

function statementMonthRelation(value: unknown, month: string): string {
  if (value === "") return "empty";
  return value === month ? "matches_artifact" : "other";
}

function boundedArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(code);
  return value;
}

function statementRows(value: unknown, code: string): unknown[] {
  return value === undefined || value === null ? [] : boundedArray(value, code);
}

function boundedStringArray(value: unknown, code: string): string[] {
  const array = boundedArray(value, code);
  if (array.some((entry) => typeof entry !== "string" || entry.length > 5_000)) {
    throw new Error(code);
  }
  return array as string[];
}

function dateShape(value: unknown): string {
  if (typeof value !== "string") return "non_string";
  if (value === "") return "empty";
  const normalized = value.normalize("NFKC").trim();
  const weekday = "(?:\\([^0-9()]{1,3}\\))?";
  if (new RegExp(`^\\d{4}/\\d{1,2}/\\d{1,2}${weekday}$`, "u").test(normalized)) {
    return "yyyy_mm_dd";
  }
  if (new RegExp(`^\\d{1,2}/\\d{1,2}${weekday}$`, "u").test(normalized)) return "mm_dd";
  if (new RegExp(`^\\d{4}年\\d{1,2}月\\d{1,2}日${weekday}$`, "u").test(normalized)) {
    return "yyyy_jp_md";
  }
  if (new RegExp(`^\\d{1,2}月\\d{1,2}日${weekday}$`, "u").test(normalized)) return "jp_md";
  if (/^\d{8}$/u.test(normalized)) return "yyyymmdd";
  if (/^\d{4}$/u.test(normalized)) return "mmdd";
  return `other_${dateMask(normalized)}`;
}

function dateMask(value: string): string {
  return [...value]
    .map((character) => {
      if (/\d/u.test(character)) return "d";
      if (/[/().-]/u.test(character)) return character;
      if (/\s/u.test(character)) return "_";
      return "x";
    })
    .join("")
    .slice(0, 64);
}

function amountShape(value: unknown): string {
  if (typeof value !== "string") return "non_string";
  if (value === "") return "empty";
  const normalized = value.normalize("NFKC").replaceAll(",", "").trim();
  if (/^-?\d+$/u.test(normalized)) return normalized.startsWith("-") ? "negative" : "unsigned";
  return "other";
}

function safeProviderCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{0,64}$/u.test(value)
    ? value || "empty"
    : "other";
}

function increment(counts: Counts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(target: Counts, values: Counts): void {
  for (const [key, value] of Object.entries(values)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function emptyAggregate() {
  return {
    scanned: 0,
    audited: 0,
    skipped: 0,
    failed: 0,
    statuses: {} as Counts,
    schemas: {} as Counts,
    artifacts: 0,
    statementArtifacts: 0,
    rows: 0,
    webRows: 0,
    customizedRows: 0,
    parsedStatementArtifacts: 0,
    parsedTransactions: 0,
    parserWarnings: 0,
    blockedStatementArtifacts: 0,
    webShapes: {} as Counts,
    customizedShapes: {} as Counts,
    webPresentationShapes: {} as Counts,
    customizedPageShapes: {} as Counts,
    webRowKeyShapes: {} as Counts,
    customizedRowKeyShapes: {} as Counts,
    webBeanKeyShapes: {} as Counts,
    customizedBeanKeyShapes: {} as Counts,
    rootKeyShapes: {} as Counts,
    headerKeyShapes: {} as Counts,
    bodyKeyShapes: {} as Counts,
    contentKeyShapes: {} as Counts,
    failures: {} as Counts,
  };
}

function objectAt(
  root: Record<string, unknown>,
  ...path: string[]
): Record<string, unknown> | undefined {
  let value: unknown = root;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return isRecord(value) ? value : undefined;
}

function auditResponse(input: {
  scanned: number;
  audited: number;
  skipped: number;
  failed: number;
  statuses: Counts;
  schemas: Counts;
  artifacts: number;
  statementArtifacts: number;
  rows: number;
  webRows: number;
  customizedRows: number;
  parsedStatementArtifacts: number;
  parsedTransactions: number;
  parserWarnings: number;
  blockedStatementArtifacts: number;
  webShapes: Counts;
  customizedShapes: Counts;
  webPresentationShapes: Counts;
  customizedPageShapes: Counts;
  webRowKeyShapes: Counts;
  customizedRowKeyShapes: Counts;
  webBeanKeyShapes: Counts;
  customizedBeanKeyShapes: Counts;
  rootKeyShapes: Counts;
  headerKeyShapes: Counts;
  bodyKeyShapes: Counts;
  contentKeyShapes: Counts;
  failures: Counts;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "vpass-r2-layer-b-structural-audit-v1",
    scannedObjectCount: input.scanned,
    auditedRecordCount: input.audited,
    skippedObjectCount: input.skipped,
    failedRecordCount: input.failed,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    recordStatusCounts: input.statuses,
    recordSchemaCounts: input.schemas,
    artifactCount: input.artifacts,
    statementArtifactCount: input.statementArtifacts,
    statementRowCount: input.rows,
    webRowCount: input.webRows,
    customizedRowCount: input.customizedRows,
    parsedStatementArtifactCount: input.parsedStatementArtifacts,
    parsedTransactionCount: input.parsedTransactions,
    parserWarningCount: input.parserWarnings,
    blockedStatementArtifactCount: input.blockedStatementArtifacts,
    observedWebShapes: input.webShapes,
    observedCustomizedShapes: input.customizedShapes,
    observedWebPresentationShapes: input.webPresentationShapes,
    observedCustomizedPageShapes: input.customizedPageShapes,
    observedWebRowKeyShapes: input.webRowKeyShapes,
    observedCustomizedRowKeyShapes: input.customizedRowKeyShapes,
    observedWebBeanKeyShapes: input.webBeanKeyShapes,
    observedCustomizedBeanKeyShapes: input.customizedBeanKeyShapes,
    observedRootKeyShapes: input.rootKeyShapes,
    observedHeaderKeyShapes: input.headerKeyShapes,
    observedBodyKeyShapes: input.bodyKeyShapes,
    observedContentKeyShapes: input.contentKeyShapes,
    failureCodeCounts: input.failures,
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

function safeCode(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    const parserCodes: Array<[RegExp, string]> = [
      [/fetch unit/u, "parser_fetch_unit_invalid"],
      [/artifact key/u, "parser_artifact_key_invalid"],
      [/header\.resultCode/u, "parser_result_code_invalid"],
      [/web bean has schema drift/u, "parser_web_bean_schema_drift"],
      [/web content has schema drift/u, "parser_web_content_schema_drift"],
      [/web row .*\.columnsSize/u, "parser_web_columns_size_invalid"],
      [/web row .*\.maxIndex/u, "parser_web_max_index_invalid"],
      [/web row .*\.columnsSizeS/u, "parser_web_columns_size_s_invalid"],
      [/web row .*\.rowType/u, "parser_web_row_type_invalid"],
      [/web row .*\.shiharaiPatternFlag/u, "parser_web_payment_pattern_invalid"],
      [/web row .*\.data must/u, "parser_web_data_container_invalid"],
      [/web row .*\.data has schema drift/u, "parser_web_data_schema_drift"],
      [/web row .* metadata conflicts/u, "parser_web_metadata_invalid"],
      [/unsupported provider subtype/u, "parser_web_subtype_unknown"],
      [/provider YY\/MM\/DD/u, "parser_date_shape_invalid"],
      [/calendar date/u, "parser_calendar_date_invalid"],
      [/exact JPY integer/u, "parser_amount_invalid"],
      [/customized page kind/u, "parser_customized_page_kind_invalid"],
      [/customized pageFlg/u, "parser_customized_page_flag_invalid"],
      [/customized pageSize/u, "parser_customized_page_size_invalid"],
      [/customized responseCnt/u, "parser_customized_response_count_invalid"],
      [/customized total/u, "parser_customized_total_invalid"],
      [/customized page metadata/u, "parser_customized_page_metadata_invalid"],
      [/customized statement month/u, "parser_customized_month_invalid"],
      [/must contain exactly one supported family/u, "parser_family_invalid"],
      [/has schema drift/u, "parser_schema_drift"],
    ];
    for (const [pattern, code] of parserCodes) {
      if (pattern.test(message)) return code;
    }
  }
  const candidate =
    error instanceof ImportError
      ? error.code
      : error instanceof Error
        ? error.message
        : "request_failed";
  return /^[a-z0-9_-]{1,100}$/u.test(candidate) ? candidate : "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
