import { canonicalDigest } from "../../../domain/src/context.ts";
import { TRANSACTION_FAMILY_REGISTRY_VERSION } from "../../../domain/src/event-families.ts";
import {
  ECONOMIC_ROW_READINESS_SCHEMA,
  ECONOMIC_ROW_READINESS_VERSION,
  evaluateEconomicRowReadiness,
  validEconomicRowReadinessRequest,
  type EconomicRowEvaluation,
  type EconomicRowRef,
} from "../../../domain/src/economic-row-readiness.ts";
import { loadEconomicRowReadiness } from "../../../read-model/src/economic-row-readiness.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

export interface SafeEconomicRowReadiness extends EconomicRowEvaluation {
  ref: EconomicRowRef;
  pinsDigest: string;
  keyDigest: string | null;
  aliasDigest: string | null;
}
/** Internal only. A future service MUST authorize row scope BEFORE calling. */
export async function queryEconomicRowReadiness(sql: SqlExecutor, input: unknown) {
  if (!validEconomicRowReadinessRequest(input))
    return { status: "refused", reason: "invalid_request" } as const;
  const rows = [...input.rows].sort(
    (a, b) => a.observationId - b.observationId || a.parseRunId - b.parseRunId,
  );
  let loaded;
  try {
    loaded = await loadEconomicRowReadiness(sql, rows, input.family);
  } catch {
    return { status: "unavailable", reason: "readiness_store_unavailable" } as const;
  }
  if (
    loaded.length !== rows.length ||
    loaded.some(
      (row, i) =>
        row.observation_id !== rows[i]!.observationId || row.parse_run_id !== rows[i]!.parseRunId,
    )
  )
    return { status: "unavailable", reason: "readiness_store_unavailable" } as const;
  const results: SafeEconomicRowReadiness[] = [];
  for (const row of loaded) {
    const pins: unknown = JSON.parse(row.pins) as unknown;
    if (
      pins === null ||
      typeof pins !== "object" ||
      !("guardObjects" in pins) ||
      pins.guardObjects !== 6 ||
      !("core" in pins) ||
      pins.core === null ||
      !("identityEpoch" in pins) ||
      pins.identityEpoch === null
    )
      return { status: "unavailable", reason: "readiness_store_unavailable" } as const;
    results.push({
      ref: { observationId: row.observation_id, parseRunId: row.parse_run_id },
      ...evaluateEconomicRowReadiness(input.family, row),
      pinsDigest: await canonicalDigest({
        pins,
        keyHolders: row.key_holders,
        aliasHolders: row.alias_holders,
      }),
      keyDigest: row.key_text === null ? null : await canonicalDigest(row.key_text),
      aliasDigest: row.alias_text === null ? null : await canonicalDigest(row.alias_text),
    });
  }
  const manifest = {
    schema: ECONOMIC_ROW_READINESS_SCHEMA,
    evaluator: ECONOMIC_ROW_READINESS_VERSION,
    registry: TRANSACTION_FAMILY_REGISTRY_VERSION,
    family: input.family,
    knowledge: "current" as const,
    rows: results,
  };
  return {
    status: "ok",
    contextId: await canonicalDigest(manifest),
    manifest,
    counts: {
      admitted: results.filter((r) => r.readiness === "admitted").length,
      blocked: results.filter((r) => r.readiness === "blocked").length,
      unavailable: results.filter((r) => r.readiness === "unavailable").length,
    },
    proposalEnabled: false,
    writerEnabled: false,
    historyCoverage: "unknown",
    generationGates:
      input.family === "securities-execution"
        ? [
            "security_book_unsupported",
            "security_selector_unsupported",
            "security_event_vocabulary_missing",
            "security_class_unknown",
            "wrapper_unknown",
          ]
        : ["ownership_principal_contract_missing", "writer_not_registered"],
  } as const;
}
