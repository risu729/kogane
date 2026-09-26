// The per-invocation registration budget (issue #87).
//
// The legacy Vpass importer this issue was filed against is retired; its
// successor is the Processor's in-process registration of shared terminals,
// and the same question applies to it: does one invocation stay under the
// documented per-invocation limits however large a manifest the schema
// allows? Each test below measures operations — every D1 statement and every
// R2 call — through the meter registration itself runs on, against the real
// CORE schema, so the counts are the ones production makes.
//
//   * every step kind, at its largest, fits the reserve it is checked against;
//   * at, just below and just above the one-invocation edge — in artifacts,
//     in units, and in budget — each invocation stays under the budget and
//     the terminal calls (unit reports, run report, seal) happen exactly once;
//   * a failure at the edge of the budget still records its audit, once;
//   * what the previous release left in CORE for an unfinished run — the
//     continuation of the old code — completes under this one;
//   * the scan continues staged registrations on the next tick.
//
// Synthetic throughout: `kogane-synthetic`, no amount, no account, no token.
import { expect, test } from "bun:test";
import {
  ARTIFACT_STEP_BASE,
  AUDIT_RESERVE,
  createRunRequest,
  DIRECT_SEAL_ARTIFACTS,
  DOCUMENTED_LIMITS,
  FINAL_STEP_RESERVE,
  inventoryChunkReserve,
  PREAMBLE_RESERVE,
  REGISTRATION_CONTRACT_VERSION,
  REGISTRATION_OPERATION_BUDGET,
  RegistrationBudget,
  registerTerminal,
  runRangeRequests,
  STRUCTURE_STEP_RESERVE,
  artifactRequest,
  unitRequest,
  type RegisterTerminalOutcome,
} from "../../../packages/application/src/collection/index.ts";
import { MAX_INVENTORY_CHUNK_ITEMS } from "../../../packages/evidence-contract/src/requests.ts";
import { IngestError, type IngestEnv } from "../../../packages/application/src/ingest/contract.ts";
import {
  directRegistrationPort,
  type RunRegistrationPort,
} from "../../../packages/application/src/ingest/port.ts";
import { readTerminal } from "../../../packages/collection/src/reader.ts";
import { objectKey } from "../../../packages/collection/src/keys.ts";
import type { PersistArtifact } from "../../../packages/collection/src/writer.ts";
import type {
  TerminalRange,
  TerminalTransformation,
  TerminalUnit,
} from "../../../packages/collection/src/manifest.ts";
import { descriptorContractV1 } from "../../../packages/evidence-contract/src/descriptor.ts";
import { canonicalJsonV1, type JsonValue } from "../../../packages/evidence-contract/src/json.ts";
import { sha256Hex } from "../../../packages/collection/src/digest.ts";
import {
  appendCollectionStage,
  insertCollectionRunIfAbsent,
  readCollectionRun,
} from "../../../packages/storage-d1/src/core/collection-runs.ts";
import { collectionScan } from "../src/collection/index.ts";
import {
  artifact,
  CLIENT,
  collectionHarness,
  persistSyntheticRun,
  rows,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";

interface Shape {
  runId?: string;
  /** Provider artifacts, all in the first unit. */
  artifacts: number;
  units?: number;
  ranges?: number;
  /** Derived artifacts, each with a transformation from `parents` provider artifacts. */
  derived?: number;
  parents?: number;
}

/** Persist one synthetic run of the given shape exactly as a collector would. */
async function persistShape(harness: CollectionHarness, shape: Shape): Promise<PersistArtifact[]> {
  const unitCount = shape.units ?? 1;
  const units: TerminalUnit[] = [];
  for (let index = 0; index < unitCount; index += 1)
    units.push({
      unitKey: `unit-${String(index).padStart(4, "0")}`,
      unitKind: "account",
      artifactCount: index === 0 ? shape.artifacts + (shape.derived ?? 0) : 0,
      coverageStatus: "partial",
    });
  const ranges: TerminalRange[] = [];
  for (let index = 0; index < (shape.ranges ?? 1); index += 1)
    ranges.push({
      rangeKey: `range-${String(index).padStart(4, "0")}`,
      rangeKind: "declared_coverage",
      precision: "month",
      basis: "manifest",
      startValue: "2026-01",
      endValue: "2026-12",
    });
  const artifacts: PersistArtifact[] = [];
  for (let index = 0; index < shape.artifacts; index += 1) {
    const key = `page-${String(index).padStart(4, "0")}.json`;
    artifacts.push(await artifact(key, `{"synthetic":"${key}"}`, { unitKey: "unit-0000" }));
  }
  const transformations: TerminalTransformation[] = [];
  for (let index = 0; index < (shape.derived ?? 0); index += 1) {
    const key = `derived-${String(index).padStart(4, "0")}.json`;
    artifacts.push(
      await artifact(key, `{"synthetic":"${key}"}`, {
        role: "collector_derived",
        unitKey: "unit-0000",
      }),
    );
    transformations.push({
      transformationId: `derive-${index}`,
      stepKind: "extracted",
      transformerId: "synthetic-deriver",
      transformerVersion: "1.0.0",
      inputArtifactKeys: artifacts.slice(0, shape.parents ?? 1).map((entry) => entry.artifactKey),
      outputArtifactKey: key,
    });
  }
  await persistSyntheticRun(harness, {
    run: {
      runId: shape.runId ?? "run-001",
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: units.map((unit) => unit.unitKey),
      },
      units,
      ranges,
      reports: [
        { reportRef: "terminal", reportKind: "terminal", scope: "run", outcome: "success" },
      ],
      transformations,
    },
    artifacts,
  });
  return artifacts;
}

