// Read stored, checksum-verified captures only. No source network requests,
// raw text, account identifiers, amounts or HTML are logged or written.
import { getPlatformProxy } from "wrangler";
import { parse } from "parse5";
import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types.ts";
type Node = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
};
const proxy = await getPlatformProxy<{ DB: D1Database; EVIDENCE: R2Bucket }>({
  configPath: new URL("../wrangler.diagnostic.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
const parser = PARSERS.find((p) => p.name === "global-pass-activity")!;
try {
  const { results } =
    await proxy.env.DB.prepare(`SELECT a.*,o.blob_key,o.byte_size FROM observation_fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256
 JOIN observation_parse_jobs j ON j.fetch_artifact_id=a.id WHERE j.parser_name='global-pass-activity' AND j.parser_version='1.0.0' AND j.last_error_code IS NOT NULL ORDER BY a.id`).all<{
      id: number;
      artifact_key: string;
      fetched_at: string;
      mime: string;
      dataset: string;
      sha256: string;
      blob_key: string;
      byte_size: number;
    }>();
  const summaries: Record<string, number> = {};
  let representativePrinted = false;
  for (const row of results) {
    if (row.byte_size > 2 * 1024 * 1024) throw new Error("diagnostic bound");
    const object = await proxy.env.EVIDENCE.get(row.blob_key);
    if (!object) throw new Error("missing object");
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== row.sha256 || bytes.length !== row.byte_size)
      throw new Error("integrity failure");
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dom = parse(html) as Node;
    const nodes: Node[] = [];
    const walk = (node: Node) => {
      nodes.push(node);
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(dom);
    const attr = (node: Node, name: string) =>
      node.attrs?.find((a) => a.name === name)?.value ?? "";
    const tables = nodes.filter((n) => n.nodeName === "table").length;
    const passwords = nodes.filter(
      (n) => n.nodeName === "input" && attr(n, "type").toLowerCase() === "password",
    ).length;
    const turnstile = nodes.some(
      (n) =>
        attr(n, "class").split(/\s+/).includes("cf-turnstile") ||
        attr(n, "src").includes("challenges.cloudflare.com"),
    );
    const errorMarkers = nodes.filter(
      (n) =>
        ["alert", "error", "error-message", "errorMessage", "error_message"].includes(
          attr(n, "role"),
        ) ||
        attr(n, "class")
          .split(/\s+/)
          .some((c) => ["error", "error-message", "errorMessage", "error_message"].includes(c)),
    ).length;
    const selectCount = nodes.filter((n) => n.nodeName === "select").length;
    const meta: ArtifactMeta = {
      id: row.id,
      sourceId: "global-pass",
      dataset: row.dataset,
      artifactKey: row.artifact_key,
      mime: row.mime,
      sha256: row.sha256,
      fetchedAt: row.fetched_at,
      url: null,
      runStatus: "success",
      runFailureCount: 0,
    };
    let reason = "parsed";
    try {
      parser.parse(bytes, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const codePhrases = [
        "contains an unclassified table",
        "activity table cardinality drift",
        "source-view row cardinality drift",
        "activity row cardinality drift",
        "date cardinality drift",
        "outside the selected month",
        "source views disagree on amount text",
        "transaction dates are not in provider ascending order",
        "transaction amount format drift",
        "signed amount is not exactly representable",
        "header schema drift",
        "schema is missing",
        "header/value cardinality drift",
        "value cardinality drift",
        "must have exactly three fee fields",
        "month selector",
        "artifact key and selected month disagree",
      ];
      reason = codePhrases.find((p) => message.includes(p)) ?? "unclassified_parser_check";
    }
    const summary = {
      reason,
      tables,
      passwordInputs: passwords,
      turnstile,
      errorMarkers,
      selectCount,
    };
    if (tables > 0) {
      const tableShapes = nodes
        .filter((n) => n.nodeName === "table")
        .map((table) => {
          const owned: Node[] = [];
          const visit = (node: Node) => {
            owned.push(node);
            for (const child of node.childNodes ?? []) if (child.nodeName !== "table") visit(child);
          };
          visit(table);
          const headings = owned.filter((n) => n.nodeName === "th");
          return {
            headers: headings.length,
            unexpectedHeaderCount: ![12, 4, 10].includes(headings.length),
            rows: owned.filter((n) => n.nodeName === "tr").length,
            cells: owned.filter((n) => n.nodeName === "td").length,
            inputs: owned.filter((n) => n.nodeName === "input").length,
          };
        });
      console.log(JSON.stringify({ nonemptyRejectedShape: tableShapes }));
    }
    const key = JSON.stringify(summary);
    summaries[key] = (summaries[key] ?? 0) + 1;
    if (tables === 0 && !representativePrinted) {
      representativePrinted = true;
      const contentText = (node: Node): string =>
        (node.value ?? "") + (node.childNodes ?? []).map(contentText).join("");
      const informationMessages = nodes
        .filter((n) => attr(n, "class").split(/\s+/).includes("informationMsg"))
        .map((n) => contentText(n).trim());
      console.log(
        JSON.stringify({
          zeroTableTemplate: {
            informationMessageCount: informationMessages.length,
            nonemptyInformationMessages: informationMessages.filter(Boolean).length,
            forms: nodes.filter((n) => n.nodeName === "form").length,
          },
        }),
      );
    }
  }
  console.log(
    JSON.stringify({
      verifiedArtifacts: results.length,
      categories: Object.entries(summaries).map(([key, count]) => ({ ...JSON.parse(key), count })),
    }),
  );
} finally {
  await proxy.dispose();
}
