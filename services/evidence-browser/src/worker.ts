import {
  EVIDENCE_API_VERSION,
  type EvidenceMeta,
} from "../../../poc/observation-pipeline/shared/evidence-contract";
import { authenticate } from "./auth";
import { agentApi, classifyAgentPath, sharedQueryApi } from "./agent-api";
import { observationApi } from "./observation-api";
import { eventsApi } from "./events-api";
import { identityApi } from "./identity-api";
import { cursor, HttpError, identifier, json, secureResponse } from "./http";
import { catalogue, detailDto, getArtifact, getRun, listArtifacts, listRuns, raw } from "./read";

const PREFIX = "/api/evidence/v1";
function classify(path: string): string {
  const agent = classifyAgentPath(path);
  if (agent !== null) return agent;
  if (path === `${PREFIX}/meta`) return "meta";
  if (/^\/api\/evidence\/v1\/sources\/[^/]+\/runs$/.test(path)) return "source_runs";
  if (/^\/api\/evidence\/v1\/runs\/[^/]+\/artifacts$/.test(path)) return "run_artifacts";
  if (/^\/api\/evidence\/v1\/runs\/[^/]+\/artifacts\/[^/]+\/raw$/.test(path)) return "artifact_raw";
  if (/^\/api\/evidence\/v1\/runs\/[^/]+\/artifacts\/[^/]+$/.test(path)) return "artifact_detail";
  if (path === "/api/v2/activity" || path === "/api/v2/obligations") return "events_v2";
  return path.startsWith("/api/") ? "unknown_api" : "assets";
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  await authenticate(request, env);
  // The only non-GET surface: an explicit allow-list of authenticated,
  // grant-checked POST paths (docs/agent-api.md). Everything else stays
  // read-only, and both sides keep the same closed 401/403 responses.
  const agentResponse = await agentApi(request, env, url);
  if (agentResponse) return agentResponse;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  const sharedQueryResponse = await catalogue(() => sharedQueryApi(request, env, url));
  if (sharedQueryResponse) return sharedQueryResponse;
  const identityResponse = await catalogue(() => identityApi(request, env, url));
  if (identityResponse) return identityResponse;
  const observationResponse = await catalogue(() => observationApi(request, env, url));
  if (observationResponse) return observationResponse;
  // A10 read side: 404 unless the projection exists and the reader flag is on.
  const eventsResponse = await catalogue(() => eventsApi(env, url));
  if (eventsResponse) return eventsResponse;
  if (env.EVIDENCE_SOURCE_ID !== "sony-bank") throw new HttpError(503, "source_not_configured");
  const source = env.EVIDENCE_SOURCE_ID;
  const path = url.pathname;
  if (path === `${PREFIX}/meta`) {
    if (url.search) throw new HttpError(400, "invalid_query");
    return json({
      apiVersion: EVIDENCE_API_VERSION,
      source: { kind: "central-raw-store", classification: "financial" },
      capabilities: {
        readOnly: true,
        rawEvidence: true,
        parsedObservations: true,
        liveCollectors: false,
      },
      sources: [{ id: source, label: "Sony Bank" }],
    } satisfies EvidenceMeta);
  }
  const sourceMatch = /^\/api\/evidence\/v1\/sources\/([^/]+)\/runs$/.exec(path);
  if (sourceMatch) {
    if (sourceMatch[1] !== source) throw new HttpError(404, "not_found");
    const before = cursor(url);
    return json({
      apiVersion: EVIDENCE_API_VERSION,
      sourceId: source,
      coverage: "sealed-only",
      ...(await catalogue(() => listRuns(env.DB, source, before))),
    });
  }
  const match = /^\/api\/evidence\/v1\/runs\/([^/]+)\/artifacts(?:\/([^/]+)(\/raw)?)?$/.exec(path);
  if (match) {
    const runId = identifier(match[1], "r");
    const before = match[2] ? undefined : cursor(url);
    if (match[2] && url.search) throw new HttpError(400, "invalid_query");
    const run = await catalogue(() => getRun(env.DB, source, runId));
    if (!match[2])
      return json({
        apiVersion: EVIDENCE_API_VERSION,
        run,
        ...(await catalogue(() => listArtifacts(env.DB, source, runId, before!))),
      });
    const artifactId = identifier(match[2], "a");
    const artifact = await catalogue(() => getArtifact(env.DB, source, runId, artifactId));
    if (match[3]) return raw(env.EVIDENCE, artifact, request.method === "HEAD");
    return json({ apiVersion: EVIDENCE_API_VERSION, run, artifact: detailDto(artifact) });
  }
  if (path === "/api" || path.startsWith("/api/")) throw new HttpError(404, "not_found");
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let response: Response;
    let errorCode: string | null = null;
    try {
      response = await route(request, env, url);
    } catch (error) {
      const known = error instanceof HttpError;
      errorCode = known ? error.code : "internal_error";
      response = json({ error: errorCode, requestId }, known ? error.status : 500);
    }
    try {
      console.log(
        JSON.stringify({
          event: "evidence_request",
          route: classify(url.pathname),
          status: response.status,
          requestId,
          durationMs: Date.now() - started,
          errorCode,
        }),
      );
    } catch {
      /* Observability never changes the response. */
    }
    return secureResponse(response, request, requestId);
  },
} satisfies ExportedHandler<Env>;