type Calls = Record<string, { cost: number; usedBefore: number; r2Before: number }[]>;

/**
 * The in-process port, recording what each call cost in metered operations
 * and how much of the budget was spent when it started. `fail` makes the
 * `at`-th call (0-based, counted across invocations) of one method throw,
 * after spending `spend` operations — a step that used its whole reserve and
 * then failed.
 */
function recordingPort(
  budget: () => RegistrationBudget,
  calls: Calls,
  fail?: { method: keyof RunRegistrationPort; at: number; error: Error; spend?: number },
): (env: IngestEnv) => RunRegistrationPort {
  return (env) => {
    const port = directRegistrationPort(env, CLIENT) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, operation] of Object.entries(port)) {
      wrapped[name] = async (...args: unknown[]) => {
        const list = (calls[name] ??= []);
        const usedBefore = budget().used;
        const r2Before = budget().meter.r2Operations;
        if (fail && fail.method === name && list.length === fail.at) {
          budget().meter.d1Statements += fail.spend ?? 0;
          list.push({ cost: fail.spend ?? 0, usedBefore, r2Before });
          throw fail.error;
        }
        try {
          return await operation.apply(port, args);
        } finally {
          list.push({ cost: budget().used - usedBefore, usedBefore, r2Before });
        }
      };
    }
    return wrapped as unknown as RunRegistrationPort;
  };
}

function registerOnce(
  harness: CollectionHarness,
  budget: RegistrationBudget,
  options: { runId?: string; port?: (env: IngestEnv) => RunRegistrationPort } = {},
): Promise<RegisterTerminalOutcome> {
  return registerTerminal({
    env: { DB: harness.env.DB, EVIDENCE: harness.env.EVIDENCE },
    bucket: harness.env.EVIDENCE,
    clientId: CLIENT,
    source: SOURCE,
    runId: options.runId ?? "run-001",
    budget,
    ...(options.port ? { port: options.port } : {}),
  });
}

interface Invocation {
  outcome: RegisterTerminalOutcome;
  used: number;
}

/**
 * Invocations of the default budget until the run is registered or stops for
 * another reason. Every invocation is checked against the budget as it ends.
 */
async function registerUntilDone(
  harness: CollectionHarness,
  options: { calls?: Calls; limit?: number } = {},
): Promise<Invocation[]> {
  const invocations: Invocation[] = [];
  for (let index = 0; index < 100; index += 1) {
    const budget = new RegistrationBudget(options.limit ?? REGISTRATION_OPERATION_BUDGET);
    const outcome = await registerOnce(harness, budget, {
      ...(options.calls ? { port: recordingPort(() => budget, options.calls) } : {}),
    });
    expect(budget.used).toBeLessThanOrEqual(budget.limit);
    invocations.push({ outcome, used: budget.used });
    if (outcome.outcome !== "pending") return invocations;
  }
  throw new Error("registration did not converge");
}

const count = (harness: CollectionHarness, sql: string, ...binds: unknown[]): number =>
  (harness.db.query(sql).get(...(binds as never[])) as { n: number }).n;

const stageRows = (harness: CollectionHarness) =>
  rows<{ stage: string; state: string; failure_code: string | null; evidence_ref: string | null }>(
    harness.db,
    "SELECT stage,state,failure_code,evidence_ref FROM collection_run_stages ORDER BY id",
  );

const terminalCalls = (calls: Calls) => ({
  unitReports: calls["addUnitReport"]?.length ?? 0,
  runReports: calls["addRunReport"]?.length ?? 0,
  seals: (calls["seal"]?.length ?? 0) + (calls["sealStagedInventory"]?.length ?? 0),
});

/**
 * The largest value of one shape dimension that still registers in a single
 * invocation of the default budget. Operations grow with every dimension, so
 * a binary search over fresh harnesses finds the edge.
 */
async function oneInvocationEdge(
  shape: (size: number) => Shape,
  low: number,
  high: number,
): Promise<number> {
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const harness = collectionHarness();
    await persistShape(harness, shape(middle));
    const outcome = await registerOnce(harness, new RegistrationBudget());
    if (outcome.outcome === "registered") low = middle;
    else high = middle - 1;
  }
  return low;
}

