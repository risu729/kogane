import {
  sonyBankGrossBalance,
  sonyBankHistoryCsv,
  sonyBankHistoryJson,
  sonyBankWalletHistory,
} from "../../../poc/observation-pipeline/src/parsers/sony-bank";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types";
import { validateSonyRun } from "./sony";

type AuditEnv = Pick<Env, "SONY_SNAPSHOTS">;

const PREFIX = "raw/sony-bank/";
const PARSERS = [
  sonyBankGrossBalance,
  sonyBankHistoryJson,
  sonyBankHistoryCsv,
  sonyBankWalletHistory,
] as const;

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "sony-bank-r2-layer-b-audit" });
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
      const listed = await env.SONY_SNAPSHOTS.list({
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
        const audit = await auditManifest(env.SONY_SNAPSHOTS, object.key);
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
  // This is the same strict manifest/artifact/inventory validation used by the
  // importer. It performs reads only and returns no source identifiers or data.
  const validated = await validateSonyRun(bucket, manifestKey);
  const manifest = validated.manifest;
  let expectedParserArtifactCount = 0;
  let matchedArtifactCount = 0;
  let parsedArtifactCount = 0;
  let warningCount = 0;
  let hasEightDigitWalletOption = false;
  let hasDefaultWalletSelection = false;
  let hasAmbiguousWalletDirection = false;
  const jsonIds = new Set<string>();
  const csvIds = new Set<string>();

  for (const artifact of manifest.artifacts) {
    const object = await bucket.get(artifact.key);
    if (!object || object.size !== artifact.bytes) throw new Error("artifact_size_invalid");
    if (object.httpMetadata?.contentType !== artifact.mediaType) {
      throw new Error("artifact_content_type_invalid");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(bytes)) !== artifact.sha256) throw new Error("artifact_hash_invalid");
    if (manifest.status !== "success" || artifact.dataset === "collection-summary") continue;
    expectedParserArtifactCount += 1;
    const meta: ArtifactMeta = {
      id: 0,
      sourceId: "sony-bank",
      runStatus: "success",
      runFailureCount: 0,
      runWindow: manifest.window,
      dataset: artifact.dataset,
      url: null,
      mime: artifact.mediaType,
      fetchedAt: manifest.completedAt,
      sha256: artifact.sha256,
    };
    const matches = PARSERS.filter((parser) => parser.accepts(meta));
    if (matches.length !== 1) throw new Error("parser_route_invalid");
    matchedArtifactCount += 1;
    const result = matches[0]!.parse(bytes, meta);
    parsedArtifactCount += 1;
    warningCount += result.warnings.length;
    const target = artifact.dataset.endsWith("-csv")
      ? csvIds
      : artifact.dataset.includes("-page-")
        ? jsonIds
        : null;
    if (target) {
      for (const observation of result.observations) {
        if (observation.kind === "transaction" && observation.externalId) {
          target.add(observation.externalId);
        }
      }
    }
    if (artifact.dataset.startsWith("wallet-history-")) {
      const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      hasEightDigitWalletOption ||= /<option\b[^>]*\bvalue\s*=\s*["']\d{8}["']/iu.test(html);
      hasDefaultWalletSelection ||= !/<option\b[^>]*\bselected(?:\s*=|\s|>)/iu.test(html);
      hasAmbiguousWalletDirection ||= result.warnings.some((warning) =>
        warning.includes("signed amount omitted"),
      );
    }
  }

  return {
    manifestStatus: manifest.status,
    artifactCount: manifest.artifacts.length,
    expectedParserArtifactCount,
    matchedArtifactCount,
    parsedArtifactCount,
    warningCount,
    hasJsonCsvOverlap: [...jsonIds].some((id) => csvIds.has(id)),
    hasEightDigitWalletOption,
    hasDefaultWalletSelection,
    hasAmbiguousWalletDirection,
  };
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
  expectedParserArtifactCount?: number;
  matchedArtifactCount?: number;
  parsedArtifactCount?: number;
  warningCount?: number;
  hasJsonCsvOverlap?: boolean;
  hasEightDigitWalletOption?: boolean;
  hasDefaultWalletSelection?: boolean;
  hasAmbiguousWalletDirection?: boolean;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "sony-bank-r2-layer-b-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    auditedManifestCount: input.audited ?? 0,
    skippedObjectCount: input.skipped ?? 0,
    failedManifestCount: input.failed ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.manifestStatus ? { manifestStatus: input.manifestStatus } : {}),
    ...(input.artifactCount === undefined ? {} : { artifactCount: input.artifactCount }),
    ...(input.expectedParserArtifactCount === undefined
      ? {}
      : { expectedParserArtifactCount: input.expectedParserArtifactCount }),
    ...(input.matchedArtifactCount === undefined
      ? {}
      : { matchedArtifactCount: input.matchedArtifactCount }),
    ...(input.parsedArtifactCount === undefined
      ? {}
      : { parsedArtifactCount: input.parsedArtifactCount }),
    ...(input.warningCount === undefined ? {} : { warningCount: input.warningCount }),
    ...(input.hasJsonCsvOverlap === undefined
      ? {}
      : {
          hasJsonCsvOverlap: input.hasJsonCsvOverlap,
          hasEightDigitWalletOption: input.hasEightDigitWalletOption,
          hasDefaultWalletSelection: input.hasDefaultWalletSelection,
          hasAmbiguousWalletDirection: input.hasAmbiguousWalletDirection,
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
