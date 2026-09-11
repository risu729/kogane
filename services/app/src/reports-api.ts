import { HttpError, json } from "./http";
import { decimalPolicySelection } from "./decimal-policy";
import {
  interpretationContext,
  NO_RECORDED_IDENTITY_RELEASE,
} from "../../../packages/read-model/src/index";
import {
  replayabilityFor,
  replayCapabilities,
  reportStorageRef,
  validReportBody,
  type EvidenceUseRestriction,
  type Replayability,
} from "../../../packages/domain/src/index";

/**
 * Fixed report artifacts, read-only (architecture addendum A12; AR03, AR17).
 *
 * Three different operations are named in addendum 09 section 9 and only the
 * first is a route here:
 *
 *   * `re-display`  — return the stored body of this exact report. That is
 *     this module. It never recomputes and never regenerates: a later rule,
 *     price or classification change does not touch a stored report
 *     (UC60/AT60).
 *   * `recompute-under-current-rules`
 *   * `share-corrected-version`
 *
 * The last two produce new state and belong to the authenticated command
 * boundary (A09). They are documented here so a caller cannot mistake one
 * ambiguous "regenerate" for all three.
 *
 * Current authorization outranks a past context (addendum 06 section 6):
 * returning a stored report already requires the Access gate the Worker
 * applies before this module runs, and if the evidence the report was computed
 * from is now restricted, the explanation and export routes refuse even though
 * the body itself is still preserved.
 */
const PREFIX = "/api/v2/reports";
const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface ArtifactRow {
  report_id: string;
  context_id: string;
  purpose: string;
  schema_version: string;
  content_digest: string;
  storage_ref: string;
  created_by: string;
  created_at: string;
}

interface RunRow {
  run_id: string;
  policy_refs_json: string;
  input_manifest_digest: string;
  status: string;
  replayability: Replayability;
  started_at: string;
  completed_at: string | null;
}

export function reportsRoute(path: string): { reportId: string; view: string } | null {
  const match = /^\/api\/v2\/reports\/([^/]+)(?:\/(explanation|export))?$/.exec(path);
  if (!match) return null;
  const reportId = decodeURIComponent(match[1]!);
  if (!REPORT_ID.test(reportId)) throw new HttpError(400, "invalid_identifier");
  return { reportId, view: match[2] ?? "body" };
}

