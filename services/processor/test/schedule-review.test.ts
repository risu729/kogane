import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { startPipeline } from "./harness";
import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  markAbandonedOccurrences,
  releaseCollectionLease,
  scheduleSnapshot,
  maintenanceForSchedule,
} from "../src/schedule-store";
let mf: Miniflare, env: Env;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  env = {
    ...started.env,
    SCHEDULE_ALARMS: { getByName: () => ({ alarmTime: async () => null }) },
  } as unknown as Env;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
async function occurrence(id: string, schedule: string, nominal: string, status = "completed") {
  await env.DB.prepare(
    "INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status) VALUES(?,?,?,?,?)",
  )
    .bind(id, schedule, nominal, nominal, status)
    .run();
}
test("interval history cannot hide a daily source's latest execution", async () => {
  await occurrence("synthetic-daily", "mizuho-bank", "2026-01-01T00:00:00.000Z");
  const inserts = Array.from({ length: 105 }, (_, i) => {
    const at = new Date(Date.parse("2026-01-01T01:00:00.000Z") + i * 300000).toISOString();
    return env.DB.prepare(
      "INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status) VALUES(?,'processor-tick',?,?,'completed')",
    ).bind(`synthetic-tick-${i}`, at, at);
  });
  await env.DB.batch(inserts);
  const snapshot = await scheduleSnapshot(env);
  expect(snapshot.occurrences.filter((o) => o.scheduleId === "processor-tick")).toHaveLength(100);
  expect(snapshot.occurrences.some((o) => o.id === "synthetic-daily")).toBe(true);
  expect(snapshot.schedules.find((s) => s.id === "mizuho-bank")?.latest?.id).toBe(
    "synthetic-daily",
  );
});
test("abandoned started receipts become uncertain without replay or invented finish time", async () => {
  await occurrence("synthetic-abandoned", "vpass", "2026-02-01T09:00:00.000Z", "started");
  await occurrence("synthetic-current", "vpass", "2026-02-01T10:05:00.000Z", "started");
  await markAbandonedOccurrences(env.DB, "2026-02-01T10:00:00.000Z");
  expect(
    await env.DB.prepare(
      "SELECT status,failure_code,finished_at FROM collection_schedule_occurrences WHERE id='synthetic-abandoned'",
    ).first<{ status: string; failure_code: string; finished_at: null }>(),
  ).toEqual({ status: "uncertain", failure_code: "dispatch_uncertain", finished_at: null });
  expect(
    await env.DB.prepare(
      "SELECT status FROM collection_schedule_occurrences WHERE id='synthetic-current'",
    ).first<string>("status"),
  ).toBe("started");
});
test("operator recovery requires stopped confirmation and exact active lease reference", async () => {
  const ref = "12345678-1234-4234-8234-123456789abc";
  await env.DB.prepare(
    "INSERT OR REPLACE INTO collection_execution_leases(source,lease_ref,started_at) VALUES('mizuho-bank',?,'2026-03-01T00:00:00.000Z')",
  )
    .bind(ref)
    .run();
  await expect(
    releaseCollectionLease(env, "mizuho-bank", { leaseRef: ref, confirmedStopped: false }),
  ).rejects.toThrow("confirmation_required");
  await expect(
    releaseCollectionLease(env, "mizuho-bank", {
      leaseRef: "00000000-0000-4000-8000-000000000000",
      confirmedStopped: true,
    }),
  ).rejects.toThrow("lease_conflict");
  expect((await scheduleSnapshot(env)).leases).toEqual([
    { source: "mizuho-bank", leaseRef: ref, startedAt: "2026-03-01T00:00:00.000Z" },
  ]);
  expect(
    await releaseCollectionLease(env, "mizuho-bank", { leaseRef: ref, confirmedStopped: true }),
  ).toEqual({ released: true });
  expect((await scheduleSnapshot(env)).leases).toEqual([]);
});
test("repeated releases still validate confirmation, reference and source", async () => {
  const ref = "12345678-1234-4234-8234-123456789abc";
  expect(
    await releaseCollectionLease(env, "mizuho-bank", { leaseRef: ref, confirmedStopped: true }),
  ).toEqual({ released: true });
  await expect(
    releaseCollectionLease(env, "mizuho-bank", { leaseRef: ref, confirmedStopped: false }),
  ).rejects.toThrow("confirmation_required");
  await expect(
    releaseCollectionLease(env, "mizuho-bank", { leaseRef: "invalid", confirmedStopped: true }),
  ).rejects.toThrow("confirmation_required");
  for (const [value, code] of [
    [null, "invalid_request"],
    [{ leaseRef: ref, confirmedStopped: true, extra: true }, "invalid_request"],
    [{ confirmedStopped: true }, "confirmation_required"],
    [{ leaseRef: null, confirmedStopped: true }, "confirmation_required"],
    [{ leaseRef: ref }, "confirmation_required"],
  ] as const)
    await expect(releaseCollectionLease(env, "mizuho-bank", value)).rejects.toThrow(code);
  await expect(
    releaseCollectionLease(env, "unknown-source", { leaseRef: ref, confirmedStopped: true }),
  ).rejects.toThrow("schedule_not_found");
  expect((await scheduleSnapshot(env)).leases).toEqual([]);
});

