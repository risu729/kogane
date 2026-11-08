// The `instrument_auto_adoption` lane (ADR 0055, amendment 2026-11-08): rule
// `instrument-auto-v1` adopts SBI Securities' bare domestic code onto SBI's
// own Japanese listing of the same code, as a recorded rule decision.
//
// Per tick:
//
// 1. A gate (`INSTRUMENT_AUTO_ADOPTION_SQL.gate`) counts the identifier pairs
//    of the rule's shape that do not share an instrument yet, from the
//    identifier catalogue and the current mappings only: index seeks, no
//    observation is read. Zero pairs ends the tick.
// 2. Otherwise the full candidate read (`queryInstrumentAutoAdoptions`), which
//    walks every current identity observation once, decides which pairs the
//    rule adopts. It runs at most once per `EVALUATION_INTERVAL_MS`, judged by
//    this lane's own tick records, and never past the identity-observation
//    bound the candidate page enforces: a pair the gate keeps finding but the
//    rule declines (an unconfirmed currency, say) costs one walk an hour, not
//    one a tick.
// 3. Each adoption is an `assign` identity command with method `rule` under
//    the rule's actor, guarded on the subject's mapping revision it was
//    computed on, at most `ADOPTIONS_PER_TICK` a tick. The lane audit record
//    (`lane-audit.ts`) names the decisions it wrote.
import {
  INSTRUMENT_AUTO_ADOPTION_ACTOR,
  INSTRUMENT_AUTO_ADOPTION_POLICY,
  INSTRUMENT_AUTO_ADOPTION_SOURCE,
  JAPANESE_LISTING_MICS,
} from "../../../packages/domain/src/instrument-auto-adoption.ts";
import { CURRENT_IDENTITY_OBSERVATION_BOUND } from "../../../packages/application/src/query/instrument-candidates-review.ts";
import {
  queryInstrumentAutoAdoptions,
  type PlannedInstrumentAutoAdoption,
} from "../../../packages/application/src/query/instrument-resolution.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readIdentityObservationCount } from "../../../packages/read-model/src/instrument-resolution.ts";
import { executeIdentityCommand } from "../../../packages/storage-d1/src/core/identity-commands.ts";
import { IDENTITY_POLICY_VERSION } from "../../../packages/storage-d1/src/core/identity-store.ts";

export const INSTRUMENT_AUTO_ADOPTION_LANE = "instrument_auto_adoption";

/** The full candidate read runs at most this often while the gate finds pairs. */
export const EVALUATION_INTERVAL_MS = 3_600_000;

/** Adoptions one tick writes; more wait for a later tick. */
export const ADOPTIONS_PER_TICK = 50;

const MICS = JAPANESE_LISTING_MICS.map((mic) => `'${mic}'`).join(",");

export const INSTRUMENT_AUTO_ADOPTION_SQL = {
  /**
   * Pairs of the rule's shape not on one instrument yet, both mapped by rule:
   * the bare code is read by the `(namespace, scope, value)` key range, its
   * listings by the same key, each current mapping by `(identifier_id,
   * revision)`. A pair the rule then declines stays counted here.
   */
  gate: `SELECT count(*) AS n FROM instrument_identifiers s
 JOIN current_instrument_mappings ms ON ms.identifier_id=s.id AND ms.method='rule'
 JOIN instrument_identifiers a ON a.namespace='mic-symbol' AND a.scope IN (${MICS}) AND a.value=s.value
 JOIN current_instrument_mappings ma ON ma.identifier_id=a.id AND ma.method='rule'
 WHERE s.namespace='sbi-security-code' AND s.scope='JP' AND ma.instrument_id<>ms.instrument_id`,
  /** The command's guard: the anchor's current mapping is the rule revision the read saw. */
  anchorUnchanged: `EXISTS(SELECT 1 FROM current_instrument_mappings anchor
 WHERE anchor.identifier_id=? AND anchor.revision=? AND anchor.instrument_id=? AND anchor.method='rule')`,
  /** Whether this lane ran the full read after `?2`: its own ticks, by the `(lane, id)` index. */
  evaluatedSince: `SELECT 1 AS evaluated FROM processor_lane_ticks
 WHERE lane=?1 AND outcome='ran' AND started_at_ms>?2 AND json_extract(counts_json,'$.evaluated')=1
 LIMIT 1`,
} as const;

