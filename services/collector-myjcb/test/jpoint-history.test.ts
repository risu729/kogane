import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectJPointHistory } from "../src/jpoint-history";
import { allowedUrl, assertAllowedRequest } from "../src/policy";
import { myJcbRunPlan } from "../src/shared-collection";
import type { RawArtifact } from "../src/types";
import type { ReadResponse } from "../src/client";
import { syntheticJPointHistoryHtml } from "../../../packages/parsers/test/myjcb-jpoint-history-fixture";
const page = '<p class="user-stage"><span class="txt">JCBカードW</span></p>';
const balance = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/myjcb-jpoint/jpoint-balance.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
balance.result.pointJsonInfo.normalPointInfo.point = "80";
balance.result.pointJsonInfo.specialPointInfo.point = "20";
balance.result.pointJsonInfo.totalPointInfo.point = "100";
balance.result.pointJsonInfo.totalPointInfo.expirePoint = "20";
const pointArtifacts: RawArtifact[] = [
  {
    dataset: "jpoint-balance",
    filename: "jpoint-balance.json",
    mediaType: "application/json",
    body: JSON.stringify(balance),
  },
];
const inquiry =
  '<!doctype html><html><body><input name="token" value="synthetic-private-token"><script>synthetic-private-token</script><a href="/iss-pc/member/point/pointHistoryInquiry.html">履歴</a></body></html>';
function client(history = syntheticJPointHistoryHtml(), entry = inquiry) {
  const calls: string[] = [];
  return {
    calls,
    get: async (
      operation: Parameters<Parameters<typeof collectJPointHistory>[0]["get"]>[0],
    ): Promise<ReadResponse> => {
      calls.push(operation);
      return {
        url:
          operation === "jpoint-inquiry"
            ? allowedUrl(operation, new URLSearchParams({ link_id: "myj_main_pointInquiry" }))
            : allowedUrl(operation),
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: new TextEncoder().encode(operation === "jpoint-inquiry" ? entry : history).buffer,
      };
    },
  };
}
test("collects all raw HTML rows once and reuses the already collected total", async () => {
  const read = client();
  const result = await collectJPointHistory(read, page, pointArtifacts);
  expect(read.calls).toEqual(["jpoint-inquiry", "jpoint-history"]);
  expect(result.code).toBe("collected");
  expect(result.artifacts.map((a) => a.dataset)).toEqual([
    "jpoint-inquiry",
    "jpoint-history-html",
    "jpoint-history",
  ]);
  expect(JSON.parse(String(result.artifacts[2]!.body)).rows).toHaveLength(3);
  expect(String(result.artifacts[0]!.body)).not.toContain("synthetic-private-token");
  expect(String(result.artifacts[0]!.body)).not.toContain("href=");
  const plan = await myJcbRunPlan({
    schemaVersion: "myjcb-worker-poc-v1",
    runId: "synthetic-history-run",
    startedAt: "2099-02-01T00:00:00Z",
    completedAt: "2099-02-01T00:01:00Z",
    status: "success",
    trigger: "manual",
    failures: [],
    connections: [
      {
        summary: {
          connectionId: "synthetic",
          bootstrapMode: "session",
          status: "success",
          cardCount: 1,
          periodCount: 0,
          artifactCount: 4,
          jpointCode: "collected",
          jpointHistoryCode: "collected",
        },
        artifacts: [...pointArtifacts, ...result.artifacts],
      },
    ],
  });
  expect(plan.run.units.find((u) => u.unitKey === "synthetic:j-point-history")).toMatchObject({
    artifactCount: 3,
    coverageStatus: "complete",
  });
  expect(plan.run.units.find((u) => u.unitKey === "synthetic:j-point")).toMatchObject({
    artifactCount: 1,
  });
  expect(plan.artifacts.filter((a) => a.unitKey === "synthetic:j-point-history")).toHaveLength(3);
});
test("unsupported roots or unavailable totals issue no request", async () => {
  const read = client();
  expect(
    await collectJPointHistory(
      read,
      page.replace("JCBカードW", "リクルートカード"),
      pointArtifacts,
    ),
  ).toEqual({ code: "unsupported", artifacts: [] });
  expect(await collectJPointHistory(read, page, [])).toEqual({
    code: "unavailable",
    artifacts: [],
  });
  expect(read.calls).toEqual([]);
});
test("failed history preserves bounded sanitized evidence and closes its own unit, never zero", async () => {
  const read = client(
    syntheticJPointHistoryHtml().replace('<div class="inner">90', '<div class="inner">91'),
  );
  const result = await collectJPointHistory(read, page, pointArtifacts);
  expect(result.code).toBe("unavailable");
  expect(result.artifacts.map((a) => a.dataset)).toEqual(["jpoint-inquiry", "jpoint-history-html"]);
  expect(result.artifacts.every((a) => a.dataset !== "jpoint-history")).toBe(true);
  const noLink = client(syntheticJPointHistoryHtml(), "<html><body>unavailable</body></html>");
  expect((await collectJPointHistory(noLink, page, pointArtifacts)).code).toBe("unavailable");
  expect(noLink.calls).toEqual(["jpoint-inquiry"]);
});
test("only exact observed GET routes are allowed; no windows, card switches or export fetches", () => {
  expect(allowedUrl("jpoint-history").pathname).toBe(
    "/iss-pc/member/point/pointHistoryInquiry.html",
  );
  for (const [operation, method, url] of [
    ["jpoint-history", "POST", allowedUrl("jpoint-history").href],
    ["jpoint-history", "GET", allowedUrl("jpoint-history").href + "?page=2"],
    ["jpoint-history", "GET", "https://evil.example/iss-pc/member/point/pointHistoryInquiry.html"],
  ] as const)
    expect(() => assertAllowedRequest(operation, method, url)).toThrow();
});
