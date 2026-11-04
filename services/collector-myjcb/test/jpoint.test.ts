// Synthetic protocol and amounts only; no provider is contacted.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MyJcbReadClient } from "../src/client";
import { CookieJar } from "../src/cookie-jar";
import { collectJPoint, isObservedJPointProduct } from "../src/jpoint";
import { allowedUrl, assertAllowedRequest } from "../src/policy";
import { myJcbRunPlan, type SharedRunInput } from "../src/shared-collection";

const body = readFileSync(
  new URL(
    "../../../tests/fixtures/observation-pipeline/myjcb-jpoint/jpoint-balance.json",
    import.meta.url,
  ),
  "utf8",
);
const page =
  '<p class="user-stage"><span class="txt">JCBカードW</span></p><input type="hidden" name="generalJsonShikibetuId" value="synthetic-discriminator">';
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("observed JPOINT acquisition", () => {
  test.each([
    [page, true],
    [page.replace("JCBカードW", "【架空】JCBカードW（仮）"), true],
    [page.replace("JCBカードW", "JCB CARD W"), false],
    [page.replace("<span", "<div").replace("</span>", "</div>"), false],
    [page.replace("JCBカードW", "JCBカードW / JCBカードW"), false],
    [page.replace("JCBカードW", "架空JCBカードW"), false],
    [page.replace("JCBカードW", "JCBカードW / リクルートカード"), false],
    [page.replace("JCBカードW", "JCBカードW / JCBゴールド"), false],
    [page.replace("JCBカードW", "JCB JCBカードW（仮）"), true],
    [page.replace("JCBカードW", "JCB W plus L"), false],
    [page.replace("JCBカードW", "リクルートカード"), false],
    ["<div>JCBカードW</div>", false],
    [page + page, false],
  ] as const)("only current product marker is eligible: %#", (html, eligible) => {
    expect(isObservedJPointProduct(html)).toBe(eligible);
  });
  test("unsupported product performs no point request", async () => {
    const request = spyOn(
      {
        postJPointJson: async () => {
          throw new Error("must not fetch");
        },
      },
      "postJPointJson",
    );
    const result = await collectJPoint(
      { postJPointJson: request },
      page.replace("JCBカードW", "リクルートカード"),
    );
    expect(result).toEqual({ code: "unsupported", artifacts: [] });
    expect(request).not.toHaveBeenCalled();
  });
  test("failed point acquisition returns a closed outcome without provider text", async () => {
    const result = await collectJPoint(
      {
        postJPointJson: async () => {
          throw new Error("synthetic-private-token");
        },
      },
      page,
    );
    expect(result).toEqual({ code: "unavailable", artifacts: [] });
  });
  test("one POST uses the observed body and stores response bytes unchanged", async () => {
    const mocked = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    restore = () => mocked.mockRestore();
    const result = await collectJPoint(
      new MyJcbReadClient(new CookieJar(), "synthetic-agent"),
      page,
    );
    expect(result.code).toBe("collected");
    expect(result.artifacts).toHaveLength(1);
    expect(new TextDecoder().decode(result.artifacts[0]!.body as ArrayBuffer)).toBe(body);
    const [url, init] = mocked.mock.calls[0]!;
    expect(String(url)).toBe(allowedUrl("jpoint-json").href);
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBeFalse();
    expect(new Headers(init?.headers).get("referer")).toBe(allowedUrl("mypage").href);
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0",
      method: "execute",
      params: [{ generalJsonShikibetuId: "synthetic-discriminator" }],
      id: "200100101",
    });
  });
  test.each([
    new Response("synthetic-private-token", {
      status: 302,
      headers: { location: "https://evil.example" },
    }),
    new Response("synthetic-private-token", { status: 429 }),
    new Response("<html>synthetic-private-token</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response(body.replace("200100101", "200100102"), {
      headers: { "content-type": "application/json" },
    }),
    new Response(body.replace('"errId": ""', '"errId": "synthetic-private-token"'), {
      headers: { "content-type": "application/json" },
    }),
  ])("unsafe or unavailable response is refused without retry: %#", async (response) => {
    const mocked = spyOn(globalThis, "fetch").mockResolvedValue(response);
    restore = () => mocked.mockRestore();
    await expect(
      new MyJcbReadClient(new CookieJar(), "test").postJPointJson("synthetic"),
    ).rejects.toThrow(/myjcb_jpoint_/u);
    expect(mocked).toHaveBeenCalledTimes(1);
  });
  test("stream limit cancels an oversized response even with absent content-length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const mocked = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { headers: { "content-type": "application/json" } }),
    );
    restore = () => mocked.mockRestore();
    await expect(
      new MyJcbReadClient(new CookieJar(), "test").postJPointJson("synthetic"),
    ).rejects.toThrow("myjcb_jpoint_response_too_large");
    expect(cancelled).toBeTrue();
  });
  test("route policy rejects query, GET, cross-origin and point exchange", () => {
    for (const [method, url] of [
      ["GET", allowedUrl("jpoint-json").href],
      ["POST", allowedUrl("jpoint-json").href + "?token=synthetic"],
      ["POST", "https://evil.example/iss-pc/general_json/member/point/pointJson.json"],
      ["POST", "https://my.jcb.co.jp/iss-pc/member/point/exchange.html"],
    ])
      expect(() => assertAllowedRequest("jpoint-json", method!, url!)).toThrow();
  });
});

