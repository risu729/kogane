// The Processor frees a collection execution lease whose holder went silent
// (ADR 0085), on D1's clock, and records each release on the `alarm` path.
// Every value is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import { expireStaleLeases } from "../src/schedule-store.ts";
import { startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  env = started.env as unknown as Env;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

const minutesAgo = (minutes: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${minutes} minutes')`;
async function hold(source: string, ref: string, started: string, heartbeat: string | null) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO collection_execution_leases(source,lease_ref,started_at,heartbeat_at) VALUES(?,?,${started},${heartbeat ?? "NULL"})`,
  )
    .bind(source, ref)
    .run();
}
async function lease(source: string) {
  return env.DB.prepare(
    "SELECT lease_ref,started_at,heartbeat_at FROM collection_execution_leases WHERE source=?",
  )
    .bind(source)
    .first<{ lease_ref: string | null; started_at: string | null; heartbeat_at: string | null }>();
}
async function expiryRecords() {
  const rows = await env.DB.prepare(
    "SELECT path,principal,principal_kind,operation,risk_class,result,target_ref,scope_namespace,scope_source,diff_json FROM audit_records WHERE operation='alarm.lease.expire' ORDER BY target_ref",
  ).all<Record<string, unknown>>();
  return rows.results;
}

test("a silent lease is freed and recorded; a live or young one is left alone", async () => {
  await hold("vpass", "4e1a2b3c-0000-4000-8000-0000000000a1", minutesAgo(20), minutesAgo(11));
  await hold("myjcb", "4e1a2b3c-0000-4000-8000-0000000000a2", minutesAgo(20), minutesAgo(2));
  // Claimed before heartbeats existed: judged by its age.
  await hold("mizuho-bank", "4e1a2b3c-0000-4000-8000-0000000000a3", minutesAgo(61), null);
  await hold("sony-bank", "4e1a2b3c-0000-4000-8000-0000000000a4", minutesAgo(30), null);
  const occurrencesBefore = await env.DB.prepare(
    "SELECT count(*) AS n FROM collection_schedule_occurrences",
  ).first<number>("n");

  expect(await expireStaleLeases(env.DB)).toBe(2);

  expect(await lease("vpass")).toEqual({ lease_ref: null, started_at: null, heartbeat_at: null });
  expect(await lease("mizuho-bank")).toEqual({
    lease_ref: null,
    started_at: null,
    heartbeat_at: null,
  });
  expect((await lease("myjcb"))?.lease_ref).toBe("4e1a2b3c-0000-4000-8000-0000000000a2");
  expect((await lease("sony-bank"))?.lease_ref).toBe("4e1a2b3c-0000-4000-8000-0000000000a4");
  expect(await expiryRecords()).toEqual(
    ["mizuho-bank", "vpass"].map((source) => ({
      path: "alarm",
      principal: "alarm:processor-tick",
      principal_kind: "automatic",
      operation: "alarm.lease.expire",
      risk_class: "R2",
      result: "applied",
      target_ref: `collection-lease:${source}`,
      scope_namespace: "schedule-source",
      scope_source: source,
      diff_json: '{"kind":"release","released":true}',
    })),
  );
  // Freeing a lease starts nothing and replays nothing.
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM collection_schedule_occurrences").first<number>(
      "n",
    ),
  ).toBe(occurrencesBefore);
  // A second tick finds nothing more to free and records nothing more.
  expect(await expireStaleLeases(env.DB)).toBe(0);
  expect(await expiryRecords()).toHaveLength(2);
}, 60_000);

test("a holder writes its heartbeat on D1's clock and clears it with its lease", async () => {
  let during: Awaited<ReturnType<typeof lease>> = null;
  await withCollectionLease({ SCHEDULE_DB: env.DB as never }, "sbi-securities", async () => {
    during = await lease("sbi-securities");
    // A live holder is never freed.
    expect(await expireStaleLeases(env.DB)).toBe(0);
  });
  expect(during!.lease_ref).not.toBeNull();
  expect(during!.heartbeat_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  expect(await lease("sbi-securities")).toEqual({
    lease_ref: null,
    started_at: null,
    heartbeat_at: null,
  });
}, 60_000);

test("a heartbeat that lands between the read and the release wins, and nothing is recorded", async () => {
  await hold(
    "prestia-bank",
    "4e1a2b3c-0000-4000-8000-0000000000b1",
    minutesAgo(20),
    minutesAgo(12),
  );
  const before = (await expiryRecords()).length;
  const racing = new Proxy(env.DB, {
    get(target, key, receiver) {
      if (key !== "batch") return Reflect.get(target, key, receiver);
      return async (statements: D1PreparedStatement[]) => {
        // The holder proves it is alive just before the release runs.
        await target
          .prepare(
            "UPDATE collection_execution_leases SET heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source='prestia-bank'",
          )
          .run();
        return target.batch(statements);
      };
    },
  });
  expect(await expireStaleLeases(racing)).toBe(0);
  expect((await lease("prestia-bank"))?.lease_ref).toBe("4e1a2b3c-0000-4000-8000-0000000000b1");
  expect(await expiryRecords()).toHaveLength(before);
}, 60_000);

test("an operator release between the read and the release records nothing: changes() is the release's own", async () => {
  await hold(
    "mobile-suica",
    "4e1a2b3c-0000-4000-8000-0000000000c1",
    minutesAgo(20),
    minutesAgo(12),
  );
  const before = (await expiryRecords()).length;
  const racing = new Proxy(env.DB, {
    get(target, key, receiver) {
      if (key !== "batch") return Reflect.get(target, key, receiver);
      return async (statements: D1PreparedStatement[]) => {
        // The operator frees the lease first: the source is unlocked, and the
        // last statement before the batch changed one row.
        await target
          .prepare(
            "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL,heartbeat_at=NULL WHERE source='mobile-suica'",
          )
          .run();
        return target.batch(statements);
      };
    },
  });
  expect(await expireStaleLeases(racing)).toBe(0);
  expect((await lease("mobile-suica"))?.lease_ref).toBeNull();
  expect(await expiryRecords()).toHaveLength(before);
}, 60_000);

test("a claim by a build without heartbeats under a heartbeat left behind is judged by its age", async () => {
  // An older build's release cleared the reference but left the previous
  // holder's heartbeat; an older build's claim then wrote no new one.
  await hold(
    "moneyforward-me",
    "4e1a2b3c-0000-4000-8000-0000000000d1",
    minutesAgo(5),
    minutesAgo(30),
  );
  // The same shape once its claim is an hour old.
  await hold("vpoint", "4e1a2b3c-0000-4000-8000-0000000000d2", minutesAgo(61), minutesAgo(90));
  expect(await expireStaleLeases(env.DB)).toBe(1);
  expect((await lease("moneyforward-me"))?.lease_ref).toBe("4e1a2b3c-0000-4000-8000-0000000000d1");
  expect((await lease("vpoint"))?.lease_ref).toBeNull();
}, 60_000);
