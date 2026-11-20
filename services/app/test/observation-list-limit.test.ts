// The v1 grouped balance list's summary (ADR 0123, amendment of 2026-11-20)
// when one line alone passes the page's byte budget: an account label of
// thousands of characters (the schema does not bound one). The read is
// refused with `413 result_limit_exceeded` and `retryWith: {detail: "full"}`
// on the route, `/api/agent/v1/*` and `/mcp` alike, never answered past
// 8 KB; `full` answers the same row. Every name, amount and date is invented.
import { beforeAll, describe, expect, it } from "vitest";
import { pageReadHarness } from "./page-read-harness";
import { seedRegistry } from "./fixtures";
import { routeSources, seedAccount } from "./realistic-store";

/** What the owner's client shows of a tool result (#1414). */
const CLIENT_BYTES = 8 * 1024;
const ORDINARY = "synthetic-ordinary-account";
const OVERSIZED = "synthetic-oversized-account";
const page = pageReadHarness("observation-list-limit");

beforeAll(async () => {
  await seedRegistry();
  await routeSources();
  await seedAccount(0, {
    rawAccount: ORDINARY,
    label: "合成普通預金口座",
    metrics: ["利用可能額"],
  });
  // Over 7,680 bytes in UTF-8 on its own: 2,700 three-byte characters.
  await seedAccount(1, { rawAccount: OVERSIZED, label: "合".repeat(2_700), metrics: ["残高"] });
}, 120_000);

describe("kogane.observations.list balances summary over its byte budget", () => {
  it("refuses a page whose first line alone passes the budget, naming detail full", async () => {
    const refusal = { error: "result_limit_exceeded", retryWith: { detail: "full" } };
    const route = await page.route(`/api/balances?account=${OVERSIZED}`);
    expect(route.status).toBe(413);
    expect(route.body).toMatchObject(refusal);
    const args = { kind: "balances", account: OVERSIZED };
    expect(await page.http("kogane.observations.list", args)).toEqual({
      status: 413,
      body: refusal,
    });
    const answer = await page.mcp("kogane.observations.list", args);
    expect(answer.isError).toBe(true);
    expect(answer.body).toEqual(refusal);
    // `full` answers the same window.
    const full = await page.mcp("kogane.observations.list", { ...args, detail: "full" });
    expect(full.isError).toBe(false);
    expect(full.body.data.latest).toHaveLength(1);
    // The other account's summary is unaffected.
    const ordinary = await page.mcp("kogane.observations.list", {
      kind: "balances",
      account: ORDINARY,
    });
    expect(ordinary.body.data.latest).toHaveLength(1);
  });

  it("answers every page under 8 KB up to the line that does not fit, then refuses", async () => {
    let at: { offset: number; latestOffset: number } | null = { offset: 0, latestOffset: 0 };
    let refused = 0;
    for (let pages = 0; at !== null && pages < 10; pages++) {
      const message = await page.mcpMessage({
        method: "tools/call",
        params: { name: "kogane.observations.list", arguments: { kind: "balances", ...at } },
      });
      const text = message["result"].content[0].text as string;
      if (message["result"].isError) {
        expect(JSON.parse(text)).toEqual({
          error: "result_limit_exceeded",
          retryWith: { detail: "full" },
        });
        refused++;
        break;
      }
      expect(new TextEncoder().encode(text).length).toBeLessThan(CLIENT_BYTES);
      at = message["result"].structuredContent.data.coverage.next;
    }
    expect(refused).toBe(1);
  });
});
