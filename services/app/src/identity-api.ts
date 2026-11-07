import { HttpError, json } from "./http";
import { identityReadMode } from "./identity-read";
import {
  IDENTITY_COLLECTIONS,
  type IdentityCollection,
  readIdentityConnections,
  readIdentityPage,
} from "../../../packages/application/src/query/identity-pages.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";

/** Call only after the existing Access authentication gate. No mutations. */
export async function identityApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/identity/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  const collection = url.pathname.slice("/api/identity/".length);
  if (!(IDENTITY_COLLECTIONS as readonly string[]).includes(collection))
    throw new HttpError(404, "not_found");
  // Any query text, even one with no parameters (`?&`), as before the reader
  // was shared; `readIdentityCollection` sees only the parsed parameters.
  if (collection === "connections" && url.search) throw new HttpError(400, "invalid_query");
  return json(
    await readIdentityCollection(env, collection as IdentityCollection, url.searchParams),
  );
}

/**
 * One identity page: the answer of `GET /api/identity/<collection>` for these
 * query parameters, and of `kogane.identity.read` (ADR 0081), so the page and
 * an agent read one function. Its refusals are `HttpError`s with the route's
 * closed codes.
 */
export async function readIdentityCollection(
  env: Env,
  collection: IdentityCollection,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  if (collection === "connections") {
    if ([...params.keys()].length > 0) throw new HttpError(400, "invalid_query");
    return readIdentityConnections(d1Executor(env.DB));
  }
  for (const [key, value] of params) {
    if (
      !["source", "offset", "identityRead"].includes(key) ||
      params.getAll(key).length !== 1 ||
      !value ||
      value.length > 128 ||
      /[\u0000-\u001f]/u.test(value)
    )
      throw new HttpError(400, "invalid_query");
  }
  const mode = identityReadMode({ searchParams: params });
  const text = params.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset))
    throw new HttpError(400, "invalid_offset");
  return readIdentityPage(d1Executor(env.DB), collection, {
    source: params.get("source"),
    offset,
    mode,
  });
}