function input(code: "collected" | "unavailable", pointBody = body): SharedRunInput {
  const artifacts = [
    {
      dataset: "discovery",
      filename: "discovery.json",
      mediaType: "application/json",
      body: '{"schemaVersion":1}',
    },
    ...(code === "collected"
      ? [
          {
            dataset: "jpoint-balance",
            filename: "jpoint-balance.json",
            mediaType: "application/json",
            body: pointBody,
          },
        ]
      : []),
  ];
  return {
    schemaVersion: "myjcb-worker-poc-v1",
    runId: "synthetic-run",
    startedAt: "2030-01-01T00:00:00.000Z",
    completedAt: "2030-01-01T00:01:00.000Z",
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
          periodCount: 1,
          artifactCount: artifacts.length,
          jpointCode: code,
        },
        artifacts,
      },
    ],
  };
}
describe("independent reward collection unit", () => {
  test("point artifact belongs to its own complete unit, preserving statement unit", async () => {
    const plan = await myJcbRunPlan(input("collected"));
    expect(plan.run.units).toEqual([
      {
        unitKey: "synthetic:j-point",
        unitKind: "reward-balance",
        artifactCount: 1,
        coverageStatus: "complete",
      },
      {
        unitKey: "synthetic",
        unitKind: "connection",
        artifactCount: 1,
        coverageStatus: "complete",
      },
    ]);
    expect(
      plan.artifacts.find((item) => item.artifactKey === "synthetic/jpoint-balance.json"),
    ).toMatchObject({ unitKey: "synthetic:j-point", role: "provider_response" });
  });
  test("missing points never downgrade collected history to failed or invent balance", async () => {
    const plan = await myJcbRunPlan(input("unavailable"));
    expect(plan.run.units[0]).toMatchObject({
      coverageStatus: "unknown",
      artifactCount: 0,
      safeErrorCode: "jpoint_unavailable",
    });
    expect(plan.run.units[1]).toMatchObject({ coverageStatus: "complete" });
    expect(
      plan.artifacts.some((item) => item.artifactKey.endsWith("jpoint-balance.json")),
    ).toBeFalse();
  });
  test("complete point unit survives partial statement coverage without widening it", async () => {
    const original = input("collected");
    const plan = await myJcbRunPlan({
      ...original,
      status: "partial",
      connections: original.connections.map((connection) => ({
        ...connection,
        summary: { ...connection.summary, status: "partial" as const },
      })),
    });
    expect(plan.run.providerOutcome).toBe("partial");
    expect(plan.run.units[0]).toMatchObject({ coverageStatus: "complete", artifactCount: 1 });
    expect(plan.run.units[1]).toMatchObject({
      coverageStatus: "partial",
      safeErrorCode: "collector_partial",
    });
  });
  test("a point unit stopped by an earlier statement failure remains unknown without bytes", async () => {
    const original = input("unavailable");
    const plan = await myJcbRunPlan({
      ...original,
      status: "partial",
      connections: original.connections.map((connection) => ({
        ...connection,
        summary: {
          ...connection.summary,
          status: "partial" as const,
          jpointCode: "stopped" as const,
          stopCode: "month_fetch" as const,
          capturedMonthCount: 1,
        },
      })),
    });
    expect(plan.run.units[0]).toMatchObject({
      coverageStatus: "unknown",
      artifactCount: 0,
      safeErrorCode: "jpoint_stopped",
    });
    expect(plan.run.units[1]).toMatchObject({
      coverageStatus: "partial",
      safeErrorCode: "month_fetch",
    });
  });
  test("failed run persists no point artifact even with previously collected bytes", async () => {
    const plan = await myJcbRunPlan({ ...input("collected"), status: "failed" });
    expect(plan.artifacts).toHaveLength(0);
    expect(plan.run.units[0]).toMatchObject({
      coverageStatus: "unknown",
      artifactCount: 0,
      safeErrorCode: "jpoint_stopped",
    });
  });
  test("unknown response field is refused before any persistence", async () => {
    const raw = JSON.parse(body);
    raw.result.token = "synthetic-private-token";
    await expect(myJcbRunPlan(input("collected", JSON.stringify(raw)))).rejects.toThrow(
      "myjcb_jpoint_response_unsupported",
    );
  });
});
