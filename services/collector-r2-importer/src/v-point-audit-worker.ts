import { ImportError } from "./error";
import { validateVPointLayerBRun } from "./v-point";
import {
  vPointBalanceInfo,
  vPointHistoryPage,
  vPointSmfgPoint,
} from "../../../packages/parsers/src/parsers/v-point";

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
      const input = (await request.json()) as unknown;
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== "cursor") ||
        !(input.cursor === undefined || safeCursor(input.cursor))
      ) {
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
        const audited = await validateVPointLayerBRun({
          bucket: env.VPOINT_SNAPSHOTS,
          reconciliationBucket: env.VPOINT_PAY_SNAPSHOTS,
          manifestKey: object.key,
        });
        const shape = {
          financialArtifactCount: 0,
          ignoredArtifactCount: 0,
          parsedObservationCount: 0,
          balanceObservationCount: 0,
          transactionObservationCount: 0,
          externalIdObservationCount: 0,
          positivePointTransactionCount: 0,
          negativePointTransactionCount: 0,
          zeroPointTransactionCount: 0,
        };
        if (audited.status === "success" && audited.failureCount === 0) {
          const parsers = [vPointBalanceInfo, vPointSmfgPoint, vPointHistoryPage];
          for (const artifact of audited.artifacts) {
            const meta = {
              id: 0,
              sourceId: "v-point",
              runStatus: audited.status,
              runFailureCount: audited.failureCount,
              dataset: artifact.dataset,
              url: null,
              mime: "application/json",
              fetchedAt: audited.completedAt,
              sha256: artifact.sha256,
            } as const;
            const selected = parsers.filter((parser) => parser.accepts(meta));
            if (selected.length === 0) {
              shape.ignoredArtifactCount += 1;
              continue;
            }
            if (selected.length !== 1) throw new Error("parser_cardinality_invalid");
            shape.financialArtifactCount += 1;
            const parsed = selected[0]!.parse(artifact.bytes, meta);
            shape.parsedObservationCount += parsed.observations.length;
            for (const observation of parsed.observations) {
              if (observation.kind === "balance") shape.balanceObservationCount += 1;
              if (observation.kind !== "transaction") continue;
              shape.transactionObservationCount += 1;
              if (observation.externalId !== undefined) shape.externalIdObservationCount += 1;
              const points = observation.amountMinor;
              if (points === undefined) throw new Error("point_amount_missing");
              if (points > 0) shape.positivePointTransactionCount += 1;
              else if (points < 0) shape.negativePointTransactionCount += 1;
              else shape.zeroPointTransactionCount += 1;
            }
          }
        }
        return auditResponse({
          scanned: 1,
          audited: 1,
          schemaVersion: audited.schemaVersion,
          status: audited.status,
          artifactCount: audited.artifacts.length,
          hasReconciliation: audited.hasReconciliation,
          ...shape,
          nextCursor: nextCursor ?? null,
        });
      } catch {
        return auditResponse({
          scanned: 1,
          failed: 1,
          failureCode: "vpoint_contract_validation_failed",
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
  financialArtifactCount?: number;
  ignoredArtifactCount?: number;
  parsedObservationCount?: number;
  balanceObservationCount?: number;
  transactionObservationCount?: number;
  externalIdObservationCount?: number;
  positivePointTransactionCount?: number;
  negativePointTransactionCount?: number;
  zeroPointTransactionCount?: number;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "vpoint-layer-b-aggregate-audit-v1",
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
    ...(input.financialArtifactCount === undefined
      ? {}
      : {
          financialArtifactCount: input.financialArtifactCount,
          ignoredArtifactCount: input.ignoredArtifactCount,
          parsedObservationCount: input.parsedObservationCount,
          balanceObservationCount: input.balanceObservationCount,
          transactionObservationCount: input.transactionObservationCount,
          externalIdObservationCount: input.externalIdObservationCount,
          positivePointTransactionCount: input.positivePointTransactionCount,
          negativePointTransactionCount: input.negativePointTransactionCount,
          zeroPointTransactionCount: input.zeroPointTransactionCount,
        }),
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
