// The Processor half of the operations API (unified plan 02 §5, U06 → U08).
//
// The rule every test here checks is the one contracts/stages.json states:
// **handing work over is not completing it**. A dispatched replay, a
// projection that will run on the next tick and a collector call that does
// not exist yet must all leave the operation short of `completed`.
//
// Synthetic throughout: `kogane-synthetic`, no amount, no account, no token.
import { beforeAll, expect, test } from "bun:test";
import {
  d1CommandStore,
  type CommandStore,
  type Principal,
} from "../../../packages/application/src/index.ts";
import {
  readOperation,
  requestCollection,
  requestImport,
  requestProjectionRebuild,
} from "../../../packages/application/src/operations/requests.ts";
import { RegistrationBudget } from "../../../packages/application/src/collection/index.ts";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { dispatchOperations, opsDispatchEnabled } from "../src/operations/dispatch.ts";
import {
  collectionHarness,
  persistSyntheticRun,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget, not inside whichever test first asks for a copy
// (see packages/storage-d1/test/sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const PRINCIPAL: Principal = {
  id: "operator-1",
  kind: "human",
  verification: "server",
  capabilities: [],
};
const NOW = "2026-09-11T00:00:00Z";

function withDispatch(vars: Record<string, string> = {}): CollectionHarness & {
  store: CommandStore;
} {
  const harness = collectionHarness({ OPS_DISPATCH_ENABLED: "true", ...vars });
  return { ...harness, store: d1CommandStore(sqliteD1(harness.db) as never) };
}

const receipt = (harness: { store: CommandStore }, operationId: string) =>
  readOperation({ store: harness.store, principal: PRINCIPAL, now: NOW, operationId });

/**
 * A receipt lists every stage the kind can reach; one with no row of its own
 * reads `pending`. These helpers make the assertions say which stages *moved*
 * rather than restating the whole ladder each time.
 */
const stageStates = (stages: readonly { stage: string; state: string }[]) =>
  stages.map((entry) => `${entry.stage}:${entry.state}`);
const stageOf = (
  stages: readonly { stage: string; state: string }[],
  stage: string,
): { stage: string; state: string } | undefined => stages.find((entry) => entry.stage === stage);

test("the lane is off unless OPS_DISPATCH_ENABLED is set, and off is not done", async () => {
  expect(opsDispatchEnabled(undefined)).toBe(false);
  expect(opsDispatchEnabled("no")).toBe(false);
  expect(opsDispatchEnabled("1")).toBe(true);
  const harness = withDispatch({ OPS_DISPATCH_ENABLED: "false" });
  await persistSyntheticRun(harness);
  const accepted = await requestImport({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, runId: "run-001" },
  });
  expect(accepted.ok).toBe(true);

  expect(await dispatchOperations(harness.env)).toMatchObject({
    enabled: false,
    status: "skipped",
    claimed: 0,
  });
  // Nothing was dispatched and, above all, nothing was completed.
  const record = await receipt(harness, accepted.ok ? accepted.receipt.operationId : "");
  expect(record.ok && record.receipt.status).toBe("accepted");
  expect(record.ok && record.receipt.dispatch.state).toBe("dispatch_pending");
  // Every stage is still untouched: an unset flag is not progress.
  expect(record.ok && stageStates(record.receipt.stages)).toEqual([
    "registered:pending",
    "parsed:pending",
    "adopted:pending",
    "projected:pending",
  ]);
});

test("an import request registers the stored terminal and completes only that stage", async () => {
  const harness = withDispatch();
  await persistSyntheticRun(harness);
  const accepted = await requestImport({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, runId: "run-001" },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  const operationId = accepted.receipt.operationId;

  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 1, dispatched: 1 });
  const record = await receipt(harness, operationId);
  if (!record.ok) throw new Error("receipt missing");
  expect(record.receipt.dispatch.state).toBe("dispatched");
  expect(record.receipt.targetRef).toBe("run:1");
  expect(stageOf(record.receipt.stages, "registered")).toMatchObject({
    state: "completed",
    evidenceRef: "run:1",
    failureCode: null,
    attempts: 1,
  });
  // Only that one moved; nothing parsed, adopted or projected anything.
  expect(stageStates(record.receipt.stages)).toEqual([
    "registered:completed",
    "parsed:pending",
    "adopted:pending",
    "projected:pending",
  ]);
  // An import reaches `registered`, `parsed`, `adopted` and `projected`; only
  // the first of them happened, so the request is not complete.
  expect(record.receipt.status).toBe("accepted");

  // Nothing is left pending, so a second pass claims nothing.
  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 0 });
});

