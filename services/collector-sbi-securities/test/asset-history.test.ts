import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectMainSiteArtifacts, fetchAssetHistory } from "../src/main-site";
import { safeFailureCode, sbiRunPlan } from "../src/shared-run";
import type { Artifact } from "../src/types";
import { assetHistoryError } from "../../../packages/parsers/src/parsers/sbi-asset-history-schema";
import { assetHistoryArtifacts, assetHistoryInventoryComplete } from "../src/asset-history";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/sbi-parser-boundaries/account-assets-history.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the observed all-period request has no guessed window, body or CSRF header", async () => {
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://site.invalid/account/api/assets/valuations");
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.has("x-csrf-token")).toBe(false);
    expect(headers.get("referer")).toBe("https://site.invalid/account/assets");
    expect(headers.get("cookie")).toBe("synthetic=fixture");
    return Response.json(fixture);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  expect(
    await fetchAssetHistory({
      assetsUrl: "https://site.invalid/account/assets",
      cookies: [
        {
          name: "synthetic",
          value: "fixture",
          domain: "site.invalid",
          path: "/",
          hostOnly: true,
          secure: true,
        },
      ],
    }),
  ).toEqual(fixture);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("unknown payload fields fail before storage and retain only a closed safe code", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ leakedToken: "synthetic" }),
  ) as unknown as typeof fetch;
  await expect(
    fetchAssetHistory({ assetsUrl: "https://site.invalid/account/assets", cookies: [] }),
  ).rejects.toThrow("sbi_asset_history_schema");
  expect(
    safeFailureCode(
      assetHistoryError("sbi_asset_history_schema", {
        cause: new Error("synthetic-private-message"),
      }),
    ),
  ).toBe("sbi_asset_history_schema");
});

