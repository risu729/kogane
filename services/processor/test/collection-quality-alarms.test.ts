import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { startPipeline } from "./harness";
import {
  collectionQualityAlarmRoute,
  collectionQualityAlarms,
} from "../src/collection-quality-alarms";
import { validCollectionQualityAlarms } from "../../../packages/observation-shared/src/collection-quality-contract";
let mf: Miniflare, env: Env;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  env = started.env;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
test("actual reservations are read from configured jobs, including unknown failures, with no reconciliation", async () => {
  const seen: string[] = [];
  // Existing DO stubs retain their type; only the read RPC is replaced.
  const alarmTime = async (id: string) => {
    seen.push(id);
    if (id === "vpass") throw new Error("synthetic unavailable");
    return id === "sony-bank" ? "2099-01-01T00:00:00.000Z" : null;
  };
  const sourceEnv = {
    ...env,
    SCHEDULE_ALARMS: { getByName: (id: string) => ({ alarmTime: () => alarmTime(id) }) },
  };
  const before = await env.DB.prepare(
    "SELECT id,revision,enabled,next_nominal_at,next_run_at FROM collection_schedules ORDER BY id",
  ).all();
  const value = await collectionQualityAlarms(sourceEnv);
  expect(validCollectionQualityAlarms(value)).toBe(true);
  expect(value!.alarms.find((alarm) => alarm.id === "vpass")!.alarm).toEqual({
    status: "unavailable",
    actualAt: null,
  });
  expect(value!.alarms.find((alarm) => alarm.id === "sony-bank")!.alarm).toEqual({
    status: "observed",
    actualAt: "2099-01-01T00:00:00.000Z",
  });
  expect(value!.alarms.find((alarm) => alarm.id === "smbc-direct")!.alarm).toEqual({
    status: "observed",
    actualAt: null,
  });
  expect(seen.sort()).toEqual(value!.alarms.map((alarm) => alarm.id).sort());
  const after = await env.DB.prepare(
    "SELECT id,revision,enabled,next_nominal_at,next_run_at FROM collection_schedules ORDER BY id",
  ).all();
  expect(after.results).toEqual(before.results);
  expect(before.meta.rows_written).toBe(0);
  expect(after.meta.rows_written).toBe(0);
});
test("the internal route rejects public callers, disabled scheduling, writes and queries before reading", async () => {
  const url = new URL("https://fixture.test/internal/collection-quality/alarms");
  const trusted = { "x-kogane-internal-caller": "kogane-evidence-browser" };
  expect((await collectionQualityAlarmRoute(new Request(url), env, url))!.status).toBe(403);
  expect(
    (await collectionQualityAlarmRoute(
      new Request(url, { headers: { ...trusted, "cf-connecting-ip": "127.0.0.1" } }),
      env,
      url,
    ))!.status,
  ).toBe(403);
  expect(
    (await collectionQualityAlarmRoute(
      new Request(url, { headers: trusted }),
      { ...env, SCHEDULES_ENABLED: "false" },
      url,
    ))!.status,
  ).toBe(403);
  expect(
    (await collectionQualityAlarmRoute(
      new Request(url, { headers: trusted, method: "POST" }),
      { ...env, SCHEDULES_ENABLED: "true" },
      url,
    ))!.status,
  ).toBe(405);
  const queryUrl = new URL(`${url}?source=vpass`);
  expect(
    (await collectionQualityAlarmRoute(
      new Request(queryUrl, { headers: trusted }),
      { ...env, SCHEDULES_ENABLED: "true" },
      queryUrl,
    ))!.status,
  ).toBe(400);
});
