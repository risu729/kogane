import { expect, test } from "bun:test";
import { collectCredit, type CreditReadClient } from "../src/credit";
import { creditDocumentOffers } from "../src/documents";
import { creditMenu } from "./synthetic-myjcb";
import { creditExportBytes } from "../../../packages/parsers/test/myjcb-document-fixture";
import { myJcbRunPlan } from "../src/shared-collection";
import type { ReadResponse } from "../src/client";
import { StopConditionError } from "../src/types";
const response = (body: string | Uint8Array): ReadResponse => ({
  url: new URL("https://my.jcb.co.jp/"),
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: (typeof body === "string" ? new TextEncoder().encode(body) : Uint8Array.from(body)).buffer,
});
function syntheticClient(deny = false): { client: CreditReadClient; reads: string[] } {
  const reads: string[] = [];
  const months = [0, 1, 12, 15];
  return {
    reads,
    client: {
      get: async (operation, query) => {
        const position = Number(query?.get("detailMonth"));
        reads.push(`${operation}:${position}`);
        if (operation === "credit-menu") return response(creditMenu([0, 1]));
        if (operation !== "credit-detail") {
          if (deny)
            throw Object.assign(new StopConditionError("synthetic denial"), { httpStatus: 429 });
          if (operation === "credit-csv" && position === 1)
            return response("<html>synthetic unsupported file</html>");
          return response(
            creditExportBytes(
              operation === "credit-csv" ? "csv" : operation === "credit-pdf" ? "pdf" : "ofx",
            ),
          );
        }
        if (!months.includes(position)) throw new Error("invented position");
        const exports =
          position === 0
            ? ""
            : ["csv", "pdf", "money"]
                .map(
                  (output) =>
                    `<a href="${output === "pdf" ? "detailDbPdf" : "detail"}.html?detailMonth=${position}&amp;output=${output}">file</a>`,
                )
                .join("");
        return response(
          `<html><body><h1>カードご利用代金明細(${position === 0 ? "未確定分" : "確定分"})</h1><h2>2098年${months.indexOf(position) + 1}月お支払い分のカードご利用明細</h2><input name="generalJsonShikibetuId" value="synthetic">${exports}<div class="detail-list-01"><div class="head">ご利用日 ご利用先など 支払区分 ${position === 0 ? "ご利用金額" : "今回のお支払い金額"}</div></div></body></html>`,
        );
      },
      postCreditPastJson: async () =>
        response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "030100601",
            result: {
              errId: "0",
              errMessage: "",
              detailPastJsonInfo: [12, 15].map((month) => ({
                detailMonth: String(month),
                detailAvailableFlag: true,
              })),
            },
          }),
        ),
    },
  };
}
test("malformed CSV preserves healthy PDF, OFX, page and later sparse months as independent evidence", async () => {
  const { client, reads } = syntheticClient();
  const result = await collectCredit(client, "synthetic", { exports: "fetch" });
  expect(result.stop).toBeUndefined();
  expect(result.periodCount).toBe(4);
  expect(result.documentResults).toHaveLength(9);
  expect(result.documentResults.filter((doc) => doc.code === "unavailable")).toEqual([
    { period: "2098-02", kind: "csv", code: "unavailable" },
  ]);
  expect(result.artifacts.filter((a) => a.dataset === "credit-detail")).toHaveLength(4);
  expect(result.artifacts.filter((a) => a.dataset === "credit-pdf")).toHaveLength(3);
  expect(reads.filter((read) => read.startsWith("credit-csv:"))).toEqual([
    "credit-csv:1",
    "credit-csv:12",
    "credit-csv:15",
  ]);
  const plan = await myJcbRunPlan({
    schemaVersion: "synthetic",
    runId: "synthetic-documents",
    startedAt: "2098-05-01T00:00:00Z",
    completedAt: "2098-05-01T00:01:00Z",
    status: "partial",
    trigger: "manual",
    failures: [],
    connections: [
      {
        summary: {
          connectionId: "synthetic",
          bootstrapMode: "session",
          status: "success",
          cardCount: 1,
          periodCount: result.periodCount,
          artifactCount: result.artifacts.length,
          exportOffers: result.exportOffers,
          documentResults: result.documentResults,
        },
        artifacts: result.artifacts,
      },
    ],
  });
  expect(plan.run.units.find((unit) => unit.unitKey === "synthetic")).toMatchObject({
    coverageStatus: "complete",
  });
  expect(
    plan.run.units.filter(
      (unit) => unit.unitKind === "statement-document" && unit.coverageStatus === "complete",
    ),
  ).toHaveLength(8);
  expect(
    plan.run.units.find((unit) => unit.unitKey === "synthetic:document:credit:2098-02:csv"),
  ).toMatchObject({ coverageStatus: "unknown", artifactCount: 0 });
  const pdf = plan.artifacts.find(
    (a) => a.artifactKey === "synthetic/credit-document-2098-02.pdf",
  )!;
  expect(pdf.unitKey).toBe("synthetic:document:credit:2098-02:pdf");
  expect(pdf.body).toEqual({ kind: "bytes", bytes: creditExportBytes("pdf") });
});
test("session-wide export denial stops subsequent reads while preserving the valid current statement", async () => {
  const { client, reads } = syntheticClient(true);
  const result = await collectCredit(client, "synthetic", { exports: "fetch" });
  expect(result.stop).toMatchObject({ code: "export_fetch", position: 1 });
  expect(result.artifacts.some((a) => a.filename === "credit-detail-01.html")).toBe(true);
  expect(reads).not.toContain("credit-detail:12");
  expect(reads).not.toContain("credit-pdf:1");
});
test("active export offers require exact observed query membership", () => {
  const link = (href: string) => `<a href="${href}">PDF</a>`;
  expect(creditDocumentOffers(link("detail.html?detailMonth=2&amp;output=csv"), 2).kinds).toEqual([
    "csv",
  ]);
  for (const href of [
    "detail.html?output=csv",
    "detail.html?detailMonth=2&amp;detailMonth=1&amp;output=csv",
    "detail.html?detailMonth=2&amp;output=csv&amp;token=synthetic",
    "https://example.invalid/iss-pc/member/details_inquiry/detail.html?detailMonth=2&amp;output=csv",
  ])
    expect(creditDocumentOffers(link(href), 2).unavailableKinds).toEqual(["csv"]);
  expect(creditDocumentOffers(link("detailNewspdf.html"), 2)).toEqual({
    kinds: [],
    unavailableKinds: [],
  });
});

