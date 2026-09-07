import { ImportError } from "./error";
import { auditVPointPayEmailPair } from "./v-point-pay-email";

export default {
  async fetch(request: Request, env: Pick<Env, "VPOINT_PAY_SNAPSHOTS">): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return Response.json({ ok: true, service: "vpoint-pay-email-r2-contract-audit" });
    }
    if (request.method !== "POST" || url.pathname !== "/audit-page" || url.search !== "") {
      return Response.json({ error: "not_found" }, { status: 404 });
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
      const listed = await env.VPOINT_PAY_SNAPSHOTS.list({
        prefix: "raw/v-point-pay-email/",
        limit: 25,
        ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
      });
      if (listed.objects.length > 25) throw new ImportError(409, "prefix_page_too_large");
      const nativeChecksumPresent = listed.objects.filter(
        (object) => object.checksums?.sha256 !== undefined,
      ).length;
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && (!nextCursor || nextCursor === input.cursor)) {
        throw new ImportError(409, "prefix_cursor_invalid");
      }
      const results = await Promise.all(
        listed.objects.map(async (object) => {
          if (object.key.endsWith(".eml")) return { kind: "raw" as const };
          if (!object.key.endsWith(".json")) {
            return { kind: "failed" as const, failureCode: "unexpected_extension" };
          }
          try {
            return {
              kind: "normalized" as const,
              eventType: (await auditVPointPayEmailPair(env.VPOINT_PAY_SNAPSHOTS, object.key))
                .eventType,
            };
          } catch (error) {
            return { kind: "failed" as const, failureCode: safeCode(error) };
          }
        }),
      );
      let raw = 0;
      let normalized = 0;
      let failed = 0;
      let failureCode: string | undefined;
      const eventTypeCounts = { usage: 0, charge: 0, balanceAddition: 0, declined: 0 };
      for (const result of results) {
        if (result.kind === "raw") {
          raw += 1;
          continue;
        }
        if (result.kind === "failed") {
          failed += 1;
          failureCode ??= result.failureCode;
          continue;
        }
        normalized += 1;
        if (result.eventType === "balance-addition") eventTypeCounts.balanceAddition += 1;
        else eventTypeCounts[result.eventType] += 1;
      }
      return auditResponse({
        scanned: listed.objects.length,
        raw,
        normalized,
        failed,
        nativeChecksumPresent,
        nativeChecksumMissing: listed.objects.length - nativeChecksumPresent,
        ...(failureCode ? { failureCode } : {}),
        eventTypeCounts,
        nextCursor: nextCursor ?? null,
      });
    } catch (error) {
      return Response.json(
        { error: safeCode(error) },
        { status: error instanceof ImportError ? error.status : 502 },
      );
    }
  },
};

function auditResponse(input: {
  scanned: number;
  raw?: number;
  normalized?: number;
  failed?: number;
  nativeChecksumPresent?: number;
  nativeChecksumMissing?: number;
  failureCode?: string;
  eventTypeCounts?: {
    usage: number;
    charge: number;
    balanceAddition: number;
    declined: number;
  };
  nextCursor: string | null;
}): Response {
  return Response.json({
    schemaVersion: "vpoint-pay-email-r2-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    rawObjectCount: input.raw ?? 0,
    normalizedObjectCount: input.normalized ?? 0,
    failedObjectCount: input.failed ?? 0,
    nativeChecksumPresentObjectCount: input.nativeChecksumPresent ?? 0,
    nativeChecksumMissingObjectCount: input.nativeChecksumMissing ?? 0,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    eventTypeCounts: input.eventTypeCounts ?? {
      usage: 0,
      charge: 0,
      balanceAddition: 0,
      declined: 0,
    },
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