test("concurrent releases of the same reference both succeed with an empty lease", async () => {
  const ref = "12345678-1234-4234-8234-123456789abc";
  await env.DB.prepare(
    "UPDATE collection_execution_leases SET lease_ref=?,started_at='2026-03-01T00:00:00.000Z' WHERE source='mizuho-bank'",
  )
    .bind(ref)
    .run();
  expect(
    await Promise.all([
      releaseCollectionLease(env, "mizuho-bank", { leaseRef: ref, confirmedStopped: true }),
      releaseCollectionLease(env, "mizuho-bank", { leaseRef: ref, confirmedStopped: true }),
    ]),
  ).toEqual([{ released: true }, { released: true }]);
  expect(
    await env.DB.prepare(
      "SELECT lease_ref,started_at FROM collection_execution_leases WHERE source='mizuho-bank'",
    ).first<{ lease_ref: null; started_at: null }>(),
  ).toEqual({ lease_ref: null, started_at: null });
});

test("an old duplicate racing acquisition cannot clear the new execution's lease", async () => {
  const oldRef = "12345678-1234-4234-8234-123456789abc";
  let entered!: () => void, finish!: () => void;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const execution = withCollectionLease({ SCHEDULE_DB: env.DB }, "mizuho-bank", async () => {
    entered();
    await running;
  });
  // Depending on statement ordering, the duplicate succeeds before the new
  // claim or conflicts after it. Neither ordering may empty the new lease.
  const retry = releaseCollectionLease(env, "mizuho-bank", {
    leaseRef: oldRef,
    confirmedStopped: true,
  });
  try {
    const [result] = await Promise.allSettled([retry, acquired]);
    if (result!.status === "fulfilled") expect(result!.value).toEqual({ released: true });
    else expect(result!.reason).toMatchObject({ code: "lease_conflict", status: 409 });
    const current = await env.DB.prepare(
      "SELECT lease_ref,started_at FROM collection_execution_leases WHERE source='mizuho-bank'",
    ).first<{ lease_ref: string; started_at: string }>();
    expect(current!.lease_ref).not.toBe(oldRef);
    expect(current!.started_at).not.toBeNull();
    await expect(
      releaseCollectionLease(env, "mizuho-bank", {
        leaseRef: oldRef,
        confirmedStopped: true,
      }),
    ).rejects.toMatchObject({ code: "lease_conflict", status: 409 });
    expect(
      await env.DB.prepare(
        "SELECT lease_ref,started_at FROM collection_execution_leases WHERE source='mizuho-bank'",
      ).first<{ lease_ref: string; started_at: string }>(),
    ).toEqual(current);
  } finally {
    finish();
    await execution;
  }
  expect(
    await releaseCollectionLease(env, "mizuho-bank", {
      leaseRef: oldRef,
      confirmedStopped: true,
    }),
  ).toEqual({ released: true });
});

test("a missing source lease row is still a conflict", async () => {
  await env.DB.prepare("DELETE FROM collection_execution_leases WHERE source='sony-bank'").run();
  await expect(
    releaseCollectionLease(env, "sony-bank", {
      leaseRef: "12345678-1234-4234-8234-123456789abc",
      confirmedStopped: true,
    }),
  ).rejects.toMatchObject({ code: "lease_conflict", status: 409 });
});

test("occurrence identity remains immutable while closed outcome is mutable", async () => {
  await expect(
    env.DB.prepare(
      "UPDATE collection_schedule_occurrences SET nominal_at='2026-01-01T00:00:01.000Z' WHERE id='synthetic-daily'",
    ).run(),
  ).rejects.toThrow("immutable_occurrence_identity");
});

test("collection-only maintenance does not suppress session keepalive", async () => {
  await env.DB.prepare(
    "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) VALUES('synthetic-collection-only',1,'sbi-vc-trade','Asia/Tokyo',?,1,'https://www.sbivc.co.jp/','2026-01-01T00:00:00.000Z','collection','synthetic','2026-01-01T00:00:00.000Z')",
  )
    .bind(JSON.stringify({ kind: "weekly", weekdays: [1], start: "00:00", end: "01:00" }))
    .run();
  expect(
    (await maintenanceForSchedule(env.DB, { source: "sbi-vc-trade", kind: "collection" })).some(
      (r) => r.id === "synthetic-collection-only",
    ),
  ).toBe(true);
  expect(
    (await maintenanceForSchedule(env.DB, { source: "sbi-vc-trade", kind: "keepalive" })).some(
      (r) => r.id === "synthetic-collection-only",
    ),
  ).toBe(false);
  expect(
    (await maintenanceForSchedule(env.DB, { source: "sbi-vc-trade", kind: "keepalive" })).some(
      (r) => r.scope === "session",
    ),
  ).toBe(true);
});