export interface InstrumentAutoAdoptionResult {
  /** Pairs the gate found. */
  pairs: number;
  /** Whether the full candidate read ran this tick. */
  evaluated: boolean;
  /** Adoptions the rule found. */
  eligible: number;
  /** Adoptions written this tick. */
  adopted: number;
  /** Adoptions not written because the subject's mapping moved (another tick, a person). */
  conflicts: number;
  /** Adoptions refused for another reason (the target vanished, an invalid command). */
  refused: number;
}

interface LaneOptions {
  now?: number;
}

function reason(adoption: PlannedInstrumentAutoAdoption): string {
  return (
    `${INSTRUMENT_AUTO_ADOPTION_POLICY}: ${INSTRUMENT_AUTO_ADOPTION_SOURCE} states Japanese ` +
    `securities code ${adoption.securityCode} as listing ${adoption.mic}/${adoption.securityCode} ` +
    `(identifier ${adoption.anchorIdentifierId}) and as a bare code; one code is one issue on ` +
    `every Japanese venue. Kind, country and currency (JPY) agree; no ISIN, RIC, market, share ` +
    `class or product class conflicts; nobody decided either identifier.`
  );
}

export async function instrumentAutoAdoptionLane(
  db: D1Database,
  options: LaneOptions = {},
): Promise<InstrumentAutoAdoptionResult> {
  const result: InstrumentAutoAdoptionResult = {
    pairs: 0,
    evaluated: false,
    eligible: 0,
    adopted: 0,
    conflicts: 0,
    refused: 0,
  };
  const gate = await db.prepare(INSTRUMENT_AUTO_ADOPTION_SQL.gate).first<{ n: number }>();
  result.pairs = gate?.n ?? 0;
  if (result.pairs === 0) return result;

  const now = options.now ?? Date.now();
  const recent = await db
    .prepare(INSTRUMENT_AUTO_ADOPTION_SQL.evaluatedSince)
    .bind(INSTRUMENT_AUTO_ADOPTION_LANE, now - EVALUATION_INTERVAL_MS)
    .first();
  if (recent) return result;

  const sql = d1Executor(db);
  // The candidate page's bound, before the walk: past it the lane fails with
  // a code rather than walking a store nobody measured.
  if ((await readIdentityObservationCount(sql)) > CURRENT_IDENTITY_OBSERVATION_BOUND)
    throw new IdentityObservationBoundExceeded();
  const adoptions = await queryInstrumentAutoAdoptions(sql);
  result.evaluated = true;
  result.eligible = adoptions.length;

  for (const adoption of adoptions.slice(0, ADOPTIONS_PER_TICK)) {
    const outcome = await executeIdentityCommand(
      db,
      {
        // One operation per subject revision: a resend of the same adoption
        // replays, and an adoption of a later revision is a new operation.
        operationId: `${INSTRUMENT_AUTO_ADOPTION_POLICY}:${adoption.subjectIdentifierId}:r${String(adoption.subjectMappingRevision)}`,
        actorId: INSTRUMENT_AUTO_ADOPTION_ACTOR,
        actorVerification: "server",
        action: "assign",
        kind: "instrument",
        referenceId: adoption.subjectIdentifierId,
        expectedRevision: adoption.subjectMappingRevision,
        targetId: adoption.targetInstrumentId,
        reason: reason(adoption),
      },
      IDENTITY_POLICY_VERSION,
      {
        method: "rule",
        evidenceRefs: [
          `identifier:${adoption.anchorIdentifierId}`,
          `identifier:${adoption.subjectIdentifierId}`,
        ],
        // The anchor must still be where the read saw it: a person who
        // re-mapped it in between has decided, and nothing is written.
        guard: {
          sql: INSTRUMENT_AUTO_ADOPTION_SQL.anchorUnchanged,
          binds: [
            adoption.anchorIdentifierId,
            adoption.anchorMappingRevision,
            adoption.targetInstrumentId,
          ],
        },
      },
    );
    if (outcome.ok) {
      if (!outcome.replayed) result.adopted += 1;
    } else if (outcome.error === "revision_conflict" || outcome.error === "idempotency_conflict")
      result.conflicts += 1;
    else result.refused += 1;
  }
  return result;
}

/**
 * More current identity observations than the candidate read may walk. The
 * scheduler records the class name as the lane's failure code.
 */
export class IdentityObservationBoundExceeded extends Error {}
