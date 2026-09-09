import { sbiShinseiTopBalancesAndActivity } from "../../../packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity";
import { sbiShinseiYenDepositAccount } from "../../../packages/parsers/src/parsers/sbi-shinsei-yen-deposit-account";
import type { ArtifactMeta } from "../../../packages/parsers/src/types";
import { validateSbiShinseiRun } from "./sbi-shinsei";

type AuditEnv = Pick<Env, "SBI_SHINSEI_SNAPSHOTS">;
const PREFIX = "raw/sbi-shinsei/";
const PARSED = new Set(["top-accounts-balance-and-activity", "yen-deposit-account"]);
const PARSERS = [sbiShinseiTopBalancesAndActivity, sbiShinseiYenDepositAccount] as const;

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "sbi-shinsei-r2-layer-b-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return response({ error: "not_found" }, 404);
    }
    let cursor: string | undefined;
    try {
      const input = (await request.json()) as unknown;
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "cursor"))
        return response({ error: "cursor_invalid" }, 400);
      if (input.cursor !== undefined) {
        if (!safeCursor(input.cursor)) return response({ error: "cursor_invalid" }, 400);
        cursor = input.cursor;
      }
      const listed = await env.SBI_SHINSEI_SNAPSHOTS.list({
        prefix: PREFIX,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      if (listed.objects.length > 1) throw new Error("prefix_page_too_large");
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && (!nextCursor || nextCursor === cursor))
        throw new Error(nextCursor ? "prefix_cursor_did_not_advance" : "prefix_cursor_missing");
      const object = listed.objects[0];
      if (!object) return auditResponse({ scanned: 0, nextCursor: null });
      if (!object.key.endsWith("/manifest.json"))
        return auditResponse({
          scanned: 1,
          skipped: 1,
          nextCursor: nextCursor ?? null,
        });
      try {
        const audit = await auditManifest(env.SBI_SHINSEI_SNAPSHOTS, object.key);
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
  const { manifest, artifacts } = await validateSbiShinseiRun({ bucket, manifestKey });
  let matchedArtifactCount = 0;
  let parsedArtifactCount = 0;
  let decisionCoveredArtifactCount = 0;
  let hasNonEmptyTopAccounts = false;
  let hasNonEmptyTopActivity = false;
  let hasNonEmptyYenAccounts = false;
  let hasMultipleCurrencies = false;
  let hasUnclassifiedProduct = false;
  for (const validatedArtifact of artifacts) {
    const { manifest: artifact, value } = validatedArtifact;
    if (manifest.status !== "success") continue;
    const meta: ArtifactMeta = {
      id: 0,
      sourceId: "sbi-shinsei-bank",
      runStatus: "success",
      runFailureCount: 0,
      dataset: artifact.dataset,
      url: null,
      mime: "application/json",
      fetchedAt: manifest.completedAt,
      sha256: artifact.sha256,
    };
    const matches = PARSERS.filter((parser) => parser.accepts(meta));
    const shouldParse = PARSED.has(artifact.dataset);
    if (matches.length !== (shouldParse ? 1 : 0)) throw new Error("parser_route_invalid");
    decisionCoveredArtifactCount += 1;
    if (!shouldParse) continue;
    matchedArtifactCount += 1;
    const safeBytes = sanitizeProviderResponse(value);
    const result = matches[0]!.parse(safeBytes, meta);
    parsedArtifactCount += 1;
    if (artifact.dataset === "top-accounts-balance-and-activity") {
      hasNonEmptyTopAccounts ||= result.observations.some(
        (entry) => entry.kind === "balance" && entry.metric === "account_balance",
      );
      hasNonEmptyTopActivity ||= result.observations.some((entry) => entry.kind === "transaction");
    } else {
      hasNonEmptyYenAccounts ||= result.observations.some((entry) => entry.kind === "balance");
    }
    const currencies = new Set(
      result.observations.flatMap((entry) =>
        entry.kind === "position"
          ? entry.currency
            ? [entry.currency]
            : []
          : entry.kind === "valuation"
            ? [entry.currency]
            : entry.kind === "balance"
              ? [entry.instrument]
              : entry.currency
                ? [entry.currency]
                : [],
      ),
    );
    hasMultipleCurrencies ||= currencies.size > 1;
    hasUnclassifiedProduct ||= result.observations.some((entry) => {
      const kogane = entry.extra["_kogane"];
      return (
        isRecord(kogane) &&
        typeof kogane["productCode"] === "string" &&
        !["601", "603"].includes(kogane["productCode"])
      );
    });
  }
  return {
    manifestStatus: manifest.status,
    artifactCount: manifest.artifacts.length,
    matchedArtifactCount,
    parsedArtifactCount,
    decisionCoveredArtifactCount,
    hasNonEmptyTopAccounts,
    hasNonEmptyTopActivity,
    hasNonEmptyYenAccounts,
    hasMultipleCurrencies,
    hasUnclassifiedProduct,
  };
}

function sanitizeProviderResponse(value: Record<string, unknown>): Uint8Array {
  const clean = { ...value };
  if (isRecord(value["header"])) {
    const header = { ...value["header"] };
    delete header["newToken"];
    clean["header"] = header;
  }
  return new TextEncoder().encode(JSON.stringify(clean));
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
  decisionCoveredArtifactCount?: number;
  hasNonEmptyTopAccounts?: boolean;
  hasNonEmptyTopActivity?: boolean;
  hasNonEmptyYenAccounts?: boolean;
  hasMultipleCurrencies?: boolean;
  hasUnclassifiedProduct?: boolean;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "sbi-shinsei-r2-layer-b-aggregate-audit-v1",
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
          matchedArtifactCount: input.matchedArtifactCount,
          parsedArtifactCount: input.parsedArtifactCount,
          decisionCoveredArtifactCount: input.decisionCoveredArtifactCount,
          hasNonEmptyTopAccounts: input.hasNonEmptyTopAccounts,
          hasNonEmptyTopActivity: input.hasNonEmptyTopActivity,
          hasNonEmptyYenAccounts: input.hasNonEmptyYenAccounts,
          hasMultipleCurrencies: input.hasMultipleCurrencies,
          hasUnclassifiedProduct: input.hasUnclassifiedProduct,
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