for (const kind of [
  "valid",
  "precision",
  "duplicate",
  "escaped-duplicate",
  "nested-duplicate",
  "malformed-exponent",
  "malformed-decimal",
] as const)
  test(`capture preserves eligible raw only; case=${kind}`, async () => {
    const original = JSON.stringify(fixture);
    const historyText = {
      valid: original,
      precision: original.replace('"profitLoss":10', '"profitLoss":0.99999999999999999'),
      duplicate: '{"balances":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
      "escaped-duplicate":
        '{"balanc\\u0065s":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
      "nested-duplicate": original.replace(
        '"valuation":10',
        '"valuation":{"accessToken":"SYNTHETIC_SENTINEL"},"valuation":10',
      ),
      "malformed-exponent": original.replace('"profitLoss":10', '"profitLoss":10e0e0'),
      "malformed-decimal": original.replace('"profitLoss":10', '"profitLoss":10.0.0'),
    }[kind];
    const inexact = kind === "precision";
    const unsafe = kind !== "valid" && !inexact;
    const codes: string[] = [];
    const header = Buffer.alloc(70, " ");
    header.write("F1132", 34);
    header.write("000000", 45);
    const responses = [
      new Response(Buffer.concat([header, Buffer.from("SYNTHETIC_LINK")])),
      new Response('<form action="/switch"><input name="synthetic" value="fixture"></form>'),
      new Response(null, { status: 302, headers: { location: "https://site.invalid/sso" } }),
      new Response(null, { status: 302, headers: { location: "/account/assets" } }),
      new Response("<html></html>"),
      Response.json({}),
      new Response(historyText),
      new Response(Buffer.concat([header, Buffer.from("SYNTHETIC_LINK")])),
      new Response("synthetic failure", { status: 503 }),
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      if (/\/account\/api\/assets\/(?:dividends|profit-loss)/u.test(String(input)))
        return new Response("synthetic income sibling failure", { status: 503 });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected synthetic request");
      return response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const retained: Artifact[] = [];
    await expect(
      collectMainSiteArtifacts({
        onIncomeHistoryError: () => {},
        session: {
          sessionId: "synthetic",
          branchCode: "001",
          accountNumber: "1234567",
          accountHash: "synthetic",
          mtsBaseUrl: "https://mts.invalid",
        },
        mainSiteBaseUrl: "https://main.invalid",
        onArtifact: (a) => retained.push(a),
        onAssetHistoryError: (error) => codes.push(safeFailureCode(error)),
      }),
    ).rejects.toThrow("sbi_cash_history_fetch_failed");
    expect(retained.map((a) => a.dataset)).toEqual(
      unsafe
        ? ["account-assets-current"]
        : inexact
          ? ["account-assets-current", "account-assets-history-source"]
          : [
              "account-assets-current",
              "account-assets-history-source",
              "account-assets-history-inventory",
              "account-assets-history",
            ],
    );
    expect(codes).toEqual(
      unsafe ? ["sbi_asset_history_schema"] : inexact ? ["sbi_asset_history_money"] : [],
    );
    if (!unsafe) expect(retained[1]!.bytes).toEqual(new TextEncoder().encode(historyText));
    const plan = await sbiRunPlan({
      runId: "weekly-synthetic-partial",
      producerVersion: "synthetic-v1",
      attemptId: "attempt-weekly",
      startedAt: "2099-01-10T01:00:00Z",
      completedAt: "2099-01-10T01:01:00Z",
      scope: "domestic",
      status: "partial",
      artifacts: retained,
      failures: [
        ...codes.map((code) => ({ scope: "domestic" as const, code })),
        { scope: "domestic", code: "provider_http_failed" },
      ],
    });
    expect(plan.run.providerOutcome).toBe("partial");
    expect(plan.run.units[0]?.coverageStatus).toBe("partial");
    expect(plan.run.safeErrorCode).toBe(codes[0] ?? "provider_http_failed");
    expect(plan.artifacts.some((a) => a.artifactKey === "account-assets-history-2099.json")).toBe(
      kind === "valid",
    );
    expect(responses).toHaveLength(0);
  });

test("year shards keep exact source bytes and an exhaustive hash inventory; missing or altered shards stay partial", async () => {
  const body = structuredClone(fixture);
  const bytes = new TextEncoder().encode(JSON.stringify(body, null, 2));
  const source: Artifact = {
    artifactKey: "account-assets-history-source.json",
    dataset: "account-assets-history-source",
    mediaType: "application/json",
    role: "provider_response",
    body,
    bytes,
  };
  const derived = await assetHistoryArtifacts({
    body,
    bytes,
    capturedAt: "2020-01-01T00:00:00.000Z",
  });
  const artifacts = [source, ...derived];
  expect(await assetHistoryInventoryComplete(artifacts)).toBe(true);
  expect(await assetHistoryInventoryComplete([source, derived[0]!])).toBe(false);
  const corrupted = structuredClone(artifacts);
  corrupted[2]!.body = {};
  expect(await assetHistoryInventoryComplete(corrupted)).toBe(false);
  const plan = await sbiRunPlan({
    runId: "weekly-inventory",
    producerVersion: "synthetic-v1",
    attemptId: "attempt-inventory",
    startedAt: "2020-01-01T00:00:00Z",
    completedAt: "2020-01-01T00:01:00Z",
    scope: "domestic",
    status: "success",
    artifacts,
    failures: [],
  });
  const raw = plan.artifacts.find((a) => a.artifactKey === source.artifactKey)!;
  expect(raw.role).toBe("provider_response");
  expect(raw.body).toEqual({ kind: "bytes", bytes });
  expect(plan.run.transformations.map((t) => t.inputArtifactKeys)).toEqual([
    [source.artifactKey!],
    [source.artifactKey!, "account-assets-history-inventory.json"],
  ]);
  const partial = await sbiRunPlan({
    runId: "weekly-inventory-missing",
    producerVersion: "synthetic-v1",
    attemptId: "attempt-missing",
    startedAt: "2020-01-01T00:00:00Z",
    completedAt: "2020-01-01T00:01:00Z",
    scope: "domestic",
    status: "success",
    artifacts: [source, derived[0]!],
    failures: [],
  });
  expect(partial.run.providerOutcome).toBe("partial");
  expect(partial.run.safeErrorCode).toBe("sbi_asset_history_shard_inventory");
  expect(partial.run.units[0]!.coverageStatus).toBe("partial");
});
