import { describe, expect, test } from "bun:test";
import { collectSbiVcTrade } from "../src/collect";
import { SbiVcTradeClient } from "../src/client";

const session = { cookieHeader: "session=synthetic", secureKey: "synthetic-key" };

describe("SBI VC Trade read-only gateway", () => {
  test("sends only the statically verified balance event shape", async () => {
    let requestBody: unknown;
    const client = new SbiVcTradeClient(session, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return json({ meta: { status: "OK" }, body: { list: [] } });
    });
    await client.cashBalances();
    expect(requestBody).toEqual({
      event: "cashBalanceList",
      data: { secureKey: "synthetic-key" },
    });
  });

  test("uses the observed execution and cashflow defaults", async () => {
    const requests: Array<{ event: string; data: Record<string, unknown> }> = [];
    const client = new SbiVcTradeClient(session, async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return json({ meta: { status: "OK" }, body: { list: [], totalSize: 0 } });
    });
    await client.executions({ pageNumber: 0, pageSize: 30, historical: false });
    await client.cashflows({ pageNumber: 0, pageSize: 30, historical: true });

    expect(requests[0]?.data).toMatchObject({
      pageNumber: "0",
      pageSize: "30",
      sortKey: "executionDatetime",
      sortAsc: "false",
      historical: "false",
      isExOrder: "true",
      isCloseOrder: "false",
    });
    expect(requests[1]?.data).toMatchObject({
      pageNumber: "0",
      pageSize: "30",
      historical: "true",
      currency: ["JPY"],
      cashflowType: ["REMITTANCE_DEPOSIT", "REMITTANCE_WITHDRAW"],
    });
    expect(requests[1]?.data).not.toHaveProperty("eventDateFrom");
    expect(requests[1]?.data).not.toHaveProperty("eventDateTo");
  });

  test("does not leak session values in HTTP errors", async () => {
    const client = new SbiVcTradeClient(session, async () =>
      new Response("blocked", { status: 403 }));
    await expect(client.accountMargin()).rejects.toThrow("HTTP 403");
    try {
      await client.accountMargin();
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-key");
      expect(String(error)).not.toContain("session=synthetic");
    }
  });

  test("collects recent and historical pages independently", async () => {
    const events: Array<{ event: string; historical?: string }> = [];
    const client = new SbiVcTradeClient(session, async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: { historical?: string };
      };
      events.push({ event: request.event, historical: request.data.historical });
      return json({
        meta: { status: "OK" },
        body: request.event === "cashBalanceList" || request.event === "accountMargin"
          ? {}
          : { list: [], totalSize: 0, pageNumber: 0, pageSize: 30 },
      });
    });
    const artifacts = await collectSbiVcTrade(client);
    expect(artifacts).toHaveLength(5);
    expect(events).toContainEqual({ event: "executionList", historical: "false" });
    expect(events).toContainEqual({ event: "executionList", historical: "true" });
    expect(events).toContainEqual({ event: "getCashflowList", historical: "true" });
  });

  test("rejects non-JSON and non-OK gateway envelopes", async () => {
    const html = new SbiVcTradeClient(session, async () =>
      new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    await expect(html.accountMargin()).rejects.toThrow("non-JSON");

    const validation = new SbiVcTradeClient(session, async () =>
      json({ meta: { status: "VALIDATION_ERROR" }, body: {} }));
    await expect(validation.accountMargin()).rejects.toThrow("VALIDATION_ERROR");
  });
});

function json(value: unknown): Response {
  return Response.json(value, { status: 200 });
}
