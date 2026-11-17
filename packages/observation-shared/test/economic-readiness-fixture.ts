import type { ReadinessFamily } from "../../domain/src/economic-row-readiness.ts";
import { TRANSACTION_FAMILY_REGISTRY_VERSION } from "../../domain/src/event-families.ts";
import {
  BANK_GENERATION_GATES,
  SECURITY_GENERATION_GATES,
  type EconomicReadinessResult,
} from "../src/economic-readiness-contract.ts";

export function economicReadinessFixture(
  observationId = 1,
  parseRunId = 7,
  family: ReadinessFamily = "bank-movement",
): EconomicReadinessResult {
  return {
    status: "ok",
    contextId: "a".repeat(64),
    manifest: {
      schema: "economic-row-readiness-v1",
      evaluator: "economic-row-readiness-evaluator-v1",
      registry: TRANSACTION_FAMILY_REGISTRY_VERSION,
      family,
      knowledge: "current",
      rows: [
        {
          ref: { observationId, parseRunId },
          readiness: "blocked",
          identity: "admitted",
          reasons: ["ownership_unresolved"],
          pinsDigest: "b".repeat(64),
          keyDigest: "c".repeat(64),
          aliasDigest: null,
        },
      ],
    },
    counts: { admitted: 0, blocked: 1, unavailable: 0 },
    writerEnabled: false,
    proposalEnabled: false,
    historyCoverage: "unknown",
    generationGates: family === "bank-movement" ? BANK_GENERATION_GATES : SECURITY_GENERATION_GATES,
  };
}