async function restrictionsFor(
  db: D1Database,
  refs: readonly string[],
): Promise<EvidenceUseRestriction[]> {
  if (refs.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT evidence_ref,restriction,since,affected_manifests_json,actor,reason
       FROM evidence_use_restrictions
       WHERE evidence_ref IN (${refs.map(() => "?").join(",")})
          OR EXISTS(SELECT 1 FROM json_each(affected_manifests_json) m
                    WHERE m.value IN (${refs.map(() => "?").join(",")}))`,
    )
    .bind(...refs, ...refs)
    .all<{
      evidence_ref: string;
      restriction: EvidenceUseRestriction["restriction"];
      since: string;
      affected_manifests_json: string;
      actor: string;
      reason: string;
    }>();
  return rows.results.map((row) => ({
    evidenceRef: row.evidence_ref,
    restriction: row.restriction,
    since: row.since,
    affectedManifests: [],
    actor: row.actor,
    reason: row.reason,
  }));
}

/** Called only after the Access gate and the read-only method check in worker.ts. */
export async function reportsApi(env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  const route = reportsRoute(path);
  if (!route) throw new HttpError(404, "not_found");
  for (const key of url.searchParams.keys())
    if (key !== "decimalPolicy") throw new HttpError(400, "invalid_query");
  // Selecting a normalization policy is part of the read contract even where
  // the stored body already fixed one; an unknown name is refused here rather
  // than served from the decimal-v1 projection (docs/normalized-decimals.md).
  // A stored report is read as-recorded: its body fixed its own interpretation,
  // and this context names the one the request was served under.
  const decimalPolicy = decimalPolicySelection(url);
  const interpretation = interpretationContext(
    "as-recorded",
    NO_RECORDED_IDENTITY_RELEASE,
    decimalPolicy,
  );

  const artifact = await env.DB.prepare(
    `SELECT report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at
     FROM report_artifacts WHERE report_id=?`,
  )
    .bind(route.reportId)
    .first<ArtifactRow>();
  if (!artifact) throw new HttpError(404, "not_found");

  const run = await env.DB.prepare(
    `SELECT run_id,policy_refs_json,input_manifest_digest,status,replayability,started_at,completed_at
     FROM calculation_runs WHERE context_id=? ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(artifact.context_id)
    .first<RunRow>();

  const stored = await env.EVIDENCE.head(artifact.storage_ref);
  const restrictions = await restrictionsFor(env.DB, [
    artifact.context_id,
    artifact.report_id,
    ...(run ? [run.run_id, run.input_manifest_digest] : []),
  ]);
  const replayability = replayabilityFor({
    // Without a run the inputs are not identified, so nothing may claim to be
    // replayable; the preserved body is all that is left.
    inputsPresent: run !== null && run.status === "complete",
    artifactPresent: stored !== null,
    restrictions,
  });
  const capabilities = replayCapabilities(replayability);

  if (route.view !== "body") {
    const allowed = route.view === "export" ? capabilities.export : capabilities.explain;
    // Explanation and export are refused while the evidence is restricted, and
    // no cached explanation node is served (UC66/AT66). The pipeline purges the
    // cached nodes themselves; this reader never serves one.
    if (!allowed) throw new HttpError(403, "evidence_restricted");
  }

  if (route.view === "explanation") {
    const cached = await env.EVIDENCE.get(`${artifact.storage_ref}.explanation`);
    if (!cached) throw new HttpError(404, "not_found");
    if (cached.size > MAX_BODY_BYTES) throw new HttpError(503, "report_body_too_large");
    return json({
      reportId: artifact.report_id,
      contextId: artifact.context_id,
      replayability,
      interpretationContext: interpretation,
      explanation: JSON.parse(await cached.text()) as unknown,
    });
  }

  const object = await env.EVIDENCE.get(artifact.storage_ref);
  if (!object) {
    if (route.view === "export") throw new HttpError(404, "not_found");
    // The catalogue row survives even when the body is gone; say so instead of
    // rebuilding a different report under the same id.
    return json({
      report: reportDto(artifact, run, "unavailable", replayCapabilities("unavailable")),
      interpretationContext: interpretation,
      body: null,
    });
  }
  if (object.size > MAX_BODY_BYTES) throw new HttpError(503, "report_body_too_large");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // The stored bytes must still be the bytes the report was created from.
  if (digest !== artifact.content_digest) throw new HttpError(503, "report_digest_mismatch");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(503, "report_body_invalid");
  }
  if (!validReportBody(body)) throw new HttpError(503, "report_body_invalid");

  const events = await env.DB.prepare(
    "SELECT kind,actor,related_report_id,occurred_at FROM report_events WHERE report_id=? ORDER BY occurred_at,id LIMIT 200",
  )
    .bind(artifact.report_id)
    .all<{
      kind: string;
      actor: string;
      related_report_id: string | null;
      occurred_at: string;
    }>();

  return json({
    report: reportDto(artifact, run, replayability, capabilities),
    interpretationContext: interpretation,
    events: events.results,
    view: route.view,
    body,
  });
}

function reportDto(
  artifact: ArtifactRow,
  run: RunRow | null,
  replayability: Replayability,
  capabilities: ReturnType<typeof replayCapabilities>,
) {
  return {
    reportId: artifact.report_id,
    contextId: artifact.context_id,
    purpose: artifact.purpose,
    schemaVersion: artifact.schema_version,
    contentDigest: artifact.content_digest,
    storageRef: reportStorageRef(artifact.content_digest),
    createdBy: artifact.created_by,
    createdAt: artifact.created_at,
    replayability,
    capabilities,
    calculationRun: run
      ? {
          runId: run.run_id,
          policyRefs: JSON.parse(run.policy_refs_json) as unknown,
          inputManifestDigest: run.input_manifest_digest,
          status: run.status,
          startedAt: run.started_at,
          completedAt: run.completed_at,
        }
      : null,
    /** Re-display is this route; the other two are commands, not reads. */
    operations: {
      "re-display": "GET /api/v2/reports/{reportId}",
      "recompute-under-current-rules": "command (A09); not served by this reader",
      "share-corrected-version": "command (A09); not served by this reader",
    },
  };
}