test("the budget is a fraction of the documented limits, not a guess below them", () => {
  expect(DOCUMENTED_LIMITS).toEqual({
    workerInvocationsPerRequest: 32,
    d1QueriesPerInvocation: 1_000,
    subrequestsPerInvocation: 10_000,
  });
  expect(REGISTRATION_OPERATION_BUDGET).toBeLessThan(DOCUMENTED_LIMITS.d1QueriesPerInvocation);
  expect(REGISTRATION_OPERATION_BUDGET).toBeLessThan(DOCUMENTED_LIMITS.subrequestsPerInvocation);
  // The largest single reserve still leaves room for real work in every invocation.
  expect(
    PREAMBLE_RESERVE +
      STRUCTURE_STEP_RESERVE +
      inventoryChunkReserve(MAX_INVENTORY_CHUNK_ITEMS) +
      FINAL_STEP_RESERVE +
      AUDIT_RESERVE,
  ).toBeLessThan(REGISTRATION_OPERATION_BUDGET / 2);
});

test("every step kind, at its largest, fits the reserve it is checked against", async () => {
  // A direct seal at its largest, a staged inventory with full chunks, many
  // units and ranges, and derived artifacts with several parents each. The
  // budget is large so that nothing yields and every step is measured once.
  const shapes: Shape[] = [
    { artifacts: DIRECT_SEAL_ARTIFACTS, units: 3, ranges: 3 },
    { artifacts: 95, derived: 6, parents: 4, units: 2, ranges: 2 },
  ];
  for (const shape of shapes) {
    const harness = collectionHarness();
    await persistShape(harness, shape);
    const calls: Calls = {};
    const budget = new RegistrationBudget(1_000_000);
    const outcome = await registerOnce(harness, budget, {
      port: recordingPort(() => budget, calls),
    });
    expect(outcome.outcome).toBe("registered");

    // The preamble: every statement before the run is created, and the one
    // R2 read of the terminal. The other R2 calls before it are the objects
    // verified ahead, which the artifact steps account for.
    const create = calls["createRun"]![0]!;
    expect(create.usedBefore - create.r2Before + 1).toBeLessThanOrEqual(PREAMBLE_RESERVE);

    // Structure steps.
    for (const name of ["createRun", "addUnit", "addRunRange", "beginInventory", "addUnitReport"])
      for (const call of calls[name] ?? [])
        expect(call.cost).toBeLessThanOrEqual(STRUCTURE_STEP_RESERVE);
    // Inventory chunks, in order: full chunks of the contract's maximum, then the rest.
    const items = shape.artifacts + (shape.derived ?? 0);
    for (const [index, call] of (calls["addInventoryItems"] ?? []).entries())
      expect(call.cost).toBeLessThanOrEqual(
        inventoryChunkReserve(
          Math.min(MAX_INVENTORY_CHUNK_ITEMS, items - index * MAX_INVENTORY_CHUNK_ITEMS),
        ),
      );
    // The final step is the run report, the seal, and the three statements
    // that link the fetch run and complete the stage.
    const seal = [...(calls["seal"] ?? []), ...(calls["sealStagedInventory"] ?? [])];
    expect(seal).toHaveLength(1);
    expect(calls["addRunReport"]!).toHaveLength(1);
    const final = calls["addRunReport"]![0]!.cost + seal[0]!.cost + 3;
    expect(final).toBeLessThanOrEqual(FINAL_STEP_RESERVE);

    // An artifact step: its object's R2 head, the adoption and the catalogue
    // row. Lineage order puts the provider artifacts first; the derived ones
    // follow, each with one transformation step and `parents` relations.
    const adopt = calls["adoptObject"]!;
    const catalogue = calls["addArtifact"]!;
    expect(catalogue).toHaveLength(shape.artifacts + (shape.derived ?? 0));
    for (let index = 0; index < catalogue.length; index += 1) {
      const derived = index >= shape.artifacts;
      const reserve = derived
        ? ARTIFACT_STEP_BASE + 1 + 2 * (shape.parents ?? 0)
        : ARTIFACT_STEP_BASE;
      expect(1 + adopt[index]!.cost + catalogue[index]!.cost).toBeLessThanOrEqual(reserve);
    }
    // The staged run's items went in chunks no larger than the contract's.
    if (items > DIRECT_SEAL_ARTIFACTS) {
      expect(calls["addInventoryItems"]).toHaveLength(Math.ceil(items / MAX_INVENTORY_CHUNK_ITEMS));
      expect(count(harness, "SELECT count(*) AS n FROM run_inventory_items")).toBe(items);
    }
  }
}, 60_000);

