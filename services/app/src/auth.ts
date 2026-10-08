import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { HttpError } from "./http";

// Only public verification keys are cached. Tokens and verified claims stay request-local.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * What one verified Cloudflare Access token proved.
 *
 * A user session carries a subject. A **service token** carries none:
 * Cloudflare issues it with an empty `sub` and names the token in
 * `common_name`, so a service token is deliberately *not* a subject and can
 * never be the actor of a write. It supports narrowly scoped deployment housekeeping — the release
 * postcheck needs an authenticated, non-human caller for the health route and bodyless future alarm bootstrap (ADR 0039) — and
 * `authenticate` below still refuses it.
 */
export interface AccessIdentity {
  /** The verified subject of a user session, or "" for a service token. */
  subject: string;
  /** The service token's common name, or null for a user session. */
  serviceToken: string | null;
}

/**
 * Verifies the Cloudflare Access JWT and returns the identity it proved,
 * without deciding what that identity may do. Every failure mode of
 * `authenticate` is this function's: a missing or oversized assertion, an
 * unverifiable token and an unreachable key set answer exactly as before.
 *
 * Only an assertion issued for this Worker's own Access application
 * (`ACCESS_AUDIENCE`) is accepted here. An assertion for the MCP application
 * (`ACCESS_MCP_AUDIENCE`, ADR 0047) is accepted by `agentPrincipal` on `/mcp`
 * and nowhere else.
 */
export async function accessIdentity(
  request: Request,
  env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE">,
): Promise<AccessIdentity> {
  const audience = appAudience(env);
  return (await verifyAssertion(request, env.ACCESS_ISSUER, [audience])).identity;
}

/** This Worker's own Access application audience, or 503 when it is not configured. */
function appAudience(env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE">): string {
  const issuer: string = env.ACCESS_ISSUER;
  const audience: string = env.ACCESS_AUDIENCE;
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience ||
    audience.length > 256
  ) {
    throw new HttpError(503, "auth_not_configured");
  }
  return audience;
}

/**
 * Verifies the assertion against the issuer and any one of `audiences`, and
 * reports which audiences the verified token names. The token's own `aud`
 * claim is what is reported, never a header or a path.
 */
async function verifyAssertion(
  request: Request,
  issuer: string,
  audiences: readonly string[],
): Promise<{ identity: AccessIdentity; audiences: readonly string[] }> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16_384) throw new HttpError(401, "authentication_required");
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
      [customFetch]: async (url, options) => {
        try {
          const response = await fetch(url, options);
          if (response.status !== 200) throw new HttpError(503, "identity_keys_unavailable");
          return response;
        } catch {
          throw new HttpError(503, "identity_keys_unavailable");
        }
      },
    });
    keySets.set(issuer, keys);
  }
  try {
    // `sub` is not a required claim here because a service token's is empty;
    // which identities are acceptable is decided below and by each caller.
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: [...audiences],
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    if (payload.type !== "app") throw new HttpError(401, "authentication_required");
    const named = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
    const matched = audiences.filter((audience) => named.includes(audience));
    // The subject is returned exactly as the claim carries it, as `authenticate`
    // always did; only the emptiness test trims.
    if (typeof payload.sub === "string" && payload.sub.trim() !== "")
      return { identity: { subject: payload.sub, serviceToken: null }, audiences: matched };
    const common = payload["common_name"];
    if (typeof common === "string" && common.trim() !== "" && common.length <= 256)
      return { identity: { subject: "", serviceToken: common.trim() }, audiences: matched };
    throw new HttpError(401, "authentication_required");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (
      error instanceof errors.JWKSInvalid ||
      error instanceof errors.JWKInvalid ||
      error instanceof errors.JWKSTimeout ||
      (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC")
    ) {
      throw new HttpError(503, "identity_keys_unavailable");
    }
    throw new HttpError(401, "authentication_required");
  }
}

