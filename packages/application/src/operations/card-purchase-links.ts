// Reading recognised card purchases back for a merge or a split, and building
// those drafts from one resolved pending-to-posted candidate. Shared by the
// reviewed path (the change lifecycle's plan and commit,
// pending-posted-review.ts) and the rule's provider-linked path
// (services/processor/src/card-purchase-job.ts), so both merge and split the
// same way. Nothing here writes; the guarded batches are
// packages/storage-d1/src/atomic/card-purchase-recognition.ts.
import {
  cardPurchaseMerge,
  cardPurchaseSplit,
  validCardPurchaseFacts,
  type CardPurchaseAction,
  type CardPurchaseKey,
  type CardPurchaseLive,
  type CardPurchaseMergeDraft,
  type CardPurchaseSidecar,
  type CardPurchaseSourceId,
  type CardPurchaseSplitDraft,
} from "../../../domain/src/card-purchase.ts";
import type { EconomicEventRevision, EconomicLeg } from "../../../domain/src/events.ts";
import type { PendingPostedTarget } from "../../../domain/src/pending-posted-review.ts";
import { exactQuantity, normalizeDecimal } from "../../../domain/src/values.ts";
import type { CandidateReader } from "../query/card-purchase-candidates.ts";

/** A live recognised revision, with what a writer compares against. */
export interface LiveCardPurchase extends CardPurchaseLive {
  action: CardPurchaseAction;
  contentDigest: string;
  /** Per key: whether the parse run it pins is still published. */
  published: ReadonlyMap<string, boolean>;
}

interface LiveRow {
  event_id: string;
  revision: number;
  action: string;
  content_digest: string;
  account_id: string;
  source_id: string;
  statement_period: string | null;
  facts_json: string;
  kind: string;
  state: string;
  unknown_reason: string | null;
  effective_time_json: string;
  basis: string;
  evidence_support_json: string;
  decision_revision_id: string;
}
interface LegRow {
  event_id: string;
  revision: number;
  leg_index: number;
  subject_ref: string;
  unit_ref: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  role: string;
  basis: string;
}
interface KeyRow {
  event_id: string;
  recognition_key: string;
  role: string;
  observation_id: number;
  parse_run_id: number;
  published: number;
}

// The live revision of each wanted event, by the primary key; the current_*
// views would be materialized whole.
const LIVE = `FROM json_each(?1) wanted
JOIN economic_event_revisions r ON r.event_id=wanted.value AND r.superseded_by IS NULL`;
const LIVE_SQL = `SELECT c.event_id,c.revision,c.action,c.content_digest,c.account_id,c.source_id,
 c.statement_period,c.facts_json,r.kind,r.state,r.unknown_reason,r.effective_time_json,r.basis,
 r.evidence_support_json,r.decision_revision_id
${LIVE}
JOIN card_purchase_recognitions c ON c.event_id=r.event_id AND c.revision=r.revision`;
const LEGS_SQL = `SELECT l.event_id,l.revision,l.leg_index,l.subject_ref,l.unit_ref,l.value_status,
 l.coefficient,l.scale,l.role,l.basis
${LIVE}
JOIN economic_legs l ON l.event_id=r.event_id AND l.revision=r.revision
ORDER BY l.event_id,l.leg_index`;
const KEYS_SQL = `SELECT k.event_id,k.recognition_key,k.role,k.observation_id,k.parse_run_id,
 EXISTS(SELECT 1 FROM published_parse_runs p WHERE p.parse_run_id=k.parse_run_id) AS published
${LIVE}
JOIN card_purchase_recognition_keys k ON k.event_id=r.event_id AND k.revision=r.revision
ORDER BY k.event_id,k.role DESC,k.recognition_key`;

/** The stored rows read back into the domain shape, or null when any part is malformed. */
function liveOf(row: LiveRow, legRows: readonly LegRow[], keyRows: readonly KeyRow[]) {
  try {
    const legs: EconomicLeg[] = [];
    for (const leg of legRows) {
      if (leg.value_status !== "exact" || leg.coefficient === null || leg.scale === null)
        return null;
      legs.push({
        eventId: leg.event_id,
        revision: leg.revision,
        legIndex: leg.leg_index,
        subjectRef: leg.subject_ref,
        quantity: exactQuantity(
          leg.unit_ref,
          normalizeDecimal(BigInt(leg.coefficient), leg.scale),
          "decimal-v1",
        ),
        role: leg.role as EconomicLeg["role"],
        basis: leg.basis as EconomicLeg["basis"],
      });
    }
    const keys = keyRows.map((key): CardPurchaseKey => ({
      key: key.recognition_key,
      role: key.role as CardPurchaseKey["role"],
      observationId: key.observation_id,
      parseRunId: key.parse_run_id,
    }));
    const facts: unknown = JSON.parse(row.facts_json);
    if (
      keys.length === 0 ||
      (row.source_id !== "vpass" && row.source_id !== "myjcb") ||
      !validCardPurchaseFacts(facts)
    )
      return null;
    const revision: EconomicEventRevision = {
      eventId: row.event_id,
      revision: row.revision,
      kind: row.kind as EconomicEventRevision["kind"],
      state: row.state as EconomicEventRevision["state"],
      unknownReason: row.unknown_reason as EconomicEventRevision["unknownReason"],
      effectiveTime: JSON.parse(row.effective_time_json) as EconomicEventRevision["effectiveTime"],
      basis: row.basis as EconomicEventRevision["basis"],
      evidenceSupport: JSON.parse(
        row.evidence_support_json,
      ) as EconomicEventRevision["evidenceSupport"],
      decisionRevisionRef: row.decision_revision_id,
      supersededBy: null,
      legs,
    };
    const live: LiveCardPurchase = {
      revision,
      keys,
      sidecar: {
        accountId: row.account_id,
        sourceId: row.source_id as CardPurchaseSourceId,
        statementPeriod: row.statement_period,
        facts,
      },
      action: row.action as CardPurchaseAction,
      contentDigest: row.content_digest,
      published: new Map(keyRows.map((key) => [key.recognition_key, key.published === 1])),
    };
    return live;
  } catch {
    // Unreadable JSON is a holder a writer cannot plan against, never an absent one.
    return null;
  }
}

