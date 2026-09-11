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
 * never be the actor of a write. It exists here for one reason — the release
 * postcheck needs an authenticated, non-human caller for the health route
 * (unified plan 11 §6) — and `authenticate` below still refuses it.
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
 */
export async function accessIdentity(
  request: Request,
  env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE">,
): Promise<AccessIdentity> {
  const issuer: string = env.ACCESS_ISSUER;
  const audience: string = env.ACCESS_AUDIENCE;
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience ||
    audience.length > 256
  ) {
    throw new HttpError(503, "auth_not_configured");
  }
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
    // The subject is returned exactly as the claim carries it, as `authenticate`
    // always did; only the emptiness test trims.
    if (typeof payload.sub === "string" && payload.sub.trim() !== "")
      return { subject: payload.sub, serviceToken: null };
    const common = payload["common_name"];
    if (typeof common === "string" && common.trim() !== "" && common.length <= 256)
      return { subject: "", serviceToken: common.trim() };
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