test("an import whose terminal is not there stays pending and is never failed away", async () => {
  const harness = withDispatch();
  const accepted = await requestImport({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, runId: "run-404" },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 1, retried: 1 });
  const record = await receipt(harness, accepted.receipt.operationId);
  if (!record.ok) throw new Error("receipt missing");
  expect(record.receipt.dispatch.state).toBe("dispatch_pending");
  expect(record.receipt.failureCode).toBe("terminal_not_found");
  expect(stageStates(record.receipt.stages).every((entry) => entry.endsWith(":pending"))).toBe(
    true,
  );
  expect(record.receipt.status).toBe("accepted");
});

test("an import the tick's registration budget cannot start waits for a later tick", async () => {
  // The scan spent the cron invocation's shared registration budget first
  // (issue #87). Nothing is registered and nothing is failed: the request
  // keeps its place and says why it waits.
  const harness = withDispatch();
  await persistSyntheticRun(harness);
  const accepted = await requestImport({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, runId: "run-001" },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  expect(
    await dispatchOperations(harness.env, { budget: new RegistrationBudget(0) }),
  ).toMatchObject({ claimed: 1, retried: 1, dispatched: 0 });
  const record = await receipt(harness, accepted.receipt.operationId);
  if (!record.ok) throw new Error("receipt missing");
  expect(record.receipt.dispatch.state).toBe("dispatch_pending");
  expect(record.receipt.failureCode).toBe("registration_deferred");
  expect(stageStates(record.receipt.stages).every((entry) => entry.endsWith(":pending"))).toBe(
    true,
  );
  expect(harness.db.query("SELECT count(*) AS n FROM collection_runs").get()).toEqual({ n: 0 });
});

test("an import of a blocked terminal records the block and does not complete", async () => {
  const harness = withDispatch();
  const plan = await persistSyntheticRun(harness);
  const { objectKey } = await import("../../../packages/collection/src/keys.ts");
  harness.bucket.entries.delete(objectKey(plan.artifacts[0]!.sha256));
  const accepted = await requestImport({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, runId: "run-001" },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 1, failed: 1 });
  const record = await receipt(harness, accepted.receipt.operationId);
  if (!record.ok) throw new Error("receipt missing");
  expect(record.receipt.status).toBe("blocked");
  expect(stageOf(record.receipt.stages, "registered")).toMatchObject({
    state: "blocked",
    failureCode: "object_missing",
    attempts: 1,
  });
});

test("an import whose run id no terminal key can carry ends with a closed code", async () => {
  // The App's run grammar admits `:`, the bucket key grammar does not, and the
  // key builder throws on it. Before, that throw left dispatchImport
  // unclassified: the whole lane failed every tick and the request, never
  // updated, stayed at the head of the queue.
  const harness = withDispatch();
  await persistSyntheticRun(harness);
  const operations: string[] = [];
  for (const runId of ["run:001", "run-001"]) {
    const accepted = await requestImport({
      store: harness.store,
      principal: PRINCIPAL,
      now: NOW,
      request: { source: SOURCE, runId },
    });
    if (!accepted.ok) throw new Error("acceptance failed");
    operations.push(accepted.receipt.operationId);
  }
  const at = () => new Date("2026-09-11T00:01:00Z");
  expect(await dispatchOperations(harness.env, { now: at })).toMatchObject({
    claimed: 2,
    dispatched: 1,
    failed: 1,
  });
  const refused = await receipt(harness, operations[0]!);
  if (!refused.ok) throw new Error("receipt missing");
  expect(refused.receipt.status).toBe("blocked");
  expect(refused.receipt.dispatch.state).toBe("dispatch_failed");
  expect(refused.receipt.failureCode).toBe("operation_payload_invalid");
  // Nothing was judged about a terminal: no stage row was written.
  expect(stageStates(refused.receipt.stages).every((entry) => entry.endsWith(":pending"))).toBe(
    true,
  );
  const registered = await receipt(harness, operations[1]!);
  if (!registered.ok) throw new Error("receipt missing");
  expect(stageOf(registered.receipt.stages, "registered")).toMatchObject({ state: "completed" });
  // A closed end: the refused request is not taken again.
  expect(await dispatchOperations(harness.env, { now: at })).toMatchObject({ claimed: 0 });
});