test("at, below and above the one-invocation edge in artifacts, each invocation stays under budget and the terminal calls happen once", async () => {
  const shape = (size: number): Shape => ({ artifacts: size });
  const edge = await oneInvocationEdge(shape, 1, 64);
  // A Vpass card of about twenty statement pages registers in one invocation.
  expect(edge).toBeGreaterThanOrEqual(20);
  for (const size of [edge - 1, edge, edge + 1]) {
    const harness = collectionHarness();
    await persistShape(harness, shape(size));
    const calls: Calls = {};
    const invocations = await registerUntilDone(harness, { calls });
    expect(invocations.at(-1)!.outcome.outcome).toBe("registered");
    expect(invocations).toHaveLength(size > edge ? 2 : 1);
    if (size > edge) {
      // Above the edge the first invocation yields with nothing of the
      // terminal phase done: no report and no seal until the second.
      expect(invocations[0]!.outcome).toMatchObject({ outcome: "pending" });
      expect(invocations[0]!.used).toBeLessThanOrEqual(REGISTRATION_OPERATION_BUDGET);
    }
    // Exactly once each, across however many invocations it took.
    expect(terminalCalls(calls)).toEqual({ unitReports: 1, runReports: 1, seals: 1 });
    expect(calls["addArtifact"]).toHaveLength(size);
    expect(calls["createRun"]).toHaveLength(invocations.length);
    expect(count(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
    expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
    expect(count(harness, "SELECT count(*) AS n FROM fetch_artifacts")).toBe(size);
    // One pending stage per yielding invocation, then the completion.
    expect(stageRows(harness).map((row) => `${row.stage}:${row.state}`)).toEqual([
      "persisted:completed",
      ...invocations.slice(0, -1).map(() => "registered:pending"),
      "registered:completed",
    ]);
  }
}, 60_000);

test("at, below and above the one-invocation edge in units, the structure is catalogued once and every unit reports once", async () => {
  // Units are this path's page groups: the structure the initial path used to
  // catalogue in full before a single artifact.
  const shape = (size: number): Shape => ({ artifacts: 2, units: size });
  const edge = await oneInvocationEdge(shape, 1, 200);
  expect(edge).toBeGreaterThanOrEqual(10);
  for (const size of [edge - 1, edge, edge + 1]) {
    const harness = collectionHarness();
    await persistShape(harness, shape(size));
    const calls: Calls = {};
    const invocations = await registerUntilDone(harness, { calls });
    expect(invocations.at(-1)!.outcome.outcome).toBe("registered");
    expect(invocations.length > 1).toBe(size > edge);
    expect(calls["addUnit"]).toHaveLength(size);
    expect(terminalCalls(calls)).toEqual({ unitReports: size, runReports: 1, seals: 1 });
    expect(count(harness, "SELECT count(*) AS n FROM fetch_units")).toBe(size);
    expect(count(harness, "SELECT count(*) AS n FROM fetch_unit_reports")).toBe(size);
  }
}, 60_000);

test("the schema's largest structure converges without any invocation passing the budget", async () => {
  // The manifest schema allows 1,000 units and 1,000 ranges. The previous
  // code re-added every one of them on every call before cataloguing an
  // artifact; here each call adds only what is missing.
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 3, units: 300, ranges: 300 });
  const calls: Calls = {};
  const invocations = await registerUntilDone(harness, { calls });
  expect(invocations.at(-1)!.outcome.outcome).toBe("registered");
  expect(invocations.length).toBeGreaterThan(1);
  for (const invocation of invocations)
    expect(invocation.used).toBeLessThanOrEqual(REGISTRATION_OPERATION_BUDGET);
  expect(calls["addUnit"]).toHaveLength(300);
  expect(calls["addRunRange"]).toHaveLength(300);
  expect(terminalCalls(calls)).toEqual({ unitReports: 300, runReports: 1, seals: 1 });
}, 60_000);

test("the largest artifact the descriptor contract accepts still fits one invocation", async () => {
  // The descriptor contract accepts at most 100 transformation steps and 100
  // relations per artifact. Such a step's reserve fits what a fresh
  // invocation has left once its preamble, the run, its reads and the
  // inventory declaration are paid for, so a staged registration never waits
  // on a step no invocation can afford.
  const largest = ARTIFACT_STEP_BASE + 100 + 2 * 100;
  expect(
    PREAMBLE_RESERVE + 2 * STRUCTURE_STEP_RESERVE + 8 + largest + AUDIT_RESERVE,
  ).toBeLessThanOrEqual(REGISTRATION_OPERATION_BUDGET);
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 100, derived: 1, parents: 100 });
  const calls: Calls = {};
  const invocations = await registerUntilDone(harness, { calls });
  expect(invocations.at(-1)!.outcome.outcome).toBe("registered");
  expect(count(harness, "SELECT count(*) AS n FROM artifact_relations")).toBe(100);
}, 60_000);

