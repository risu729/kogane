// `/api/v2/activity` and `/api/v2/obligations` (architecture addendum A10).
// Read-only, behind the `eventsV2` capability, and served only when the
// projection exists in this database. A deploy ahead of migration 0032
// answers 404, like any unknown route.
//
// The request rules and the read are `readEconomicEvents`
// (packages/application), which the agent tool `kogane.events.read` calls
// too (ADR 0081 point 2): this file only maps a path to its list and a
// refusal to its status.
import { readEconomicEvents } from "../../../packages/application/src/index";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import { d1Executor } from "../../../packages/read-model/src/index";
import { HttpError, json } from "./http";

const V2_PATHS = {
  "/api/v2/activity": "activity",
  "/api/v2/obligations": "obligations",
} as const;

/**
 * The capability is not a static claim: the routes are served only when the
 * A10 projection is actually present in this database. A build deployed ahead
 * of migration 0032 advertises `eventsV2: false` and serves nothing.
 */
export async function eventsV2Available(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "economicEvents");
}

/** Called only after the Access gate and the read-only method check of `worker.ts`. */
export async function eventsApi(env: Env, url: URL): Promise<Response | null> {
  if (!Object.hasOwn(V2_PATHS, url.pathname)) return null;
  if (!(await eventsV2Available(env))) throw new HttpError(404, "not_found");
  const list = V2_PATHS[url.pathname as keyof typeof V2_PATHS];
  const outcome = await readEconomicEvents(d1Executor(env.DB), list, url.searchParams);
  if (!outcome.ok) throw new HttpError(400, outcome.refusal);
  return json(outcome.body);
}