/** The live revision, legs and keys of each event, in three bounded reads. */
export async function loadLiveCardPurchases(
  reader: CandidateReader,
  eventIds: readonly string[],
): Promise<Map<string, LiveCardPurchase>> {
  const live = new Map<string, LiveCardPurchase>();
  if (eventIds.length === 0) return live;
  const ids = JSON.stringify([...new Set(eventIds)]);
  const [rows, legs, keys] = await Promise.all([
    reader.all<LiveRow>(LIVE_SQL, [ids]),
    reader.all<LegRow>(LEGS_SQL, [ids]),
    reader.all<KeyRow>(KEYS_SQL, [ids]),
  ]);
  for (const row of rows) {
    const parsed = liveOf(
      row,
      legs.filter((leg) => leg.event_id === row.event_id),
      keys.filter((key) => key.event_id === row.event_id),
    );
    if (parsed) live.set(row.event_id, parsed);
  }
  return live;
}

interface SidecarRow {
  account_id: string;
  source_id: string;
  statement_period: string | null;
  facts_json: string;
}

/**
 * The merged event's last pending-only sidecar before `revision`: the row it
 * displayed as a pending authorisation, which a split retires it back to.
 */
async function loadPendingSidecar(
  reader: CandidateReader,
  eventId: string,
  revision: number,
): Promise<CardPurchaseSidecar | null> {
  const [row] = await reader.all<SidecarRow>(
    `SELECT c.account_id,c.source_id,c.statement_period,c.facts_json FROM card_purchase_recognitions c
 WHERE c.event_id=?1 AND c.revision<?2 AND json_extract(c.facts_json,'$.providerStatus')='unconfirmed'
 ORDER BY c.revision DESC LIMIT 1`,
    [eventId, revision],
  );
  if (!row || (row.source_id !== "vpass" && row.source_id !== "myjcb")) return null;
  try {
    const facts: unknown = JSON.parse(row.facts_json);
    return validCardPurchaseFacts(facts)
      ? {
          accountId: row.account_id,
          sourceId: row.source_id,
          statementPeriod: row.statement_period,
          facts,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * The posted event a merge absorbed: the latest revision of another event
 * that held the posted key and was superseded by one of the survivor's
 * revisions, with nothing after it.
 */
async function loadAbsorbedRevision(
  reader: CandidateReader,
  survivorId: string,
  postedKey: string,
): Promise<{ eventId: string; revision: number } | null> {
  const [row] = await reader.all<{ event_id: string; revision: number }>(
    `SELECT r.event_id,r.revision FROM card_purchase_recognition_keys k
 JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
 WHERE k.recognition_key=?1 AND k.event_id<>?2
  AND substr(r.superseded_by,1,length(?2)+1)=?2||'@'
  AND NOT EXISTS(SELECT 1 FROM economic_event_revisions later
   WHERE later.event_id=r.event_id AND later.revision>r.revision)
 ORDER BY r.created_at DESC,r.revision DESC LIMIT 1`,
    [postedKey, survivorId],
  );
  return row ? { eventId: row.event_id, revision: row.revision } : null;
}

/**
 * The merge a candidate asks for: the pending row's live event survives, the
 * posted row's live event is absorbed. Null when either is missing, not what
 * the candidate resolved, or the two cannot be one purchase.
 */
export async function candidateMerge(
  reader: CandidateReader,
  pending: PendingPostedTarget,
  posted: PendingPostedTarget,
  operationId: string | null,
): Promise<CardPurchaseMergeDraft | null> {
  if (pending.holder === null || posted.holder === null) return null;
  const live = await loadLiveCardPurchases(reader, [pending.holder.eventId, posted.holder.eventId]);
  const survivor = live.get(pending.holder.eventId);
  const absorbed = live.get(posted.holder.eventId);
  if (
    !survivor ||
    !absorbed ||
    survivor.revision.revision !== pending.holder.revision ||
    absorbed.revision.revision !== posted.holder.revision
  )
    return null;
  return cardPurchaseMerge({ survivor, absorbed, operationId });
}

/**
 * The split a withdrawn candidate asks for: the merged event holding both
 * rows' keys is retired to its pending row, and the posted event it absorbed
 * is restored. Null when the link is not merged as the candidate says.
 */
export async function candidateSplit(
  reader: CandidateReader,
  pending: PendingPostedTarget,
  posted: PendingPostedTarget,
  operationId: string | null,
): Promise<CardPurchaseSplitDraft | null> {
  const holder = pending.holder;
  if (
    holder === null ||
    posted.holder?.eventId !== holder.eventId ||
    posted.recognitionKey === null
  )
    return null;
  const merged = (await loadLiveCardPurchases(reader, [holder.eventId])).get(holder.eventId);
  if (!merged || merged.revision.revision !== holder.revision) return null;
  const [pendingSidecar, absorbed] = await Promise.all([
    loadPendingSidecar(reader, holder.eventId, holder.revision),
    loadAbsorbedRevision(reader, holder.eventId, posted.recognitionKey),
  ]);
  if (pendingSidecar === null || absorbed === null) return null;
  return cardPurchaseSplit({ merged, pendingSidecar, absorbed, operationId });
}