test("an artifact beyond the descriptor contract is blocked once, not retried forever", async () => {
  // The manifest schema allows a transformation with more inputs than the
  // descriptor contract accepts as relations. Asking again cannot change
  // the contract's answer, so the run is blocked with its code.
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 101, derived: 1, parents: 101 });
  const invocations = await registerUntilDone(harness);
  expect(invocations.at(-1)!.outcome).toMatchObject({
    outcome: "blocked",
    code: "invalid_relations",
  });
  expect(stageRows(harness).filter((row) => row.state === "blocked")).toHaveLength(1);
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
  expect(await registerOnce(harness, new RegistrationBudget())).toMatchObject({
    outcome: "blocked",
    code: "invalid_relations",
  });
  expect(stageRows(harness).filter((row) => row.state === "blocked")).toHaveLength(1);
}, 60_000);

test("a run above the direct-seal size stages its inventory in contract-sized chunks and seals", async () => {
  // The previous chunk of 50 was above the contract's 30, so a run of more
  // than 50 artifacts failed `invalid_items` on every attempt and never sealed.
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: DIRECT_SEAL_ARTIFACTS + 12 });
  const calls: Calls = {};
  const invocations = await registerUntilDone(harness, { calls });
  expect(invocations.at(-1)!.outcome.outcome).toBe("registered");
  expect(calls["addInventoryItems"]).toHaveLength(3);
  expect(calls["sealStagedInventory"]).toHaveLength(1);
  expect(count(harness, "SELECT count(*) AS n FROM run_inventory_items")).toBe(62);
}, 60_000);

test("at, below and above the budget edge of the final step, the terminal calls happen once", async () => {
  // Measure where the final step starts for one shape, then run that shape
  // with a budget that fits it with no slack, and with one operation less.
  const probe = collectionHarness();
  await persistShape(probe, { artifacts: 6, units: 2 });
  const measured: Calls = {};
  const unlimited = new RegistrationBudget(1_000_000);
  await registerOnce(probe, unlimited, { port: recordingPort(() => unlimited, measured) });
  const edge = measured["addRunReport"]![0]!.usedBefore + FINAL_STEP_RESERVE + AUDIT_RESERVE;

  for (const limit of [edge - 1, edge, edge + 1]) {
    const harness = collectionHarness();
    await persistShape(harness, { artifacts: 6, units: 2 });
    const calls: Calls = {};
    const invocations = await registerUntilDone(harness, { calls, limit });
    if (limit < edge) {
      // Everything but the final step fitted: the first invocation yielded
      // in the terminal phase, having made no run report and no seal.
      expect(invocations[0]!.outcome).toMatchObject({ outcome: "pending", phase: "terminal" });
      expect(invocations).toHaveLength(2);
    } else {
      expect(invocations).toHaveLength(1);
    }
    expect(terminalCalls(calls)).toEqual({ unitReports: 2, runReports: 1, seals: 1 });
    expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
  }
}, 60_000);

test("a failure in the final step at the budget edge still records its audit, once", async () => {
  const probe = collectionHarness();
  await persistShape(probe, { artifacts: 6 });
  const measured: Calls = {};
  const unlimited = new RegistrationBudget(1_000_000);
  await registerOnce(probe, unlimited, { port: recordingPort(() => unlimited, measured) });
  const limit = measured["addRunReport"]![0]!.usedBefore + FINAL_STEP_RESERVE + AUDIT_RESERVE;

  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 6 });
  const calls: Calls = {};
  const budget = new RegistrationBudget(limit);
  const outcome = await registerOnce(harness, budget, {
    // The seal spends what is left of the final step's reserve, then fails:
    // the invocation is at the budget less the audit reserve.
    port: recordingPort(() => budget, calls, {
      method: "seal",
      at: 0,
      error: new IngestError(409, "inventory_conflict"),
      spend: limit - AUDIT_RESERVE - measured["seal"]![0]!.usedBefore,
    }),
  });
  expect(outcome).toMatchObject({ outcome: "blocked", code: "inventory_conflict" });
  // The audit — a stage row and the block — fitted in what was kept back.
  expect(budget.used).toBeGreaterThan(limit - AUDIT_RESERVE);
  expect(budget.used).toBeLessThanOrEqual(limit);
  expect(stageRows(harness).filter((row) => row.state === "blocked")).toEqual([
    {
      stage: "registered",
      state: "blocked",
      failure_code: "inventory_conflict",
      evidence_ref: null,
    },
  ]);
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
  // A block is write-once: asking again records nothing further.
  const again = new RegistrationBudget();
  expect(await registerOnce(harness, again)).toMatchObject({ outcome: "blocked" });
  expect(stageRows(harness).filter((row) => row.state === "blocked")).toHaveLength(1);
}, 60_000);

