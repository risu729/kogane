import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types";
import { parseSbiVcManifest } from "./sbi-vc";

type AuditEnv = Pick<Env, "SBI_VC_SNAPSHOTS">;

const PREFIX = "raw/sbi-vc-trade/";

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "sbi-vc-r2-layer-b-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return response({ error: "not_found" }, 404);
    }
    let cursor: string | undefined;
    try {
      const input = (await request.json()) as unknown;
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "cursor")) {
        return response({ error: "cursor_invalid" }, 400);
      }
      if (input.cursor !== undefined) {
        if (!safeCursor(input.cursor)) return response({ error: "cursor_invalid" }, 400);
        cursor = input.cursor;
      }
      const listed = await env.SBI_VC_SNAPSHOTS.list({
        prefix: PREFIX,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      if (listed.objects.length > 1) throw new Error("prefix_page_too_large");
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && (!nextCursor || nextCursor === cursor)) {
        throw new Error(nextCursor ? "prefix_cursor_did_not_advance" : "prefix_cursor_missing");
      }
      const object = listed.objects[0];
      if (!object) return auditResponse({ scanned: 0, nextCursor: null });
      if (!object.key.endsWith("/manifest.json")) {
        return auditResponse({ scanned: 1, skipped: 1, nextCursor: nextCursor ?? null });
      }
      try {
        const audit = await auditManifest(env.SBI_VC_SNAPSHOTS, object.key);
        return auditResponse({
          scanned: 1,
          audited: 1,
          nextCursor: nextCursor ?? null,
          ...audit,
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

async function auditManifest(bucket: R2Bucket, manifestKey: string) {
  const manifestObject = await bucket.get(manifestKey);
  if (!manifestObject) throw new Error("manifest_missing");
  assertJson(manifestObject);
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifest = parseSbiVcManifest(manifestBytes, manifestKey);
  await assertExactPrefix(bucket, manifestKey, [
    manifestKey,
    ...manifest.artifacts.map((artifact) => artifact.key),
  ]);

  let matchedArtifactCount = 0;
  let parsedArtifactCount = 0;
  let hasNonEmptyPosition = false;
  let hasNonEmptyRecentExecutions = false;
  const recentIds = new Set<string>();
  const historicalIds = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const object = await bucket.get(artifact.key);
    if (!object || object.size !== artifact.bytes) throw new Error("artifact_size_invalid");
    assertJson(object);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(bytes)) !== artifact.sha256) throw new Error("artifact_hash_invalid");
    if (manifest.status !== "success") continue;
    const meta: ArtifactMeta = {
      id: 0,
      sourceId: "sbi-vc-trade",
      runStatus: "success",
      runFailureCount: 0,
      dataset: artifact.dataset,
      url: null,
      mime: "application/json",
      fetchedAt: manifest.completedAt,
      sha256: artifact.sha256,
    };
    const matches = PARSERS.filter((parser) => parser.accepts(meta));
    if (matches.length !== 1) throw new Error("parser_route_invalid");
    matchedArtifactCount += 1;
    const result = matches[0]!.parse(bytes, meta);
    parsedArtifactCount += 1;
    if (artifact.dataset === "position-summary" && result.observations.length > 0) {
      hasNonEmptyPosition = true;
    }
    if (artifact.dataset === "executions-recent-page-0001" && result.observations.length > 0) {
      hasNonEmptyRecentExecutions = true;
    }
    if (artifact.dataset.startsWith("executions-")) {
      const target = artifact.dataset.includes("-recent-") ? recentIds : historicalIds;
      for (const observation of result.observations) {
        if (observation.kind === "transaction" && observation.externalId) {
          target.add(observation.externalId);
        }
      }
    }
  }
  return {
    manifestStatus: manifest.status,
    artifactCount: manifest.artifacts.length,
    matchedArtifactCount,
    parsedArtifactCount,
    hasNonEmptyPosition,
    hasNonEmptyRecentExecutions,
    hasMultipleHistoricalExecutionPages:
      manifest.artifacts.filter((entry) => entry.dataset.startsWith("executions-historical-page-"))
        .length > 1,
    hasMultipleHistoricalCashflowPages:
      manifest.artifacts.filter((entry) => entry.dataset.startsWith("cashflows-historical-page-"))
        .length > 1,
    hasCrossViewExecutionOverlap: [...recentIds].some((id) => historicalIds.has(id)),
  };
}

async function assertExactPrefix(
  bucket: R2Bucket,
  manifestKey: string,
  expected: string[],
): Promise<void> {
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const actual: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    actual.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) throw new Error("run_cursor_missing");
  } while (cursor);
  actual.sort();
  expected.sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("run_inventory_invalid");
  }
}

function assertJson(object: R2ObjectBody): void {
  if (object.httpMetadata?.contentType?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("content_type_invalid");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function auditResponse(input: {
  scanned: 0 | 1;
  audited?: 1;
  skipped?: 1;
  failed?: 1;
  failureCode?: string;
  manifestStatus?: "success" | "partial" | "failed";
  artifactCount?: number;
  matchedArtifactCount?: number;
  parsedArtifactCount?: number;
  hasNonEmptyPosition?: boolean;
  hasNonEmptyRecentExecutions?: boolean;
  hasMultipleHistoricalExecutionPages?: boolean;
  hasMultipleHistoricalCashflowPages?: boolean;
  hasCrossViewExecutionOverlap?: boolean;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "sbi-vc-r2-layer-b-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.manifestStatus ? { manifestStatus: input.manifestStatus } : {}),
    ...(input.artifactCount === undefined ? {} : { artifactCount: input.artifactCount }),
    ...(input.matchedArtifactCount === undefined
      ? {}
      : { matchedArtifactCount: input.matchedArtifactCount }),
    ...(input.parsedArtifactCount === undefined
      ? {}
      : { parsedArtifactCount: input.parsedArtifactCount }),
    ...(input.hasNonEmptyPosition === undefined
      ? {}
      : {
          hasNonEmptyPosition: input.hasNonEmptyPosition,
          hasNonEmptyRecentExecutions: input.hasNonEmptyRecentExecutions,
          hasMultipleHistoricalExecutionPages: input.hasMultipleHistoricalExecutionPages,
          hasMultipleHistoricalCashflowPages: input.hasMultipleHistoricalCashflowPages,
          hasCrossViewExecutionOverlap: input.hasCrossViewExecutionOverlap,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
