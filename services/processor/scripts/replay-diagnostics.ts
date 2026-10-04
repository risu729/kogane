// Read-only: fetch selected failed objects into memory, emit structural error
// categories only. Never log raw payloads or provider error strings.
//
//   bun services/processor/scripts/replay-diagnostics.ts [parser] [maxReplays] [artifactId]
//   bun services/processor/scripts/replay-diagnostics.ts globalpass-activity[@version] [maxReplays] [artifactId]
//
// `parser` is an exact registered parser name (filtered in SQL) or, as before,
// a substring of one. `globalpass-activity` selects the stored GLOBAL PASS
// activity pages whose latest `global-pass-activity` parse (of `version`, when
// given) was rejected, newest fetch run first (`globalPassReplaySelectionSql`),
// and prints each refused page's counts-only shape. Every wrangler call is a
// D1 SELECT or an R2 object read
// through `wrangler.diagnostic.jsonc`; nothing is written anywhere. Each
// rejection prints its closed category (scripts/parser-rejection.ts) and the
// last line is a count per category.
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";
import { parseCsv } from "../../../packages/parsers/src/parsers/util.ts";
import { decimalText } from "../../../packages/parsers/src/parsers/util.ts";
import {
  classifyParserRejection,
  GLOBAL_PASS_ACTIVITY_PARSER,
  GLOBAL_PASS_SELECTION,
  globalPassActivityShape,
  globalPassReplaySelectionSql,
  replaySelectionSql,
  replayStatementMetadata,
  skipScheduleShape,
  throwSites,
  topActivityShape,
} from "./parser-rejection.ts";
const cli = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const processorDir = new URL("..", import.meta.url).pathname;
async function command(args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["node", cli, ...args, "--config", "wrangler.diagnostic.jsonc"], {
    cwd: processorDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).bytes();
  if ((await child.exited) !== 0) throw new Error("read-only command failed");
  return output;
}
const parserArgument = process.argv[2] || undefined;
const versionAt = (parserArgument ?? "").indexOf("@");
const selectionName = versionAt < 0 ? parserArgument : parserArgument!.slice(0, versionAt);
const sql =
  selectionName === GLOBAL_PASS_SELECTION
    ? globalPassReplaySelectionSql(
        versionAt < 0 ? {} : { version: parserArgument!.slice(versionAt + 1) },
      )
    : replaySelectionSql(
        parserArgument === undefined
          ? {}
          : PARSERS.some((parser) => parser.name === parserArgument)
            ? { parser: parserArgument }
            : { substring: parserArgument },
      );
const result = JSON.parse(
  new TextDecoder().decode(
    await command(["d1", "execute", "kogane-raw-evidence", "--remote", "--command", sql, "--json"]),
  ),
);
const summary: Record<string, number> = {};
const selected: number = result[0].results.length;
let parsedCount = 0;
let replayed = 0;
const maxReplays = Math.max(1, Math.min(50, Number(process.argv[3]) || 1));
for (const row of result[0].results) {
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
    // As the processor's artifactMeta: the lane already admitted the artifact,
    // so a run that is not a clean success was admitted by its unit.
    runStatus: row.run_status,
    runFailureCount: row.run_failure_count,
    unitScopeEligibility:
      row.run_status === "success" && row.run_failure_count === 0 ? null : "unit-independent-v1",
    // What the processor handed the parser: for MyJCB, the newest metadata
    // projection; otherwise the artifact row, as before.
    ...replayStatementMetadata(row),
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
    parsedCount++;
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
    if (row.dataset === "top-accounts-balance-and-activity")
      console.log(JSON.stringify({ artifact: row.id, shape: topActivityShape(bytes) }));
    if (row.parser_name === "myjcb-skip-payment-schedule")
      console.log(JSON.stringify({ artifact: row.id, shape: skipScheduleShape(bytes) }));
    if (row.parser_name === GLOBAL_PASS_ACTIVITY_PARSER)
      console.log(
        JSON.stringify({
          artifact: row.id,
          shape: globalPassActivityShape(bytes, row.artifact_key),
        }),
      );
    const category = classifyParserRejection(parser.name, error);
    const key = JSON.stringify([parser.name, category]);
    summary[key] = (summary[key] ?? 0) + 1;
    const sites = throwSites(error);
    console.log(
      JSON.stringify({
        artifact: row.id,
        parser: parser.name,
        result: "rejected",
        category,
        sites,
      }),
    );
  }
}
console.log(
  JSON.stringify({
    selected,
    replayed: Math.min(replayed, maxReplays),
    parsed: parsedCount,
    rejected: Object.entries(summary).map(([key, count]) => {
      const [parser, category] = JSON.parse(key) as [string, unknown];
      return { parser, category, count };
    }),
  }),
);
