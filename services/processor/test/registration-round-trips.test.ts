// How many D1 statements one registration makes, and proof that remembering
// a fetch run for the length of one registration changes nothing it writes or
// answers.
//
// Every port operation used to read its fetch run again (`loadRun`), so a run
// of N artifacts read the same immutable `fetch_runs` row about 2N times.
// `registerTerminal` now reads it once per call (`rememberingRunLookups`).
// The client and route checks are deliberately not remembered: they still run
// before every operation.
//
//   * the statement count of a synthetic multi-artifact registration is
//     pinned, and so is what each kind of statement costs;
//   * the run is looked up once per registration call and again by the next
//     call: nothing is remembered across registrations;
//   * the same captures registered with and without the memory leave every
//     CORE table identical and get the same verdicts: registered, already
//     registered, staged, budgeted over several invocations, a missing object,
//     and a route or client revoked half-way through.
//
// "Without the memory" is the code as it was: the port is handed a copy of
// the env, which `loadRun` does not remember anything for, so every operation
// reads its run as before. The first test checks that this is so.
//
// Synthetic throughout: `kogane-synthetic`, no amount, no account, no token.
import type { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  DIRECT_SEAL_ARTIFACTS,
  RegistrationBudget,
  registerTerminal,
  type RegisterTerminalOutcome,
} from "../../../packages/application/src/collection/index.ts";
import type { IngestEnv } from "../../../packages/application/src/ingest/contract.ts";
import {
  directRegistrationPort,
  type RunRegistrationPort,
} from "../../../packages/application/src/ingest/port.ts";
import { objectKey } from "../../../packages/collection/src/keys.ts";
import type {
  TerminalRange,
  TerminalTransformation,
  TerminalUnit,
} from "../../../packages/collection/src/manifest.ts";
import type { PersistArtifact } from "../../../packages/collection/src/writer.ts";
import type { D1Like, D1StatementLike } from "../../../packages/storage-d1/src/d1.ts";
import { fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";
import {
  artifact,
  CLIENT,
  collectionHarness,
  persistSyntheticRun,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget (see packages/storage-d1/test/sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const NOW = new Date("2026-09-02T00:00:00.000Z");
// Every `Date.now()` the use cases stamp a row with is this instant, so two
// registrations of the same capture write byte-identical rows.
beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

interface Executed {
  sql: string;
  binds: readonly unknown[];
}

/** `db`, recording the text and bindings of every statement it executes. */
function recordingD1(db: D1Like, log: Executed[]): D1Like {
  const inner = new WeakMap<D1StatementLike, D1StatementLike>();
  const entries = new WeakMap<D1StatementLike, Executed>();
  const statement = (wrapped: D1StatementLike, entry: Executed): D1StatementLike => {
    const record = <T>(execute: () => Promise<T>): Promise<T> => {
      log.push(entry);
      return execute();
    };
    const proxy: D1StatementLike = {
      bind: (...values: unknown[]) =>
        statement(wrapped.bind(...values), { sql: entry.sql, binds: values }),
      first: <T>() => record(() => wrapped.first<T>()),
      run: () => record(() => wrapped.run()),
      all: <T>() => record(() => wrapped.all<T>()),
      raw: <T>() => record(() => wrapped.raw<T>()),
    };
    inner.set(proxy, wrapped);
    entries.set(proxy, entry);
    return proxy;
  };
  return {
    prepare: (sql) => statement(db.prepare(sql), { sql, binds: [] }),
    batch: (statements) => {
      for (const each of statements) log.push(entries.get(each) ?? { sql: "?", binds: [] });
      return db.batch(statements.map((each) => inner.get(each) ?? each));
    },
  };
}

const RUN_LOOKUP = /from "fetch_runs" where "fetch_runs"\."id" = \?/u;
const CLIENT_CHECK = /from "ingest_clients" where/u;
const ROUTE_CHECK = /FROM active_ingest_routes\s+WHERE/u;
const matching = (log: readonly Executed[], pattern: RegExp) =>
  log.filter((entry) => pattern.test(entry.sql)).length;

interface Shape {
  runId?: string;
  artifacts: number;
  units?: number;
  ranges?: number;
  /** Derived artifacts, each with a transformation from `parents` provider artifacts. */
  derived?: number;
  parents?: number;
}

/** Persist one synthetic run of the given shape exactly as a collector would. */
async function persistShape(harness: CollectionHarness, shape: Shape): Promise<PersistArtifact[]> {
  const units: TerminalUnit[] = [];
  for (let index = 0; index < (shape.units ?? 1); index += 1)
    units.push({
      unitKey: `unit-${index}`,
      unitKind: "account",
      artifactCount: index === 0 ? shape.artifacts + (shape.derived ?? 0) : 0,
      coverageStatus: "partial",
    });
  const ranges: TerminalRange[] = [];
  for (let index = 0; index < (shape.ranges ?? 1); index += 1)
    ranges.push({
      rangeKey: `range-${index}`,
      rangeKind: "declared_coverage",
      precision: "month",
      basis: "manifest",
      startValue: "2026-01",
      endValue: "2026-12",
    });
  const artifacts: PersistArtifact[] = [];
  for (let index = 0; index < shape.artifacts; index += 1) {
    const key = `page-${String(index).padStart(4, "0")}.json`;
    artifacts.push(await artifact(key, `{"synthetic":"${key}"}`, { unitKey: "unit-0" }));
  }
  const transformations: TerminalTransformation[] = [];
  for (let index = 0; index < (shape.derived ?? 0); index += 1) {
    const key = `derived-${index}.json`;
    artifacts.push(
      await artifact(key, `{"synthetic":"${key}"}`, {
        role: "collector_derived",
        unitKey: "unit-0",
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

/** With the memory (the code as shipped) or without it (the code as it was). */
type Mode = "remembered" | "legacy";

/** Runs before a port operation; `index` counts that method's calls in one registration. */
type BeforeCall = (method: string, index: number) => void;

interface Registered {
  outcome: RegisterTerminalOutcome;
  log: Executed[];
  portCalls: number;
}

async function registerAs(
  mode: Mode,
  harness: CollectionHarness,
  options: { budget?: RegistrationBudget; runId?: string; before?: BeforeCall } = {},
): Promise<Registered> {
  const log: Executed[] = [];
  let portCalls = 0;
  const counts = new Map<string, number>();
  const port = (env: IngestEnv): RunRegistrationPort => {
    // A copy of the env is one `loadRun` remembers nothing for: every
    // operation reads its run, exactly as before the memory existed.
    const operations = directRegistrationPort(
      mode === "legacy" ? { ...env } : env,
      CLIENT,
    ) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, operation] of Object.entries(operations))
      wrapped[name] = (...args: unknown[]) => {
        const index = counts.get(name) ?? 0;
        counts.set(name, index + 1);
        portCalls += 1;
        options.before?.(name, index);
        return operation(...args);
      };
    return wrapped as unknown as RunRegistrationPort;
  };
  const outcome = await registerTerminal({
    env: { DB: recordingD1(harness.env.DB, log), EVIDENCE: harness.env.EVIDENCE },
    bucket: harness.env.EVIDENCE,
    clientId: CLIENT,
    source: SOURCE,
    runId: options.runId ?? "run-001",
    budget: options.budget ?? new RegistrationBudget(1_000_000),
    now: () => NOW,
    port,
  });
  return { outcome, log, portCalls };
}

/** Every row of every CORE table, as sorted JSON per table. */
function snapshot(db: Database): Record<string, string[]> {
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.query(`SELECT * FROM "${name}"`).all() as object[])
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

/** The direct-seal shape: provider pages, derived artifacts with lineage, units and ranges. */
const DIRECT: Shape = { artifacts: 10, derived: 2, parents: 2, units: 2, ranges: 2 };

test("one registration reads its fetch run once, and the client and route before every operation", async () => {
  const counts: Record<Mode, Registered> = {} as Record<Mode, Registered>;
  for (const mode of ["legacy", "remembered"] as const) {
    const harness = collectionHarness();
    await persistShape(harness, DIRECT);
    counts[mode] = await registerAs(mode, harness);
    expect(counts[mode].outcome.outcome).toBe("registered");
  }
  const { legacy, remembered } = counts;
  // Both made the same port operations: createRun, 2 units, 2 ranges,
  // 12 x (adopt + catalogue), 2 unit reports, the run report and the seal.
  expect(legacy.portCalls).toBe(1 + 2 + 2 + 12 * 2 + 2 + 1 + 1);
  expect(remembered.portCalls).toBe(legacy.portCalls);
  // The code as it was read the run in every operation but createRun, which
  // makes it; that is what "legacy" reproduces.
  expect(matching(legacy.log, RUN_LOOKUP)).toBe(legacy.portCalls - 1);
  // Now: once.
  expect(matching(remembered.log, RUN_LOOKUP)).toBe(1);
  // Authorization is not remembered: one client and one route check per
  // operation, in both.
  for (const registered of [legacy, remembered]) {
    expect(matching(registered.log, CLIENT_CHECK)).toBe(registered.portCalls);
    expect(matching(registered.log, ROUTE_CHECK)).toBe(registered.portCalls);
  }
  // Everything else is the same statements, in the same order.
  const others = (log: readonly Executed[]) =>
    log.filter((entry) => !RUN_LOOKUP.test(entry.sql)).map((entry) => entry.sql);
  expect(others(remembered.log)).toEqual(others(legacy.log));
  // The pinned bounds: 288 statements before, 257 now, for 12 artifacts.
  expect(legacy.log.length).toBe(288);
  expect(remembered.log.length).toBeLessThanOrEqual(257);
  expect(legacy.log.length - remembered.log.length).toBe(legacy.portCalls - 2);
});

test("nothing is remembered across registrations: each invocation of a budgeted run reads the run again", async () => {
  const harness = collectionHarness();
  await persistShape(harness, { artifacts: 40 });
  const invocations: Registered[] = [];
  for (let index = 0; index < 20; index += 1) {
    const registered = await registerAs("remembered", harness, {
      budget: new RegistrationBudget(),
    });
    invocations.push(registered);
    if (registered.outcome.outcome !== "pending") break;
  }
  expect(invocations.at(-1)!.outcome.outcome).toBe("registered");
  expect(invocations.length).toBeGreaterThan(1);
  // Every invocation catalogues after createRun, so each reads the run, once.
  for (const invocation of invocations) expect(matching(invocation.log, RUN_LOOKUP)).toBe(1);
});

/** Persist the same capture into two fresh harnesses and register it in each mode. */
async function differential(
  shape: Shape,
  register: (mode: Mode, harness: CollectionHarness) => Promise<RegisterTerminalOutcome[]>,
  prepare?: (harness: CollectionHarness, artifacts: readonly PersistArtifact[]) => void,
): Promise<Record<Mode, { outcomes: RegisterTerminalOutcome[]; rows: Record<string, string[]> }>> {
  const result = {} as Record<
    Mode,
    { outcomes: RegisterTerminalOutcome[]; rows: Record<string, string[]> }
  >;
  for (const mode of ["legacy", "remembered"] as const) {
    const harness = collectionHarness();
    const artifacts = await persistShape(harness, shape);
    prepare?.(harness, artifacts);
    const outcomes = await register(mode, harness);
    result[mode] = { outcomes, rows: snapshot(harness.db) };
  }
  return result;
}

const once =
  (
    options: {
      budget?: () => RegistrationBudget;
      before?: (harness: CollectionHarness) => BeforeCall;
    } = {},
  ) =>
  async (mode: Mode, harness: CollectionHarness) => [
    (
      await registerAs(mode, harness, {
        ...(options.budget ? { budget: options.budget() } : {}),
        ...(options.before ? { before: options.before(harness) } : {}),
      })
    ).outcome,
  ];

test("registered, then asked again: the same verdicts and every CORE row identical", async () => {
  const { legacy, remembered } = await differential(DIRECT, async (mode, harness) => [
    (await registerAs(mode, harness)).outcome,
    (await registerAs(mode, harness)).outcome,
  ]);
  expect(legacy.outcomes.map((outcome) => outcome.outcome)).toEqual([
    "registered",
    "already_registered",
  ]);
  expect(remembered.outcomes).toEqual(legacy.outcomes);
  expect(remembered.rows).toEqual(legacy.rows);
  expect(legacy.rows["fetch_artifacts"]).toHaveLength(12);
  expect(legacy.rows["artifact_relations"]).toHaveLength(4);
  expect(legacy.rows["fetch_run_seals"]).toHaveLength(1);
});

test("a staged inventory: the same verdict and every CORE row identical", async () => {
  const shape = { artifacts: DIRECT_SEAL_ARTIFACTS + 10, units: 2 };
  const { legacy, remembered } = await differential(shape, once());
  expect(legacy.outcomes[0]!.outcome).toBe("registered");
  expect(remembered.outcomes).toEqual(legacy.outcomes);
  expect(remembered.rows).toEqual(legacy.rows);
  expect(legacy.rows["run_inventory_items"]).toHaveLength(DIRECT_SEAL_ARTIFACTS + 10);
});

test("a run registered over several budgeted invocations ends with the same rows", async () => {
  const until = async (mode: Mode, harness: CollectionHarness) => {
    const outcomes: RegisterTerminalOutcome[] = [];
    for (let index = 0; index < 20; index += 1) {
      const { outcome } = await registerAs(mode, harness, { budget: new RegistrationBudget() });
      outcomes.push(outcome);
      if (outcome.outcome !== "pending") break;
    }
    return outcomes;
  };
  const { legacy, remembered } = await differential(
    { artifacts: DIRECT_SEAL_ARTIFACTS + 20, units: 2 },
    until,
  );
  expect(legacy.outcomes.length).toBeGreaterThan(1);
  expect(legacy.outcomes.at(-1)!.outcome).toBe("registered");
  expect(remembered.outcomes.at(-1)).toEqual(legacy.outcomes.at(-1)!);
  // Fewer statements per step can only let an invocation do more, never less.
  expect(remembered.outcomes.length).toBeLessThanOrEqual(legacy.outcomes.length);
  // Each yield records one pending stage, so only their number may differ.
  const settled = (rows: Record<string, string[]>) => ({
    ...rows,
    collection_run_stages: rows["collection_run_stages"]!.filter(
      (row) => !row.includes('"state":"pending"'),
    ),
  });
  expect(settled(remembered.rows)).toEqual(settled(legacy.rows));
});

test("a missing object: the same block and every CORE row identical", async () => {
  const { legacy, remembered } = await differential(DIRECT, once(), (harness, artifacts) => {
    harness.bucket.entries.delete(objectKey(artifacts[3]!.sha256));
  });
  expect(legacy.outcomes[0]).toMatchObject({ outcome: "blocked", recorded: false });
  expect(remembered.outcomes).toEqual(legacy.outcomes);
  expect(remembered.rows).toEqual(legacy.rows);
});

test("a route revoked half-way through: refused at the same operation, retryable, every CORE row identical", async () => {
  const revokeRoute =
    (harness: CollectionHarness): BeforeCall =>
    (method, index) => {
      if (method === "addArtifact" && index === 4)
        harness.db.exec("UPDATE ingest_client_routes SET active = 0");
    };
  const { legacy, remembered } = await differential(DIRECT, async (mode, harness) => {
    const refused = await registerAs(mode, harness, { before: revokeRoute(harness) });
    // The configuration is fixed and the next attempt finishes the run.
    harness.db.exec("UPDATE ingest_client_routes SET active = 1");
    return [refused.outcome, (await registerAs(mode, harness)).outcome];
  });
  expect(legacy.outcomes.map((outcome) => outcome.outcome)).toEqual(["retryable", "registered"]);
  expect(legacy.outcomes[0]).toMatchObject({ code: "inactive_ingest_route" });
  expect(remembered.outcomes).toEqual(legacy.outcomes);
  expect(remembered.rows).toEqual(legacy.rows);
});

test("a client revoked half-way through: refused at the same operation, retryable, every CORE row identical", async () => {
  const { legacy, remembered } = await differential(
    DIRECT,
    once({
      before: (harness) => (method, index) => {
        if (method === "addUnitReport" && index === 1)
          harness.db.exec("UPDATE ingest_clients SET active = 0");
      },
    }),
  );
  expect(legacy.outcomes[0]).toMatchObject({
    outcome: "retryable",
    code: "inactive_ingest_client",
  });
  expect(remembered.outcomes).toEqual(legacy.outcomes);
  expect(remembered.rows).toEqual(legacy.rows);
  // Revoked after the catalogue and before the seal: nothing was sealed.
  expect(legacy.rows["fetch_artifacts"]).toHaveLength(12);
  expect(legacy.rows["fetch_run_seals"]).toHaveLength(0);
});
