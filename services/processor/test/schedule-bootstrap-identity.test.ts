import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { scheduleRoute, jobs } from "../src/schedule-store.ts";
import { startPipeline } from "./harness.ts";

const sha = "a".repeat(40),
  old = "b".repeat(40);
let mf: Miniflare, env: Env;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  env = {
    ...started.env,
    RELEASE_SHA: sha,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: { getByName: () => ({ reconcile: async () => null }) },
  } as unknown as Env;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
function post(target: string | undefined, environment = env, extra: Record<string, string> = {}) {
  const url = new URL("https://pipeline.internal/internal/schedules/bootstrap");
  return scheduleRoute(
    new Request(url, {
      method: "POST",
      headers: {
        "x-kogane-internal-caller": "kogane-evidence-browser",
        ...(target === undefined ? {} : { "x-kogane-release-sha": target }),
        ...extra,
      },
    }),
    environment,
    url,
  ) as Promise<Response>;
}
test("only exact authenticated target passes before any DB or alarm write", async () => {
  let writes = 0;
  const poisoned = {
    ...env,
    DB: {
      prepare: () => {
        writes++;
        throw new Error("must_not_write");
      },
    },
    SCHEDULE_ALARMS: {
      getByName: () => {
        writes++;
        throw new Error("must_not_arm");
      },
    },
  } as unknown as Env;
  for (const target of [undefined, "", "main", old]) {
    const response = await post(target, poisoned);
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toEqual({
      error: target === old ? "release_mismatch" : "scheduling_unavailable",
    });
  }
  const anonymous = await post(old, poisoned, { "cf-connecting-ip": "192.0.2.1" });
  expect(anonymous.status).toBe(403);
  expect((await anonymous.json()) as { error: string }).toEqual({
    error: "service_binding_required",
  });
  for (const releaseSha of ["main", [sha] as unknown as string]) {
    const invalidServer = await post(sha, { ...poisoned, RELEASE_SHA: releaseSha } as Env);
    expect(invalidServer.status).toBe(503);
    expect((await invalidServer.json()) as { error: string }).toEqual({
      error: "scheduling_unavailable",
    });
  }
  expect(writes).toBe(0);
});
test("actual bootstrap response captures serving identity before writes", async () => {
  let reconciles = 0;
  const mutable: Omit<Env, "RELEASE_SHA"> & { RELEASE_SHA: string } = {
    ...env,
    SCHEDULE_ALARMS: {
      getByName: () => ({
        reconcile: async () => {
          reconciles++;
          mutable.RELEASE_SHA = old;
          return null;
        },
      }),
    },
  } as unknown as Omit<Env, "RELEASE_SHA"> & { RELEASE_SHA: string };
  const response = await post(sha, mutable as unknown as Env);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    status: string;
    releaseSha: string;
    reservations: unknown[];
  };
  expect(body.status).toBe("armed");
  expect(body.releaseSha).toBe(sha);
  expect(body.reservations).toHaveLength(jobs.length);
  expect(reconciles).toBe(jobs.length);
  expect(mutable.RELEASE_SHA).toBe(old);
});
test("operational failure stays generic and cannot be retried as a prewrite refusal", async () => {
  const response = await post(sha, {
    ...env,
    DB: {
      prepare: () => {
        throw new Error("synthetic_SQL_failure");
      },
    },
  } as unknown as Env);
  expect(response.status).toBe(503);
  expect((await response.json()) as { error: string }).toEqual({ error: "scheduling_unavailable" });
});
test("the deployment's bootstrap frees no lease and records nothing in the tick's name (ADR 0085)", async () => {
  // A lease whose heartbeat went silent long ago. Only the `processor-tick`
  // alarm frees it, and its record names that alarm as the principal; the
  // release workflow's bootstrap is not that alarm and leaves it to the tick.
  const ref = "4e1a2b3c-0000-4000-8000-0000000000b1";
  await env.DB.prepare(
    "INSERT OR REPLACE INTO collection_execution_leases(source,lease_ref,started_at,heartbeat_at) VALUES('vpass',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes'))",
  )
    .bind(ref)
    .run();
  const response = await post(sha);
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT lease_ref FROM collection_execution_leases WHERE source='vpass'",
    ).first<string | null>("lease_ref"),
  ).toBe(ref);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_records WHERE operation='alarm.lease.expire'",
    ).first<number>("n"),
  ).toBe(0);
});
