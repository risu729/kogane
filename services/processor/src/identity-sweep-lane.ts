// The scheduled identity sweep, gated on a change (ADR 0129; migration 0110).
//
// `identitySweep` reads its whole candidate set in one statement: every
// adopted parse run, each checked against its sealed identity runs and the
// policy its artifact requires. With nothing to identify that statement still
// read about 197k rows on every tick in production (2026-11-27). Here the
// scheduled lane is a one-page pass of `src/sweep-pass.ts`: a tick whose
// candidate read came back empty marks the CORE revision it started at clean,
// and later ticks read only the gate row while the revision and the policy
// stay the same.
//
// What the candidate read depends on, and why each is covered:
//   * parse runs, their publication, identity runs and their seals, and the
//     fetch run seals: all on the CORE dependency ledger;
//   * the fetch run's terminal reports and the fetch artifacts: written before
//     the run is sealed, and only a sealed run is a candidate (the
//     `observation_fetch_runs` view joins `fetch_run_seals`);
//   * the trusted Vpass card bindings a policy-2 artifact needs: a view whose
//     financial and binding runs must both be sealed, so a new binding arrives
//     with a fetch run seal, which moves the revision (an unsealed row written
//     later can only withdraw a binding, which never adds a candidate to an
//     empty read);
//   * the policy versions and the evidence each source requires: code, carried
//     in the policy as a digest of the candidate statement's text, and the
//     view definitions it reads, carried as `IDENTITY_SWEEP_VIEWS`.
// The read has no clock: the same rows give the same candidates.
//
// A tick with candidates always processes at least one (the first run of a
// tick is never past the observation cap), so `processedRuns === 0` is exactly
// an empty candidate read. A tick that processed runs leaves its pass open,
// so the next tick reads again, as before the gate; the first tick that finds
// nothing closes it.
import {
  identitySweep,
  type IdentityResolver,
} from "../../../packages/storage-d1/src/core/identity-store.ts";
import { identitySweepCandidatesSql } from "../../../packages/storage-d1/src/core/identity-sweep-sql.ts";
import { finishSweepPass, ONE_PAGE_CURSOR_SQL, openSweepTick, shortDigest } from "./sweep-pass.ts";

/**
 * The definitions of the views the identity sweep's code can read, as a digest
 * that `test/sweep-pass.test.ts` checks against the migrated schema: a
 * migration that redefines one moves no revision, so it changes this value,
 * and with it the gate's policy, to read again.
 */
export const IDENTITY_SWEEP_VIEWS = "1d25cf4f67d1dc3f";

/** The gate policy of the scheduled identity sweep. */
export async function identitySweepPolicy(): Promise<string> {
  return `identity-sweep-v1+sql:${await shortDigest(identitySweepCandidatesSql(false))}+views:${IDENTITY_SWEEP_VIEWS}`;
}

/** The scheduled lane: `identitySweep` over every source, unless the gate holds. */
export async function identitySweepLane(
  db: D1Database,
  resolver: IdentityResolver,
  maxRuns: number,
): Promise<Awaited<ReturnType<typeof identitySweep>>> {
  const tick = await openSweepTick(
    db,
    "identity_sweep",
    await identitySweepPolicy(),
    ONE_PAGE_CURSOR_SQL,
  );
  if (tick.skip) return { processedRuns: 0, identifiedRuns: 0, identifiedObservations: 0 };
  const result = await identitySweep(db, resolver, maxRuns);
  if (result.processedRuns === 0) await finishSweepPass(db, "identity_sweep", tick.token);
  return result;
}
