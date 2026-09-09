// Read-only: fetch selected failed objects into memory, emit structural error
// categories only. Never log raw payloads or provider error strings.
import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types.ts";
import { parseCsv } from "../../../poc/observation-pipeline/src/parsers/util.ts";
import { decimalText } from "../../../poc/observation-pipeline/src/parsers/util.ts";
const cli = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
async function command(args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["node", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).bytes();
  if ((await child.exited) !== 0) throw new Error("read-only command failed");
  return output;
}
const sql = `WITH ranked AS (
 SELECT a.*,o.blob_key,o.byte_size,p.parser_name,
 row_number() OVER(PARTITION BY p.parser_name,a.sha256 ORDER BY p.fetch_artifact_id DESC) AS rank,
 (SELECT start_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' LIMIT 1) window_start,
 (SELECT end_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' LIMIT 1) window_end
 FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN raw_objects o ON o.sha256=a.sha256
 WHERE p.status='error' AND a.source_id IN ('sony-bank','sbi-shinsei-bank')
 AND NOT EXISTS(SELECT 1 FROM published_parse_runs success WHERE success.fetch_artifact_id=p.fetch_artifact_id AND success.parser_name=p.parser_name)
) SELECT * FROM ranked WHERE rank=1 ORDER BY id DESC LIMIT 50`;
const result = JSON.parse(
  new TextDecoder().decode(
    await command(["d1", "execute", "kogane-raw-evidence", "--remote", "--command", sql, "--json"]),
  ),
);
let replayed = 0;
const maxReplays = Math.max(1, Math.min(50, Number(process.argv[3]) || 1));
for (const row of result[0].results) {
  if (process.argv[2] && !row.parser_name.includes(process.argv[2])) continue;
  if (process.argv[4] && row.id !== Number(process.argv[4])) continue;
  if (replayed++ >= maxReplays) break;
  const parser = PARSERS.find((p) => p.name === row.parser_name)!;
  const bytes = await command([
    "r2",
    "object",
    "get",
    `kogane-raw-evidence/${row.blob_key}`,
    "--remote",
    "--pipe",
  ]);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== row.sha256 || bytes.length !== row.byte_size)
    throw new Error("raw_integrity_failure");
  const meta: ArtifactMeta = {
    id: row.id,
    sourceId: row.source_id,
    dataset: row.dataset,
    artifactKey: row.artifact_key,
    fetchUnitKey: row.fetch_unit_key,
    mime: row.mime,
    sha256: row.sha256,
    fetchedAt: row.fetched_at,
    url: null,
    runStatus: "success",
    runFailureCount: 0,
    statementState: row.statement_state,
    period: row.period,
    ...(row.window_start && row.window_end
      ? { runWindow: { from: row.window_start, to: row.window_end } }
      : {}),
  };
  if (row.parser_name === "sony-bank-wallet-history") {
    const manifestSql = `SELECT o.blob_key,o.sha256,o.byte_size FROM fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256 WHERE a.fetch_run_id=${Number(row.fetch_run_id)} AND a.artifact_role='collector_manifest'`;
    const manifestRow = JSON.parse(
      new TextDecoder().decode(
        await command([
          "d1",
          "execute",
          "kogane-raw-evidence",
          "--remote",
          "--command",
          manifestSql,
          "--json",
        ]),
      ),
    )[0].results[0];
    const manifestBytes = await command([
      "r2",
      "object",
      "get",
      `kogane-raw-evidence/${manifestRow.blob_key}`,
      "--remote",
      "--pipe",
    ]);
    const manifestHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(manifestBytes))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (manifestHash !== manifestRow.sha256 || manifestBytes.length !== manifestRow.byte_size)
      throw new Error("manifest_integrity_failure");
    const matches = JSON.parse(new TextDecoder().decode(manifestBytes)).artifacts.filter(
      (a: { dataset: string; sha256: string }) =>
        a.dataset === row.dataset && a.sha256 === row.sha256,
    );
    if (matches.length !== 1) throw new Error("manifest_match_failure");
    meta.mime = matches[0].mediaType;
  }
  try {
    const parsed = parser.parse(bytes, meta);
    console.log(
      JSON.stringify({
        artifact: row.id,
        parser: parser.name,
        result: "ok",
        observations: parsed.observations.length,
      }),
    );
  } catch (error) {
    const text = new TextDecoder().decode(bytes);
    if (row.parser_name === "sony-bank-wallet-history") {
      const select =
        text.match(
          /<select\b[^>]*name=["']W131301\.referenceDate["'][^>]*>([\s\S]*?)<\/select>/i,
        )?.[1] ?? "";
      const attrs = [...select.matchAll(/<option\b([^>]*)>/gi)].map((m) => m[1] ?? "");
      const values = attrs.map((a) => a.match(/value=["']([^"']*)["']/i)?.[1] ?? "");
      console.log(
        JSON.stringify({
          optionCount: values.length,
          emptyValues: values.filter((v) => v === "").length,
          dateValues: values.filter((v) => /^\d{8}$/.test(v)).length,
          otherValueCount: values.filter((v) => v !== "" && !/^\d{8}$/.test(v)).length,
        }),
      );
      const headers = [...text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((t) =>
        [...t[1]!.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((h) =>
          h[1]!
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        ),
      );
      console.log(
        JSON.stringify({
          tableCount: headers.length,
          headerCounts: headers.map((h) => h.length),
          explicitEmpty: />\s*ご利用明細はありません。\s*</u.test(text),
        }),
      );
      const desktop =
        [...text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].find(
          (t) => [...t[1]!.matchAll(/<th\b/gi)].length === 12,
        )?.[1] ?? "";
      const tbody = desktop.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
      const supplements = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .filter((_, i) => i % 2 === 1)
        .map((r) => r[1]!.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "")
        .map((v) =>
          v
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/\s+/g, " ")
            .trim(),
        );
      console.log(
        JSON.stringify({
          usageShapes: supplements.map((v) => ({
            empty: v === "",
            dash: v === "-",
            currencyFirst: /^[A-Z]{3}[\s:]*[+\-△▲]?[\d,]+(?:\.\d+)?$/.test(v),
            amountFirst: /^[+\-△▲]?[\d,]+(?:\.\d+)?[\s:]*[A-Z]{3}$/.test(v),
            japaneseYen: v.includes("円"),
            parenthesis: /[()（）]/.test(v),
            numericOnly: /^[+\-△▲]?[\d,]+(?:\.\d+)?$/.test(v),
          })),
        }),
      );
      const rows = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
        [...r[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
          c[1]!
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/\s+/g, " ")
            .trim(),
        ),
      );
      console.log(
        JSON.stringify({
          feeShapes: rows
            .flatMap((row, i) => (i % 2 === 0 ? row.slice(3, 6) : row.slice(1, 2)))
            .map((v) => ({
              empty: v === "",
              dash: v === "-",
              currencyFirst: /^[A-Z]{3}[\s:]*[+\-△▲]?[\d,]+(?:\.\d+)?$/.test(v),
              amountFirst: /^[+\-△▲]?[\d,]+(?:\.\d+)?[\s:]*[A-Z]{3}$/.test(v),
              japaneseYen: v.includes("円"),
              parenthesis: /[()（）]/.test(v),
              numericOnly: /^[+\-△▲]?[\d,]+(?:\.\d+)?$/.test(v),
              percent: v.includes("%"),
            })),
        }),
      );
    }
    if (row.dataset?.endsWith("-csv"))
      console.log(
        JSON.stringify({
          artifact: row.id,
          invalidRateCategories: [
            ...new Set(
              parseCsv(new TextDecoder("shift_jis").decode(bytes))
                .slice(1)
                .filter((r) => r.length > 1 && !decimalText(r[7]))
                .map((r) => (r[7] === "" ? "empty" : r[7] === "-" ? "dash" : "other")),
            ),
          ],
        }),
      );
    if (row.source_id === "sbi-shinsei-bank") {
      const wrapper = JSON.parse(text).responseParam?.overview;
      const code = wrapper?.errorInfo?.statusID;
      const message = String(wrapper?.errorInfo?.statusMessage ?? "");
      console.log(
        JSON.stringify({
          artifact: row.id,
          explicitSuccessCode: code === "00000",
          exactSuccess: message.toLowerCase() === "success",
        }),
      );
    }
    const message = error instanceof Error ? error.message : "";
    const labels = [
      "media type",
      "unknown field",
      "missing field",
      "expected an object",
      "expected an array",
      "cardinality",
      "response was not successful",
      "window",
      "encoding",
      "date",
      "schema",
      "balance",
      "unsupported",
    ];
    const category = labels.find((label) => message.toLowerCase().includes(label)) ?? "other";
    const field = message.match(/(?:unknown|missing) field ([A-Za-z][A-Za-z0-9_]{0,60})$/)?.[1];
    const sites =
      error instanceof Error
        ? [...(error.stack ?? "").matchAll(/parsers\/([a-z0-9-]+\.ts:\d+:\d+)/g)].map((m) => m[1])
        : [];
    console.log(
      JSON.stringify({
        artifact: row.id,
        parser: parser.name,
        result: "rejected",
        category,
        sites,
        ...(field ? { field } : {}),
      }),
    );
  }
}
