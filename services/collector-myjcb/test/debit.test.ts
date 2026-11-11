import { expect, test } from "bun:test";
import { collectDebit, collectDebitOther } from "../src/debit";
import { myJcbRunPlan } from "../src/shared-collection";
import {
  myJcbDebitLedger,
  myJcbDebitOtherStatement,
} from "../../../packages/parsers/src/parsers/myjcb-debit";
import { allowedUrl, assertAllowedRequest } from "../src/policy";
import { MYJCB_DEBIT_HEADERS } from "../../../packages/domain/src/myjcb-debit-page";
import { readMyJcbDebitMenu } from "../../../packages/domain/src/myjcb-debit-page";
import { parse } from "parse5";

const ordinary = ["本人", "2030/02/04", "架空店舗", "1,200", "", "000001"];
const difference = ["本人", "2030/02/05", "架空店舗", "-200", "", "銀行振替済", "000001"];
function table(section: keyof typeof MYJCB_DEBIT_HEADERS, cells: readonly string[]) {
  return `<table><tr>${MYJCB_DEBIT_HEADERS[section].map((s) => `<th>${s}</th>`).join("")}</tr><tr>${cells.map((s) => `<td>${s}</td>`).join("")}</tr></table>`;
}
const body = `<input name="token" value="synthetic-secret"><div class="pc-disp">${table("ordinary", ordinary)}${table("difference", difference)}</div><div class="sp-disp">${table("ordinary", ordinary)}${table("difference", difference)}</div>`;
const selected = (sequence: string) =>
  `<select name="seq"><option value="${sequence}" selected>2030年1月16日～2030年2月15日分</option></select>`;
const meta = (position: number) => ({
  id: 1,
  sourceId: "myjcb",
  dataset: "debit-detail",
  runStatus: "success" as const,
  runFailureCount: 0,
  artifactKey: `synthetic/debit-detail-${String(position).padStart(2, "0")}.html`,
  fetchUnitKey: "synthetic",
  statementState: "debit",
  url: null,
  mime: "text/html",
  fetchedAt: "2030-03-01T00:00:00Z",
  sha256: "0".repeat(64),
});

test("daily debit collector walks every offered month and persists sanitized bytes readable by the parser", async () => {
  const calls: string[] = [];
  const result = await collectDebit({
    async get(operation, query) {
      calls.push(`${operation}:${query?.get("seq") ?? ""}`);
      const text =
        operation === "debit-menu"
          ? `<a href="/iss-pc/member/debit/details/debitDetail.html?seq=0">最新</a><select name="seq">${Array.from({ length: 14 }, (_, i) => `<option value="${i + 1}">過去</option>`).join("")}</select>`
          : selected(query!.get("seq")!) + body;
      return {
        url: new URL("https://my.jcb.co.jp/"),
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(text).buffer,
      };
    },
  });
  expect(result.periodCount).toBe(15);
  expect(calls).toHaveLength(16);
  expect(result.unreadMonths).toEqual([]);
  const plan = await myJcbRunPlan({
    schemaVersion: "1",
    runId: "synthetic-run",
    startedAt: meta(0).fetchedAt,
    completedAt: meta(0).fetchedAt,
    status: "success",
    trigger: "scheduled",
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
        },
        artifacts: result.artifacts,
      },
    ],
  });
  const ids: string[][] = [];
  for (let position = 0; position < 15; position++) {
    const artifact = plan.artifacts.find((a) => a.artifactKey === meta(position).artifactKey)!;
    if (artifact.body.kind !== "bytes") throw new Error("missing bytes");
    expect(new TextDecoder().decode(artifact.body.bytes)).not.toContain("synthetic-secret");
    const rows = myJcbDebitLedger.parse(artifact.body.bytes, meta(position)).observations;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.kind === "transaction" ? r.amountText : undefined))).toEqual([
      "-1200",
      "200",
    ]);
    ids.push(rows.map((r) => (r.kind === "transaction" ? r.externalId! : "")));
  }
  expect(ids.every((id) => JSON.stringify(id) === JSON.stringify(ids[0]))).toBe(true);
  expect(ids[0]![0]).not.toBe(ids[0]![1]);
});

test("unknown difference status, missing desktop schema and invalid dates fail closed", () => {
  for (const html of [
    body.replaceAll("銀行振替済", "未知"),
    "<p>no table</p>",
    body.replaceAll("2030/02/04", "2030/02/31"),
  ]) {
    expect(() => myJcbDebitLedger.parse(new TextEncoder().encode(html), meta(0))).toThrow();
  }
});

test("an unclassified month is retained and reported unread, without stopping the later months", async () => {
  const result = await collectDebit({
    async get(operation, query) {
      const text =
        operation === "debit-menu"
          ? '<a href="/iss-pc/member/debit/details/debitDetail.html?seq=0">最新</a><select name="seq"><option value="1">過去</option></select>'
          : query?.get("seq") === "0"
            ? "<p>unknown empty</p>"
            : selected("1") + body;
      return {
        url: new URL("https://my.jcb.co.jp/"),
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(text).buffer,
      };
    },
  });
  expect(result.unreadMonths).toEqual([{ position: 0, code: "rows_unstated" }]);
  expect(result.artifacts).toHaveLength(3);
});

