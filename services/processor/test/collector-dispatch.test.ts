// An accepted collection or session-refresh request, executed through the
// named collector RPC and followed to publication or a closed reason (issue
// #544, ADR 0048).
//
// Synthetic throughout: the `kogane-synthetic` source, a synthetic connection
// table entry and a fake collector binding that persists a synthetic run into
// the in-memory DATA bucket. CORE is the real schema (every migration); the
// registration is the real one; the parse lane's effect is written with the
// same statements the pipeline writer uses (publication-gate.md). No amount,
// account, merchant, credential or provider text appears.
import { beforeAll, expect, spyOn, test } from "bun:test";
import {
  claimCollectorStart,
  d1CommandStore,
  readOperation,
  requestCollection,
  requestSessionRefresh,
  type CommandStore,
  type OperationReceipt,
  type Principal,
} from "../../../packages/application/src/index.ts";
import type { OperationConnection } from "../../../packages/collection/src/operation-rpc.ts";
import * as scheduleModel from "../../../packages/collection/src/schedule-model.ts";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import {
  collectorDispatchConnections,
  dispatchOperations,
  type CollectorRpc,
  type DispatchOptions,
} from "../src/operations/dispatch.ts";
import {
  collectionHarness,
  persistSyntheticRun,
  rows,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const PRINCIPAL: Principal = {
  id: "operator-1",
  kind: "human",
  verification: "server",
  capabilities: [],
};
const ACCEPTED_AT = "2026-09-11T00:00:00Z";
const T0 = Date.parse(ACCEPTED_AT);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const COLLECT: OperationConnection = {
  connectionId: "synthetic",
  workspace: "collector-synthetic",
  source: SOURCE,
  terminalSource: SOURCE,
  action: "collect",
  cron: "0 0 * * *",
};
const REFRESH: OperationConnection = {
  ...COLLECT,
  connectionId: "synthetic-keepalive",
  action: "refresh-session",
  cron: "*/15 * * * *",
};

interface World extends CollectionHarness {
  store: CommandStore;
  calls: unknown[];
  /** What the fake collector does when called; persists one synthetic run by default. */
  answer: (request: unknown) => Promise<unknown>;
  tick(at: number, extra?: Partial<DispatchOptions>): ReturnType<typeof dispatchOperations>;
}

function world(options: { enabled?: string; connections?: OperationConnection[] } = {}): World {
  const harness = collectionHarness({
    OPS_DISPATCH_ENABLED: "true",
    OPS_COLLECTOR_DISPATCH_CONNECTIONS:
      options.enabled ?? JSON.stringify(["synthetic", "synthetic-keepalive"]),
  });
  const calls: unknown[] = [];
  const self: World = {
    ...harness,
    store: d1CommandStore(sqliteD1(harness.db) as never),
    calls,
    answer: async () => {
      await persistSyntheticRun(harness, { run: { runId: "op-run-001" } });
      return { status: "completed", runIds: ["op-run-001"], failureCode: null };
    },
    tick: (at, extra = {}) => {
      const rpc: CollectorRpc = {
        async runOperation(request) {
          calls.push(request);
          return self.answer(request);
        },
      };
      return dispatchOperations(harness.env, {
        now: () => new Date(at),
        connections: options.connections ?? [COLLECT, REFRESH],
        collectors: () => rpc,
        ...extra,
      });
    },
  };
  return self;
}

async function collect(w: World, idempotencyKey = "manual-1"): Promise<string> {
  const accepted = await requestCollection({
    store: w.store,
    principal: PRINCIPAL,
    now: ACCEPTED_AT,
    request: {
      source: SOURCE,
      requestedScope: { from: "2026-09-01", to: "2026-09-10" },
      idempotencyKey,
    },
  });
  if (!accepted.ok) throw new Error(`acceptance failed: ${accepted.error}`);
  return accepted.receipt.operationId;
}

async function refresh(w: World, mode: "unattended" | "human"): Promise<string> {
  const accepted = await requestSessionRefresh({
    store: w.store,
    principal: PRINCIPAL,
    now: ACCEPTED_AT,
    request: { source: SOURCE, idempotencyKey: "refresh-1" },
    policy: () => mode,
  });
  if (!accepted.ok) throw new Error(`acceptance failed: ${accepted.error}`);
  return accepted.receipt.operationId;
}

async function read(w: World, operationId: string): Promise<OperationReceipt> {
  const outcome = await readOperation({
    store: w.store,
    principal: PRINCIPAL,
    now: ACCEPTED_AT,
    operationId,
  });
  if (!outcome.ok) throw new Error("receipt missing");
  return outcome.receipt;
}

const stages = (receipt: OperationReceipt) =>
  receipt.stages.map((entry) => `${entry.stage}:${entry.state}`);

/** The parse lane's effect on one artifact: a done job, an ok parse, its publication. */
function publishArtifact(w: World, artifactKey: string): void {
  const artifact = w.db
    .query("SELECT id FROM fetch_artifacts WHERE artifact_key=?")
    .get(artifactKey) as { id: number };
  w.db.run(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,'synthetic-parser','1.0.0','done')",
    [artifact.id],
  );
  const parse = w.db.run(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'synthetic-parser','1.0.0','2026-09-11','ok','[]')",
    [artifact.id],
  );
  const parseRunId = Number(parse.lastInsertRowid);
  w.db.run(
    "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,'synthetic-parser',NULL,?,'normal','pipeline','parse_ok','2026-09-11T00:20:00Z')",
    [artifact.id, parseRunId],
  );
  w.db.run(
    "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'synthetic-parser',?,'1.0.0','2026-09-11T00:20:00Z','normal')",
    [artifact.id, parseRunId],
  );
}

