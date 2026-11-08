// The run ids a Vpass alarm reports (one run per card) are the shared result
// helpers' own: each persisted run once, at most `MAX_RUN_IDS`, and a
// collection with more cards than that is `run_ids_over_limit`, never a
// completed answer the Processor refuses. Synthetic auth boundary, cards,
// months and storage only: no real key, credential, session or provider request.
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { collectorOperationResult } from "../../../packages/collection/src/operation-rpc";
import { MAX_RUN_IDS, RUN_IDS_OVER_LIMIT } from "../../../packages/collection/src/schedule-result";
import { afterEach, expect, spyOn, test } from "bun:test";
import type worker from "../src/worker";
import { alarmCollection } from "../src/worker";
import * as mobileAuth from "../src/mobile-auth";

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const SESSION_RUN = "2026-09-05T00-00-00-000Z";
const cardRun = (n: number) => `${SESSION_RUN}-card-${String(n).padStart(3, "0")}`;

/**
 * An alarm over `cards` synthetic cards. A card with a month collects it and
 * persists a successful run; a card without one fails and persists a failed run.
 */
async function alarmOver(cards: number, withMonths: boolean) {
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation(() => {});
    restores.push(() => spy.mockRestore());
  }
  const authSpies = [
    spyOn(mobileAuth, "assertPublicKeyHash").mockImplementation(() => {}),
    spyOn(mobileAuth, "buildConfigAuth").mockReturnValue("synthetic-config-auth"),
    spyOn(mobileAuth, "buildFirstLoginAuth").mockReturnValue("synthetic-login-auth"),
  ];
  restores.push(() => authSpies.forEach((spy) => spy.mockRestore()));
  const member = (content: Record<string, unknown>) =>
    Response.json({ header: { resultCode: 0 }, body: { content } });
  const responses: Array<() => Response> = [
    () =>
      Response.json(
        { status: 200 },
        {
          headers: {
            "x-vappsessiontime": "synthetic-time",
            "set-cookie": "sid=synthetic-cookie; Path=/",
          },
        },
      ),
    () => Response.json({ status: 200, data: { login_token: "synthetic-token" } }),
    () =>
      member({
        DropdownListInitDisplayServiceBean: {
          multiCardInfoList: Array.from({ length: cards }, (_, i) => ({
            name: `Synthetic card ${i + 1}`,
            value: `synthetic-card-${i + 1}`,
          })),
        },
      }),
  ];
  for (let i = 0; i < cards; i += 1) {
    responses.push(() => member({ MultiCardUpdateBean: { cardIdentifyKey: `synthetic-${i}` } }));
    responses.push(() =>
      member({
        WebMeisaiTopDisplayServiceBean: {
          seikyuYMList: withMonths ? [{ value: "209901" }] : [],
        },
      }),
    );
    if (withMonths)
      responses.push(() =>
        member({
          WebMeisaiTopDisplayServiceBean: {
            meisaiList: [],
            webMeisaiTopK3Vo: { allCnt: "0", nextPageRow: "1" },
          },
        }),
      );
  }
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        const response = responses.shift();
        if (!response) throw new Error("unexpected synthetic request");
        return response();
      },
      { preconnect: () => {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  const data = new FakeR2Bucket();
  const env = {
    DATA: data,
    VPASS_AUTH_PUBLIC_KEY_B64: "c3ludGhldGlj",
    VPASS_CONFIG_PUBLIC_KEY_B64: "c3ludGhldGlj",
    VPASS_DEVICE_ID: "00000000-0000-4000-8000-000000000000",
    VPASS_ID: "synthetic-user",
    VPASS_PASSWORD: "synthetic-password",
  } as unknown as Parameters<typeof worker.scheduled>[1];
  const result = await alarmCollection(env, "0 21 * * *", Date.parse("2026-09-05T00:00:00Z"));
  expect(responses).toHaveLength(0);
  const terminals = [...data.entries.keys()].filter((key) => key.endsWith("/terminal.json"));
  return { result, terminals };
}

test("a collection of at most 100 cards completes and names every card run once", async () => {
  const { result, terminals } = await alarmOver(MAX_RUN_IDS, true);
  const all = Array.from({ length: MAX_RUN_IDS }, (_, i) => cardRun(i + 1));
  expect(result).toEqual({ status: "completed", runIds: all, failureCode: null });
  expect(collectorOperationResult(result)).toEqual(result);
  expect(terminals).toHaveLength(MAX_RUN_IDS);
});

test("a collection of more than 100 cards keeps every terminal and reports run_ids_over_limit", async () => {
  const cards = MAX_RUN_IDS + 3;
  const { result, terminals } = await alarmOver(cards, true);
  // Every card's run is persisted: no evidence is dropped at the result cap.
  expect(terminals).toHaveLength(cards);
  expect(terminals.some((key) => key.includes(`/${cardRun(cards)}/`))).toBe(true);
  // The answer is a closed failure with the first 100 runs, which the
  // Processor accepts back, rather than an over-long answer it would refuse
  // (an `uncertain` operation) or a completed one naming a subset.
  const first = Array.from({ length: MAX_RUN_IDS }, (_, i) => cardRun(i + 1));
  expect(result).toEqual({ status: "failed", runIds: first, failureCode: RUN_IDS_OVER_LIMIT });
  expect(collectorOperationResult(result)).toEqual(result);
});

test("a failed collection of more than 100 cards keeps its code and lists the first 100 runs", async () => {
  const cards = MAX_RUN_IDS + 3;
  const { result, terminals } = await alarmOver(cards, false);
  expect(terminals).toHaveLength(cards);
  const first = Array.from({ length: MAX_RUN_IDS }, (_, i) => cardRun(i + 1));
  expect(result).toEqual({ status: "failed", runIds: first, failureCode: "collection_failed" });
  expect(collectorOperationResult(result)).toEqual(result);
});
