// The v1 grouped balance list's summary (`kogane.observations.list
// {kind: "balances"}`; ADR 0123, amendment of 2026-11-20) at its realistic
// worst, through the real `/mcp` envelope: many accounts, each with a long
// Japanese label and a long provider key, and every balance under a long
// provider metric of its own, so nearly every line names a new account and
// metric. Every page a client is shown stays under 8 KB, and paging reads
// every row of both lists once. Every name, amount and date is invented.
import { beforeAll, describe, expect, it } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { BALANCE_LIST_SUMMARY_LINES } from "../../../packages/observation-shared/src/api-contract";
import { pageReadHarness } from "./page-read-harness";
import { seedRegistry } from "./fixtures";
import { routeSources, seedAccount } from "./realistic-store";

/** What the owner's client shows of a tool result (#1414). */
const CLIENT_BYTES = 8 * 1024;
const ACCOUNTS = 60;
const METRICS_PER_ACCOUNT = 3;
const page = pageReadHarness("observation-list-summary");

beforeAll(async () => {
  await seedRegistry();
  await routeSources();
  for (let index = 0; index < ACCOUNTS; index++)
    await seedAccount(index, {
      rawAccount: `synthetic-provider-account-with-a-long-key-${String(index).padStart(6, "0")}`,
      label: `合成普通預金口座（本店営業部・支店番号${String(index).padStart(3, "0")}）`.padEnd(
        64,
        "合",
      ),
      metrics: Array.from(
        { length: METRICS_PER_ACCOUNT },
        (_, position) =>
          `合成お支払い予定額（リボ払い・分割払い・ボーナス払い）_synthetic_metric_${index}_${position}`,
      ),
    });
}, 120_000);

/** One `/mcp` call's result: the bytes a client is shown and the structured content's data. */
async function call(args: Record<string, unknown>) {
  const message = await page.mcpMessage({
    method: "tools/call",
    params: { name: "kogane.observations.list", arguments: { kind: "balances", ...args } },
  });
  expect(message["result"].isError).toBe(false);
  const text = message["result"].content[0].text as string;
  return {
    bytes: new TextEncoder().encode(text).length,
    data: message["result"].structuredContent.data,
  };
}

describe("kogane.observations.list balances summary at its realistic worst", () => {
  it("shows a client under 8 KB a page, cutting lines rather than names, and reads every row once", async () => {
    const full = (await page.route("/api/balances?detail=full")).body as {
      latest: { id: number }[];
      history: { id: number }[];
    };
    expect(full.latest).toHaveLength(ACCOUNTS * METRICS_PER_ACCOUNT);
    expect(full.history).toHaveLength(ACCOUNTS * METRICS_PER_ACCOUNT);
    const fullBytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: "kogane-page-read-v1", data: full }),
    ).length;
    const first = await call({});
    // The measurement, for the ADR's table (`vitest --silent=false`).
    console.log(
      JSON.stringify({
        accounts: ACCOUNTS,
        rows: full.latest.length,
        fullBytes,
        firstPageBytes: first.bytes,
        firstPageLines: { latest: first.data.latest.length, history: first.data.history.length },
      }),
    );
    expect(fullBytes).toBeGreaterThan(50 * CLIENT_BYTES);
    // The page is cut by its byte budget before its line cap.
    expect(first.data.latest.length + first.data.history.length).toBeLessThan(
      2 * BALANCE_LIST_SUMMARY_LINES,
    );
    const seen = { latest: [] as number[], history: [] as number[] };
    // Following `coverage.next` alone, as an agent does.
    let at: { offset: number; latestOffset: number } | null = { offset: 0, latestOffset: 0 };
    let largest = 0;
    for (let pages = 0; at !== null && pages < 500; pages++) {
      const { bytes, data } = await call(at);
      largest = Math.max(largest, bytes);
      expect(bytes).toBeLessThan(CLIENT_BYTES);
      expect(validApiResponse("/api/balances", data, "summary")).toBe(true);
      seen.latest.push(...data.latest.map((line: { observationId: number }) => line.observationId));
      seen.history.push(
        ...data.history.map((line: { observationId: number }) => line.observationId),
      );
      at = data.coverage.next;
    }
    expect(at).toBeNull();
    console.log(JSON.stringify({ largestPageBytes: largest }));
    expect(seen.latest).toEqual(full.latest.map((row) => row.id));
    expect(seen.history).toEqual(full.history.map((row) => row.id));
  });
});
