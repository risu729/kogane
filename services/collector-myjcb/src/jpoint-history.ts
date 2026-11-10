import { parse } from "parse5";
import { readMyJcbJPointResponse } from "../../../packages/domain/src/myjcb-jpoint-response";
import { normalizeJPointHistoryHtml } from "../../../packages/parsers/src/parsers/myjcb-jpoint-history-html";
import { decodeMyJcbHtml, type MyJcbReadClient, type ReadResponse } from "./client";
import { isObservedJPointProduct } from "./jpoint";
import { redactedStatementHtml } from "./parsers";
import { allowedUrl } from "./policy";
import type { JPointCollectionCode, RawArtifact } from "./types";

function html(response: ReadResponse): string {
  if (!/^text\/html(?:;|$)/iu.test(response.contentType))
    throw new Error("myjcb_jpoint_history_html_mime_unsupported");
  return decodeMyJcbHtml(response.body, response.contentType);
}
function offersHistory(input: string): boolean {
  const document = parse(input);
  const target = allowedUrl("jpoint-history").href;
  const base = allowedUrl("jpoint-inquiry", new URLSearchParams({ link_id: "myj_main_pointInquiry" }));
  let found = 0;
  const visit = (node: (typeof document)["childNodes"][number]): void => {
    if ("tagName" in node && node.tagName === "a") {
      const href = node.attrs.find((a) => a.name === "href")?.value;
      if (href) { try { if (new URL(href, base).href === target) found++; } catch { /* Not an offered read route. */ } }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  for (const child of document.childNodes) visit(child);
  return found > 0;
}
/** Reuse this run's already fetched total; no second JSON request or card switch. */
export async function collectJPointHistory(
  client: Pick<MyJcbReadClient, "get">,
  mypageHtml: string,
  pointArtifacts: readonly RawArtifact[],
): Promise<{ code: JPointCollectionCode; artifacts: RawArtifact[] }> {
  if (!isObservedJPointProduct(mypageHtml)) return { code: "unsupported", artifacts: [] };
  const artifacts: RawArtifact[] = [];
  try {
    const balance = pointArtifacts.find((a) => a.dataset === "jpoint-balance");
    if (!balance) return { code: "unavailable", artifacts };
    const value = JSON.parse(typeof balance.body === "string" ? balance.body : new TextDecoder("utf-8", { fatal: true }).decode(balance.body));
    const total = readMyJcbJPointResponse(value).result.pointJsonInfo.totalPointInfo;
    if (!total.pointDispFlag || !/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/u.test(total.point))
      return { code: "unavailable", artifacts };
    const inquiry = html(await client.get("jpoint-inquiry", new URLSearchParams({ link_id: "myj_main_pointInquiry" })));
    artifacts.push({ dataset: "jpoint-inquiry", filename: "jpoint-inquiry.html",
      mediaType: "text/html; charset=utf-8", body: redactedStatementHtml(inquiry) });
    if (!offersHistory(inquiry)) return { code: "unavailable", artifacts };
    const raw = html(await client.get("jpoint-history"));
    const sanitized = redactedStatementHtml(raw);
    artifacts.push({ dataset: "jpoint-history-html", filename: "jpoint-history.html",
      mediaType: "text/html; charset=utf-8", body: sanitized });
    // Validate original closures before the sanitizer serializes a repaired
    // DOM. The retained, sanitized bytes must describe the identical measures.
    const normalized = normalizeJPointHistoryHtml(raw, BigInt(total.point.replaceAll(",", "")).toString());
    if (JSON.stringify(normalizeJPointHistoryHtml(sanitized, normalized.reportedTotal)) !== JSON.stringify(normalized))
      return { code: "unavailable", artifacts };
    artifacts.push({ dataset: "jpoint-history", filename: "jpoint-history.json",
      mediaType: "application/json", body: JSON.stringify(normalized) });
    return { code: "collected", artifacts };
  } catch {
    return { code: "unavailable", artifacts };
  }
}
