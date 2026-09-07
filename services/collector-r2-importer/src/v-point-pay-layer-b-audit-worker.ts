import { vPointPayNotificationEvent } from "../../../poc/observation-pipeline/src/parsers/v-point-pay";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types";
import { validateVPointPayEmailPairForLayerB } from "./v-point-pay-email";

type AuditEnv = Pick<Env, "VPOINT_PAY_SNAPSHOTS">;

const PREFIX = "raw/v-point-pay-email/";

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
      return response({ ok: true, service: "v-point-pay-r2-layer-b-audit" });
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
      if (cursor !== undefined && !safeCursor(cursor))
        return response({ error: "cursor_invalid" }, 400);
      const listed = await env.VPOINT_PAY_SNAPSHOTS.list({
        prefix: PREFIX,
        limit: 25,
        ...(typeof cursor === "string" ? { cursor } : {}),
      });
      if (listed.objects.length > 25) throw new Error("prefix_page_too_large");
      const nextCursor = listed.truncated ? listed.cursor : undefined;
      if (listed.truncated && (!nextCursor || nextCursor === cursor))
        throw new Error("prefix_cursor_invalid");

      let ignoredRaw = 0;
      let audited = 0;
      let failed = 0;
      let transactions = 0;
      let balances = 0;
      let declined = 0;
      let failureCode: string | undefined;
      for (const object of listed.objects) {
        if (object.key.endsWith(".eml")) {
          ignoredRaw += 1;
          if (matchingParsers(rawMeta()).length !== 0) {
            failed += 1;
            failureCode ??= "raw_parser_route_invalid";
          }
          continue;
        }
        if (!object.key.endsWith(".json")) {
          failed += 1;
          failureCode ??= "unexpected_extension";
          continue;
        }
        let stage: "layer-a" | "route" | "parser" | "semantics" = "layer-a";
        let eventType: string | undefined;
        try {
          const validated = await validateVPointPayEmailPairForLayerB(
            env.VPOINT_PAY_SNAPSHOTS,
            object.key,
          );
          eventType = validated.eventType;
          stage = "route";
          const meta = normalizedMeta(validated.occurredAt);
          const matches = matchingParsers(meta);
          if (matches.length !== 1) throw new Error("normalized_parser_route_invalid");
          stage = "parser";
          const result = matches[0]!.parse(validated.normalizedBytes, meta);
          stage = "semantics";
          const tx = result.observations.filter(
            (observation) => observation.kind === "transaction",
          );
          const balance = result.observations.filter(
            (observation) => observation.kind === "balance",
          );
          if (
            tx.length !== 1 ||
            balance.length > 1 ||
            result.observations.length !== tx.length + balance.length
          ) {
            throw new Error("observation_cardinality_invalid");
          }
          if (validated.eventType === "declined") {
            if (
              tx[0]!.status !== "declined" ||
              tx[0]!.sourceAccount !== "v-point-pay:notification-events" ||
              tx[0]!.amountMinor !== undefined
            ) {
              throw new Error("declined_semantics_invalid");
            }
            declined += 1;
          } else if (
            tx[0]!.status !== "notified" ||
            tx[0]!.sourceAccount !== "v-point-pay:notification-events" ||
            tx[0]!.amountMinor === undefined
          ) {
            throw new Error("notification_semantics_invalid");
          }
          if (
            balance.some((observation) => observation.sourceAccount !== "v-point-pay:prepaid-yen")
          ) {
            throw new Error("balance_account_scope_invalid");
          }
          audited += 1;
          transactions += tx.length;
          balances += balance.length;
        } catch (error) {
          failed += 1;
          failureCode ??= auditFailureCode(stage, error, eventType);
        }
      }
      return auditResponse({
        scanned: listed.objects.length,
        ignoredRaw,
        audited,
        failed,
        transactions,
        balances,
        declined,
        ...(failureCode ? { failureCode } : {}),
        nextCursor: nextCursor ?? null,
      });
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : "request_failed";
      return response({ error: code }, 502);
    }
  },
};

function matchingParsers(meta: ArtifactMeta) {
  return [vPointPayNotificationEvent].filter((parser) => parser.accepts(meta));
}

function auditFailureCode(
  stage: "layer-a" | "route" | "parser" | "semantics",
  error: unknown,
  eventType?: string,
): string {
  if (stage === "layer-a") return "layer_a_contract_failed";
  if (stage === "route") return "parser_route_failed";
  if (stage === "semantics") return "observation_semantics_failed";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("non-declined notification amountYen must not be null")) {
    return "notification_amount_missing";
  }
  if (message.includes("amountYen must be a non-negative")) {
    return eventType === "usage"
      ? "usage_cashflow_domain_failed"
      : eventType === "charge"
        ? "charge_cashflow_domain_failed"
        : eventType === "balance-addition"
          ? "addition_cashflow_domain_failed"
          : "declined_cashflow_domain_failed";
  }
  if (message.includes("usedPoints must be a non-negative"))
    return "supporting_points_domain_failed";
  if (message.includes("balanceYen must be a non-negative"))
    return "prepaid_snapshot_domain_failed";
  if (message.includes("subject contradicts eventType")) return "subject_type_failed";
  if (message.includes("sourceProvenance")) return "provenance_contract_failed";
  return "parser_schema_failed";
}

function normalizedMeta(occurredAt: string): ArtifactMeta {
  return {
    id: 0,
    sourceId: "v-point-pay",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "notification-event",
    artifactKey: "normalized-event.json",
    url: null,
    mime: "application/json",
    fetchedAt: occurredAt,
    sha256: "0".repeat(64),
  };
}

function rawMeta(): ArtifactMeta {
  return {
    ...normalizedMeta("1970-01-01T00:00:00.000Z"),
    dataset: "notification-mail",
    artifactKey: "notification.eml",
    mime: "message/rfc822",
  };
}

function auditResponse(input: {
  scanned: number;
  ignoredRaw: number;
  audited: number;
  failed: number;
  transactions: number;
  balances: number;
  declined: number;
  failureCode?: string;
  nextCursor: string | null;
}): Response {
  return response({
    schemaVersion: "v-point-pay-r2-layer-b-aggregate-audit-v1",
    scannedObjectCount: input.scanned,
    ignoredRawObjectCount: input.ignoredRaw,
    auditedNormalizedObjectCount: input.audited,
    failedNormalizedObjectCount: input.failed,
    transactionObservationCount: input.transactions,
    balanceObservationCount: input.balances,
    declinedObservationCount: input.declined,
    nextCursor: input.nextCursor,
    truncated: input.nextCursor !== null,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
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