test("a missing object beyond the first invocation blocks the run before its seal, audited once", async () => {
  // The objects verified ahead are the ones the first invocation can reach;
  // the last artifact of a larger run is checked in its own step later.
  const harness = collectionHarness();
  const artifacts = await persistShape(harness, { artifacts: 40 });
  harness.bucket.entries.delete(objectKey(artifacts.at(-1)!.sha256));
  const invocations = await registerUntilDone(harness);
  expect(invocations[0]!.outcome).toMatchObject({ outcome: "pending" });
  expect(invocations.at(-1)!.outcome).toMatchObject({
    outcome: "blocked",
    code: "object_missing",
  });
  expect(
    stageRows(harness)
      .filter((row) => row.state !== "pending")
      .map((row) => `${row.stage}:${row.state}:${row.failure_code ?? ""}`),
  ).toEqual(["persisted:completed:", "registered:blocked:object_missing"]);
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
}, 60_000);

test("a refused ingest client at the edge is recorded once per change of state, and retried", async () => {
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 40 });
  expect(await registerOnce(harness, new RegistrationBudget())).toMatchObject({
    outcome: "pending",
  });
  harness.db.exec("UPDATE ingest_clients SET active = 0");
  for (let index = 0; index < 3; index += 1) {
    const budget = new RegistrationBudget();
    expect(await registerOnce(harness, budget)).toMatchObject({
      outcome: "retryable",
      code: "inactive_ingest_client",
    });
    expect(budget.used).toBeLessThanOrEqual(REGISTRATION_OPERATION_BUDGET);
  }
  expect(stageRows(harness).filter((row) => row.state === "retryable")).toHaveLength(1);
  harness.db.exec("UPDATE ingest_clients SET active = 1");
  const rest = await registerUntilDone(harness);
  expect(rest.at(-1)!.outcome.outcome).toBe("registered");
}, 60_000);

test("a shared budget that is spent defers the next registration without recording anything", async () => {
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 3 });
  const spent = new RegistrationBudget(
    PREAMBLE_RESERVE + STRUCTURE_STEP_RESERVE + AUDIT_RESERVE - 1,
  );
  expect(await registerOnce(harness, spent)).toEqual({ outcome: "deferred" });
  expect(spent.used).toBe(0);
  expect(spent.deferred).toBe(1);
  expect(count(harness, "SELECT count(*) AS n FROM collection_runs")).toBe(0);
}, 60_000);

/**
 * What the previous release's registration left in CORE for a run it did not
 * finish, written through the same port and the same derivation it used: the
 * run, every unit and range, the inventory declaration for a staged run, the
 * first `catalogued` artifacts, and — when it stopped at its artifact budget —
 * a `pending` stage naming the fetch run. A staged run above 50 artifacts
 * never got further than that: its first inventory chunk of 50 was refused.
 */
async function previousReleaseState(
  harness: CollectionHarness,
  catalogued: number,
  pendingStage: boolean,
): Promise<number> {
  const read = await readTerminal(harness.env.EVIDENCE, SOURCE, "run-001");
  if (read.outcome !== "found") throw new Error("terminal missing");
  const manifest = read.manifest;
  const env: IngestEnv = { DB: harness.env.DB, EVIDENCE: harness.env.EVIDENCE };
  const identity = {
    source: SOURCE,
    runId: "run-001",
    terminalDigest: read.terminalDigest,
    registrationContractVersion: REGISTRATION_CONTRACT_VERSION,
  };
  await insertCollectionRunIfAbsent(env.DB, {
    ...identity,
    terminalKey: read.key,
    providerOutcome: manifest.providerOutcome,
    coverageStatus: manifest.coverageStatus,
    acquisitionSessionRef: null,
    firstSeenAt: "2026-09-10T00:00:00.000Z",
    blockedCode: null,
  });
  const row = (await readCollectionRun(env.DB, identity))!;
  await appendCollectionStage(env.DB, {
    collectionRunId: row.id,
    stage: "persisted",
    state: "completed",
    evidenceRef: read.terminalDigest,
    recordedAt: "2026-09-10T00:00:00.000Z",
  });
  const port = directRegistrationPort(env, CLIENT);
  const fetchRunId = await port.createRun(createRunRequest(manifest));
  const unitIds = new Map<string, number>();
  for (const unit of manifest.units)
    unitIds.set(unit.unitKey, await port.addUnit(fetchRunId, unitRequest(unit)));
  for (const range of runRangeRequests(manifest)) await port.addRunRange(fetchRunId, range);
  const requests = manifest.artifacts.map((entry) => artifactRequest(manifest, entry, unitIds));
  const items = [];
  for (const [index, request] of requests.entries()) {
    const parsed = descriptorContractV1.parseRequest(
      request as unknown as Record<string, unknown>,
      { runId: fetchRunId },
    );
    items.push({
      artifactKey: manifest.artifacts[index]!.artifactKey,
      sha256: manifest.artifacts[index]!.sha256,
      descriptorSha256: await descriptorContractV1.digest(
        descriptorContractV1.encode(descriptorContractV1.normalize(parsed)),
      ),
    });
  }
  if (items.length > DIRECT_SEAL_ARTIFACTS)
    await port.beginInventory(
      fetchRunId,
      await sha256Hex(new TextEncoder().encode(canonicalJsonV1(items as unknown as JsonValue))),
      items.length,
    );
  for (const [index, entry] of manifest.artifacts.slice(0, catalogued).entries()) {
    await port.adoptObject!(fetchRunId, entry.sha256, entry.byteSize);
    await port.addArtifact(fetchRunId, requests[index]!);
  }
  if (pendingStage)
    await appendCollectionStage(env.DB, {
      collectionRunId: row.id,
      stage: "registered",
      state: "pending",
      evidenceRef: String(fetchRunId),
      recordedAt: "2026-09-10T00:05:00.000Z",
    });
  return fetchRunId;
}