/** The sealed run's parse scheduling has looked at every artifact. */
function workItemProcessed(w: World): void {
  w.db.run(
    "UPDATE observation_work_items SET processed_at_ms=?,outcome='jobs_created' WHERE processed_at_ms IS NULL",
    [T0 + 20 * MINUTE],
  );
}

test("the connection list is a closed JSON array; anything else enables none", () => {
  expect([...collectorDispatchConnections(undefined)]).toEqual([]);
  expect([...collectorDispatchConnections("")]).toEqual([]);
  expect([...collectorDispatchConnections("sony-bank")]).toEqual([]);
  expect([...collectorDispatchConnections('{"sony-bank":true}')]).toEqual([]);
  expect([...collectorDispatchConnections("[1]")]).toEqual([]);
  expect([...collectorDispatchConnections('["sony-bank"]')]).toEqual(["sony-bank"]);
});

test("success: accepted, started, collected and published are distinct, timestamped states", async () => {
  const w = world();
  const operationId = await collect(w);

  // Accepted: stored, nothing executed, and the record says so.
  const accepted = await read(w, operationId);
  expect(accepted.execution).toMatchObject({
    action: "collect",
    state: "accepted",
    connectionId: null,
    scope: "collector_default",
    expiresAt: "2026-09-12T00:00:00.000Z",
    startedAt: null,
    runs: [],
  });

  // Tick 1: the named RPC is called once, with identifiers only.
  const startedAt = T0 + 5 * MINUTE;
  expect(await w.tick(startedAt)).toMatchObject({ claimed: 1, started: 1, awaiting: 0 });
  expect(w.calls).toEqual([
    {
      version: "kogane-collector-operation-v1",
      operationId,
      connectionId: "synthetic",
      source: SOURCE,
      action: "collect",
      requestedAtMs: startedAt,
    },
  ]);
  const collected = await read(w, operationId);
  expect(collected.status).toBe("running");
  expect(collected.dispatch.state).toBe("dispatched");
  expect(collected.targetRef).toBe("collector:synthetic");
  expect(collected.execution).toMatchObject({
    state: "collected",
    connectionId: "synthetic",
    startedAt: new Date(startedAt).toISOString(),
    collectedAt: new Date(startedAt).toISOString(),
    publishedAt: null,
    runs: [{ runId: "op-run-001", state: "not_registered", evidenceRunId: null }],
  });
  // The terminal is the `persisted` evidence; nothing later is claimed.
  expect(stages(collected)).toEqual([
    "persisted:completed",
    "registered:pending",
    "parsed:pending",
    "adopted:pending",
    "projected:pending",
  ]);

  // The terminal is registered (the Processor's real registration).
  expect(await registerCollectionRun(w.env, { source: SOURCE, runId: "op-run-001" })).toMatchObject(
    { outcome: "registered" },
  );
  expect(await w.tick(startedAt + 5 * MINUTE)).toMatchObject({ tracked: 1, published: 0 });
  const registered = await read(w, operationId);
  expect(registered.execution?.state).toBe("collected");
  expect(registered.execution?.runs[0]).toMatchObject({
    state: "parsing",
    providerOutcome: "success",
    evidenceRunId: expect.stringMatching(/^r_\d+$/u),
    artifacts: { total: 2, parseSelected: 0, published: 0, pending: 0 },
  });
  expect(stages(registered).slice(0, 3)).toEqual([
    "persisted:completed",
    "registered:completed",
    "parsed:pending",
  ]);

  // The parse lane selects one artifact and publishes it; the other is
  // evidence no parser reads.
  publishArtifact(w, "balance.json");
  workItemProcessed(w);
  const publishedAt = startedAt + 10 * MINUTE;
  expect(await w.tick(publishedAt)).toMatchObject({ tracked: 1, published: 1 });
  const published = await read(w, operationId);
  expect(published.execution).toMatchObject({
    state: "published",
    publishedAt: new Date(publishedAt).toISOString(),
    finishedAt: new Date(publishedAt).toISOString(),
    reasonCode: null,
    runs: [
      {
        runId: "op-run-001",
        state: "published",
        artifacts: {
          total: 2,
          parseSelected: 1,
          published: 1,
          pending: 0,
          parseFailed: 0,
          notPublished: 0,
        },
      },
    ],
  });
  // READ projection of the run is not traced: `projected` stays pending and
  // the request is not reported complete (ADR 0048, limits).
  expect(stages(published)).toEqual([
    "persisted:completed",
    "registered:completed",
    "parsed:completed",
    "adopted:completed",
    "projected:pending",
  ]);
  expect(published.status).toBe("running");

  // Nothing further happens: no second call, nothing left to track.
  expect(await w.tick(publishedAt + HOUR)).toMatchObject({ claimed: 0, started: 0, tracked: 0 });
  expect(w.calls).toHaveLength(1);
});

