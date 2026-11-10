import { afterEach, expect, spyOn, test } from "bun:test";
import { encode, decode } from "iconv-lite";
import { collectMobileSuica, HistoryCollectionError, parseHistoryRows } from "../src/mobile-suica";
import { mobileSuicaRunPlan } from "../src/shared-run";
import { mobileSuicaSfHistory } from "../../../packages/parsers/src/parsers/mobile-suica-sf-history.ts";
import { historyPage, historyRow, walkPages, syntheticSession, emptyPage } from "./history-fixture";
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => fetchMock?.mockRestore());
function responses(pages: readonly string[]) {
  let index = 0;
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        const html = pages[index++];
        if (html === undefined) throw new Error("unexpected_request");
        return new Response(new Uint8Array(encode(html, "shift_jis")), {
          headers: { "content-type": "text/html" },
        });
      },
      { preconnect() {} },
    ),
  );
}
const collect = () => collectMobileSuica({ session: syntheticSession, asOfDateJst: "2026-08-30" });
test("walks inclusive dates, enriches the blank boundary amount, and keeps identical occurrences", async () => {
  responses(walkPages);
  const result = await collect();
  expect(result).toMatchObject({ complete: true, pageCount: 2 });
  expect(result.rows).toHaveLength(101);
  expect(result.rows.filter((row) => row.date === "2026-08-28").map((row) => row.amount)).toEqual([
    -100, -100,
  ]);
  expect(String(fetchMock!.mock.calls[1]![1]!.body)).toContain("specifyDay=28");
  expect(result.artifacts.filter((a) => a.dataset === "sf-history-html")).toHaveLength(2);
  for (const artifact of result.artifacts.filter((a) => a.body instanceof Uint8Array))
    expect(decode(artifact.body as Uint8Array, "shift_jis")).not.toContain(
      "synthetic-private-state",
    );
  const body = result.artifacts.find((a) => a.dataset === "sf-history")!.body as string;
  const metadata = {
    id: 1,
    sourceId: "mobile-suica",
    runStatus: "success" as const,
    runFailureCount: 0,
    dataset: "sf-history",
    url: null,
    mime: "application/json",
    fetchedAt: "2026-08-30T01:00:00Z",
    sha256: "0".repeat(64),
  };
  const parsed = mobileSuicaSfHistory.parse(new TextEncoder().encode(body), metadata);
  const tx = parsed.observations.filter((o) => o.kind === "transaction");
  expect(tx).toHaveLength(100);
  expect(new Set(tx.map((o) => o.externalId)).size).toBe(100);
  await expect(
    mobileSuicaRunPlan({
      runId: "synthetic-missing-page",
      producerVersion: "synthetic",
      attemptId: "synthetic-attempt",
      startedAt: "2026-08-30T01:00:00Z",
      completedAt: "2026-08-30T01:01:00Z",
      status: "success",
      asOfDateJst: "2026-08-30",
      complete: true,
      artifacts: result.artifacts.filter((a) => a.filename !== "sf-history-page-0002.html"),
      failureCodes: [],
    }),
  ).rejects.toThrow("history_page_inventory_invalid");
  expect(
    parsed.observations.find((o) => o.kind === "transaction" && o.asOf === "2026-08-28")!.extra
      ._kogane,
  ).toMatchObject({ sourcePage: { artifactKey: "sf-history-page-0002.html", rowIndex: 1 } });
  const mutated = JSON.parse(body);
  mutated.pages[1].rows[0].amount = -999;
  expect(() =>
    mobileSuicaSfHistory.parse(new TextEncoder().encode(JSON.stringify(mutated)), metadata),
  ).toThrow();
});
test("a sub-100 snapshot keeps the single-page envelope and request count", async () => {
  responses([historyPage(historyRow("08/29", ""))]);
  const result = await collect();
  expect(result.pageCount).toBe(1);
  expect(result.rows[0]!.amount).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(result.artifacts.find((a) => a.dataset === "sf-history")!.body as string).pages,
  ).toBeUndefined();
});
test("the observed empty message is successful and all hidden state is redacted", async () => {
  responses([emptyPage]);
  const result = await collect();
  expect(result.rows).toEqual([]);
  expect(result.complete).toBe(true);
  const html = decode(result.artifacts[0]!.body as Uint8Array, "shift_jis");
  expect(html).not.toContain("synthetic-private-state");
  expect(html).not.toContain("synthetic-navigation-state");
  expect(html).not.toContain("synthetic-transfer-state");
});
test("100 rows on one day fail closed while preserving only sanitized evidence", async () => {
  responses([historyPage(historyRow("08/29").repeat(99) + historyRow("08/29", ""))]);
  try {
    await collect();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(HistoryCollectionError);
    expect((error as HistoryCollectionError).message).toBe("history_single_day_limit");
    expect((error as HistoryCollectionError).artifacts.map((a) => a.dataset)).toEqual([
      "sf-history-html",
    ]);
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("changed overlap, missing overlap, repeated capped pages and unknown messages refuse publication", async () => {
  for (const pages of [
    [walkPages[0]!, historyPage(historyRow("08/28", "-999"))],
    [walkPages[0]!, emptyPage],
    [walkPages[0]!, historyPage(historyRow("08/28").repeat(100))],
    [emptyPage.replace("利用履歴がありません。", "不明なエラー")],
    [historyPage(historyRow("08/29")).replace("08/29", "02/30")],
    [historyPage(historyRow("08/29", "9007199254740993"))],
  ]) {
    responses(pages);
    await expect(collect()).rejects.toBeInstanceOf(HistoryCollectionError);
    fetchMock!.mockRestore();
  }
});
test("strict dates reject calendar normalization and unsupported monetary text", () => {
  expect(() => parseHistoryRows(historyPage(historyRow("02/30")), "2026-08-30")).toThrow(
    "history_date_invalid",
  );
  expect(() => parseHistoryRows(historyPage(historyRow("08/29", "-1.2")), "2026-08-30")).toThrow(
    "history_amount_invalid",
  );
});

test("three pages advance inclusive oldest dates without dropping the intervening days", async () => {
  responses([
    walkPages[0]!,
    historyPage(
      historyRow("08/28").repeat(2) + historyRow("08/27").repeat(97) + historyRow("08/26", ""),
    ),
    historyPage(historyRow("08/26") + historyRow("08/25", "")),
  ]);
  const result = await collect();
  expect(result.pageCount).toBe(3);
  expect(result.rows).toHaveLength(199);
  expect(result.rows.filter((row) => row.date === "2026-08-27")).toHaveLength(97);
  expect(String(fetchMock!.mock.calls[2]![1]!.body)).toContain("specifyDay=26");
});
