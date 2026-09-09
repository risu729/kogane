// What this deployment can actually serve, as one object.
//
// Two of the advertised capabilities are not static contract facts. `rewardsV2`
// follows a deployment flag (A11), and `eventsV2` follows a flag *and* the
// presence of the A10 projection in the database this Worker reads. Both are
// resolved here so `/api/meta` cannot advertise a route the Worker refuses,
// and so a second flagged capability has one place to be added.
import {
  CENTRAL_STORE_CAPABILITIES,
  type ApiCapabilities,
} from "../../../poc/observation-pipeline/shared/api-schema";
import { eventsV2Available, flagOn } from "./events-api";

/** A11 reward reads. Off unless explicitly on; anything else, including absent, is off. */
export function rewardsV2Enabled(env: Env): boolean {
  return flagOn(env.REWARDS_V2_ENABLED);
}

/**
 * The pinned contract with this deployment's own capabilities overlaid. It
 * touches the database (for `eventsV2`), so call it where a response is being
 * built, not on every request's parameter check.
 */
export async function centralStoreCapabilities(env: Env): Promise<ApiCapabilities> {
  return {
    ...CENTRAL_STORE_CAPABILITIES,
    rewardsV2: rewardsV2Enabled(env),
    eventsV2: await eventsV2Available(env),
  };
}