test("resend with the same key is the same operation and never a second run", async () => {
  const w = world();
  const operationId = await collect(w, "same-key");
  await w.tick(T0 + MINUTE);
  expect(w.calls).toHaveLength(1);
  // The same key again, before and after the run: one operation, one call.
  expect(await collect(w, "same-key")).toBe(operationId);
  expect(await w.tick(T0 + 2 * MINUTE)).toMatchObject({ claimed: 0, started: 0 });
  expect(await collect(w, "same-key")).toBe(operationId);
  await w.tick(T0 + 10 * MINUTE);
  expect(w.calls).toHaveLength(1);
  expect(rows(w.db, "SELECT count(*) AS n FROM ops_collector_dispatches")).toEqual([{ n: 1 }]);
  // A new key is a new request — which is how an operator asks again.
  const second = await collect(w, "second-key");
  expect(second).not.toBe(operationId);
});

test("a started execution is claimed once even when two ticks race", async () => {
  const w = world();
  const operationId = await collect(w);
  const store = w.store;
  const context = {
    store,
    operationId,
    action: "collect" as const,
    acceptedAt: ACCEPTED_AT,
    expiresAt: "2026-09-12T00:00:00.000Z",
    now: "2026-09-11T00:01:00.000Z",
  };
  const binding = { connectionId: "synthetic", terminalSource: SOURCE };
  expect(await claimCollectorStart({ ...context, binding })).toBe(true);
  expect(await claimCollectorStart({ ...context, binding, now: "2026-09-11T00:01:01.000Z" })).toBe(
    false,
  );
  // The row cannot be put back to waiting, deleted or started twice.
  expect(() =>
    w.db.run("UPDATE ops_collector_dispatches SET state='waiting' WHERE operation_id=?", [
      operationId,
    ]),
  ).toThrow(/only moves forward/u);
  expect(() =>
    w.db.run("DELETE FROM ops_collector_dispatches WHERE operation_id=?", [operationId]),
  ).toThrow(/never deleted/u);
});

test("failure: the collector's closed code ends the operation, and it is never retried", async () => {
  const w = world();
  // The collector persisted a failed terminal and says so: the run is kept
  // on the operation, so the trail shows what was written.
  w.answer = async () => ({
    status: "failed",
    runIds: ["failed-run-001"],
    failureCode: "collection_failed",
  });
  const operationId = await collect(w);
  expect(await w.tick(T0 + MINUTE)).toMatchObject({ started: 1 });
  const failed = await read(w, operationId);
  expect(failed.status).toBe("failed");
  expect(failed.failureCode).toBe("collection_failed");
  expect(failed.execution).toMatchObject({
    state: "failed",
    reasonCode: "collection_failed",
    finishedAt: "2026-09-11T00:01:00.000Z",
    collectedAt: null,
    runs: [{ runId: "failed-run-001", state: "not_registered" }],
  });
  await w.tick(T0 + 2 * HOUR);
  expect(await collect(w)).toBe(operationId);
  await w.tick(T0 + 3 * HOUR);
  expect(w.calls).toHaveLength(1);
});

