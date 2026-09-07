// Read-only, in-memory parser diagnostic. Never print raw bytes, identifiers,
// financial values, provider keys or unfiltered exception messages.
import { getPlatformProxy } from "wrangler";
import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types.ts";
import { parse } from "parse5";

const proxy = await getPlatformProxy<{ DB: D1Database; EVIDENCE: R2Bucket }>({
  configPath: new URL("../wrangler.diagnostic.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
function safeReason(message: string): string {
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
  if (/schema/.test(message)) return "unsupported_schema";
  if (/fields changed/.test(message))
    return message.includes("depositRecordList")
      ? "record_fields_changed"
      : message.includes("pages[")
        ? "page_fields_changed"
        : "bundle_fields_changed";
  if (/exact decimal/.test(message)) return "decimal_shape_rejected";
  if (/pagination|page metadata|page chain|page inventory/.test(message))
    return "pagination_rejected";
  if (/incomplete|truncated|length|width/.test(message)) return "incomplete_payload";
  if (/duplicate did/.test(message)) return "duplicate_record_id";
  if (/must be|is invalid|unsupported|not successful/.test(message)) return "field_value_rejected";
  return "parser_rejected_other";
}
try {
  const newestSbi = process.argv.includes("--newest-sbi");
  const remainingAll = process.argv.includes("--remaining-all");
  const remaining = process.argv.includes("--remaining") || remainingAll;
  if (newestSbi) {
    const inventory =
      await proxy.env.DB.prepare(`SELECT a.dataset,COUNT(DISTINCT a.id) AS artifacts,MIN(a.fetched_at) AS earliest,MAX(a.fetched_at) AS latest,
      COUNT(DISTINCT CASE WHEN p.status='ok' THEN a.id END) AS successful_artifacts
      FROM observation_fetch_artifacts a LEFT JOIN parse_runs p ON p.fetch_artifact_id=a.id
      WHERE a.source_id='sbi-securities' AND a.dataset IN ('domestic-cash-positions','yen-detail-history') GROUP BY a.dataset`).all();
    console.log(JSON.stringify({ inventory: inventory.results }));
  }
  const { results } = await proxy.env.DB.prepare(`SELECT a.*, o.blob_key, o.byte_size,
    coalesce((SELECT start_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_start) AS window_start,
    coalesce((SELECT end_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_end) AS window_end
    FROM observation_fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256
    JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
    WHERE a.id IN (${remaining ? `SELECT ${remainingAll ? "fetch_artifact_id" : "MAX(fetch_artifact_id)"} FROM observation_parse_jobs WHERE last_error_code IS NOT NULL AND ((parser_name='sbi-yen-detail-history' AND parser_version='1.0.1') OR (parser_name='global-pass-activity' AND parser_version='1.0.0')) ${remainingAll ? "" : "GROUP BY parser_name"}` : newestSbi ? `SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY dataset ORDER BY fetched_at DESC,id DESC) AS rank FROM observation_fetch_artifacts WHERE source_id='sbi-securities' AND dataset IN ('domestic-cash-positions','yen-detail-history')) WHERE rank=1` : `SELECT MIN(fetch_artifact_id) FROM observation_parse_jobs WHERE last_error_code IS NOT NULL GROUP BY parser_name`})
    ORDER BY a.id`).all<{
    id: number;
    source_id: string;
    dataset: string;
    artifact_key: string;
    fetch_unit_key: string | null;
    mime: string;
    fetched_at: string;
    sha256: string;
    blob_key: string;
    byte_size: number;
    window_start: string | null;
    window_end: string | null;
  }>();
  for (const row of results) {
    const meta: ArtifactMeta = {
      id: row.id,
      sourceId: row.source_id,
      dataset: row.dataset,
      artifactKey: row.artifact_key,
      fetchUnitKey: row.fetch_unit_key,
      mime: row.mime,
      fetchedAt: row.fetched_at,
      sha256: row.sha256,
      url: null,
      runStatus: "success",
      runFailureCount: 0,
    };
    if (row.window_start && row.window_end)
      meta.runWindow = { from: row.window_start, to: row.window_end };
    for (const parser of PARSERS.filter((p) => p.accepts(meta))) {
      if (row.byte_size > 16 * 1024 * 1024) {
        console.log(JSON.stringify({ parser: parser.name, result: "oversize" }));
        continue;
      }
      const object = await proxy.env.EVIDENCE.get(row.blob_key);
      if (!object) throw new Error("Diagnostic object unavailable");
      const bytes = new Uint8Array(await object.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== row.sha256 || bytes.length !== row.byte_size)
        throw new Error("Diagnostic integrity failure");
      if (newestSbi || (remaining && !remainingAll && parser.name === "sbi-yen-detail-history")) {
        const root = JSON.parse(new TextDecoder().decode(bytes));
        if (parser.name === "sbi-domestic-cash-positions") {
          const payload = Uint8Array.from(atob(root.payloadBase64), (c) => c.charCodeAt(0));
          const integer = (start: number, end: number) =>
            Number(new TextDecoder().decode(payload.subarray(start, end)).trim());
          const pageIndex = integer(24, 27),
            totalCount = integer(27, 30),
            recordCount = integer(30, 34);
          console.log(
            JSON.stringify({
              parser: parser.name,
              fetchedAt: row.fetched_at,
              payloadBytes: payload.length,
              pageIndex,
              totalCount,
              recordCount,
              expectedBaseBytes: 34 + 423 * recordCount + 29,
              trailerBytes: payload.length - (34 + 423 * recordCount + 29),
            }),
          );
        } else {
          if (remaining) {
            const expected = [
              "depositRecordList",
              "detailsConditions",
              "exceededMaxCount",
              "isExceededMaxCount",
              "nextBusinessDate",
              "pageCount",
              "pageNumber",
              "pageSize",
              "totalCount",
              "totalDepositAmount",
              "totalDepositCount",
              "totalPaymentAmount",
              "totalPaymentCount",
              "totalTransDepositAmount",
              "totalTransDepositCount",
              "totalTransPaymentAmount",
              "totalTransPaymentCount",
            ];
            console.log(
              JSON.stringify({
                parser: parser.name,
                missingFields: expected.filter((k) => !Object.hasOwn(root, k)),
                unexpectedCount: Object.keys(root).filter((k) => !expected.includes(k)).length,
              }),
            );
          }
          console.log(
            JSON.stringify({
              parser: parser.name,
              fetchedAt: row.fetched_at,
              expectedBundleSchema: root.schemaVersion === "sbi-yen-detail-history-bundle-v1",
              pageCount: root.pageCount,
              pageNumber: root.pageNumber,
              pageSize: root.pageSize,
              totalCount: root.totalCount,
              recordCount: Array.isArray(root.depositRecordList)
                ? root.depositRecordList.length
                : null,
              bundlePages: Array.isArray(root.pages) ? root.pages.length : null,
              complete: root.complete,
              exceededMaxCount: root.exceededMaxCount,
              isExceededMaxCount: root.isExceededMaxCount,
            }),
          );
        }
      }
      if (remaining && !remainingAll && parser.name === "global-pass-activity") {
        const html = new TextDecoder().decode(bytes);
        const dom = parse(html);
        const shapes: number[] = [];
        const walk = (node: { nodeName: string; childNodes?: unknown[] }, owner?: number) => {
          let current = owner;
          if (node.nodeName === "table") {
            current = shapes.length;
            shapes.push(0);
          }
          if (node.nodeName === "th" && current !== undefined) shapes[current]!++;
          for (const child of node.childNodes ?? []) walk(child as typeof node, current);
        };
        walk(dom);
        console.log(
          JSON.stringify({
            parser: parser.name,
            fetchedAt: row.fetched_at,
            tableHeaderCounts: shapes,
            emptyMarkers: [
              "No transactions",
              "No Transactions",
              "no transactions",
              "No data",
              "No Data",
              "no data",
              "取引はありません",
              "該当",
            ].filter((s) => html.includes(s)),
          }),
        );
        if (shapes.length === 0) {
          const messages: string[] = [];
          const collect = (node: { nodeName: string; value?: string; childNodes?: unknown[] }) => {
            const value = node.value?.trim();
            if (
              value &&
              value.length < 100 &&
              /(?:data|record|exist|ありません|該当|nothing|empty|not found)/i.test(value) &&
              !/[0-9@]/.test(value)
            )
              messages.push(value);
            for (const child of node.childNodes ?? []) collect(child as typeof node);
          };
          collect(dom);
          console.log(JSON.stringify({ parser: parser.name, emptyStateCandidates: messages }));
        }
      }
      try {
        const parsed = parser.parse(bytes, meta);
        console.log(
          JSON.stringify({
            parser: parser.name,
            result: "parsed",
            observations: parsed.observations.length,
          }),
        );
      } catch (error) {
        console.log(
          JSON.stringify({
            parser: parser.name,
            result: "rejected",
            reason: safeReason(error instanceof Error ? error.message : ""),
          }),
        );
        if (!remainingAll && parser.name === "sbi-yen-detail-history") {
          const root = JSON.parse(new TextDecoder().decode(bytes));
          console.log(
            JSON.stringify({
              parser: parser.name,
              expectedBundleSchema: root.schemaVersion === "sbi-yen-detail-history-bundle-v1",
              pagesArray: Array.isArray(root.pages),
              legacyDirectRecords: Array.isArray(root.depositRecordList),
            }),
          );
        }
      }
    }
  }
} finally {
  await proxy.dispose();
}