test("a run the previous release left pending continues under the same identity", async () => {
  // Staged registration changes how many calls a registration takes, not
  // what a terminal means in CORE: descriptors, inventory digest and seal
  // attempt are byte-identical, so #250 kept the registration contract
  // version and old progress under the same version is reused as it is. (The
  // version moved later, for ADR 0022's datasets; the state below is written
  // under the current one.)
  expect(REGISTRATION_CONTRACT_VERSION).toBe("terminal-registration-v2");
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 12 });
  const fetchRunId = await previousReleaseState(harness, 1, true);
  const calls: Calls = {};
  const invocations = await registerUntilDone(harness, { calls });
  expect(invocations.at(-1)!.outcome).toMatchObject({ outcome: "registered", fetchRunId });
  // Only the missing artifacts were catalogued; nothing was re-created.
  expect(calls["addArtifact"]).toHaveLength(11);
  expect(calls["addUnit"]).toBeUndefined();
  expect(calls["addRunRange"]).toBeUndefined();
  expect(count(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
}, 60_000);

test("a staged run the previous release could never seal completes on its own inventory", async () => {
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: DIRECT_SEAL_ARTIFACTS + 10 });
  // The previous release catalogued fifty artifacts, then failed its first
  // inventory chunk on every attempt, without recording a pending stage.
  const fetchRunId = await previousReleaseState(harness, DIRECT_SEAL_ARTIFACTS, false);
  const inventory = count(harness, "SELECT count(*) AS n FROM run_inventories");
  expect(inventory).toBe(1);
  const invocations = await registerUntilDone(harness);
  expect(invocations.at(-1)!.outcome).toMatchObject({ outcome: "registered", fetchRunId });
  // The same declaration was reused rather than a second one begun.
  expect(count(harness, "SELECT count(*) AS n FROM run_inventories")).toBe(1);
  expect(count(harness, "SELECT count(*) AS n FROM run_inventory_items")).toBe(60);
  expect(count(harness, "SELECT count(*) AS n FROM fetch_artifacts")).toBe(60);
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
}, 60_000);

test("the scan continues a staged registration on the next tick, before it lists", async () => {
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 45 });
  const first = await collectionScan(harness.env, { budget: new RegistrationBudget() });
  expect(first).toMatchObject({ listed: 1, pending: 1, continued: 0 });
  const second = await collectionScan(harness.env, { budget: new RegistrationBudget() });
  expect(second).toMatchObject({ continued: 1 });
  const ticks = [first, second];
  for (
    let index = 0;
    index < 5 && count(harness, "SELECT count(*) AS n FROM fetch_run_seals") === 0;
    index += 1
  )
    ticks.push(await collectionScan(harness.env, { budget: new RegistrationBudget() }));
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
  // Nothing is left for the next tick to continue.
  const last = await collectionScan(harness.env, { budget: new RegistrationBudget() });
  expect(last).toMatchObject({ continued: 0 });
}, 60_000);

test("the scan stops at a spent budget and leaves its cursor where it was", async () => {
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 3, runId: "run-001" });
  await persistShape(harness, { artifacts: 3, runId: "run-002" });
  const spent = new RegistrationBudget(
    PREAMBLE_RESERVE + STRUCTURE_STEP_RESERVE + AUDIT_RESERVE - 1,
  );
  const summary = await collectionScan(harness.env, { budget: spent });
  expect(summary).toMatchObject({ listed: 2, deferred: 1, budgetExhausted: true });
  expect(count(harness, "SELECT count(*) AS n FROM collection_runs")).toBe(0);
  const next = await collectionScan(harness.env, { budget: new RegistrationBudget() });
  expect(next).toMatchObject({ registered: 2 });
}, 60_000);

/**
 * The in-process port, except that `method` runs to completion and then the
 * invocation dies: what a Worker killed between two calls of the final step
 * leaves behind.
 */
function dyingAfter(
  method: keyof RunRegistrationPort,
  calls: Calls,
): (env: IngestEnv) => RunRegistrationPort {
  return (env) => {
    const port = directRegistrationPort(env, CLIENT) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, operation] of Object.entries(port))
      wrapped[name] = async (...args: unknown[]) => {
        (calls[name] ??= []).push({ cost: 0, usedBefore: 0, r2Before: 0 });
        const result = await operation.apply(port, args);
        if (name === method) throw new Error("invocation ended");
        return result;
      };
    return wrapped as unknown as RunRegistrationPort;
  };
}