test("a collector that cannot be heard from is uncertain, never replayed", async () => {
  const w = world();
  w.answer = async () => {
    throw new Error("synthetic transport failure");
  };
  const operationId = await collect(w);
  await w.tick(T0 + MINUTE);
  const uncertain = await read(w, operationId);
  expect(uncertain.execution).toMatchObject({
    state: "uncertain",
    reasonCode: "dispatch_uncertain",
  });
  expect(uncertain.status).toBe("failed");
  // A malformed answer arrived after the call: also uncertain.
  const other = world();
  other.answer = async () => ({ status: "completed", runIds: ["bad id with spaces"] });
  const second = await collect(other);
  await other.tick(T0 + MINUTE);
  expect((await read(other, second)).execution).toMatchObject({
    state: "uncertain",
    reasonCode: "collector_result_invalid",
  });
  await w.tick(T0 + 5 * HOUR);
  expect(w.calls).toHaveLength(1);
});

test("a start whose outcome was never recorded becomes uncertain after an hour", async () => {
  const w = world();
  const operationId = await collect(w);
  await claimCollectorStart({
    store: w.store,
    operationId,
    action: "collect",
    acceptedAt: ACCEPTED_AT,
    expiresAt: "2026-09-12T00:00:00.000Z",
    now: "2026-09-11T00:01:00.000Z",
    binding: { connectionId: "synthetic", terminalSource: SOURCE },
  });
  expect(await w.tick(T0 + 30 * MINUTE)).toMatchObject({ abandoned: 0 });
  expect(await w.tick(T0 + MINUTE + HOUR + 1)).toMatchObject({ abandoned: 1 });
  const receipt = await read(w, operationId);
  expect(receipt.execution).toMatchObject({ state: "uncertain", reasonCode: "dispatch_uncertain" });
  expect(receipt.status).toBe("failed");
  expect(w.calls).toHaveLength(0);
});

test("lease conflict: a held lease makes the request wait; it is never taken or released", async () => {
  const w = world();
  const lease = "11111111-2222-4333-8444-555555555555";
  w.db.run(
    "INSERT INTO collection_execution_leases(source,lease_ref,started_at) VALUES(?,?,'2026-09-11T00:00:30.000Z')",
    [SOURCE, lease],
  );
  const operationId = await collect(w);
  expect(await w.tick(T0 + MINUTE)).toMatchObject({ awaiting: 1, started: 0 });
  const waiting = await read(w, operationId);
  expect(waiting.execution).toMatchObject({
    state: "waiting",
    reasonCode: "collection_lease_held",
    waits: 1,
  });
  expect(waiting.dispatch.state).toBe("dispatch_pending");
  expect(waiting.status).toBe("accepted");
  expect(w.calls).toHaveLength(0);
  // The lease is exactly as the other execution left it.
  expect(rows(w.db, "SELECT source,lease_ref FROM collection_execution_leases")).toEqual([
    { source: SOURCE, lease_ref: lease },
  ]);
  // It is not looked at again before its retry time.
  expect(await w.tick(T0 + 3 * MINUTE)).toMatchObject({ claimed: 0 });

  // The other execution finishes and releases its own lease; the request starts.
  w.db.run("UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL WHERE source=?", [
    SOURCE,
  ]);
  expect(await w.tick(T0 + 7 * MINUTE)).toMatchObject({ started: 1 });
  expect((await read(w, operationId)).execution).toMatchObject({ state: "collected", waits: 1 });
});

test("lease conflict found by the collector itself declines with collection_busy", async () => {
  // The lease was free when the lane looked and taken before the collector
  // claimed it: the collector refuses before contacting anyone.
  const w = world();
  w.answer = async () => ({ status: "failed", runIds: [], failureCode: "collection_busy" });
  const operationId = await collect(w);
  await w.tick(T0 + MINUTE);
  const receipt = await read(w, operationId);
  expect(receipt.execution).toMatchObject({ state: "failed", reasonCode: "collection_busy" });
  expect(receipt.failureCode).toBe("collection_busy");
  expect(rows(w.db, "SELECT count(*) AS n FROM collection_execution_leases")).toEqual([{ n: 0 }]);
});

