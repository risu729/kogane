import { ImportError } from "./error";
import { auditMoneyForwardRun } from "./moneyforward";

type AuditEnv = Pick<Env, "MONEYFORWARD_SNAPSHOTS">;

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "moneyforward-r2-contract-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return response({ error: "not_found" }, 404);
    }
    try {
      const input = (await request.json()) as unknown;
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== "cursor") ||
        !(input.cursor === undefined || safeCursor(input.cursor))
      ) {
        throw new ImportError(400, "cursor_invalid");
      }
      const listed = await env.MONEYFORWARD_SNAPSHOTS.list({
        prefix: "raw/moneyforward/",
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
      if (!object) return auditResponse({ scanned: 0, nextCursor: nextCursor ?? null });
      if (!object.key.endsWith("/manifest.json")) {
        return auditResponse({ scanned: 1, skipped: 1, nextCursor: nextCursor ?? null });
      }
      try {
        const audited = await auditMoneyForwardRun({
          bucket: env.MONEYFORWARD_SNAPSHOTS,
          manifestKey: object.key,
        });
        return auditResponse({
          scanned: 1,
          audited: 1,
          status: audited.status,
          artifactCount: audited.artifactCount,
          accountDetailCount: audited.accountDetailCount,
          monthlyFragmentCount: audited.monthlyFragmentCount,
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
  status?: "success" | "partial" | "failed";
  artifactCount?: number;
  accountDetailCount?: number;
  monthlyFragmentCount?: number;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "moneyforward-r2-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.status ? { manifestStatus: input.status } : {}),
    ...(input.artifactCount === undefined ? {} : { artifactCount: input.artifactCount }),
    ...(input.accountDetailCount === undefined
      ? {}
      : { accountDetailCount: input.accountDetailCount }),
    ...(input.monthlyFragmentCount === undefined
      ? {}
      : { monthlyFragmentCount: input.monthlyFragmentCount }),
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

function safeCode(error: unknown): string {
  const candidate =
    error instanceof ImportError
      ? error.code
      : error instanceof Error
        ? error.message
        : "request_failed";
  return /^[a-z0-9_-]{1,100}$/u.test(candidate) ? candidate : "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