test("a throwing CORE registration backs off while the next import progresses", async () => {
  const harness = withDispatch();
  for (const runId of ["run-001", "run-002"]) {
    await persistSyntheticRun(harness, { run: { runId } });
  }
  const operations: string[] = [];
  for (const runId of ["run-001", "run-002"]) {
    const accepted = await requestImport({
      store: harness.store,
      principal: PRINCIPAL,
      now: NOW,
      request: { source: SOURCE, runId },
    });
    if (!accepted.ok) throw new Error("acceptance failed");
    operations.push(accepted.receipt.operationId);
  }
  // Take the failing import first, so the later request proves the lane continues.
  harness.db.run("UPDATE ops_requests SET available_at_ms=1 WHERE operation_id=?", [
    operations[0]!,
  ]);
  harness.db.run("UPDATE ops_requests SET available_at_ms=2 WHERE operation_id=?", [
    operations[1]!,
  ]);
  expect(
    harness.db
      .query<{ operation_id: string }, []>(
        "SELECT operation_id FROM ops_requests ORDER BY available_at_ms,operation_id LIMIT 1",
      )
      .get()!.operation_id,
  ).toBe(operations[0]!);
  harness.db.exec(`CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON fetch_run_seals
    WHEN (SELECT source_run_key FROM fetch_runs WHERE id=NEW.fetch_run_id) GLOB 'run-001:*'
    BEGIN SELECT RAISE(ABORT, 'synthetic_unlisted_refusal'); END`);
  const at = (minutes: number) => () => new Date(Date.parse(NOW) + minutes * 60_000);
  expect(await dispatchOperations(harness.env, { now: at(1) })).toMatchObject({
    claimed: 2,
    retried: 0,
    dispatched: 1,
    failed: 1,
  });
  const waiting = await receipt(harness, operations[0]!);
  if (!waiting.ok) throw new Error("receipt missing");
  expect(waiting.receipt).toMatchObject({
    status: "accepted",
    failureCode: "registration_failed",
    dispatch: { state: "dispatch_pending", attempts: 1 },
  });
  // A throw is not a terminal verdict and writes no operation stage.
  expect(stageStates(waiting.receipt.stages)).toEqual([
    "registered:pending",
    "parsed:pending",
    "adopted:pending",
    "projected:pending",
  ]);
  expect(
    harness.db
      .query("SELECT count(*) AS n FROM ops_request_stages WHERE operation_id=?")
      .get(operations[0]!),
  ).toEqual({ n: 0 });
  const healthy = await receipt(harness, operations[1]!);
  if (!healthy.ok) throw new Error("receipt missing");
  expect(healthy.receipt.dispatch.state).toBe("dispatched");
  expect(await dispatchOperations(harness.env, { now: at(5) })).toMatchObject({ claimed: 0 });

  harness.db.exec("DROP TRIGGER synthetic_import_failure");
  expect(await dispatchOperations(harness.env, { now: at(6) })).toMatchObject({
    claimed: 1,
    dispatched: 1,
    retried: 0,
    failed: 0,
  });
  const recovered = await receipt(harness, operations[0]!);
  if (!recovered.ok) throw new Error("receipt missing");
  expect(recovered.receipt.dispatch).toMatchObject({ state: "dispatched", attempts: 2 });
  expect(recovered.receipt.failureCode).toBe("registration_failed");
  expect(stageOf(recovered.receipt.stages, "registered")).toMatchObject({
    state: "completed",
    attempts: 1,
  });
});

test("a projection rebuild is handed over, never completed on the handover", async () => {
  const harness = withDispatch();
  const accepted = await requestProjectionRebuild({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { reason: "synthetic" },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 1, dispatched: 1 });
  const record = await receipt(harness, accepted.receipt.operationId);
  if (!record.ok) throw new Error("receipt missing");
  expect(record.receipt.dispatch.state).toBe("dispatched");
  // A projection's only stage is `projected`, and nobody published anything.
  expect(stageStates(record.receipt.stages)).toEqual(["projected:pending"]);
  expect(record.receipt.status).toBe("accepted");
});