test("unsupported session refresh ends with a closed terminal code and contacts nobody", async () => {
  const w = world({ connections: [COLLECT] });
  const operationId = await refresh(w, "unattended");
  expect(await w.tick(T0 + MINUTE)).toMatchObject({ declined: 1, started: 0 });
  const receipt = await read(w, operationId);
  expect(receipt.status).toBe("blocked");
  expect(receipt.failureCode).toBe("session_refresh_unsupported");
  expect(receipt.dispatch.state).toBe("dispatch_failed");
  expect(receipt.execution).toMatchObject({
    action: "refresh-session",
    state: "unsupported",
    reasonCode: "session_refresh_unsupported",
    connectionId: null,
    scope: null,
  });
  expect(w.calls).toHaveLength(0);
  // A collection for a source no connection serves is declined the same way.
  const none = world({ connections: [] });
  const collection = await collect(none);
  await none.tick(T0 + MINUTE);
  expect((await read(none, collection)).execution).toMatchObject({
    state: "unsupported",
    reasonCode: "collection_unsupported",
  });
});

test("a refresh a person must do waits for them and is never dispatched", async () => {
  const w = world();
  const operationId = await refresh(w, "human");
  expect(await w.tick(T0 + MINUTE)).toMatchObject({ claimed: 0 });
  const receipt = await read(w, operationId);
  expect(receipt.status).toBe("waiting_for_human");
  expect(receipt.execution).toMatchObject({
    state: "waiting_for_human",
    expiresAt: null,
    connectionId: null,
  });
  expect(w.calls).toHaveLength(0);
});

test("a supported unattended refresh runs the keepalive connection and completes", async () => {
  const w = world();
  w.answer = async () => ({ status: "completed", runIds: [], failureCode: null });
  const operationId = await refresh(w, "unattended");
  await w.tick(T0 + MINUTE);
  expect(w.calls).toEqual([
    expect.objectContaining({ connectionId: "synthetic-keepalive", action: "refresh-session" }),
  ]);
  const receipt = await read(w, operationId);
  expect(receipt.status).toBe("completed");
  expect(receipt.execution).toMatchObject({ state: "refreshed", finishedAt: expect.any(String) });
});

