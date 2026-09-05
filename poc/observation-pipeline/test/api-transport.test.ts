import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ApiError, getJson } from "../web/src/api.ts";
import type { ApiMetadata, TransactionRow } from "../shared/api-contract.ts";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});
const signal = () => new AbortController().signal;
const metadata: ApiMetadata = {
  apiVersion: 1,
  source: { kind: "local-store", classification: "unknown" },
  capabilities: { readOnly: true, rawEvidence: true, liveCollectors: false },
};
const transaction: TransactionRow = {
  id: 1,
  source_id: "sample",
  source_account: "sample-account",
  as_of: null,
  amount_minor: "9007199254740993",
  amount_text: null,
  currency: "JPY",
  description: null,
  counterparty: null,
  external_id: null,
  status: null,
  parser: "sample@1",
};
function serve(response: Response) {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
}
async function errorFor(
  path = "/api/meta",
  abortSignal = signal(),
): Promise<ApiError> {
  try {
    await getJson(path, abortSignal);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected API error");
}

describe("browser JSON transport", () => {
  test("passes cancellation and disallows cached or automatically redirected financial responses", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(metadata),
    );
    fetchSpy = spy;
    const abortSignal = signal();
    expect(await getJson<ApiMetadata>("/api/meta", abortSignal)).toEqual(
      metadata,
    );
    const init = spy.mock.calls[0]?.[1];
    expect(init?.signal).toBe(abortSignal);
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.redirect).toBe("manual");
  });
  test("auth failures use fixed Japanese text without reading private error bodies", async () => {
    const response = new Response('{"error":"private-account-token"}', {
      status: 401,
      statusText: "private-secret",
    });
    serve(response);
    const error = await errorFor();
    expect(error.status).toBe(401);
    expect(error.message).toContain("ログイン");
    expect(error.message).not.toContain("private");
    expect(response.bodyUsed).toBe(false);
  });
  test("rejects login redirects before HTML is mistaken for data", async () => {
    serve(
      new Response(null, {
        status: 302,
        headers: { location: "https://auth.test/private-secret" },
      }),
    );
    const error = await errorFor();
    expect(error.status).toBe(401);
    expect(error.message).toContain("ログイン");
    expect(error.message).not.toContain("private");
  });
  test("non-JSON success and malformed JSON cannot expose body content", async () => {
    serve(
      new Response("<html>private-account</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    const htmlError = await errorFor();
    expect(htmlError.message).toContain("接続先");
    expect(htmlError.message).not.toContain("private");
    fetchSpy!.mockRestore();
    serve(
      new Response('{"private-secret":', {
        headers: { "content-type": "application/json" },
      }),
    );
    const jsonError = await errorFor();
    expect(jsonError.message).toContain("読み取れません");
    expect(jsonError.message).not.toContain("private");
  });
  test("rejects malformed envelopes and unsupported metadata instead of rendering them", async () => {
    for (const [path, body] of [
      ["/api/transactions", { transactions: null }],
      ["/api/transactions", { transactions: [null] }],
      ["/api/transactions", { transactions: [{}] }],
      [
        "/api/transactions",
        { transactions: [{ ...transaction, source_id: null }] },
      ],
      [
        "/api/transactions",
        { transactions: [{ ...transaction, amount_minor: 9007199254740992 }] },
      ],
      ["/api/balances", { latest: [{}], history: [] }],
      ["/api/artifacts", { artifacts: [{}] }],
      ["/api/positions", { positions: [{ position: {}, valuations: null }] }],
      [
        "/api/overview",
        { counts: [], sources: [], fetchRuns: [], parseRuns: [{}] },
      ],
      [
        "/api/overview",
        {
          counts: [],
          sources: [],
          fetchRuns: [],
          parseRuns: [
            {
              id: 1,
              fetch_artifact_id: 1,
              parser_name: "sample",
              parser_version: "1",
              parsed_at: "2026-09-05",
              status: "ok",
              error: null,
              superseded_by_parse_run_id: null,
              warnings: { list: [null], raw: null, parsed: true },
            },
          ],
        },
      ],
      [
        "/api/meta",
        {
          ...metadata,
          source: { kind: "local-store", classification: "real" },
        },
      ],
      ["/api/meta", { ...metadata, apiVersion: 2 }],
    ] as const) {
      fetchSpy?.mockRestore();
      serve(Response.json(body));
      expect((await errorFor(path)).message).toContain("形式");
    }
  });
  test("preserves empty results and exact large minor-unit strings", async () => {
    const body = { transactions: [transaction] };
    serve(Response.json(body));
    expect(await getJson<typeof body>("/api/transactions", signal())).toEqual(
      body,
    );
    fetchSpy!.mockRestore();
    serve(Response.json({ artifacts: [] }));
    expect(
      await getJson<{ artifacts: unknown[] }>("/api/artifacts", signal()),
    ).toEqual({ artifacts: [] });
  });
  test("malformed amounts and mismatched detail identities become safe transport errors", async () => {
    for (const [path, body] of [
      [
        "/api/transactions",
        { transactions: [{ ...transaction, amount_minor: " " }] },
      ],
      [
        "/api/observations/transaction/1",
        {
          kind: "transaction",
          row: { id: 2, description: "private-other-record" },
          extra: {},
          extraRaw: "{}",
          extraParsed: true,
        },
      ],
    ] as const) {
      fetchSpy?.mockRestore();
      serve(Response.json(body));
      const error = await errorFor(path);
      expect(error.message).toContain("形式");
      expect(error.message).not.toContain("private-other-record");
    }
  });
  test("network errors are safe and cancellation remains an AbortError", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("private-request-url"),
    );
    const error = await errorFor();
    expect(error.status).toBe(0);
    expect(error.message).toContain("接続できません");
    expect(error.message).not.toContain("private");
    const controller = new AbortController();
    controller.abort();
    await expect(getJson("/api/meta", controller.signal)).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });
});
