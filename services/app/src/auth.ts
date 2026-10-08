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

/** The audience variables: the browser application's, and the MCP application's (ADR 0047). */
type AudienceVars = Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE"> & {
  ACCESS_MCP_AUDIENCE?: string | undefined;
};

/**
 * Verifies the Cloudflare Access JWT and returns the identity it proved,
 * without deciding what that identity may do. Every failure mode of
 * `authenticate` is this function's: a missing or oversized assertion, an
 * unverifiable token and an unreachable key set answer exactly as before.
 *
 * It accepts only an assertion issued for this Worker's own (browser) Access
 * application. One that also names the MCP application's audience is
 * `401 authentication_required`: a token minted for MCP clients reaches no
 * ordinary route (ADR 0047).
 */
export async function accessIdentity(request: Request, env: AudienceVars): Promise<AccessIdentity> {
  const app = appAudience(env);
  const mcp = mcpAudience(env, app, false);
  const verified = await verifyAssertion(request, env.ACCESS_ISSUER, app);
  if (mcp !== null && verified.audiences.includes(mcp))
    throw new HttpError(401, "authentication_required");
  return verified.identity;
}

/** This Worker's own Access application audience, or 503 when it is not configured. */
function appAudience(env: AudienceVars): string {
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
 * The MCP Access application's audience, or `null` while none is configured
 * (the committed state). A value that is present but unusable — not a plain
 * string of at most 256 characters, or the browser application's own
 * audience, which would make a browser session indistinguishable from an MCP
 * client — is `503 auth_not_configured` when `strict`, and is otherwise
 * ignored by the browser routes, which never accept it anyway.
 */
function mcpAudience(env: AudienceVars, app: string, strict: boolean): string | null {
  const configured: unknown = env.ACCESS_MCP_AUDIENCE;
  if (configured === undefined || configured === null || configured === "") return null;
  const usable =
    typeof configured === "string" &&
    configured.trim() === configured &&
    configured.length <= 256 &&
    configured !== app;
  if (usable) return configured;
  if (strict) throw new HttpError(503, "auth_not_configured");
  return null;
}

/**
 * Verifies the assertion against the issuer and exactly one audience, and
 * reports every audience the verified token names. The token's own `aud`
 * claim is what is reported, never a header or a path.
 */
async function verifyAssertion(
  request: Request,
  issuer: string,
  audience: string,
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
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    if (payload.type !== "app") throw new HttpError(401, "authentication_required");
    const audiences = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
    // The subject is returned exactly as the claim carries it, as `authenticate`
    // always did; only the emptiness test trims.
    if (typeof payload.sub === "string" && payload.sub.trim() !== "")
      return { identity: { subject: payload.sub, serviceToken: null }, audiences };
    const common = payload["common_name"];
    if (typeof common === "string" && common.trim() !== "" && common.length <= 256)
      return { identity: { subject: "", serviceToken: common.trim() }, audiences };
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
export async function authenticate(request: Request, env: AudienceVars): Promise<string> {
  const identity = await accessIdentity(request, env);
  if (identity.subject === "") throw new HttpError(401, "authentication_required");
  return identity.subject;
}

/** The namespace of an agent-only principal: an identity that reached `/mcp` through the MCP application. */
const MCP_CLIENT_PREFIX = "mcp-client:";

/**
 * The caller of the agent API, decided once at the boundary from the verified
 * Access assertion and carried, as this object, to every tool, grader and
 * service behind it (ADR 0047).
 *
 * - `mcp-client`: an identity that reached `/mcp` through the MCP Access
 *   application (Cloudflare Access Managed OAuth). Whoever signed in — the
 *   operator included — is **agent-only** here: `principal` is
 *   `mcp-client:<sub>`, its grant is that name's `AGENT_API_GRANTS` entry and
 *   nothing else, and no grader may turn it back into the subject it came
 *   from. The bare subject is deliberately not part of this object.
 * - `browser`: a session of this Worker's own Access application on an
 *   `/api/agent/v1/*` route; `principal` is its subject, as before.
 */
export type AgentCaller =
  | { readonly kind: "mcp-client"; readonly principal: string }
  | { readonly kind: "browser"; readonly principal: string };

/**
 * Whether a principal string names an agent-only caller. The graders that take
 * a bare string (`principalFor`) refuse such a name, so even a value that
 * escaped the `AgentCaller` object could not be re-classified.
 */
export function isAgentOnlyPrincipal(principal: string): boolean {
  return principal.startsWith(MCP_CLIENT_PREFIX);
}

/**
 * The caller of `/mcp`. Only an assertion issued for the MCP Access
 * application is accepted; one for the browser application, one naming both,
 * one without a subject (a service token) and every assertion while
 * `ACCESS_MCP_AUDIENCE` is unset are `401 authentication_required`. A
 * misconfigured `ACCESS_MCP_AUDIENCE` is `503 auth_not_configured`.
 */
export async function mcpCaller(request: Request, env: AudienceVars): Promise<AgentCaller> {
  const app = appAudience(env);
  const mcp = mcpAudience(env, app, true);
  if (mcp === null) throw new HttpError(401, "authentication_required");
  const verified = await verifyAssertion(request, env.ACCESS_ISSUER, mcp);
  if (verified.audiences.includes(app)) throw new HttpError(401, "authentication_required");
  const subject = verified.identity.subject;
  if (subject === "" || isAgentOnlyPrincipal(subject))
    throw new HttpError(401, "authentication_required");
  return { kind: "mcp-client", principal: `${MCP_CLIENT_PREFIX}${subject}` };
}

/**
 * The caller of an `/api/agent/v1/*` route: the browser application's
 * subject, exactly as `authenticate` returns it. A subject that claims the
 * agent-only namespace is `403 actor_not_supported`.
 */
export async function browserCaller(request: Request, env: AudienceVars): Promise<AgentCaller> {
  const subject = await authenticate(request, env);
  if (isAgentOnlyPrincipal(subject)) throw new HttpError(403, "actor_not_supported");
  return { kind: "browser", principal: subject };
}
