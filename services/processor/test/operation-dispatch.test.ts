// The Processor half of the operations API (unified plan 02 §5, U06 → U08).
//
// The rule every test here checks is the one contracts/stages.json states:
// **handing work over is not completing it**. A dispatched replay, a
// projection that will run on the next tick and a collector call that does
// not exist yet must all leave the operation short of `completed`.
//
// Synthetic throughout: `kogane-synthetic`, no amount, no account, no token.
import { expect, test } from "bun:test";
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
import { sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { dispatchOperations, opsDispatchEnabled } from "../src/operations/dispatch.ts";
import {
  collectionHarness,
  persistSyntheticRun,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";

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

test("a collection request waits for the collector binding instead of completing", async () => {
  const harness = withDispatch();
  const accepted = await requestCollection({
    store: harness.store,
    principal: PRINCIPAL,
    now: NOW,
    request: { source: SOURCE, requestedScope: { from: "2026-08-01", to: "2026-08-31" } },
  });
  if (!accepted.ok) throw new Error("acceptance failed");
  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 1, awaiting: 1 });
  const record = await receipt(harness, accepted.receipt.operationId);
  if (!record.ok) throw new Error("receipt missing");
  // Still pending, with a code that says why. Not completed, not dropped.
  expect(record.receipt.dispatch.state).toBe("dispatch_pending");
  expect(record.receipt.failureCode).toBe("awaiting_collector_dispatch");
  expect(record.receipt.status).toBe("accepted");
  expect(stageStates(record.receipt.stages).every((entry) => entry.endsWith(":pending"))).toBe(
    true,
  );
  // It backs off rather than retrying every tick.
  expect(await dispatchOperations(harness.env)).toMatchObject({ claimed: 0 });
});
