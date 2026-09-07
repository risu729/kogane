import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { HttpError } from "./http";

// Only public verification keys are cached. Tokens and verified claims stay request-local.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: Env): Promise<void> {
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
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.type !== "app") {
      throw new HttpError(401, "authentication_required");
    }
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