test("expiry: a request not started within 24 hours expires without contacting anyone", async () => {
  // The connection is not enabled for dispatch: the request waits, says why,
  // and expires on time instead of firing whenever someone enables it.
  const w = world({ enabled: "" });
  const operationId = await collect(w);
  expect(await w.tick(T0 + MINUTE)).toMatchObject({ awaiting: 1 });
  expect((await read(w, operationId)).execution).toMatchObject({
    state: "waiting",
    reasonCode: "collector_dispatch_disabled",
  });
  for (let hour = 1; hour < 24; hour += 1) await w.tick(T0 + hour * HOUR + MINUTE);
  expect(w.calls).toHaveLength(0);
  expect(await w.tick(T0 + 24 * HOUR)).toMatchObject({ declined: 1 });
  const receipt = await read(w, operationId);
  expect(receipt.execution).toMatchObject({
    state: "expired",
    reasonCode: "operation_expired",
    finishedAt: "2026-09-12T00:00:00.000Z",
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.failureCode).toBe("operation_expired");
  expect(w.calls).toHaveLength(0);
});

test("an open maintenance window defers the start until it closes", async () => {
  const w = world();
  w.db.run(
    `INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,
      reference_url,verified_at,scope,actor,created_at)
     VALUES('synthetic-window',1,?,'UTC','{"kind":"weekly","weekdays":[0,1,2,3,4,5,6],"start":"00:00","end":"02:00"}',
      1,'https://example.invalid/maintenance','2026-09-01T00:00:00.000Z','collection','synthetic','2026-09-01T00:00:00.000Z')`,
    [SOURCE],
  );
  const operationId = await collect(w);
  await w.tick(T0 + MINUTE);
  expect((await read(w, operationId)).execution).toMatchObject({
    state: "waiting",
    reasonCode: "provider_maintenance",
  });
  expect(await w.tick(T0 + HOUR)).toMatchObject({ claimed: 0 });
  expect(await w.tick(T0 + 2 * HOUR)).toMatchObject({ started: 1 });
});

test("maintenance windows that never close make the request wait instead of failing the lane", async () => {
  // Windows that chain into each other forever make the alarm's
  // `afterMaintenance` throw `maintenance_unavailable` (after a thousand
  // windows, which is slow, so the throw is stood in for here). The request
  // waits, contacting nobody, and the rest of the tick still runs.
  const w = world();
  const operationId = await collect(w);
  const unavailable = spyOn(scheduleModel, "afterMaintenance").mockImplementation(() => {
    throw new Error("maintenance_unavailable");
  });
  try {
    expect(await w.tick(T0 + MINUTE)).toMatchObject({ awaiting: 1, started: 0 });
  } finally {
    unavailable.mockRestore();
  }
  expect((await read(w, operationId)).execution).toMatchObject({
    state: "waiting",
    reasonCode: "provider_maintenance",
  });
  expect(w.calls).toHaveLength(0);
  // Looked at again an hour later, when the windows are read afresh.
  expect(await w.tick(T0 + 30 * MINUTE)).toMatchObject({ claimed: 0 });
  expect(await w.tick(T0 + MINUTE + HOUR)).toMatchObject({ started: 1 });
});

test("one collector start per tick; the next request waits for the next tick", async () => {
  const w = world();
  const first = await collect(w, "first");
  const second = await collect(w, "second");
  expect(await w.tick(T0 + MINUTE)).toMatchObject({ claimed: 2, started: 1, awaiting: 1 });
  const states = [
    (await read(w, first)).execution?.state,
    (await read(w, second)).execution?.state,
  ].sort();
  expect(states).toEqual(["collected", "waiting"]);
  w.answer = async () => ({ status: "completed", runIds: ["op-run-002"], failureCode: null });
  expect(await w.tick(T0 + 7 * MINUTE)).toMatchObject({ started: 1 });
  expect(w.calls).toHaveLength(2);
});

test("a run that never reaches CORE is reported unpublished after the horizon", async () => {
  const w = world();
  w.answer = async () => ({ status: "completed", runIds: ["never-registered"], failureCode: null });
  const operationId = await collect(w);
  await w.tick(T0 + MINUTE);
  expect(await w.tick(T0 + 47 * HOUR)).toMatchObject({ tracked: 1, unpublished: 0 });
  expect(await w.tick(T0 + MINUTE + 48 * HOUR)).toMatchObject({ unpublished: 1 });
  const receipt = await read(w, operationId);
  expect(receipt.execution).toMatchObject({
    state: "unpublished",
    reasonCode: "publication_not_observed",
    runs: [{ runId: "never-registered", state: "not_registered" }],
  });
  expect(receipt.status).toBe("failed");
  expect(receipt.stages.find((stage) => stage.stage === "registered")).toMatchObject({
    state: "blocked",
    failureCode: "publication_not_observed",
  });
});

test("a run whose artifacts no parser selects ends unpublished with that reason", async () => {
  const w = world();
  const operationId = await collect(w);
  await w.tick(T0 + MINUTE);
  await registerCollectionRun(w.env, { source: SOURCE, runId: "op-run-001" });
  workItemProcessed(w);
  expect(await w.tick(T0 + 10 * MINUTE)).toMatchObject({ unpublished: 1 });
  const receipt = await read(w, operationId);
  expect(receipt.execution).toMatchObject({
    state: "unpublished",
    reasonCode: "no_parser_selected",
    runs: [
      {
        state: "unpublished",
        reasonCode: "no_parser_selected",
        artifacts: { total: 2, parseSelected: 0 },
      },
    ],
  });
  expect(stages(receipt)).toEqual([
    "persisted:completed",
    "registered:completed",
    "parsed:blocked",
    "adopted:blocked",
    "projected:pending",
  ]);
});

test("the stored execution carries identifiers, codes and timestamps only", async () => {
  const w = world();
  const operationId = await collect(w);
  await w.tick(T0 + MINUTE);
  const [row] = rows<Record<string, unknown>>(
    w.db,
    "SELECT * FROM ops_collector_dispatches WHERE operation_id=?",
    operationId,
  );
  expect(Object.keys(row!).sort()).toEqual(
    [
      "accepted_at",
      "action",
      "collected_at",
      "connection_id",
      "expires_at",
      "finished_at",
      "next_check_at_ms",
      "operation_id",
      "published_at",
      "reason_code",
      "run_ids_json",
      "started_at",
      "starts",
      "state",
      "terminal_source",
      "updated_at",
      "waits",
    ].sort(),
  );
  expect(row).toMatchObject({ run_ids_json: '["op-run-001"]', starts: 1 });
});
