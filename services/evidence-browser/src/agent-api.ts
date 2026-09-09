// The agent API routes and the human UI's shared-query route.
//
// This is the first non-GET surface of the evidence browser. It is an
// explicit allow-list: exactly five POST paths plus `/mcp`, each with a
// bounded JSON body, each behind the unchanged Access gate, and each behind a
// grant looked up by the verified principal. `AGENT_GRANTS` absent means no
// principal has a grant, so every agent route answers 403 — that is the
// deployed default, and the demo Worker never serves these paths at all.
//
// `GET /api/v2/query` is the same query service under the reader authority
// the browser already has over every other GET route: a signed-in human sees
// what those routes already show, so the UI does not depend on `AGENT_GRANTS`
// and an agent grant is never widened to serve a page.
import {
  DEFAULT_QUERY_LIMIT,
  type Grant,
  grantFor,
  parseGrants,
  parseQueryRequest,
} from "../../../packages/application/src/index";
import {
  type AgentToolName,
  callTool,
  isAgentToolName,
  MAX_REQUEST_BYTES,
  queryResponse,
  toolContext,
} from "./agent-service";
import { handleMcp } from "./mcp";
import { HttpError, json } from "./http";

const AGENT_PREFIX = "/api/agent/v1/";
export const MCP_PATH = "/mcp";
export const SHARED_QUERY_PATH = "/api/v2/query";

/** Tool name for an agent path, or `null` when the path is not one. */
function toolForPath(path: string): AgentToolName | null {
  if (!path.startsWith(AGENT_PREFIX)) return null;
  const name = `kogane.${path.slice(AGENT_PREFIX.length)}`;
  return isAgentToolName(name) ? name : null;
}

/** Paths this module owns; `worker.ts` allows POST for exactly these. */
export function isAgentPath(path: string): boolean {
  return path === MCP_PATH || path.startsWith(AGENT_PREFIX);
}

export function classifyAgentPath(path: string): string | null {
  if (path === MCP_PATH) return "mcp";
  if (path === SHARED_QUERY_PATH) return "shared_query";
  if (path.startsWith(AGENT_PREFIX))
    return `agent_${path.slice(AGENT_PREFIX.length).replace(/\W/gu, "_")}`;
  return null;
}

/**
 * The verified principal. `authenticate` has already checked the signature,
 * issuer, audience, algorithm and required claims of this exact token; this
 * only reads the payload it accepted. A service token's `common_name` names
 * the credential itself and is preferred over the subject when present.
 */
function principalOf(request: Request): string | null {
  const token = request.headers.get("cf-access-jwt-assertion");
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    if (claims === null || typeof claims !== "object") return null;
    const record = claims as Record<string, unknown>;
    const common = record["common_name"];
    if (typeof common === "string" && common.trim() !== "") return common;
    const subject = record["sub"];
    return typeof subject === "string" && subject.trim() !== "" ? subject : null;
  } catch {
    return null;
  }
}

/** Read a bounded JSON body. An oversized or malformed body never reaches a tool. */
async function boundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_REQUEST_BYTES)
    throw new HttpError(413, "request_too_large");
  const body = request.body;
  if (body === null) return {};
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(value);
  }
  if (size === 0) return {};
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new HttpError(400, "invalid_body");
  }
}

/** The grant of the caller, or `null`. Absent configuration grants nothing. */
export function agentGrant(request: Request, env: Env): Grant | null {
  const principal = principalOf(request);
  if (principal === null) return null;
  return grantFor(parseGrants(env.AGENT_GRANTS), principal);
}

/**
 * The authority a signed-in browser reader already has: everything the
 * existing GET routes serve, and no proposal capability. It is not read from
 * `AGENT_GRANTS`, and it can never propose or accept.
 */
export function readerGrant(principal: string): Grant {
  return {
    principal,
    scopes: { sources: "*", accounts: "*" },
    capabilities: ["summary.read", "records.read", "evidence.read"],
    budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
  };
}

/** POST routes. Returns `null` when the path is not an agent path. */
export async function agentApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!isAgentPath(path)) return null;
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (url.search) throw new HttpError(400, "invalid_query");
  const grant = agentGrant(request, env);
  if (grant === null) throw new HttpError(403, "agent_api_not_configured");
  const now = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const context = toolContext(env, grant, now);

  if (path === MCP_PATH) {
    const message = await handleMcp(await boundedJson(request), (name, body) =>
      callTool(name, body, context),
    );
    if (message === null) return new Response(null, { status: 202 });
    return json(message);
  }
  const tool = toolForPath(path);
  if (tool === null) throw new HttpError(404, "not_found");
  const outcome = await callTool(tool, await boundedJson(request), context);
  return json(outcome.body, outcome.status);
}

/**
 * `GET /api/v2/query`: the same service the agent calls, for the human UI.
 * Parameters are the query spec's own fields; nothing else is accepted.
 */
export async function sharedQueryApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== SHARED_QUERY_PATH) return null;
  const filters: Record<string, string> = {};
  let intent: string | null = null;
  let cursor: string | null = null;
  let limit: number | null = null;
  for (const key of url.searchParams.keys()) {
    if (url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "invalid_query");
    const value = url.searchParams.get(key)!;
    if (key === "intent") intent = value;
    else if (key === "cursor") cursor = value;
    else if (key === "limit") {
      if (!/^[1-9][0-9]{0,3}$/u.test(value)) throw new HttpError(400, "invalid_query");
      limit = Number(value);
    } else filters[key] = value;
  }
  if (intent === null) throw new HttpError(400, "invalid_query");
  const parsed = parseQueryRequest({
    intent,
    filters,
    cursor,
    limit: limit ?? DEFAULT_QUERY_LIMIT,
  });
  if (!parsed.ok) throw new HttpError(400, parsed.code);
  const principal = principalOf(request);
  if (principal === null) throw new HttpError(401, "authentication_required");
  const outcome = await queryResponse(
    toolContext(env, readerGrant(principal), new Date().toISOString().replace(/\.\d{3}Z$/u, "Z")),
    parsed.value,
  );
  return json(outcome.body, outcome.status);
}