test("a collection request whose connection is not enabled waits instead of completing", async () => {
  // No connection is named in OPS_COLLECTOR_DISPATCH_CONNECTIONS (the
  // committed default), so nothing is called: the request stays pending with
  // a code that says why (ADR 0048; the full collector path is
  // collector-dispatch.test.ts).
  const harness = withDispatch();
  const accepted = await requestCollection({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, requestedScope: { from: "2026-08-01", to: "2026-08-31" } },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  const connections = [
    {
      connectionId: "synthetic",
      workspace: "collector-synthetic",
      source: SOURCE,
      terminalSource: SOURCE,
      action: "collect" as const,
      cron: "0 0 * * *",
    },
  ];
  const at = () => new Date("2026-09-11T00:01:00Z");
  expect(await dispatchOperations(harness.env, { now: at, connections })).toMatchObject({
    claimed: 1,
    awaiting: 1,
    started: 0,
  });
  const record = await receipt(harness, accepted.receipt.operationId);
  if (!record.ok) throw new Error("receipt missing");
  // Still pending, with a code that says why. Not completed, not dropped.
  expect(record.receipt.dispatch.state).toBe("dispatch_pending");
  expect(record.receipt.failureCode).toBe("collector_dispatch_disabled");
  expect(record.receipt.status).toBe("accepted");
  expect(record.receipt.execution).toMatchObject({ state: "waiting", startedAt: null });
  expect(stageStates(record.receipt.stages).every((entry) => entry.endsWith(":pending"))).toBe(
    true,
  );
  // It backs off rather than retrying every tick.
  expect(await dispatchOperations(harness.env, { now: at, connections })).toMatchObject({
    claimed: 0,
  });
});

test("an import whose registration throws moves behind the queue and never fails the lane", async () => {
  // A throw is not a verdict about the terminal (R2 or CORE unavailable, or a
  // refusal the derivation did not foresee). Before this was caught it failed
  // the whole lane tick, wrote nothing to the request and left it at the head
  // of the queue, so every later request and the collector tracking waited
  // for as long as the cause lasted.
  const harness = withDispatch();
  for (const runId of ["run-001", "run-002"]) {
    await persistSyntheticRun(harness, { run: { runId } });
  }
  const operations: string[] = [];
  for (const runId of ["run-001", "run-002"]) {
    const accepted = await requestImport({
      store: harness.store,
      principal: PRINCIPAL,
      now: NOW,
      request: { source: SOURCE, runId },
    });
    if (!accepted.ok) throw new Error("acceptance failed");
    operations.push(accepted.receipt.operationId);
  }
  // The two runs share content-addressed objects, so R2 failing on its first
  // read fails exactly the registration the lane takes first, whichever
  // request the queue order puts at its head.
  const head = harness.bucket.head.bind(harness.bucket);
  let reads = 0;
  harness.bucket.head = async (key: string) => {
    reads += 1;
    if (reads === 1) throw new Error("synthetic r2 outage: " + key);
    return head(key);
  };
  const queueHead = harness.db
    .query<{ operation_id: string }, []>(
      "SELECT operation_id FROM ops_requests ORDER BY available_at_ms,operation_id LIMIT 1",
    )
    .get()!.operation_id;
  const behind = operations.find((id) => id !== queueHead)!;
  const at = new Date("2026-09-11T00:01:00Z");
  const codes: string[] = [];

  // The lane completes, and the request behind is dispatched in the same tick.
  expect(
    await dispatchOperations(harness.env, { now: () => at, onFailure: (code) => codes.push(code) }),
  ).toMatchObject({ claimed: 2, dispatched: 1, failed: 1, retried: 0 });
  // The error's class only, never its message (which here quotes a key).
  expect(codes).toEqual(["Error"]);
  const dispatched = await receipt(harness, behind);
  if (!dispatched.ok) throw new Error("receipt missing");
  expect(dispatched.receipt.dispatch.state).toBe("dispatched");
  expect(stageOf(dispatched.receipt.stages, "registered")).toMatchObject({ state: "completed" });

  // The one that threw is kept, counted as attempted, says why, and has no
  // stage row: nothing about its terminal was judged.
  const thrown = await receipt(harness, queueHead);
  if (!thrown.ok) throw new Error("receipt missing");
  expect(thrown.receipt.status).toBe("accepted");
  expect(thrown.receipt.dispatch).toMatchObject({ state: "dispatch_pending", attempts: 1 });
  expect(thrown.receipt.failureCode).toBe("registration_failed");
  expect(
    harness.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM ops_request_stages WHERE operation_id=?1",
      )
      .get(queueHead),
  ).toEqual({ n: 0 });
  // It moved behind the queue: not taken again until its retry time.
  const availableAt = harness.db
    .query<{ available_at_ms: number }, [string]>(
      "SELECT available_at_ms FROM ops_requests WHERE operation_id=?1",
    )
    .get(queueHead)!.available_at_ms;
  expect(availableAt).toBeGreaterThan(at.valueOf());
  expect(await dispatchOperations(harness.env, { now: () => at })).toMatchObject({ claimed: 0 });

  // A later look registers it once the cause is gone.
  const later = new Date(availableAt);
  expect(await dispatchOperations(harness.env, { now: () => later })).toMatchObject({
    claimed: 1,
    dispatched: 1,
    failed: 0,
  });
  const recovered = await receipt(harness, queueHead);
  if (!recovered.ok) throw new Error("receipt missing");
  expect(recovered.receipt.dispatch).toMatchObject({ state: "dispatched", attempts: 2 });
  // A dispatch that names no code keeps the last one (docs/processor.md §7).
  expect(recovered.receipt.failureCode).toBe("registration_failed");
  expect(stageOf(recovered.receipt.stages, "registered")).toMatchObject({ state: "completed" });
});