test("one shared run budget admits an exact-boundary original and skips exports across later connections", async () => {
  const budget = { remainingBytes: creditExportBytes("pdf").byteLength };
  const first = syntheticClient();
  const captured = await collectCredit(first.client, "synthetic", {
    exports: "fetch",
    documentBudget: budget,
  });
  expect(budget.remainingBytes).toBe(0);
  expect(captured.documentResults.filter((doc) => doc.code === "collected")).toEqual([
    { period: "2098-02", kind: "pdf", code: "collected" },
  ]);
  expect(first.reads).not.toContain("credit-ofx:1");
  expect(first.reads).not.toContain("credit-pdf:12");
  expect(captured.artifacts.filter((a) => a.dataset === "credit-detail")).toHaveLength(4);
  const second = syntheticClient();
  const later = await collectCredit(second.client, "synthetic", {
    exports: "fetch",
    documentBudget: budget,
  });
  expect(second.reads.filter((read) => /^credit-(?:csv|pdf|ofx):/u.test(read))).toEqual([]);
  expect(later.artifacts.filter((a) => a.dataset === "credit-detail")).toHaveLength(4);
  expect(later.documentResults.every((doc) => doc.code === "budget_exhausted")).toBe(true);
});

test("an API-labelled past position cannot supply a missing document page month", async () => {
  const reads: string[] = [];
  const result = await collectCredit(
    {
      get: async (operation) => {
        reads.push(operation);
        if (operation === "credit-menu") return response(creditMenu([12]));
        if (operation !== "credit-detail") throw new Error("unproven export fetch");
        return response(
          '<html><body><h1>カードご利用代金明細(確定分)</h1><input name="generalJsonShikibetuId" value="synthetic"><a href="detailDbPdf.html?detailMonth=12&amp;output=pdf">PDF</a><div class="detail-list-01"><div class="head">ご利用日 ご利用先など 支払区分 今回のお支払い金額</div></div></body></html>',
        );
      },
      postCreditPastJson: async () =>
        response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "030100601",
            result: {
              errId: "0",
              errMessage: "",
              detailPastJsonInfo: [
                { detailMonth: "12", detailAvailableFlag: true, settlementYM: "209801" },
              ],
            },
          }),
        ),
    },
    "synthetic",
    { exports: "fetch" },
  );
  expect(result.stop).toBeUndefined();
  expect(result.unreadMonths).toEqual([]);
  expect(result.documentCode).toBe("partial");
  expect(result.documentResults).toEqual([]);
  expect(result.artifacts.find((a) => a.dataset === "credit-ledger")).toMatchObject({
    period: "209801",
  });
  expect(result.artifacts.find((a) => a.dataset === "credit-detail")).toMatchObject({
    period: "209801",
  });
  expect(reads).not.toContain("credit-pdf");
});

test("a malformed CSV offer preserves independently valid PDF and OFX offers", async () => {
  const { client, reads } = syntheticClient();
  const result = await collectCredit(
    {
      ...client,
      get: async (operation, query, options) => {
        const value = await client.get(operation, query, options);
        if (operation !== "credit-detail" || query?.get("detailMonth") !== "1") return value;
        const html = new TextDecoder()
          .decode(value.body)
          .replace(
            "detailMonth=1&amp;output=csv",
            "detailMonth=1&amp;output=csv&amp;token=synthetic",
          );
        return response(html);
      },
    },
    "synthetic",
    { exports: "fetch" },
  );
  expect(result.stop).toBeUndefined();
  expect(result.documentCode).toBe("partial");
  expect(result.documentResults.filter((doc) => doc.period === "2098-02")).toEqual([
    { period: "2098-02", kind: "csv", code: "unavailable" },
    { period: "2098-02", kind: "pdf", code: "collected" },
    { period: "2098-02", kind: "ofx", code: "collected" },
  ]);
  expect(reads).not.toContain("credit-csv:1");
  expect(reads).toContain("credit-pdf:1");
  expect(reads).toContain("credit-ofx:1");
  expect(reads).toContain("credit-detail:15");
});
