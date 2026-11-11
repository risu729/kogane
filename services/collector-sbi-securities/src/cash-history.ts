import { sha256Hex } from "../../../packages/collection/src/digest";
import {
  CASH_HISTORY_SCHEMA,
  CASH_HISTORY_PAGE_SIZE,
  CashHistoryError,
  auditCashHistoryPage,
  cashPageMetadata,
  cashRetentionRange,
  parseCashHistoryJson,
  validateCashHistory,
  type CashHistoryKind,
} from "../../../packages/parsers/src/parsers/sbi-cash-history-schema";
import type { Artifact } from "./types";

export const cashDataset = (kind: CashHistoryKind) =>
  kind === "yen" ? "yen-detail-history" : "foreign-cash-history";
export const cashSourceKey = (kind: CashHistoryKind, pageNumber: number) =>
  `${cashDataset(kind)}-page-${String(pageNumber).padStart(4, "0")}-source.json`;

/** Ten-row response pages are bounded before buffering their original bytes. */
export async function readCashHistoryResponse(response: Response): Promise<Uint8Array> {
  const limit = 256 * 1024;
  if (Number(response.headers.get("content-length")) > limit)
    throw new CashHistoryError("sbi_cash_history_schema");
  if (response.body === null) throw new CashHistoryError("sbi_cash_history_schema");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CashHistoryError("sbi_cash_history_schema");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Every page is retained immediately, including evidence from a failed chain. */
export async function collectCashHistory(options: {
  kind: CashHistoryKind;
  today: string;
  fetchPage: (range: { from: string; to: string }, pageNumber: number) => Promise<Uint8Array>;
  retain: (artifact: Artifact) => void;
}): Promise<void> {
  const range = cashRetentionRange(options.today, options.kind);
  const pages: Record<string, unknown>[] = [];
  let pageCount = 1;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const bytes = await options.fetchPage(range, pageNumber);
    const body = parseCashHistoryJson(new TextDecoder().decode(bytes));
    auditCashHistoryPage(body, options.kind);
    // Retain only closed-schema financial responses, before coverage checks.
    options.retain({
      artifactKey: cashSourceKey(options.kind, pageNumber),
      dataset: `${cashDataset(options.kind)}-page-source`,
      role: "provider_response",
      mediaType: "application/json",
      bytes,
      body: null,
    });
    const metadata = cashPageMetadata(body, options.kind, pageNumber);
    if (options.kind === "foreign" && metadata.pageCount > 1)
      throw new CashHistoryError("sbi_foreign_cash_pagination_unobserved");
    if (pageNumber === 1) pageCount = Math.max(1, metadata.pageCount);
    pages.push(metadata.page);
  }
  const body = validateCashHistory(
    {
      schemaVersion: CASH_HISTORY_SCHEMA,
      kind: options.kind,
      requestedRange: range,
      pageSize: CASH_HISTORY_PAGE_SIZE,
      totalCount: pages[0]!["totalCount"],
      pages,
    },
    options.kind,
  );
  options.retain({
    dataset: cashDataset(options.kind),
    mediaType: "application/json",
    body,
    inputArtifactKeys: pages.map((_, index) => cashSourceKey(options.kind, index + 1)),
    window: range,
  });
}

/** A caller cannot seal a complete unit from missing or changed page inputs. */
export async function cashHistoryInventoryComplete(
  artifacts: readonly Artifact[],
): Promise<boolean> {
  try {
    for (const kind of ["yen", "foreign"] as const) {
      const dataset = cashDataset(kind);
      const sources = artifacts.filter((a) => a.dataset === `${dataset}-page-source`);
      const bundles = artifacts.filter(
        (a) =>
          a.dataset === dataset &&
          typeof a.body === "object" &&
          a.body !== null &&
          (a.body as Record<string, unknown>)["schemaVersion"] === CASH_HISTORY_SCHEMA,
      );
      if (sources.length === 0 && bundles.length === 0) continue;
      if (bundles.length !== 1) return false;
      const bundleArtifact = bundles[0]!;
      const bundle = validateCashHistory(bundleArtifact.body, kind);
      const keys = bundle.pages.map((_, i) => cashSourceKey(kind, i + 1));
      if (
        sources.length !== keys.length ||
        JSON.stringify(bundleArtifact.inputArtifactKeys) !== JSON.stringify(keys) ||
        bundleArtifact.bytes !== undefined ||
        bundleArtifact.role !== undefined ||
        JSON.stringify(bundleArtifact.window) !== JSON.stringify(bundle.requestedRange)
      )
        return false;
      for (const [index, key] of keys.entries()) {
        const found = sources.filter((a) => a.artifactKey === key);
        if (
          found.length !== 1 ||
          found[0]!.role !== "provider_response" ||
          found[0]!.bytes === undefined
        )
          return false;
        const raw = parseCashHistoryJson(new TextDecoder().decode(found[0]!.bytes));
        if (
          (await sha256Hex(new TextEncoder().encode(JSON.stringify(raw)))) !==
          (await sha256Hex(new TextEncoder().encode(JSON.stringify(bundle.pages[index]))))
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
