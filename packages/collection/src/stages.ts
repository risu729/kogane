// The stage vocabulary of the unified plan (03 §5 and `contracts/stages.json`).
//
// Each stage records a different guarantee. A terminal proves persistence and
// nothing else: not that the bank returned every transaction, not that the
// parse succeeded, not that a reader ever saw the result. Collapsing them into
// one `last_success_at` is exactly the failure the plan calls out, so this
// module gives the stages names and refuses the "complete" outcome for the
// four reasons that are never completion.

export const COLLECTION_STAGES = [
  "persisted",
  "registered",
  "parsed",
  "adopted",
  "projected",
] as const;
export type CollectionStage = (typeof COLLECTION_STAGES)[number];

export const STAGE_EVIDENCE: Record<CollectionStage, string> = {
  persisted: "terminal written after all required object writes",
  registered: "CORE descriptor/inventory complete and sealed",
  parsed: "fixed-release parse output persisted",
  adopted: "CORE publication/adoption transaction",
  projected: "READ content validated and published",
};

export const JOB_OUTCOMES = ["pending", "completed", "retryable", "blocked"] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];

/**
 * Reasons that must never be reported as `completed`. `queued` and `building`
 * are work in flight; `flag_off` and `no_processor` mean nobody ran the stage
 * at all. Calling any of them complete makes an unprocessed run invisible.
 */
export const NEVER_COMPLETE_ON = ["queued", "building", "flag_off", "no_processor"] as const;
export type NeverCompleteReason = (typeof NEVER_COMPLETE_ON)[number];

export function isNeverCompleteReason(value: string): value is NeverCompleteReason {
  return (NEVER_COMPLETE_ON as readonly string[]).includes(value);
}

export interface StageRecord {
  readonly stage: CollectionStage;
  readonly outcome: JobOutcome;
  /** Machine-readable reason; never provider text, never an amount. */
  readonly reasonCode?: string;
}

export class StageContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StageContractError";
  }
}

/**
 * Build a stage record, refusing `completed` for the four non-completion
 * reasons. The check lives here so every writer of a stage row gets it.
 */
export function stageRecord(
  stage: CollectionStage,
  outcome: JobOutcome,
  reasonCode?: string,
): StageRecord {
  if (outcome === "completed" && reasonCode !== undefined && isNeverCompleteReason(reasonCode)) {
    throw new StageContractError("stage_cannot_complete_on_reason");
  }
  return { stage, outcome, ...(reasonCode === undefined ? {} : { reasonCode }) };
}

/**
 * Registration idempotency key (03 §4). The processing contract version is
 * part of it: when the ingest contract changes meaning, the same run registers
 * again as a new revision instead of silently reusing the old registration.
 */
export interface RegistrationIdentity {
  readonly source: string;
  readonly runId: string;
  readonly terminalDigest: string;
  readonly registrationContractVersion: string;
}

export function registrationIdempotencyKey(identity: RegistrationIdentity): string {
  return [
    identity.source,
    identity.runId,
    identity.terminalDigest,
    identity.registrationContractVersion,
  ].join(" ");
}
