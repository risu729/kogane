// The evidence browser's routes, `GET /api/evidence/v1/*`: the configured
// source's metadata, its sealed runs, a run's artifacts and one artifact's
// detail, and that artifact's raw bytes. The route and `kogane.evidence.read`
// (ADR 0081) both answer through `readEvidenceRoute`.
import {
  EVIDENCE_API_VERSION,
  type EvidenceMeta,
} from "../../../packages/observation-shared/src/evidence-contract";
import { cursor, HttpError, identifier } from "./http";
import {
  detailDto,
  evidenceArtifact,
  evidenceRun,
  listEvidenceArtifacts,
  listEvidenceRuns,
} from "../../../packages/application/src/query/evidence-catalogue.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { type ArtifactRow, catalogue } from "./read";

/** A run or artifact the catalogue does not hold is the route's 404. */
function found<T>(row: T | null): T {
  if (row === null) throw new HttpError(404, "not_found");
  return row;
}

export const EVIDENCE_PREFIX = "/api/evidence/v1";
const RUNS = /^\/api\/evidence\/v1\/sources\/([^/]+)\/runs$/;
const ARTIFACTS = /^\/api\/evidence\/v1\/runs\/([^/]+)\/artifacts(?:\/([^/]+)(\/raw)?)?$/;

/** The parts of a request the evidence reader reads. */
export type EvidenceRequest = Pick<URL, "pathname" | "search" | "searchParams">;

/**
 * One evidence route's answer for this path and query: its JSON body, or the
 * artifact whose raw bytes the route streams; `null` for a path that is no
 * evidence route. Refusals are `HttpError`s. Every path that reaches here is
 * refused while no source is configured, as before the reader was shared.
 */
export async function readEvidenceRoute(
  env: Env,
  url: EvidenceRequest,
): Promise<{ body: unknown } | { raw: ArtifactRow } | null> {
  if (env.EVIDENCE_SOURCE_ID !== "sony-bank") throw new HttpError(503, "source_not_configured");
  const source = env.EVIDENCE_SOURCE_ID;
  const path = url.pathname;
  if (path === `${EVIDENCE_PREFIX}/meta`) {
    if (url.search) throw new HttpError(400, "invalid_query");
    return {
      body: {
        apiVersion: EVIDENCE_API_VERSION,
        source: { kind: "central-raw-store", classification: "financial" },
        capabilities: {
          readOnly: true,
          rawEvidence: true,
          parsedObservations: true,
          liveCollectors: false,
        },
        sources: [{ id: source, label: "Sony Bank" }],
      } satisfies EvidenceMeta,
    };
  }
  const sourceMatch = RUNS.exec(path);
  if (sourceMatch) {
    if (sourceMatch[1] !== source) throw new HttpError(404, "not_found");
    const before = cursor(url);
    return {
      body: {
        apiVersion: EVIDENCE_API_VERSION,
        sourceId: source,
        coverage: "sealed-only",
        ...(await catalogue(() => listEvidenceRuns(d1Executor(env.DB), source, before))),
      },
    };
  }
  const match = ARTIFACTS.exec(path);
  if (!match) return null;
  const runId = identifier(match[1]!, "r");
  const before = match[2] ? undefined : cursor(url);
  if (match[2] && url.search) throw new HttpError(400, "invalid_query");
  const run = found(await catalogue(() => evidenceRun(d1Executor(env.DB), source, runId)));
  if (!match[2])
    return {
      body: {
        apiVersion: EVIDENCE_API_VERSION,
        run,
        ...(await catalogue(() =>
          listEvidenceArtifacts(d1Executor(env.DB), source, runId, before!),
        )),
      },
    };
  const artifactId = identifier(match[2], "a");
  const artifact = found(
    await catalogue(() => evidenceArtifact(d1Executor(env.DB), source, runId, artifactId)),
  );
  if (match[3]) return { raw: artifact };
  return { body: { apiVersion: EVIDENCE_API_VERSION, run, artifact: detailDto(artifact) } };
}
