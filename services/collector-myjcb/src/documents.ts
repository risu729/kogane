import type { MyJcbExportKind } from "../../../packages/domain/src/myjcb-statement-export";
import { validateMyJcbCreditExport } from "../../../packages/domain/src/myjcb-statement-export";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { CreditReadClient } from "./credit";
import { assertAllowedRequest, MYJCB_ORIGIN } from "./policy";
import type { RawArtifact } from "./types";

export interface StatementDocumentResult {
  readonly period: string;
  readonly kind: MyJcbExportKind;
  readonly code: "collected" | "unavailable" | "budget_exhausted";
}
/** One request-scoped budget is shared across every connection in a Worker run. */
export interface DocumentBudget {
  remainingBytes: number;
}
export const MAX_DOCUMENT_RUN_BYTES = 32 * 1024 * 1024;
export const documentBudget = (): DocumentBudget => ({ remainingBytes: MAX_DOCUMENT_RUN_BYTES });

export function documentFilename(period: string, kind: MyJcbExportKind): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new Error("myjcb_document_period_invalid");
  return `credit-document-${period}.${kind}`;
}
export function documentUnitKey(connection: string, period: string, kind: MyJcbExportKind): string {
  documentFilename(period, kind);
  return `${connection}:document:credit:${period}:${kind}`;
}

/** Only exact observed hrefs authorize requests; unrelated PDF labels do not. */
export function creditDocumentOffers(html: string, position: number): MyJcbExportKind[] {
  const found = new Set<MyJcbExportKind>();
  const visit = (node: DefaultTreeAdapterMap["node"]): void => {
    if ("tagName" in node && node.tagName === "a") {
      const href = node.attrs.find((attr) => attr.name === "href")?.value;
      if (href !== undefined) {
        let url: URL;
        try {
          url = new URL(href, `${MYJCB_ORIGIN}/iss-pc/member/details_inquiry/detail.html`);
        } catch {
          return;
        }
        const kind =
          url.pathname === "/iss-pc/member/details_inquiry/detailDbPdf.html"
            ? "pdf"
            : url.pathname === "/iss-pc/member/details_inquiry/detail.html" &&
                url.searchParams.get("output") === "csv"
              ? "csv"
              : url.pathname === "/iss-pc/member/details_inquiry/detail.html" &&
                  url.searchParams.get("output") === "money"
                ? "ofx"
                : undefined;
        if (kind !== undefined) {
          const operation =
            kind === "csv" ? "credit-csv" : kind === "pdf" ? "credit-pdf" : "credit-ofx";
          if (
            url.hash ||
            url.username ||
            url.password ||
            url.searchParams.get("detailMonth") !== String(position)
          )
            throw new Error("myjcb_document_offer_unsupported");
          assertAllowedRequest(operation, "GET", url);
          found.add(kind);
        }
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(html));
  return [...found];
}

export async function fetchCreditDocument(
  client: CreditReadClient,
  position: number,
  period: string,
  kind: MyJcbExportKind,
  remainingBytes: number,
): Promise<RawArtifact> {
  const filename = documentFilename(period, kind);
  const operation = kind === "csv" ? "credit-csv" : kind === "pdf" ? "credit-pdf" : "credit-ofx";
  const output = kind === "csv" ? "csv" : kind === "pdf" ? "pdf" : "money";
  const response = await client.get(
    operation,
    new URLSearchParams({ detailMonth: String(position), output }),
    { maxResponseBytes: Math.min(8 * 1024 * 1024, remainingBytes) },
  );
  if (response.body.byteLength > remainingBytes)
    throw new Error("myjcb_statement_export_budget_exhausted");
  validateMyJcbCreditExport(kind, new Uint8Array(response.body));
  return {
    dataset: `credit-${kind}`,
    filename,
    body: response.body,
    mediaType:
      kind === "csv"
        ? "text/csv; charset=windows-31j"
        : kind === "pdf"
          ? "application/pdf"
          : "application/x-ofx; charset=utf-8",
    statementState: "confirmed",
    period,
  };
}
