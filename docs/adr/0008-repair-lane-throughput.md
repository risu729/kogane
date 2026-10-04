# ADR 0008: Run 28 repair jobs and 40 identity runs a tick, with the D1 call risk documented

- Status: accepted (risk open until production cron metrics are read)
- Date: 2026-09-25
- Implemented by: #247
- Carried by: [observation lanes](../observation-lanes.md#repair-budget-and-drain-rate),
  `services/processor/src/lane-budgets.ts`,
  `services/processor/test/repair-budget.test.ts`

## Context

The repair lane re-parses history after a parser version bump, so its budget
is the drain rate. At 4 jobs a tick, the 3,133 artifacts `vpass-statement-page`
1.2.0 left at 1.1.0 needed about 65 hours. A published re-parse also needs its
identity run before the read models resolve its rows to an account, and the
scheduled identity stage took `identitySweep`'s default of 8 runs a tick.

## Options considered

1. Keep 4 repair jobs and let drains take days. Rejected.
2. Raise repair without touching identity. Rejected: a full repair tick would
   leave 20 published re-parses unidentified on every tick of a drain.
3. Size repair by the identity sweep in the same tick: incremental 12 +
   repair 28 = 40, `identitySweep`'s own maximum. Chosen.

## Decision

- `REPAIR_JOBS_PER_SWEEP` = 28 (336 artifacts an hour; the 1.2.0 backlog in
  about 9.3 hours).
- `IDENTITY_RUNS_PER_TICK` = `INCREMENTAL_JOBS_PER_SWEEP` +
  `REPAIR_JOBS_PER_SWEEP` = 40; a test holds the sum to 40, above which
  `identitySweep` would refuse the call on every tick.
- Measured on Miniflare, a whole tick at every budget (12 + 28 + 8 jobs, 40
  one-row runs) makes **1,470 D1 calls**. That is under the Workers page's
  10,000 subrequests but above the 1,000 queries per invocation D1's limits
  page still lists. Whether that figure applies is not verified. The risk is
  accepted and documented rather than designed around, because a drain tick
  of production shape is estimated at about 640 calls.
- **Fallback** (agreed, not in code): if production cron invocation metrics
  show ticks failing partway, the budgets come down, repair first, to at most
  12 repair jobs a tick. The constants stay 28 and 40 until then;
  [observation lanes](../observation-lanes.md#verified-locally--not-verified)
  records only that the budgets would then have to come down. (The measured
  tick of 12 repair + 4 replay jobs made 694 D1 calls.)

## Consequences

- Re-parses are identified on the tick that published them unless their rows
  pass the sweep's 200-observation cap or older unidentified runs are ahead of
  them; then on the next ticks.
- The later stages of a tick start later by the extra jobs' wall time and do
  no less work; each keeps its own bound.
- Budgets are constants in `lane-budgets.ts`, tuned from observed sweep
  durations.

## Verification

Synthetic Vpass pages under Miniflare with counting D1 and R2 proxies, and
production counts read on 2026-09-24. `repair-budget.test.ts` pins the
constants and their arithmetic. Not verified: the CPU and wall time of a
worst-case tick in production, and whether D1's 1,000-query limit applies.
