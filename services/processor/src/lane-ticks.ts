// Per-tick records of the scheduled lanes that otherwise leave only a log line
// (migration 0048, docs/processor.md §6, docs/operations.md §1).
//
// `observation_sweep` and `collection_scan` keep their own lane state
// (`observation_lane_state`, `collection_scan_state`), and the projection and
// report lanes keep their own build and report records. The lanes below kept
// nothing: whether `purchase_recognition` had run at all could only be read
// from Workers Logs. Each now writes one row per tick — ran, skipped because
// its flag is off, or failed with a safe code — with the counts of its log
// line, bounded to one day per lane.
//
// What a row may hold is decided here, per lane, by name: counts, flags and
// the closed reason-code map of `purchase_recognition`. A field a lane adds
// later is not recorded until it is listed, and no text value is ever copied
// (the 0048 trigger refuses one anyway).
import { CARD_USAGE_EXCLUSIONS } from "../../../packages/domain/src/card-purchase.ts";
import type { OutboxDispatchResult } from "../../../packages/storage-d1/src/core/decision-outbox.ts";
import type { identitySweep } from "../../../packages/storage-d1/src/core/identity-store.ts";
import {
  latestLaneTicks,
  recordLaneTick,
  type LaneTick,
  type LaneTickCounts,
  type LaneTickOutcome,
} from "../../../packages/storage-d1/src/core/lane-ticks.ts";
import type { CardPurchaseSweepResult } from "./card-purchase-job.ts";
import type { cardSettlementSweep } from "./card-settlement-job.ts";
import type { DispatchSummary } from "./operations/dispatch.ts";
import type { ReconciliationSweepResult } from "./reconciliation-job.ts";
import type { RewardPromotionResult } from "./reward-claims-job.ts";

/** The fields of `T` that are counts or flags, by name. */
type CountField<T> = {
  [K in keyof T]-?: T[K] extends number | boolean ? K : never;
}[keyof T] &
  string;

type Projection = (result: object) => LaneTickCounts;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Keeps the named count and flag fields of a lane result, and for each named
 * code map only the codes of its closed set. A value of any other shape is
 * dropped rather than coerced: the log line still carries it.
 */
function countsOf<T>(
  fields: readonly CountField<T>[],
  codeMaps: Partial<Record<keyof T & string, readonly string[]>> = {},
): Projection {
  return (result) => {
    const source = result as Record<string, unknown>;
    const counts: LaneTickCounts = {};
    for (const field of fields) {
      const value = source[field];
      if (isCount(value) || typeof value === "boolean") counts[field] = value;
    }
    for (const [field, closed] of Object.entries(codeMaps) as [string, readonly string[]][]) {
      const map = source[field];
      if (map === null || typeof map !== "object") continue;
      const codes: Record<string, number> = {};
      for (const code of closed) {
        const value = (map as Record<string, unknown>)[code];
        if (isCount(value)) codes[code] = value;
      }
      counts[field] = codes;
    }
    return counts;
  };
}

/** Every lane whose ticks are recorded, and what of its result is kept. */
export const LANE_TICK_COUNTS = {
  identity_sweep: countsOf<Awaited<ReturnType<typeof identitySweep>>>([
    "processedRuns",
    "identifiedRuns",
    "identifiedObservations",
  ]),
  reconciliation_sweep: countsOf<ReconciliationSweepResult>([
    "slices",
    "scanned",
    "groups",
    "groupsSkipped",
    "proposed",
    "written",
    "autoAccepted",
  ]),
  card_settlement_sweep: countsOf<Awaited<ReturnType<typeof cardSettlementSweep>>>([
    "scanned",
    "proposed",
    "written",
  ]),
  purchase_recognition: countsOf<CardPurchaseSweepResult>(
    [
      "scanned",
      "recognized",
      "revised",
      "reanchored",
      "retired",
      "conflicts",
      "failed",
      "deferred",
      "proposed",
      "merged",
      "groupsSkipped",
    ],
    { skipped: CARD_USAGE_EXCLUSIONS },
  ),
  reward_claims_sweep: countsOf<RewardPromotionResult>(["scanned", "promoted", "skipped"]),
  operation_dispatch: countsOf<DispatchSummary>([
    "claimed",
    "dispatched",
    "retried",
    "failed",
    "awaiting",
  ]),
  decision_outbox: countsOf<OutboxDispatchResult>([
    "claimed",
    "processed",
    "failed",
    "waiting",
    "blocked",
    "published",
  ]),
} satisfies Record<string, Projection>;

/** What happened to one lane on one tick, before it is reduced to a row. */
export type LaneTickResult =
  | { outcome: "ran"; result: object }
  | { outcome: "skipped-by-flag" }
  | { outcome: "failed"; code: string };

/** A code the 0048 check accepts; anything else is reported as `unknown`. */
function safeCode(code: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(code) ? code : "unknown";
}

/** The row one tick of `lane` becomes, or null for a lane that is not recorded. */
export function laneTick(
  lane: string,
  startedAtMs: number,
  finishedAtMs: number,
  tick: LaneTickResult,
): LaneTick | null {
  if (!Object.hasOwn(LANE_TICK_COUNTS, lane)) return null;
  const project: Projection = LANE_TICK_COUNTS[lane as keyof typeof LANE_TICK_COUNTS];
  let outcome: LaneTickOutcome = tick.outcome;
  let counts: LaneTickCounts = {};
  if (tick.outcome === "ran") {
    // A stage that is always wired reports its own flag being off as
    // `enabled: false` (operation_dispatch, like balance_projection).
    if ((tick.result as { enabled?: unknown }).enabled === false) outcome = "skipped-by-flag";
    else counts = project(tick.result);
  }
  return {
    lane,
    startedAtMs,
    finishedAtMs: Math.max(startedAtMs, finishedAtMs),
    outcome,
    errorCode: tick.outcome === "failed" ? safeCode(tick.code) : null,
    counts,
  };
}

/**
 * Writes the tick of a recorded lane. Observability never changes what the
 * lane did: a write that fails is logged as a safe code and the tick goes on.
 */
export async function recordTick(
  db: D1Database,
  lane: string,
  startedAtMs: number,
  tick: LaneTickResult,
  log: (line: string) => void,
): Promise<void> {
  const row = laneTick(lane, startedAtMs, Date.now(), tick);
  if (row === null) return;
  try {
    await recordLaneTick(db, row);
  } catch (error) {
    log(
      JSON.stringify({
        event: "lane_tick_record_failed",
        lane,
        code: error instanceof Error ? error.constructor.name : "unknown",
      }),
    );
  }
}

/** The latest tick of every recorded lane, as the health and status routes report it. */
export interface LaneTickSummary {
  lane: string;
  outcome: LaneTickOutcome;
  errorCode: string | null;
  startedAt: string;
  durationMs: number;
  /** Milliseconds since the tick finished. */
  ageMs: number;
  counts: LaneTickCounts;
}

/** Read-only. Before migration 0048 there is no table, which is an empty list. */
export async function laneTickSummary(db: D1Database, nowMs: number): Promise<LaneTickSummary[]> {
  try {
    return (await latestLaneTicks(db)).map((tick) => ({
      lane: tick.lane,
      outcome: tick.outcome,
      errorCode: tick.errorCode,
      startedAt: new Date(tick.startedAtMs).toISOString(),
      durationMs: tick.finishedAtMs - tick.startedAtMs,
      ageMs: nowMs - tick.finishedAtMs,
      counts: tick.counts,
    }));
  } catch {
    return [];
  }
}
