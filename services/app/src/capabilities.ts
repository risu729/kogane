// What this deployment can actually serve, as one object.
//
// Five of the advertised capabilities are not static contract facts.
// `commands` follows a deployment flag (A09), `rewardsV2` follows a deployment
// flag (A11), `opsApi` follows a deployment flag (02 §4), `eventsV2` follows a
// flag *and* the presence of the A10 projection in the database this Worker
// reads, and `balancesV2` follows the A07 reader flag *and* a sealed balance
// snapshot (its pagination version follows it). All five are resolved here so
// `/api/meta` cannot advertise a route the Worker refuses, and so the next
// flagged capability has one place to be added.
import {
  CENTRAL_STORE_CAPABILITIES,
  withBalancesV2,
  withRewardsV2,
  type ApiCapabilities,
} from "../../../packages/observation-shared/src/api-schema";
import { projectionFlagOn, readProjectionFlagOn, readTarget } from "./balances-v2";
import { commandsEnabled } from "./command-api";
import { eventsV2Available, flagOn } from "./events-api";
import { opsApiEnabled } from "./ops-api";
import { rewardReadContext, rewardReadFlagOn } from "./rewards-read";

/** A11 reward reads. Off unless explicitly on; anything else, including absent, is off. */
export function rewardsV2Enabled(env: Env): boolean {
  return flagOn(env.REWARDS_V2_ENABLED);
}

/**
 * The pinned contract with this deployment's own capabilities overlaid. It
 * touches the database (for `eventsV2` and `balancesV2`), so call it where a
 * response is being built.
 *
 * `/api/balances/v2` is the one place a resolved capability also decides
 * whether a path exists and which parameters it accepts, so the observation
 * API resolves this once per request and uses that one object for both. A
 * capability is never a promise the store cannot keep.
 */
export async function centralStoreCapabilities(env: Env): Promise<ApiCapabilities> {
  const rewards = rewardsV2Enabled(env);
  // U16: `read-d1` only when a reward snapshot is actually published and
  // serveable, so `/api/meta` never advertises snapshot-backed rows the
  // Worker would answer 503 for.
  const rewardReadModel =
    rewards && rewardReadFlagOn(env) && !("unavailable" in (await rewardReadContext(env)))
      ? "read-d1"
      : "none";
  const base: ApiCapabilities = withRewardsV2(
    {
      ...CENTRAL_STORE_CAPABILITIES,
      commands: commandsEnabled(env),
      rewardsV2: rewards,
      eventsV2: await eventsV2Available(env),
      // The operations API follows its own flag (02 §4, docs/ops-api.md). It is
      // advertised, never assumed: with the flag off the paths do not exist.
      opsApi: opsApiEnabled(env),
    },
    rewards,
    rewardReadModel,
  );
  if (!projectionFlagOn(env)) return base;
  const target = await readTarget(env);
  // A READ database of another baseline publishes nothing to this contract.
  const snapshot = target.contractMismatch ? null : await target.reader.currentSnapshot();
  // Which store answered is part of the capability: a client that holds a
  // cursor needs to know it belongs to a rebuildable database (U11).
  return withBalancesV2(base, snapshot !== null, readProjectionFlagOn(env) ? "read-d1" : "core-d1");
}