test("an invocation that dies inside the final step is finished by the next one, each effect once", async () => {
  // Between the run report and the seal, and between the seal and the link,
  // for a direct seal and a staged one. The next invocation re-enters the
  // final step: the run report and the seal answer from what CORE holds under
  // the same report key and the same attempt id, and the link is made once.
  for (const artifacts of [6, DIRECT_SEAL_ARTIFACTS + 5])
    for (const method of [
      "addRunReport",
      artifacts > DIRECT_SEAL_ARTIFACTS ? "sealStagedInventory" : "seal",
    ] as const) {
      const harness = collectionHarness();
      await persistShape(harness, { artifacts, units: 2 });
      const calls: Calls = {};
      const budget = new RegistrationBudget(1_000_000);
      await expect(
        registerOnce(harness, budget, { port: dyingAfter(method, calls) }),
      ).rejects.toThrow("invocation ended");
      expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(
        method === "addRunReport" ? 0 : 1,
      );
      expect(
        count(harness, "SELECT count(*) AS n FROM collection_runs WHERE registered_at IS NULL"),
      ).toBe(1);

      const rest = await registerUntilDone(harness);
      expect(rest.map((invocation) => invocation.outcome.outcome)).toEqual(["registered"]);
      expect(count(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
      expect(count(harness, "SELECT count(*) AS n FROM fetch_run_reports")).toBe(1);
      expect(count(harness, "SELECT count(*) AS n FROM fetch_unit_reports")).toBe(2);
      expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
      expect(count(harness, "SELECT count(*) AS n FROM run_inventories")).toBe(1);
      expect(count(harness, "SELECT count(*) AS n FROM ingestion_attempts")).toBe(1);
      expect(
        count(
          harness,
          "SELECT count(*) AS n FROM ingestion_attempts WHERE external_attempt_id = ?",
          `run-001:${REGISTRATION_CONTRACT_VERSION}`,
        ),
      ).toBe(1);
      expect(
        stageRows(harness)
          .filter((row) => row.stage === "registered")
          .map((row) => row.state),
      ).toEqual(["completed"]);
      // Asked again, it is simply registered.
      expect(await registerOnce(harness, new RegistrationBudget())).toMatchObject({
        outcome: "already_registered",
      });
    }
}, 120_000);

test("an inventory resumed with a different chunk size stages every item once, on the new boundaries", async () => {
  // A staged run that yields part-way through its inventory in chunks of 7,
  // then resumes in the contract's chunks of 30: the resume adds only the
  // items the inventory does not hold, so the boundaries move and nothing is
  // staged twice.
  const shape: Shape = { artifacts: DIRECT_SEAL_ARTIFACTS + 12 };
  const register = (harness: CollectionHarness, budget: RegistrationBudget, calls: Calls) =>
    registerTerminal({
      env: { DB: harness.env.DB, EVIDENCE: harness.env.EVIDENCE },
      bucket: harness.env.EVIDENCE,
      clientId: CLIENT,
      source: SOURCE,
      runId: "run-001",
      budget,
      inventoryChunk: 7,
      port: recordingPort(() => budget, calls),
    });
  const probe = collectionHarness();
  await persistShape(probe, shape);
  const measured: Calls = {};
  const unlimited = new RegistrationBudget(1_000_000);
  await register(probe, unlimited, measured);
  expect(measured["addInventoryItems"]).toHaveLength(Math.ceil(62 / 7));
  // Room for exactly two chunks of seven, not the third.
  const limit =
    measured["addInventoryItems"]![2]!.usedBefore + inventoryChunkReserve(7) + AUDIT_RESERVE - 1;

  const harness = collectionHarness();
  await persistShape(harness, shape);
  const first: Calls = {};
  const budget = new RegistrationBudget(limit);
  expect(await register(harness, budget, first)).toMatchObject({
    outcome: "pending",
    phase: "inventory",
  });
  expect(first["addInventoryItems"]).toHaveLength(2);
  expect(count(harness, "SELECT count(*) AS n FROM run_inventory_items")).toBe(14);

  const calls: Calls = {};
  const rest = await registerUntilDone(harness, { calls });
  expect(rest.at(-1)!.outcome.outcome).toBe("registered");
  // 48 items left: one chunk of 30 and one of 18, no artifact catalogued again.
  expect(calls["addInventoryItems"]).toHaveLength(2);
  expect(calls["addArtifact"]).toBeUndefined();
  expect(count(harness, "SELECT count(*) AS n FROM run_inventory_items")).toBe(62);
  expect(count(harness, "SELECT count(DISTINCT artifact_key) AS n FROM run_inventory_items")).toBe(
    62,
  );
  expect(count(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
}, 120_000);
