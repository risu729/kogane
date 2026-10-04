// The collection scan converges past terminals CORE has already judged
// (ADR 0024).
//
// Until ADR 0024 a blocked or retryable answer spent one of the tick's five
// registrations, and the cursor only advanced once the whole page was dealt
// with, so a page holding more than five terminals that never register was
// listed again on every tick and the scan never left it. These tests build
// that page on synthetic terminals — refused ones first, the worst order —
// and show that it is finished in a bounded number of ticks, that new
// terminals on it still register within the budget, that a blocked run is
// never attempted again and a retryable one at most once per retry interval.
//
// Everything is synthetic: the source is `kogane-synthetic`, the refusals are
// made with a failed run that persisted no provider bytes (blocked
// `provider_run_failed`) and with a producer the Processor has no route for
// (retryable `inactive_ingest_route`), which are the shapes of the refusals
// observed, not their contents.
import { beforeAll, expect, test } from "bun:test";
import {
  meterBucket,
  meterD1,
  OperationMeter,
  RETRYABLE_RETRY_INTERVAL_MS,
  RegistrationBudget,
  registerTerminal,
} from "../../../packages/application/src/collection/index.ts";
import { directRegistrationPort } from "../../../packages/application/src/ingest/port.ts";
import { terminalKey } from "../../../packages/collection/src/keys.ts";
import {
  collectionScan,
  handleTerminalNotification,
  registerCollectionRun,
  type ScanOptions,
  type ScanSummary,
} from "../src/collection/index.ts";
import {
  artifact,
  collectionHarness,
  CLIENT,
  notification,
  persistSyntheticRun,
  rows,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";
import { fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget, not inside whichever test first asks for a copy
// (see packages/storage-d1/test/sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const UNROUTED_PRODUCER = "synthetic-unrouted-collector";
const START_MS = Date.parse("2026-09-20T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const runId = (n: number) => `run-${String(n).padStart(3, "0")}`;

/** A failed run that persisted nothing from the provider: blocked on sight. */
async function persistBlocked(harness: CollectionHarness, id: string): Promise<void> {
  await persistSyntheticRun(harness, {
    run: { runId: id, providerOutcome: "failed", safeErrorCode: "login_failed" },
    artifacts: [
      await artifact("manifest.json", '{"synthetic":"manifest"}', { role: "collector_manifest" }),
    ],
  });
}

/** A run whose producer the Processor has no route for: refused retryable. */
async function persistRetryable(harness: CollectionHarness, id: string): Promise<void> {
  await persistSyntheticRun(harness, { run: { runId: id, producer: UNROUTED_PRODUCER } });
}

/**
 * The stalled page: 25 terminals on the first page, the first six of them
 * permanently refused (three blocked, three retryable), then `extra` more
 * terminals on the following page(s).
 */
async function stalledPage(extra: number): Promise<CollectionHarness> {
  const harness = collectionHarness();
  // The producer exists and is known to the Processor's client, but has no
  // route to the source: exactly what `inactive_ingest_route` says.
  harness.db.exec(`
    INSERT INTO producers (id, kind, display_name)
      VALUES ('${UNROUTED_PRODUCER}', 'collector', 'Synthetic unrouted collector');
    INSERT INTO producer_sources (producer_id, source_id)
      VALUES ('${UNROUTED_PRODUCER}', '${SOURCE}');
  `);
  for (let n = 1; n <= 25 + extra; n += 1) {
    if (n <= 3) await persistBlocked(harness, runId(n));
    else if (n <= 6) await persistRetryable(harness, runId(n));
    else await persistSyntheticRun(harness, { run: { runId: runId(n) } });
  }
  return harness;
}

interface ScanStateRow {
  cursor: string | null;
  pages_completed: number;
  cycles_completed: number;
  last_seen: number;
  last_registered: number;
  last_blocked: number;
}

const scanState = (h: CollectionHarness) =>
  h.db
    .query(
      `SELECT cursor, pages_completed, cycles_completed, last_seen, last_registered, last_blocked
         FROM collection_scan_state`,
    )
    .get() as ScanStateRow;
const countOf = (h: CollectionHarness, sql: string): number =>
  (h.db.query(sql).get() as { n: number }).n;
const sealed = (h: CollectionHarness) => countOf(h, "SELECT count(*) AS n FROM fetch_run_seals");
const stageRows = (h: CollectionHarness) =>
  countOf(h, "SELECT count(*) AS n FROM collection_run_stages");
const retryableStages = (h: CollectionHarness) =>
  countOf(
    h,
    `SELECT count(*) AS n FROM collection_run_stages
      WHERE stage = 'registered' AND state = 'retryable'`,
  );

/**
 * Ticks the stalled page until its first cycle is complete and nothing is
 * left pending; returns the instant of the next tick.
 */
async function settle(h: CollectionHarness): Promise<number> {
  let at = START_MS;
  for (let i = 0; i < 10; i += 1) {
    const summary = await tick(h, at);
    at += 5 * 60 * 1000;
    if (summary.cycleComplete && summary.pending === 0) return at;
  }
  throw new Error("the scan did not settle in ten ticks");
}

/** One cron tick at a fixed instant, with a fresh invocation budget. */
function tick(h: CollectionHarness, atMs: number, options: ScanOptions = {}): Promise<ScanSummary> {
  return collectionScan(h.env, {
    budget: new RegistrationBudget(),
    now: () => new Date(atMs),
    ...options,
  });
}

test("a page with more than five refused terminals is finished and the cursor moves on", async () => {
  const harness = await stalledPage(5);
  // Every tick five minutes apart, as the cron runs.
  let at = START_MS;
  const ticks: ScanSummary[] = [];
  while (scanState(harness).cursor === null && ticks.length < 10) {
    ticks.push(await tick(harness, at));
    at += 5 * 60 * 1000;
  }
  // Tick 1 judges the first five refused terminals and holds the page; each
  // later tick answers them from CORE for free and spends its five on new
  // work, so a page of 6 refusals and 19 registrations takes 25 / 5 ticks.
  expect(ticks).toHaveLength(5);
  expect(ticks[0]).toMatchObject({
    listed: 25,
    blocked: 3,
    retryable: 2,
    alreadyJudged: 0,
    registered: 0,
    budgetExhausted: true,
  });
  expect(ticks[1]).toMatchObject({
    blocked: 3,
    retryable: 3,
    alreadyJudged: 5,
    registered: 4,
    budgetExhausted: true,
  });
  const last = ticks[4]!;
  expect(last).toMatchObject({
    listed: 25,
    alreadyJudged: 6,
    alreadyRegistered: 14,
    budgetExhausted: false,
    cycleComplete: false,
  });
  // The fifth tick's last registration may yield at the operation budget
  // (ADR 0010) and is continued first on the next tick; either way it is
  // work begun, and the page is done.
  expect(last.registered + last.pending).toBe(5);
  // Held ticks count neither a page nor a cycle.
  expect(scanState(harness)).toMatchObject({ pages_completed: 1, cycles_completed: 0 });

  // The next page: the five terminals behind the stalled one register, and
  // the walk completes.
  const next = await tick(harness, at);
  expect(next).toMatchObject({ listed: 5, cycleComplete: true, pending: 0 });
  // The continuation counts among this tick's registrations.
  expect(next.continued).toBe(last.pending);
  expect(next.registered).toBe(5 + last.pending);
  expect(sealed(harness)).toBe(24);
  expect(scanState(harness)).toMatchObject({
    cursor: null,
    pages_completed: 2,
    cycles_completed: 1,
    last_seen: 5,
    last_registered: next.registered,
    last_blocked: 0,
  });

  // A new cycle over a page that is wholly judged: nothing is attempted,
  // nothing is appended, and the cursor moves past it in one tick.
  const stagesBefore = stageRows(harness);
  const again = await tick(harness, at + 5 * 60 * 1000);
  expect(again).toMatchObject({
    listed: 25,
    registered: 0,
    alreadyRegistered: 19,
    blocked: 3,
    retryable: 3,
    alreadyJudged: 6,
    budgetExhausted: false,
  });
  expect(scanState(harness).cursor).not.toBeNull();
  expect(scanState(harness)).toMatchObject({ pages_completed: 3, last_blocked: 3 });
  expect(stageRows(harness)).toBe(stagesBefore);
  // One row per terminal, however many times the page was listed.
  expect(countOf(harness, "SELECT count(*) AS n FROM collection_runs")).toBe(30);
});

test("a judged page costs a few operations per terminal, not a registration", async () => {
  const harness = await stalledPage(0);
  const at = await settle(harness);
  expect(sealed(harness)).toBe(19);
  const budget = new RegistrationBudget();
  const summary = await tick(harness, at, { budget });
  expect(summary).toMatchObject({ listed: 25, alreadyJudged: 6, alreadyRegistered: 19 });
  expect(summary.cycleComplete).toBe(true);
  // At most five operations per listed terminal (81 measured for this page),
  // well inside the invocation budget of ADR 0010, with room left for the
  // operations dispatch that shares it.
  expect(budget.used).toBeLessThanOrEqual(25 * 5);
  expect(budget.deferred).toBe(0);
});

test("new terminals on a judged page still register within the tick's budget", async () => {
  const harness = await stalledPage(0);
  const at = await settle(harness);
  expect(sealed(harness)).toBe(19);
  // Seven terminals land on the first page (their run ids sort first), where
  // they have no row yet: every one is attempted, five per tick.
  for (let n = 1; n <= 7; n += 1) {
    await persistSyntheticRun(harness, { run: { runId: `new-${n}` } });
  }
  const first = await tick(harness, at, { pageLimit: 32 });
  expect(first).toMatchObject({ listed: 32, registered: 5, budgetExhausted: true });
  expect(scanState(harness).cursor).toBeNull();
  const second = await tick(harness, at + 5 * 60 * 1000, { pageLimit: 32 });
  expect(second).toMatchObject({
    listed: 32,
    registered: 2,
    alreadyRegistered: 24,
    alreadyJudged: 6,
    budgetExhausted: false,
    cycleComplete: true,
  });
  expect(sealed(harness)).toBe(26);
});

test("a blocked run is never attempted again; a retryable one once per retry interval", async () => {
  const harness = await stalledPage(0);
  await settle(harness);
  expect(retryableStages(harness)).toBe(3);
  const blockedStages = () =>
    countOf(
      harness,
      `SELECT count(*) AS n FROM collection_run_stages
        WHERE stage = 'registered' AND state = 'blocked'`,
    );
  expect(blockedStages()).toBe(3);

  // Within the interval, however often the page is listed, nothing is tried.
  for (const offset of [HOUR_MS, 12 * HOUR_MS, RETRYABLE_RETRY_INTERVAL_MS - HOUR_MS]) {
    const summary = await tick(harness, START_MS + offset);
    expect(summary).toMatchObject({ alreadyJudged: 6, retryable: 3, blocked: 3 });
  }
  expect(retryableStages(harness)).toBe(3);

  // Once the interval has passed, each retryable run is attempted once; the
  // refusal repeats and is recorded once more, which restarts its interval.
  const due = START_MS + RETRYABLE_RETRY_INTERVAL_MS + HOUR_MS;
  const retried = await tick(harness, due);
  expect(retried).toMatchObject({ retryable: 3, blocked: 3, alreadyJudged: 3 });
  expect(retried.budgetExhausted).toBe(false);
  expect(retryableStages(harness)).toBe(6);
  const after = await tick(harness, due + 5 * 60 * 1000);
  expect(after).toMatchObject({ alreadyJudged: 6 });
  expect(retryableStages(harness)).toBe(6);

  // A block is write-once: two days on, still one blocked stage per run.
  await tick(harness, START_MS + 2 * RETRYABLE_RETRY_INTERVAL_MS + 2 * HOUR_MS);
  expect(blockedStages()).toBe(3);
  expect(
    countOf(harness, "SELECT count(*) AS n FROM collection_runs WHERE blocked_code IS NOT NULL"),
  ).toBe(3);
});

test("a configuration fix registers the retryable runs once their interval has passed", async () => {
  const harness = await stalledPage(0);
  await settle(harness);
  // The operator routes the producer. Within the interval the scan still
  // answers from the recorded refusal; the next attempt after it registers.
  harness.db.exec(`
    INSERT INTO ingest_client_producers (ingest_client_id, producer_id)
      VALUES ('${CLIENT}', '${UNROUTED_PRODUCER}');
    INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
      VALUES ('${CLIENT}', '${UNROUTED_PRODUCER}', '${SOURCE}');
  `);
  expect(await tick(harness, START_MS + HOUR_MS)).toMatchObject({ registered: 0, retryable: 3 });
  const due = await tick(harness, START_MS + RETRYABLE_RETRY_INTERVAL_MS + HOUR_MS);
  expect(due).toMatchObject({ registered: 3, retryable: 0, alreadyJudged: 3 });
  expect(sealed(harness)).toBe(22);
});

test("the queue consumer still attempts every delivery it is given", async () => {
  const harness = await stalledPage(0);
  // The registration's own clock on this path is the wall clock.
  await tick(harness, Date.now());
  // The scan recorded run-004 as retryable; a notification for it is still
  // a real attempt (no retry interval on that path), and says so.
  const delivered = await handleTerminalNotification(harness.env, {
    body: notification(SOURCE, runId(4)),
  });
  expect(delivered).toEqual({ outcome: "retryable" });
  const direct = await registerCollectionRun(harness.env, { source: SOURCE, runId: runId(4) });
  expect(direct).toMatchObject({
    outcome: "retryable",
    code: "inactive_ingest_route",
    recorded: false,
  });
  const blocked = await registerCollectionRun(harness.env, { source: SOURCE, runId: runId(1) });
  expect(blocked).toMatchObject({
    outcome: "blocked",
    code: "provider_run_failed",
    recorded: true,
  });
  // Repeated attempts inside the interval append nothing new.
  expect(
    rows<{ n: number }>(
      harness.db,
      `SELECT count(*) AS n FROM collection_run_stages s
         JOIN collection_runs r ON r.id = s.collection_run_id
        WHERE r.run_id = ? AND s.state = 'retryable'`,
      runId(4),
    )[0]!.n,
  ).toBe(1);
});

test("a judged terminal costs its terminal read and two to four statements", async () => {
  const harness = await stalledPage(0);
  const at = await settle(harness);
  const cost = async (id: string) => {
    const budget = new RegistrationBudget();
    const result = await registerCollectionRun(
      harness.env,
      { source: SOURCE, runId: id },
      { budget, retryAfterMs: RETRYABLE_RETRY_INTERVAL_MS, now: () => new Date(at) },
    );
    return { outcome: result.outcome, ...budget.meter };
  };
  // Terminal read, conditional insert, row read; a waiting retryable run
  // also reads whether it registered and its newest stage. Nothing is written.
  const none = { d1Batches: 0, r2Operations: 1 };
  expect(await cost(runId(1))).toEqual({ outcome: "blocked", d1Statements: 2, ...none });
  expect(await cost(runId(4))).toEqual({ outcome: "retryable", d1Statements: 4, ...none });
  expect(await cost(runId(10))).toEqual({
    outcome: "already_registered",
    d1Statements: 2,
    ...none,
  });

  // The whole tick, every binding metered as the invocation probe meters it:
  // 3 x 3 + 3 x 5 + 19 x 3 = 81 inside the registration budget, plus the
  // scan's own list, pending read, state read and state write.
  const meter = new OperationMeter();
  const budget = new RegistrationBudget();
  const env = {
    ...harness.env,
    DB: meterD1(harness.env.DB, meter),
    EVIDENCE: meterBucket(harness.env.EVIDENCE, meter),
  };
  const summary = await collectionScan(env, { budget, now: () => new Date(at) });
  expect(summary).toMatchObject({ listed: 25, alreadyJudged: 6, cycleComplete: true });
  expect(budget.used).toBe(81);
  expect(meter.total).toBe(81 + 4);
});

test("a terminal re-persisted with other bytes is not judged: it is attempted", async () => {
  const harness = await stalledPage(0);
  const at = await settle(harness);
  // Same run ids, different terminal bytes: a new digest, so a new identity.
  for (const id of [runId(1), runId(4)]) {
    const key = `runs/${SOURCE}/${id}/terminal.json`;
    const stored = await harness.bucket.get(key);
    const text = new TextDecoder().decode(await stored!.arrayBuffer());
    await harness.bucket.put(key, `${text}\n`);
  }
  const summary = await tick(harness, at);
  // Both are attempted, and blocked on what the new bytes are (a terminal
  // that is not canonical); the four other refused terminals are answered
  // from their rows.
  expect(summary).toMatchObject({ blocked: 4, retryable: 2, alreadyJudged: 4 });
  expect(countOf(harness, "SELECT count(*) AS n FROM collection_runs")).toBe(27);
});

test("a new registration contract version makes every judged terminal new work", async () => {
  const harness = await stalledPage(0);
  const at = await settle(harness);
  // Stand-in for a bump of REGISTRATION_CONTRACT_VERSION: the rows the scan
  // wrote are relabelled as an older contract's, in this synthetic store only
  // (the trigger that forbids it in CORE is dropped first).
  harness.db.exec(`
    DROP TRIGGER collection_runs_progress_only;
    UPDATE collection_runs SET registration_contract_version = 'terminal-registration-v0';
  `);
  // Minutes after the retryable refusals, well inside their interval: under
  // the new contract they have no row, so they are attempted all the same.
  const first = await tick(harness, at);
  expect(first).toMatchObject({
    blocked: 3,
    retryable: 2,
    alreadyJudged: 0,
    budgetExhausted: true,
  });
  const second = await tick(harness, at + 5 * 60 * 1000);
  expect(second).toMatchObject({ retryable: 3, alreadyJudged: 5 });
});

// ── a seal CORE refuses (ADR 0024, amendment of 2026-09-26) ──────────────
//
// A terminal whose unit declares more artifacts than the run attributes to it
// is registered up to its seal, and the completeness trigger
// (`fetch_run_seal_requires_complete_inventory`) refuses the seal with
// `run_inventory_incomplete`. The terminal is immutable, so that refusal is a
// verdict: the run is blocked with the trigger's code, once, and the scan
// answers it from its row afterwards. The mismatch is synthetic: one unit that
// declares two artifacts and is given one.

/** A run whose seal CORE refuses: its unit declares two artifacts, it has one. */
async function persistSealRefused(harness: CollectionHarness, id: string): Promise<void> {
  await persistSyntheticRun(harness, {
    run: {
      runId: id,
      units: [
        { unitKey: "account-1", unitKind: "account", artifactCount: 2, coverageStatus: "complete" },
      ],
    },
    artifacts: [await artifact("balance.json", '{"synthetic":true}', { unitKey: "account-1" })],
  });
}

interface RunTrace {
  blocked_code: string | null;
  registered_at: string | null;
  fetch_run_id: number | null;
  stages: string | null;
}

/** Every row of one run id, oldest first, with its `registered` stages in order. */
const traceOf = (h: CollectionHarness, id: string): RunTrace[] =>
  rows<RunTrace>(
    h.db,
    `SELECT r.blocked_code, r.registered_at, r.fetch_run_id,
            (SELECT group_concat(s.stage || ':' || s.state || ':' ||
                                 coalesce(s.failure_code, '-') || ':' ||
                                 coalesce(s.evidence_ref, '-'), ' ')
               FROM (SELECT * FROM collection_run_stages
                      WHERE collection_run_id = r.id AND stage = 'registered'
                      ORDER BY id) s) AS stages
       FROM collection_runs r WHERE r.run_id = ? ORDER BY r.id`,
    id,
  );

/** The fetch runs registration made for one run id, with whether each is sealed. */
const fetchRunsOf = (h: CollectionHarness, id: string) =>
  rows<{ id: number; source_run_key: string; sealed: number; artifacts: number }>(
    h.db,
    `SELECT f.id, f.source_run_key,
            EXISTS (SELECT 1 FROM fetch_run_seals s WHERE s.fetch_run_id = f.id) AS sealed,
            (SELECT count(*) FROM fetch_artifacts a WHERE a.fetch_run_id = f.id) AS artifacts
       FROM fetch_runs f WHERE f.source_run_key LIKE ? ORDER BY f.id`,
    `${id}:%`,
  );

test("a run CORE refuses to seal is blocked with the trigger's code, once, and then judged", async () => {
  const harness = collectionHarness();
  await persistSealRefused(harness, "run-001");
  await persistSyntheticRun(harness, { run: { runId: "run-002" } });
  await persistSyntheticRun(harness, { run: { runId: "run-003" } });

  const first = await tick(harness, START_MS);
  expect(first).toMatchObject({
    listed: 3,
    registered: 2,
    blocked: 1,
    alreadyJudged: 0,
    failed: 0,
    cycleComplete: true,
  });
  // The fetch run the attempt made stays behind unsealed, with its catalogue;
  // the blocked stage names it, and the row itself is not registered.
  const [left] = fetchRunsOf(harness, "run-001");
  expect(fetchRunsOf(harness, "run-001")).toEqual([
    {
      id: left!.id,
      source_run_key: "run-001:terminal-registration-v2",
      sealed: 0,
      artifacts: 1,
    },
  ]);
  expect(traceOf(harness, "run-001")).toEqual([
    {
      blocked_code: "run_inventory_incomplete",
      registered_at: null,
      fetch_run_id: null,
      stages: `registered:blocked:run_inventory_incomplete:${left!.id}`,
    },
  ]);

  // Every later tick answers it from its row: no attempt, no stage, no
  // second fetch run, and the page is finished.
  const stagesBefore = stageRows(harness);
  for (const offset of [5 * 60 * 1000, HOUR_MS, 2 * RETRYABLE_RETRY_INTERVAL_MS]) {
    const again = await tick(harness, START_MS + offset);
    expect(again).toMatchObject({
      listed: 3,
      blocked: 1,
      alreadyJudged: 1,
      alreadyRegistered: 2,
      failed: 0,
      cycleComplete: true,
    });
  }
  expect(stageRows(harness)).toBe(stagesBefore);
  expect(fetchRunsOf(harness, "run-001")).toHaveLength(1);
  expect(countOf(harness, "SELECT count(*) AS n FROM collection_runs")).toBe(3);
  // The queue path reads the same verdict back.
  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" }),
  ).toMatchObject({ outcome: "blocked", code: "run_inventory_incomplete", recorded: true });
});

test("a staged run whose seal CORE refuses blocks the same way", async () => {
  const harness = collectionHarness();
  // Above the direct-seal size, so the inventory is staged and the refusal
  // comes from `sealStagedInventory`; the scan continues it over ticks.
  const artifacts = [];
  for (let n = 0; n < 51; n += 1) {
    artifacts.push(
      await artifact(`page-${String(n).padStart(3, "0")}.json`, `{"page":${n}}`, {
        unitKey: "account-1",
      }),
    );
  }
  await persistSyntheticRun(harness, {
    run: {
      runId: "run-001",
      units: [
        {
          unitKey: "account-1",
          unitKind: "account",
          artifactCount: 52,
          coverageStatus: "complete",
        },
      ],
    },
    artifacts,
  });
  let at = START_MS;
  let summary: ScanSummary | undefined;
  for (let i = 0; i < 10; i += 1) {
    summary = await tick(harness, at);
    at += 5 * 60 * 1000;
    if (summary.blocked > 0) break;
  }
  // The refusal comes on a continuation; the same tick's listing then meets
  // the run again and answers it from the row it just blocked.
  expect(summary).toMatchObject({ continued: 1, blocked: 2, alreadyJudged: 1, failed: 0 });
  const [left] = fetchRunsOf(harness, "run-001");
  expect(left).toMatchObject({ sealed: 0, artifacts: 51 });
  expect(traceOf(harness, "run-001")[0]).toMatchObject({
    blocked_code: "run_inventory_incomplete",
  });
  expect(traceOf(harness, "run-001")[0]!.stages).toEndWith(
    `registered:blocked:run_inventory_incomplete:${left!.id}`,
  );
  expect(await tick(harness, at)).toMatchObject({ blocked: 1, alreadyJudged: 1, pending: 0 });
});

test("under a later contract version a seal-refused run gets one fresh attempt and blocks again", async () => {
  const harness = collectionHarness();
  await persistSealRefused(harness, "run-001");
  // The earlier version's registration, as production made it before a bump.
  const earlier = await registerTerminal({
    env: { DB: harness.env.DB, EVIDENCE: harness.env.EVIDENCE },
    bucket: harness.bucket,
    clientId: CLIENT,
    source: SOURCE,
    runId: "run-001",
    contractVersion: "terminal-registration-v1",
  });
  expect(earlier).toMatchObject({ outcome: "blocked", code: "run_inventory_incomplete" });

  // The current version has no row for it: one fresh attempt, under its own
  // run key, refused by the same trigger.
  const fresh = await tick(harness, START_MS);
  expect(fresh).toMatchObject({ blocked: 1, alreadyJudged: 0, failed: 0 });
  const left = fetchRunsOf(harness, "run-001");
  expect(left.map((run) => [run.source_run_key, run.sealed])).toEqual([
    ["run-001:terminal-registration-v1", 0],
    ["run-001:terminal-registration-v2", 0],
  ]);
  // Each version's blocked stage names the fetch run that version left.
  expect(traceOf(harness, "run-001").map((row) => [row.blocked_code, row.stages])).toEqual([
    ["run_inventory_incomplete", `registered:blocked:run_inventory_incomplete:${left[0]!.id}`],
    ["run_inventory_incomplete", `registered:blocked:run_inventory_incomplete:${left[1]!.id}`],
  ]);
  expect(await tick(harness, START_MS + HOUR_MS)).toMatchObject({ blocked: 1, alreadyJudged: 1 });
  expect(fetchRunsOf(harness, "run-001")).toHaveLength(2);

  // A different manifest under the same run id meets both blocked rows in the
  // conflict check: it is refused before any fetch run is made for it.
  await persistSyntheticRun(harness, { run: { runId: "run-002", attemptId: "attempt-002" } });
  const second = await harness.bucket.get(terminalKey(SOURCE, "run-002"));
  const text = new TextDecoder()
    .decode(new Uint8Array(await second!.arrayBuffer()))
    .replaceAll("run-002", "run-001");
  harness.bucket.entries.delete(terminalKey(SOURCE, "run-001"));
  await harness.bucket.seed(terminalKey(SOURCE, "run-001"), new TextEncoder().encode(text), {
    contentType: "application/json",
  });
  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" }),
  ).toMatchObject({ outcome: "blocked", code: "terminal_digest_conflict" });
  expect(fetchRunsOf(harness, "run-001")).toHaveLength(2);
});

test("a seal error that is not a listed trigger refusal still throws and records nothing", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness, { run: { runId: "run-001" } });
  const failures: string[] = [];
  const register = (message: string) =>
    registerTerminal({
      env: { DB: harness.env.DB, EVIDENCE: harness.env.EVIDENCE },
      bucket: harness.bucket,
      clientId: CLIENT,
      source: SOURCE,
      runId: "run-001",
      port: (env) => ({
        ...directRegistrationPort(env, CLIENT),
        seal: () => Promise.reject(new Error(message)),
      }),
    });
  // A D1 error from the seal that is not a trigger refusal.
  await expect(register("D1_ERROR: no such table: fetch_run_seals: SQLITE_ERROR")).rejects.toThrow(
    "no such table",
  );
  // A trigger refusal whose code is not in the closed list.
  await expect(
    register(
      "D1_ERROR: inactive_ingest_route: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
    ),
  ).rejects.toThrow("inactive_ingest_route");
  // The same through real SQLite: a seal trigger with an unlisted code.
  harness.db.exec(`CREATE TRIGGER synthetic_seal_refusal BEFORE INSERT ON fetch_run_seals
    BEGIN SELECT RAISE(ABORT, 'synthetic_unlisted_refusal'); END`);
  const summary = await tick(harness, START_MS, { onFailure: (code) => failures.push(code) });
  expect(summary).toMatchObject({ failed: 1, blocked: 0, registered: 0 });
  expect(failures).toHaveLength(1);
  // Nothing was judged: the row is open and has no `registered` verdict.
  expect(traceOf(harness, "run-001")).toEqual([
    {
      blocked_code: null,
      registered_at: null,
      fetch_run_id: null,
      stages: null,
    },
  ]);
  // Once the cause is gone the run registers as usual.
  harness.db.exec("DROP TRIGGER synthetic_seal_refusal");
  expect(await tick(harness, START_MS + HOUR_MS)).toMatchObject({ registered: 1, failed: 0 });
  expect(sealed(harness)).toBe(1);
});

test("a normal registration spends exactly what it spent before seal refusals were classified", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness, { run: { runId: "run-001" } });
  const budget = new RegistrationBudget();
  const result = await registerCollectionRun(
    harness.env,
    { source: SOURCE, runId: "run-001" },
    { budget, now: () => new Date(START_MS) },
  );
  expect(result.outcome).toBe("registered");
  // Measured on main before this change, with the same run: classifying the
  // seal's refusal adds no operation to the path that seals.
  expect({ ...budget.meter }).toEqual({ d1Statements: 74, d1Batches: 3, r2Operations: 5 });
});
