// What this deployment can actually serve, as one object.
//
// `commands` and `opsApi` follow deployment flags. `eventsV2` and the card
// review capabilities follow the tables this database actually has.
// `rewardsV2` is served; `rewardsV2ReadModel` is `read-d1` only when a reward
// snapshot can be served. `balancesV2` follows a sealed snapshot on READ.
// They are resolved here so `/api/meta` cannot advertise a route the Worker
// refuses.
import {
  CENTRAL_STORE_CAPABILITIES,
  withBalancesV2,
  withRewardsV2,
  type ApiCapabilities,
} from "../../../packages/observation-shared/src/api-schema";
import { balanceReadConfigured, readTarget } from "./balances-v2";
import { commandsEnabled } from "./command-api";
import { cardPurchasesAvailable } from "./card-purchases-api";
import { cardSettlementsAvailable } from "./card-settlements-api";
import { eventsV2Available } from "./events-api";
import { opsApiEnabled } from "./ops-api";
import { reportedStateAvailable } from "./reported-state-api";
import { rewardReadContext } from "./rewards-read";

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
  const settlement = await cardSettlementsAvailable(env);
  // U16: `read-d1` only when a reward snapshot is actually published and
  // serveable, so `/api/meta` never advertises snapshot-backed rows the
  // Worker would answer 503 for.
  const rewardReadModel = "unavailable" in (await rewardReadContext(env)) ? "none" : "read-d1";
  const base: ApiCapabilities = withRewardsV2(
    {
      ...CENTRAL_STORE_CAPABILITIES,
      commands: commandsEnabled(env),
      rewardsV2: true,
      eventsV2: await eventsV2Available(env),
      cardSettlementReconciliation: settlement,
      cardOwnershipReview: settlement,
      // Needs CORE 0047, like the route itself.
      cardPurchaseRecognition: await cardPurchasesAvailable(env),
      // Needs only the CORE views it joins, like the route itself.
      reportedStateOnDate: await reportedStateAvailable(env),
      // The operations API follows its own flag (02 §4, docs/ops-api.md). It is
      // advertised, never assumed: with the flag off the paths do not exist.
      opsApi: opsApiEnabled(env),
    },
    true,
    rewardReadModel,
  );
  if (!balanceReadConfigured(env)) return base;
  const target = await readTarget(env);
  // A READ database of another baseline publishes nothing to this contract.
  const snapshot = target.contractMismatch ? null : await target.reader.currentSnapshot();
  // Which store answered is part of the capability: a client that holds a
  // cursor needs to know it belongs to a rebuildable database (U11).
  return withBalancesV2(base, snapshot !== null, "read-d1");
}
