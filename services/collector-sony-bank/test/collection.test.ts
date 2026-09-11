import { describe, expect, spyOn, test } from "bun:test";
import { collectSonyBank } from "../src/sony-bank";
import { failure, SonyBankDiagnostics } from "../src/diagnostics";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const privateValue = "synthetic-private-financial-value";
const csvBytes = new Uint8Array([0x82, 0xa0, 0x2c, 0x31, 0x0d, 0x0a]);

function provider(total: number, csvStatus = 200, invalidHistory = false) {
  const csvCurrencies: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/input/"))
      return new Response("", { headers: { "set-cookie": `FSID=${privateValue}` } });
    if (path.endsWith("revision.json")) return new Response("1");
    if (path.endsWith("csrf-token/get"))
      return Response.json({}, { headers: { "bff-csrf": privateValue } });
    if (path.endsWith("to-customers/login"))
      return Response.json({ accountInfo: [{ privateValue }] });
    if (path.endsWith("gross-balance/acq")) return Response.json({ privateValue });
    if (path.includes("ordinary-deposit-transaction-histories")) {
      const body = JSON.parse(String(init?.body));
      const currency = body.currencyCd || body.currencyCdInq;
      if (path.endsWith("csv/load")) {
        csvCurrencies.push(currency);
        return csvStatus === 200
          ? new Response(csvBytes, { headers: { "content-type": "text/csv" } })
          : Response.json({ errors: [{ code: privateValue }] }, { status: csvStatus });
      }
      const count = currency === "JPY" ? total : 0;
      return Response.json({
        countCnt: invalidHistory ? -1 : count,
        transactionHistInfo: Array.from(
          { length: Math.min(3, Math.max(0, count - body.acquisitionStrtCnt + 1)) },
          () => ({ privateValue }),
        ),
      });
    }
    if (path.endsWith("debit-sso/login-usage-dtl-inq"))
      return Response.json({ debitSsoBinDat: privateValue });
    if (path.endsWith("vcfb02001"))
      return new Response(
        `<form name="tisdcform" action="/statement;jsessionid=${privateValue}"><input name="r01" value="${privateValue}"><input name="cc" value="${privateValue}"></form>`,
      );
    if (path.startsWith("/statement"))
      return new Response(
        `<form name="nablarch_form3"><select name="W131301.referenceDate"><option value="20260930">September</option></select><input type="hidden" name="session" value="${privateValue}"></form>`,
      );
    throw new Error(`unexpected request ${privateValue}`);
  };
  return { fetcher, csvCurrencies };
}

function collect(mock: ReturnType<typeof provider>) {
  return collectSonyBank({
    credential: { branchNum: "001", accountNum: "1234567", loginPwd: privateValue },
    from: "2026-09-01",
    to: "2026-09-05",
    runId,
    fetcher: mock.fetcher,
  });
}

async function capture<T>(task: () => Promise<T>, throwing = false) {
  const records: Record<string, unknown>[] = [];
  const logger = (value: unknown) => {
    if (throwing) throw new Error(privateValue);
    records.push(JSON.parse(String(value)));
  };
  const spies = [
    spyOn(console, "log").mockImplementation(logger),
    spyOn(console, "error").mockImplementation(logger),
  ];
  try {
    return { value: await task(), records };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

describe("Sony history CSV follows the official empty-history guard", () => {
  test("zero JPY preserves official JSON and WALLET while skipping all empty CSVs", async () => {
    const mock = provider(0);
    const { value, records } = await capture(() => collect(mock));
    expect(mock.csvCurrencies).toEqual([]);
    expect(value.transactionCount).toBe(0);
    expect(value.artifacts.some((artifact) => artifact.dataset === "yen-history-csv")).toBe(false);
    expect(
      JSON.parse(
        String(
          value.artifacts.find((artifact) => artifact.dataset === "yen-history-page-0001")?.body,
        ),
      ),
    ).toEqual({ countCnt: 0, transactionHistInfo: [] });
    expect(value.artifacts.some((artifact) => artifact.dataset === "wallet-history-202609")).toBe(
      true,
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        runId,
        stage: "history-csv",
        currency: "JPY",
        outcome: "skipped",
        reason: "zero_transactions",
        transactionCount: 0,
      }),
    );
    expect(records.every((record) => record.runId === runId)).toBe(true);
    expect(JSON.stringify(records)).not.toContain(privateValue);
    expect(JSON.stringify(records)).not.toContain("1234567");
    expect(JSON.stringify(records)).not.toContain("https://");
  });

  test("positive JPY retains exact CSV bytes and logs validated page counts", async () => {
    const mock = provider(4);
    const { value, records } = await capture(() => collect(mock));
    expect(mock.csvCurrencies).toEqual(["JPY"]);
    expect(value.transactionCount).toBe(4);
    expect(
      new Uint8Array(
        value.artifacts.find((artifact) => artifact.dataset === "yen-history-csv")!
          .body as ArrayBuffer,
      ),
    ).toEqual(csvBytes);
    expect(records).toContainEqual(
      expect.objectContaining({
        providerOperation: "EABA0600S1fE11",
        currency: "JPY",
        page: 2,
        rowCount: 1,
        transactionCount: 4,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        phase: "request",
        providerOperation: "EABA0600S1fE12",
        currency: "JPY",
        httpStatus: 200,
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(records)).not.toContain(privateValue);
  });

  test("positive-history CSV 500 remains a failure and records count before the failed request", async () => {
    const { value, records } = await capture(async () => {
      try {
        await collect(provider(1, 500));
      } catch (error) {
        return failure("collect", error);
      }
      throw new Error("expected failure");
    });
    expect(value.diagnostics).toMatchObject({
      stage: "history-csv",
      currency: "JPY",
      httpStatus: 500,
    });
    const validated = records.findIndex(
      (record) => record.stage === "history" && record.transactionCount === 1,
    );
    const failed = records.findIndex(
      (record) => record.stage === "history-csv" && record.httpStatus === 500,
    );
    expect(validated).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(validated);
    expect(JSON.stringify(records)).not.toContain(privateValue);
  });

  test("malformed zero-history metadata fails rather than silently skipping CSV", async () => {
    const mock = provider(0, 200, true);
    const { value } = await capture(async () => {
      try {
        await collect(mock);
      } catch (error) {
        return failure("collect", error);
      }
      throw new Error("expected failure");
    });
    expect(value.diagnostics?.stage).toBe("history");
    expect(mock.csvCurrencies).toEqual([]);
  });

  test("throwing loggers cannot change successful collection or real CSV failure", async () => {
    expect((await capture(() => collect(provider(0)), true)).value.transactionCount).toBe(0);
    const { value } = await capture(async () => {
      try {
        await collect(provider(1, 503));
      } catch (error) {
        return failure("collect", error);
      }
      throw new Error("expected failure");
    }, true);
    expect(value.diagnostics?.httpStatus).toBe(503);
  });

  test("progress allowlist drops forged identifiers, invalid counts and throwing getters", async () => {
    const { records } = await capture(async () => {
      const diagnostics = new SonyBankDiagnostics(privateValue);
      diagnostics.record(privateValue, "failed", {
        currency: privateValue,
        reason: privateValue,
        page: Infinity,
        httpStatus: 999,
      });
      diagnostics.record("history", "completed", {
        get transactionCount(): number {
          throw new Error(privateValue);
        },
      });
    });
    expect(records).toEqual([
      { event: "sony-bank-progress", phase: "collection", stage: "collect", outcome: "failed" },
    ]);
  });
});