/**
 * Verifies the Cloudflare Access JWT and returns the subject it proved. The
 * subject is the only identity any write path may use: request bodies and
 * headers never name the actor (review rule 9, addendum 10 section 5). A
 * service token has no subject and is refused here, exactly as before.
 */
export async function authenticate(
  request: Request,
  env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE">,
): Promise<string> {
  const identity = await accessIdentity(request, env);
  if (identity.subject === "") throw new HttpError(401, "authentication_required");
  return identity.subject;
}

/**
 * The namespace of a principal that reached the MCP endpoint through the MCP
 * Access application (ADR 0047). Access user subjects are UUIDs, so no user
 * session can hold a name in it; a subject that claims it is refused.
 */
const MCP_CLIENT_PRINCIPAL_PREFIX = "mcp-client:";

/**
 * Whether a principal is agent-only: it may read and propose under its
 * `AGENT_API_GRANTS` entry and nothing else. It is never graded by
 * `OPERATOR_SUBJECTS` or `AGENT_GRANTS` (`principalFor` refuses it), never
 * offered an operations tool, and never reaches a non-agent route.
 */
export function isAgentOnlyPrincipal(principal: string): boolean {
  return principal.startsWith(MCP_CLIENT_PRINCIPAL_PREFIX);
}

/** The variable naming the MCP Access application's audience, typed on the variable. */
interface McpAudienceVars {
  ACCESS_MCP_AUDIENCE?: string | undefined;
}

/**
 * The MCP Access application's audience, or `null` while none is configured.
 * A value that is present but unusable — too long, or the same as
 * `ACCESS_AUDIENCE`, which would make a browser session indistinguishable
 * from an MCP client — is `503 auth_not_configured` on `/mcp`, never a
 * silent fallback to the browser audience.
 */
function mcpAudience(env: McpAudienceVars, app: string): string | null {
  const configured: unknown = env.ACCESS_MCP_AUDIENCE;
  if (configured === undefined || configured === null || configured === "") return null;
  if (
    typeof configured !== "string" ||
    configured.trim() !== configured ||
    configured.length > 256 ||
    configured === app
  )
    throw new HttpError(503, "auth_not_configured");
  return configured;
}

/**
 * The principal of a caller of the agent API, derived from the verified
 * Access assertion and nothing else (ADR 0047).
 *
 * - On `/mcp`, an assertion issued for the **MCP Access application** — the
 *   one Cloudflare Access Managed OAuth fronts for claude.ai, ChatGPT and
 *   Codex — is the principal `mcp-client:<sub>`. Whoever signed in, the
 *   operator included, is an agent-only principal there: its grant is the
 *   `AGENT_API_GRANTS` entry for that name, never the entry or the role of the
 *   bare subject.
 * - Anything else is exactly what `authenticate` accepts: an assertion for
 *   this Worker's own application with a user subject, which is its own
 *   principal as before. A subject that claims the agent-only namespace is
 *   `403 actor_not_supported`.
 *
 * A service token is refused here as it is by `authenticate`. With
 * `ACCESS_MCP_AUDIENCE` unset, an MCP-application assertion is not accepted
 * anywhere, which is the deployed default.
 */
export async function agentPrincipal(
  request: Request,
  env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE"> & McpAudienceVars,
  mcp: boolean,
): Promise<string> {
  const app = appAudience(env);
  const agent = mcp ? mcpAudience(env, app) : null;
  const verified = await verifyAssertion(
    request,
    env.ACCESS_ISSUER,
    agent === null ? [app] : [app, agent],
  );
  const subject = verified.identity.subject;
  if (subject === "") throw new HttpError(401, "authentication_required");
  if (isAgentOnlyPrincipal(subject)) throw new HttpError(403, "actor_not_supported");
  if (agent === null || !verified.audiences.includes(agent)) return subject;
  // One assertion for both applications has no defined role; refuse it
  // rather than pick one.
  if (verified.audiences.includes(app)) throw new HttpError(401, "authentication_required");
  return `${MCP_CLIENT_PRINCIPAL_PREFIX}${subject}`;
}
