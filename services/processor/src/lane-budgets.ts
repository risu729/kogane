// Per-tick budgets of the observation job lanes and of the identity sweep
// that follows them (docs/observation-lanes.md). They live outside
// `worker.ts` because workerd accepts only handlers and functions as named
// exports of a Worker's entry module, and the tests pin these values.

export const LANES = ["incremental", "repair", "replay"] as const;
export type Lane = (typeof LANES)[number];

/** Incremental jobs executed per sweep: the historical per-sweep budget. */
const INCREMENTAL_JOBS_PER_SWEEP = 12;

/**
 * Repair jobs executed per scheduled tick. The repair lane is how history is
 * re-parsed after a parser version bump, so this budget is the drain rate.
 * vpass-statement-page 1.2.0 left 3,133 published artifacts at 1.1.0 on
 * 2026-09-24; the former 4 jobs a tick would have drained them in
 * 3,133 / (4 x 12 ticks/hour) = 65 hours. Now:
 *
 *   28 jobs x 12 ticks/hour = 336 artifacts/hour; 3,133 / 336 = 9.3 hours.
 *
 * What bounds it is the identity sweep later in the same tick: it takes at
 * most 40 parse runs (identitySweep's own maximum) and 200 observations, and
 * the two unattended lanes publish at most incremental 12 + repair 28 = 40 a
 * tick (IDENTITY_RUNS_PER_TICK). So a tick's re-parses fit its run cap; they
 * are identified on that tick unless their rows pass the 200-observation cap
 * or older unidentified runs are ahead of them, and then on the next ticks.
 *
 * The jobs themselves fit the invocation (docs/observation-lanes.md, measured
 * on synthetic Vpass pages): one job makes at most 16 subrequests (14 D1
 * statements, one D1 batch, one R2 get), so 28 jobs make about 450 of the
 * 10,000 a Workers Paid invocation may make; a job costs at most about 65 ms
 * of CPU even counted on the test side of Miniflare, proxy work included, so
 * under 2 s of the 30 s a cron trigger under an hour gets; production jobs
 * took 0.3-1.1 s of wall time each, at most 31 s of the five-minute cadence.
 * A whole tick at every budget measured 1,470 D1 calls, above the
 * 1,000 queries per invocation D1's own limits page still lists; whether that
 * figure applies is not verified.
 */
export const REPAIR_JOBS_PER_SWEEP = 28;

/**
 * Parse runs the scheduled identity sweep takes per tick: everything the two
 * unattended lanes can publish in one tick, incremental 12 + repair 28 = 40,
 * which is also the most identitySweep accepts. The sum is the constraint: a
 * sum above 40 would make identitySweep refuse the call and fail the identity
 * stage on every tick, so a test holds it. The sweep also stops at 200
 * observations and takes runs in parse-run id order, so runs past either cap
 * wait for the next tick. At its own default of 8, a full repair tick would
 * leave 20 published re-parses without identity on every tick of a drain.
 */
export const IDENTITY_RUNS_PER_TICK = INCREMENTAL_JOBS_PER_SWEEP + REPAIR_JOBS_PER_SWEEP;

/** Jobs executed per sweep and lane. Replay stays small so a large replay
 * backlog never delays freshly sealed evidence; repair is sized above. */
export const LANE_BUDGETS: Readonly<Record<Lane, number>> = {
  incremental: INCREMENTAL_JOBS_PER_SWEEP,
  repair: REPAIR_JOBS_PER_SWEEP,
  replay: 8,
};

/** The hard bound on one lane's jobs per sweep: every `maxJobs` override is
 * clamped to it, and a test holds every default above to it. Overrides come
 * only from an operator's `/sweep`, which runs no identity stage; the runs it
 * publishes are identified by later ticks, oldest first. */
export const MAX_LANE_JOBS = 40;
