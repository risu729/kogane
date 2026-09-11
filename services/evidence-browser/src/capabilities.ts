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
  type ApiCapabilities,
} from "../../../packages/observation-shared/src/api-schema";
import { balanceProjectionReader, projectionFlagOn } from "./balances-v2";
import { commandsEnabled } from "./command-api";
import { eventsV2Available, flagOn } from "./events-api";
import { opsApiEnabled } from "./ops-api";

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
  const base: ApiCapabilities = {
    ...CENTRAL_STORE_CAPABILITIES,
    commands: commandsEnabled(env),
    rewardsV2: rewardsV2Enabled(env),
    eventsV2: await eventsV2Available(env),
    // The operations API follows its own flag (02 §4, docs/ops-api.md). It is
    // advertised, never assumed: with the flag off the paths do not exist.
    opsApi: opsApiEnabled(env),
  };
  if (!projectionFlagOn(env)) return base;
  const snapshot = await balanceProjectionReader(env).currentSnapshot();
  return withBalancesV2(base, snapshot !== null);
}
