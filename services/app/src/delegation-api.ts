// `GET /api/v2/delegations`: the operator's read of the AI delegations this
// App declares (ADR 0063, amendment of 2026-11-06; docs/agent-api.md). The
// schedules and confirm pages show it as a read-only notice.
//
// Operator only, like the audit read: who may act on the owner's behalf is the
// owner's record. The answer comes from `MCP_DELEGATIONS` through the
// resolver's own parser, so a table the resolver refuses is `misconfigured`
// with no entry and no hint of which entry or why; the raw configuration is
// never echoed. Nothing here names a secret, a token or an Access setting, and
// reading the table is a page load, not recorded.
import {
  delegationStatus,
  parseGrants,
  principalCan,
} from "../../../packages/application/src/index";
import { DELEGATION_STATUS_PATH } from "../../../packages/observation-shared/src/delegation-status-contract";
import type { DelegationVars } from "./delegation";
import { principalFor } from "./grants";
import { HttpError, json } from "./http";

export { DELEGATION_STATUS_PATH };

export async function delegationApi(
  env: Env & DelegationVars,
  url: URL,
  /** The subject `authenticate` proved; never a body or header claim. */
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== DELEGATION_STATUS_PATH) return null;
  if (!principalCan(principalFor(env, subject), "interpretation.accept"))
    throw new HttpError(403, "operator_required");
  if (url.search) throw new HttpError(400, "invalid_query");
  return json(
    await delegationStatus({
      configured: env.MCP_DELEGATIONS,
      operatorSubjects: env.OPERATOR_SUBJECTS,
      readGrants: parseGrants(env.AGENT_API_GRANTS),
      // The resolver's clock: sub-second, so a bound inside this second
      // reads the same here as on `/mcp`.
      now: new Date().toISOString(),
    }),
  );
}
