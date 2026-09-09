// What this deployment can actually serve.
//
// One helper, used by `/api/meta`, by the agent service and by the parameter
// and path checks of the observation API. A capability is never a promise the
// store cannot keep, and an agent, a page and the request validator all read
// the same description of the deployment rather than three that can drift.
//
// Server-computed facts, not contract defaults:
//   commands    the change lifecycle flag of this deployment (A09)
//   eventsV2    the economic-event projection is present (A10)
//   balancesV2  the balance projection's reader flag is on and a snapshot is
//               sealed (A07); the pagination version follows it
//
// None of these is an authorization decision. Authentication, the read-only
// method check and every grant stay where they are, whatever this reports.

import {
  CENTRAL_STORE_CAPABILITIES,
  withBalancesV2,
  type ApiCapabilities,
} from "../../../poc/observation-pipeline/shared/api-schema";
import { balanceProjectionReader, projectionFlagOn } from "./balances-v2";
import { commandsEnabled } from "./command-api";
import { eventsV2Available } from "./events-api";

export async function serverCapabilities(env: Env): Promise<ApiCapabilities> {
  const base: ApiCapabilities = {
    ...CENTRAL_STORE_CAPABILITIES,
    commands: commandsEnabled(env),
    eventsV2: await eventsV2Available(env),
  };
  if (!projectionFlagOn(env)) return base;
  const snapshot = await balanceProjectionReader(env).currentSnapshot();
  return withBalancesV2(base, snapshot !== null);
}
