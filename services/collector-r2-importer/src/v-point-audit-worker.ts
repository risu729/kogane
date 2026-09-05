import { ImportError } from "./error";
import { auditVPointRun } from "./v-point";

type AuditEnv = Pick<Env, "VPOINT_SNAPSHOTS" | "VPOINT_PAY_SNAPSHOTS">;

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "v-point-r2-contract-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return response({ error: "not_found" }, 404);
    }
    try {
      const input = await request.json() as unknown;
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "cursor") ||
          !(input.cursor === undefined || safeCursor(input.cursor))) {
        throw new ImportError(400, "cursor_invalid");
      }
      const listed = await env.VPOINT_SNAPSHOTS.list({
        prefix: "raw/v-point/",
        limit: 1,
        ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
      });
      if (listed.objects.length > 1) throw new ImportError(409, "prefix_page_too_large");
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && !nextCursor) throw new ImportError(409, "prefix_cursor_missing");
      if (listed.truncated && nextCursor === input.cursor) {
        throw new ImportError(409, "prefix_cursor_did_not_advance");
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
        const audited = await auditVPointRun({
          bucket: env.VPOINT_SNAPSHOTS,
          reconciliationBucket: env.VPOINT_PAY_SNAPSHOTS,
          manifestKey: object.key,
        });
        return auditResponse({
          scanned: 1,
          audited: 1,
          schemaVersion: audited.schemaVersion,
          status: audited.status,
          artifactCount: audited.artifactCount,
          hasReconciliation: audited.hasReconciliation,
          nextCursor: nextCursor ?? null,
        });
      } catch (error) {
        return auditResponse({
          scanned: 1,
          failed: 1,
          failureCode: safeCode(error),
          nextCursor: nextCursor ?? null,
        });
      }
    } catch (error) {
      return response(
        { error: safeCode(error) },
        error instanceof ImportError ? error.status : 502,
      );
    }
  },
};

function auditResponse(input: {
  scanned: 0 | 1;
  audited?: 1;
  skipped?: 1;
  failed?: 1;
  failureCode?: string;
  schemaVersion?: "vpoint-worker-poc-v1" | "vpoint-worker-poc-v2";
  status?: "success" | "partial" | "failed";
  artifactCount?: number;
  hasReconciliation?: boolean;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "vpoint-r2-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.schemaVersion ? { manifestSchemaVersion: input.schemaVersion } : {}),
    ...(input.status ? { manifestStatus: input.status } : {}),
    ...(input.artifactCount === undefined ? {} : { artifactCount: input.artifactCount }),
    ...(input.hasReconciliation === undefined
      ? {}
      : { hasReconciliation: input.hasReconciliation }),
  });
}

function safeCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value);
}

function safeCode(error: unknown): string {
  const candidate = error instanceof ImportError
    ? error.code
    : error instanceof Error ? error.message : "request_failed";
  return /^[a-z0-9_-]{1,100}$/u.test(candidate) ? candidate : "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
