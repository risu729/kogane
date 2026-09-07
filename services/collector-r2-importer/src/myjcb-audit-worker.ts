import {
  myJcbCreditLedger,
  myJcbEvidenceOnly,
  myJcbPastMonthBalances,
} from "../../../poc/observation-pipeline/src/parsers/myjcb";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types";
import {
  normalizeMyJcbArtifactPayload,
  parseMyJcbManifest,
  type MyJcbArtifactManifest,
} from "./myjcb-schema";

interface AuditEnv {
  MYJCB_SNAPSHOTS: R2Bucket;
}

const PREFIX = "raw/myjcb/";
const PARSERS = [myJcbCreditLedger, myJcbPastMonthBalances, myJcbEvidenceOnly] as const;

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return json({ ok: true, service: "myjcb-r2-layer-b-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return json({ error: "not_found" }, 404);
    }
    try {
      const input = (await request.json()) as unknown;
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "cursor")) {
        return json({ error: "cursor_invalid" }, 400);
      }
      const cursor = input.cursor;
      if (cursor !== undefined && !safeCursor(cursor)) {
        return json({ error: "cursor_invalid" }, 400);
      }
      const listed = await env.MYJCB_SNAPSHOTS.list({
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
        return auditResponse({
          scanned: 1,
          audited: 1,
          nextCursor: nextCursor ?? null,
          ...(await auditManifest(env.MYJCB_SNAPSHOTS, object.key)),
        });
      } catch (error) {
        const failureCode =
          error instanceof Error && /^[a-z0-9_]{1,100}$/u.test(error.message)
            ? error.message
            : "contract_validation_failed";
        return auditResponse({
          scanned: 1,
          failed: 1,
          failureCode,
          nextCursor: nextCursor ?? null,
        });
      }
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : "request_failed";
      return json({ error: code }, 502);
    }
  },
};

async function auditManifest(bucket: R2Bucket, manifestKey: string) {
  const object = await bucket.get(manifestKey);
  if (!object) throw new Error("manifest_missing");
  assertContentType(object, "application/json");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const manifest = parseMyJcbManifest(bytes, manifestKey);
  assertMetadata(object, { source: "myjcb", status: manifest.status, runId: manifest.runId });
  await assertExactPrefix(bucket, manifestKey, [
    manifestKey,
    ...manifest.artifacts.map((artifact) => artifact.key),
  ]);

  let matchedArtifactCount = 0;
  let parsedArtifactCount = 0;
  let transactionObservationCount = 0;
  let metricObservationCount = 0;
  let hasNonEmptyLedger = false;
  let hasDisplayedPastMonth = false;
  for (const artifact of manifest.artifacts) {
    const sourceObject = await bucket.get(artifact.key);
    if (!sourceObject || sourceObject.size !== artifact.bytes) {
      throw new Error("artifact_size_invalid");
    }
    assertContentType(sourceObject, artifact.mediaType);
    assertMetadata(sourceObject, {
      source: "myjcb",
      dataset: artifact.dataset,
      sha256: artifact.sha256,
      ...(artifact.statementState ? { statementState: artifact.statementState } : {}),
      ...(artifact.period ? { period: artifact.period } : {}),
    });
    const sourceBytes = new Uint8Array(await sourceObject.arrayBuffer());
    if ((await sha256Hex(sourceBytes)) !== artifact.sha256) {
      throw new Error("artifact_checksum_invalid");
    }
    if (manifest.status !== "success") continue;
    const connection = manifest.connections.find(
      (candidate) => candidate.connectionId === artifact.connectionId,
    );
    if (!connection) throw new Error("artifact_connection_missing");
    let normalized: Uint8Array;
    try {
      normalized = normalizeMyJcbArtifactPayload(artifact, sourceBytes, connection);
    } catch (error) {
      const detail =
        error instanceof Error && /^[a-z0-9_]{1,80}$/u.test(error.message)
          ? error.message
          : "invalid";
      throw new Error(`source_${safeDataset(artifact.dataset)}_${detail}`, { cause: error });
    }
    const meta = artifactMeta(manifest.completedAt, artifact);
    const matches = PARSERS.filter((parser) => parser.accepts(meta));
    if (matches.length !== 1) throw new Error("parser_route_invalid");
    matchedArtifactCount += 1;
    const result = (() => {
      try {
        return matches[0]!.parse(normalized, meta);
      } catch (error) {
        throw new Error(`layer_b_${safeDataset(artifact.dataset)}_${parserFailureClass(error)}`, {
          cause: error,
        });
      }
    })();
    parsedArtifactCount += 1;
    for (const observation of result.observations) {
      if (observation.kind === "transaction") transactionObservationCount += 1;
      else metricObservationCount += 1;
    }
    if (artifact.dataset === "credit-ledger" && result.observations.length > 0) {
      hasNonEmptyLedger = true;
    }
    if (artifact.dataset === "credit-past-months" && result.observations.length > 0) {
      hasDisplayedPastMonth = true;
    }
  }
  return {
    manifestStatus: manifest.status,
    artifactCount: manifest.artifacts.length,
    matchedArtifactCount,
    parsedArtifactCount,
    transactionObservationCount,
    metricObservationCount,
    hasMultipleConnections: manifest.connections.length > 1,
    hasNonEmptyLedger,
    hasDisplayedPastMonth,
  };
}

function safeDataset(dataset: string): string {
  return dataset.replaceAll("-", "_").replace(/[^a-z0-9_]/gu, "unknown");
}

function parserFailureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/amount|JPY/u.test(message)) return "amount";
  if (/date|YYYY/u.test(message)) return "date";
  if (/metadata|artifact key|identity/u.test(message)) return "identity";
  if (/header/u.test(message)) return "header";
  if (/row|schema drift|object|array/u.test(message)) return "shape";
  if (/HTML|content|sensitive/u.test(message)) return "html";
  return "invalid";
}

function artifactMeta(completedAt: string, artifact: MyJcbArtifactManifest): ArtifactMeta {
  return {
    id: 0,
    sourceId: "myjcb",
    runStatus: "success",
    runFailureCount: 0,
    dataset: artifact.dataset,
    artifactKey: `${artifact.connectionId}/${artifact.filename}`,
    statementState: artifact.statementState ?? null,
    period: artifact.period ?? null,
    url: null,
    mime: artifact.mediaType,
    fetchedAt: completedAt,
    sha256: artifact.sha256,
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

function assertContentType(object: R2ObjectBody, expected: string): void {
  if (object.httpMetadata?.contentType !== expected) throw new Error("content_type_invalid");
}

function assertMetadata(object: R2ObjectBody, expected: Record<string, string>): void {
  const actual = object.customMetadata ?? {};
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("custom_metadata_invalid");
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
  transactionObservationCount?: number;
  metricObservationCount?: number;
  hasMultipleConnections?: boolean;
  hasNonEmptyLedger?: boolean;
  hasDisplayedPastMonth?: boolean;
  nextCursor: string | null;
}): Response {
  return json({
    schemaVersion: "myjcb-r2-layer-b-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.manifestStatus ? { manifestStatus: input.manifestStatus } : {}),
    ...(input.artifactCount === undefined
      ? {}
      : {
          artifactCount: input.artifactCount,
          matchedArtifactCount: input.matchedArtifactCount,
          parsedArtifactCount: input.parsedArtifactCount,
          transactionObservationCount: input.transactionObservationCount,
          metricObservationCount: input.metricObservationCount,
          hasMultipleConnections: input.hasMultipleConnections,
          hasNonEmptyLedger: input.hasNonEmptyLedger,
          hasDisplayedPastMonth: input.hasDisplayedPastMonth,
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