test("zero rows require the observed empty marker naming the selected period", () => {
  const html =
    '<select name="seq"><option selected value="1">2030年1月16日～2030年2月15日分</option></select><p class="comment">[2030年1月16日 ～ 2030年2月15日分]のご利用代金明細はございません</p>';
  expect(myJcbDebitLedger.parse(new TextEncoder().encode(html), meta(1)).observations).toEqual([]);
  expect(() =>
    myJcbDebitLedger.parse(
      new TextEncoder().encode(html.replace("[2030年1月16日", "[2030年1月17日")),
      meta(1),
    ),
  ).toThrow();
  expect(() =>
    myJcbDebitLedger.parse(new TextEncoder().encode(html.replace(" selected", "")), meta(1)),
  ).toThrow();
});

test("separate other statements walk every offered month with the observed Shift_JIS query and explicit empty unit", async () => {
  const calls: string[] = [];
  const empty =
    '<div class="main"><div class="main-header"><h1 class="heading01-01">選択された月のご請求はございません。</h1></div></div>';
  const result = await collectDebitOther({
    async get(operation, query) {
      const url = allowedUrl(operation, query);
      calls.push(url.href);
      const text =
        operation === "debit-other-menu"
          ? `<select name="seq">${Array.from({ length: 14 }, (_, i) => `<option value="${i + 1}">過去</option>`).join("")}</select>`
          : empty;
      return {
        url,
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(text).buffer,
      };
    },
  });
  expect(result.code).toBe("complete");
  expect(calls).toHaveLength(15);
  expect(calls.slice(1).every((url) => url.endsWith("inquiry=%8F%C6%89%EF"))).toBe(true);
  const plan = await myJcbRunPlan({
    schemaVersion: "1",
    runId: "synthetic-run",
    startedAt: meta(0).fetchedAt,
    completedAt: meta(0).fetchedAt,
    status: "success",
    trigger: "scheduled",
    failures: [],
    connections: [
      {
        summary: {
          connectionId: "synthetic",
          bootstrapMode: "session",
          status: "success",
          cardCount: 1,
          periodCount: 0,
          artifactCount: result.artifacts.length,
          debitOtherCode: result.code,
        },
        artifacts: result.artifacts,
      },
    ],
  });
  expect(plan.run.units.find((u) => u.unitKey === "synthetic:debit-other")).toMatchObject({
    coverageStatus: "complete",
    artifactCount: 15,
  });
  const artifact = plan.artifacts.find(
    (a) => a.artifactKey === "synthetic/debit-other-detail-01.html",
  )!;
  if (artifact.body.kind !== "bytes") throw new Error("missing bytes");
  expect(
    myJcbDebitOtherStatement.parse(artifact.body.bytes, {
      ...meta(1),
      dataset: "debit-other-detail",
      artifactKey: artifact.artifactKey,
      fetchUnitKey: "synthetic:debit-other",
    }).observations,
  ).toEqual([]);
  expect(() =>
    assertAllowedRequest(
      "debit-other-detail",
      "GET",
      "https://my.jcb.co.jp/iss-pc/member/debit/od_details/debitOdDetail.html?seq=1&inquiry=%E7%85%A7%E4%BC%9A",
    ),
  ).toThrow();
});

test("unobserved separate other-statement content is preserved with a partial unit", async () => {
  const result = await collectDebitOther({
    async get(operation) {
      const text =
        operation === "debit-other-menu"
          ? '<select name="seq"><option value="1">過去</option></select>'
          : "<h1>unknown nonempty</h1><p>synthetic</p>";
      return {
        url: new URL("https://my.jcb.co.jp/"),
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(text).buffer,
      };
    },
  });
  expect(result.code).toBe("partial");
  expect(result.artifacts).toHaveLength(2);
  expect(() =>
    myJcbDebitOtherStatement.parse(new TextEncoder().encode(result.artifacts[1]!.body as string), {
      ...meta(1),
      dataset: "debit-other-detail",
      artifactKey: "synthetic/debit-other-detail-01.html",
      fetchUnitKey: "synthetic:debit-other",
    }),
  ).toThrow();
});

test("unknown/duplicate menu sequence codes fail closed and HTTP failures keep earlier ordinary months", async () => {
  for (const options of [
    '<option value="15">future</option>',
    '<option value="1">past</option><option value="1">duplicate</option>',
    '<option value="unknown">past</option>',
  ])
    expect(() =>
      readMyJcbDebitMenu(parse(`<select name="seq">${options}</select>`), "other"),
    ).toThrow();
  const calls: string[] = [];
  const result = await collectDebit({
    async get(operation, query) {
      calls.push(`${operation}:${query?.get("seq") ?? ""}`);
      if (query?.get("seq") === "1") throw new Error("synthetic HTTP stop");
      const text =
        operation === "debit-menu"
          ? '<a href="/iss-pc/member/debit/details/debitDetail.html?seq=0">latest</a><select name="seq"><option value="1">past</option><option value="2">past</option></select>'
          : selected(query!.get("seq")!) + body;
      return {
        url: new URL("https://my.jcb.co.jp/"),
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(text).buffer,
      };
    },
  });
  expect(result.stop).toEqual({ code: "debit", position: 1, capturedMonthCount: 1 });
  expect(result.periodCount).toBe(1);
  expect(result.artifacts).toHaveLength(2);
  expect(calls).toEqual(["debit-menu:", "debit-detail:0", "debit-detail:1"]);
});
