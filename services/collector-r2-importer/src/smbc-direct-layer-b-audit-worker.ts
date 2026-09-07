import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types";
import { validateSmbcDirectRun } from "./smbc-direct";

type AuditEnv = Pick<Env, "SMBC_DIRECT_SNAPSHOTS">;

const PREFIX = "raw/smbc-direct/";

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "smbc-direct-r2-layer-b-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return response({ error: "not_found" }, 404);
    }
    try {
      const input = (await request.json()) as unknown;
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "cursor")) {
        return response({ error: "cursor_invalid" }, 400);
      }
      const cursor = input.cursor;
      if (cursor !== undefined && !safeCursor(cursor)) {
        return response({ error: "cursor_invalid" }, 400);
      }
      const listed = await env.SMBC_DIRECT_SNAPSHOTS.list({
        prefix: PREFIX,
        limit: 1,
        ...(typeof cursor === "string" ? { cursor } : {}),
      });
      if (listed.objects.length > 1) throw new Error("prefix_page_too_large");
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && (!nextCursor || nextCursor === cursor)) {
        throw new Error(nextCursor ? "prefix_cursor_did_not_advance" : "prefix_cursor_missing");
      }
      const object = listed.objects[0];
      if (!object) return auditResponse({ scanned: 0, nextCursor: null });
      if (!object.key.endsWith("/manifest.json")) {
        return auditResponse({
          scanned: 1,
          skipped: 1,
          nextCursor: nextCursor ?? null,
        });
      }
      try {
        const validated = await validateSmbcDirectRun(env.SMBC_DIRECT_SNAPSHOTS, object.key);
        let canonicalArtifactCount = 0;
        let ignoredRawArtifactCount = 0;
        let parsedArtifactCount = 0;
        let transactionObservationCount = 0;
        let balanceObservationCount = 0;
        for (const entry of validated.artifacts) {
          const meta: ArtifactMeta = {
            id: 0,
            sourceId: "smbc-bank",
            runStatus: validated.manifest.status,
            runFailureCount: validated.manifest.failureCodes.length,
            dataset: entry.artifact.dataset,
            url: null,
            mime: entry.artifact.mediaType.split(";", 1)[0]!.trim(),
            fetchedAt: validated.manifest.completedAt,
            sha256: entry.artifact.sha256,
          };
          const matches = PARSERS.filter((parser) => parser.accepts(meta));
          if (entry.artifact.dataset.endsWith("-raw")) {
            ignoredRawArtifactCount += 1;
            if (matches.length !== 0) throw new Error("raw_parser_route_invalid");
            continue;
          }
          canonicalArtifactCount += 1;
          if (validated.manifest.status !== "success") {
            if (matches.length !== 1) throw new Error("normalized_parser_route_invalid");
            continue;
          }
          if (matches.length !== 1) throw new Error("normalized_parser_route_invalid");
          const result = matches[0]!.parse(entry.bytes, meta);
          parsedArtifactCount += 1;
          transactionObservationCount += result.observations.filter(
            (observation) => observation.kind === "transaction",
          ).length;
          balanceObservationCount += result.observations.filter(
            (observation) => observation.kind === "balance",
          ).length;
        }
        return auditResponse({
          scanned: 1,
          audited: 1,
          manifestStatus: validated.manifest.status,
          artifactCount: validated.artifacts.length,
          canonicalArtifactCount,
          ignoredRawArtifactCount,
          parsedArtifactCount,
          transactionObservationCount,
          balanceObservationCount,
          nextCursor: nextCursor ?? null,
        });
      } catch {
        return auditResponse({
          scanned: 1,
          failed: 1,
          failureCode: "contract_validation_failed",
          nextCursor: nextCursor ?? null,
        });
      }
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : "request_failed";
      return response({ error: code }, 502);
    }
  },
};

function auditResponse(input: {
  scanned: 0 | 1;
  audited?: 1;
  skipped?: 1;
  failed?: 1;
  failureCode?: string;
  manifestStatus?: "success" | "partial" | "failed";
  artifactCount?: number;
  canonicalArtifactCount?: number;
  ignoredRawArtifactCount?: number;
  parsedArtifactCount?: number;
  transactionObservationCount?: number;
  balanceObservationCount?: number;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "smbc-direct-r2-layer-b-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.manifestStatus
      ? {
          manifestStatus: input.manifestStatus,
          artifactCount: input.artifactCount,
          canonicalArtifactCount: input.canonicalArtifactCount,
          ignoredRawArtifactCount: input.ignoredRawArtifactCount,
          parsedArtifactCount: input.parsedArtifactCount,
          transactionObservationCount: input.transactionObservationCount,
          balanceObservationCount: input.balanceObservationCount,
        }
      : {}),
  });
}

function safeCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
