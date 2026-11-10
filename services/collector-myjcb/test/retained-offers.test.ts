import { expect, test } from "bun:test";
import { collectCredit, type CreditReadClient } from "../src/collector";
import { creditMenu } from "./synthetic-myjcb";
import { myJcbRunPlan } from "../src/shared-collection";
import type { ReadResponse } from "../src/client";
const response = (body: string, contentType = "text/html; charset=utf-8"): ReadResponse => ({
  url: new URL("https://my.jcb.co.jp/"), status: 200, contentType, body: new TextEncoder().encode(body).buffer,
});
test("walks only offered sparse statement positions and separate schedules, retaining finalised offers without downloading bytes", async () => {
  const reads: string[] = [];
  const months = [0, 1, 2, 3, 4, 5, 6, 12, 15];
  const client: CreditReadClient = {
    get: async (operation, query) => {
      reads.push(`${operation}:${query?.get("detailMonth") ?? ""}`);
      if (operation === "credit-menu") return response(creditMenu([0, 1, 2, 3, 4, 5, 6], [7, 8]));
      if (operation !== "credit-detail") throw new Error("unverified file request");
      const position = Number(query?.get("detailMonth"));
      if (position === 7 || position === 8)
        return response("<html><body><h1>ボーナス払いお支払い予定明細</h1></body></html>");
      if (!months.includes(position)) throw new Error("invented month position");
      const period = `2098年${months.indexOf(position) + 1}月`;
      const heading = position === 0 ? "カードご利用代金明細(未確定分)" : "カードご利用代金明細(確定分)";
      const exports = position === 1 ? '<a href="detailDbPdf.html?detailMonth=1&amp;output=pdf">PDF形式</a><a href="detail.html?detailMonth=1&amp;output=csv">CSV</a><a href="detail.html?detailMonth=1&amp;output=money">OFX</a><a href="/newsletter.pdf">PDF形式</a>' : "";
      return response(`<html><body><h1>${heading}</h1><h2>${period}お支払い分のカードご利用明細</h2><input name="generalJsonShikibetuId" value="synthetic-discriminator">${exports}<div class="detail-list-01"><div class="head">ご利用日 ご利用先など 支払区分 ${position === 0 ? "ご利用金額" : "今回のお支払い金額"}</div></div></body></html>`);
    },
    postCreditPastJson: async () => response(JSON.stringify({
      jsonrpc: "2.0", id: "030100601", result: { errId: "0", errMessage: "", detailPastJsonInfo: [
        { detailMonth: "12", detailAvailableFlag: true }, { detailMonth: "15", detailAvailableFlag: true },
      ] },
    }), "application/json"),
  };
  const result = await collectCredit(client, "myj_main_detailMenu");
  expect(result.stop).toBeUndefined();
  expect(result.periodCount).toBe(months.length);
  expect(result.exportOffers).toEqual([{ position: 1, kinds: ["pdf", "csv", "ofx"] }]);
  expect(reads.filter((r) => r.startsWith("credit-detail:")).sort()).toEqual([...months, 7, 8].map((n) => `credit-detail:${n}`).sort());
  expect(result.artifacts.some((a) => /^credit-(?:pdf|csv|ofx)$/u.test(a.dataset))).toBe(false);
  const plan = await myJcbRunPlan({ schemaVersion: "myjcb-worker-poc-v1", runId: "synthetic-offers",
    startedAt: "2099-01-01T00:00:00Z", completedAt: "2099-01-01T00:01:00Z", status: "success", trigger: "manual",
    failures: [], connections: [{ summary: { connectionId: "synthetic", bootstrapMode: "session", status: "success",
      cardCount: 1, periodCount: result.periodCount, artifactCount: result.artifacts.length, exportOffers: result.exportOffers },
      artifacts: result.artifacts }] });
  expect(plan.run.units.find((u) => u.unitKey === "synthetic:statement-documents"))
    .toMatchObject({ artifactCount: 0, coverageStatus: "unknown", safeErrorCode: "statement_export_bytes_unverified" });
});
