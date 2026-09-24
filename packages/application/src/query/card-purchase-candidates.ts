// Pending-to-posted candidates resolved against card purchase recognition: the
// stage-B `reconciliation_proposals` rows, each target's recognition key
// (re-derived from the cited row exactly as the 0047 key guard derives it), the
// live event holding that key, the decisions recorded on `proposal:<id>` and
// the relation rows of its `pending_to_posted` triple. One reader for the
// operator view (`candidates` of a card purchase) and for the review plan
// (packages/application/src/operations/pending-posted-review.ts), so the two
// can never disagree about what a review may do.
//
// A proposal is matched to a purchase through the recognition key of its
// target rows, not through the observation id the event pins: a re-fetch or a
// published replay shows the same provider row under a new observation, and
// the candidate still belongs to the purchase that row is.
import type { CardPurchaseKeyRole, CardPurchaseKind } from "../../../domain/src/card-purchase.ts";
import type {
  CardPurchaseCandidate,
  CardPurchaseCandidateSide,
} from "../../../domain/src/card-purchase-view.ts";
import {
  validSourceFactRef,
  type EventState,
  type SourceFactRef,
} from "../../../domain/src/events.ts";
import {
  PENDING_POSTED_RELATION_KIND,
  pendingPostedRelation,
  pendingPostedReview,
  type PendingPostedHolder,
  type PendingPostedRelation,
  type PendingPostedTarget,
} from "../../../domain/src/pending-posted-review.ts";
import {
  PROPOSAL_STATUSES,
  RATIONALE_CODES,
  REJECTION_CONDITION_CODES,
  type ProposalStatus,
  type RationaleCode,
  type RejectionConditionCode,
} from "../../../domain/src/reconcile.ts";
import { exactQuantity, normalizeDecimal, type Quantity } from "../../../domain/src/values.ts";

/**
 * Proposals selected per recognition key, newest first. A page lists at most
 * 10 candidates per event, and an event holds a key per row it shows, so each
 * key keeps its own 10: stage B pairs a pending row with every posted row
 * inside its matching window, and one busy week must not crowd the other
 * events of the page out of a shared limit.
 */
const CANDIDATES_PER_KEY = 10;

/** Structural: both `SqlExecutor` (queries) and `CommandStore` (commands) satisfy it. */
export interface CandidateReader {
  all<T>(sql: string, args: readonly unknown[]): Promise<T[]>;
}

interface TargetRow {
  proposal_id: string;
  status: string;
  rationale_codes_json: string;
  rejection_conditions_json: string;
  proposal_revision: number | null;
  position: number;
  ref_kind: string | null;
  ref_id: string | null;
  ref_revision: string | null;
  provider_status: string | null;
  as_of: string | null;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
  unit_ref: string | null;
  recognition_key: string | null;
  holder_event_id: string | null;
  holder_revision: number | null;
  holder_kind: string | null;
  holder_state: string | null;
  holder_account_id: string | null;
  holder_source_id: string | null;
  holder_keys_json: string | null;
}
interface RelationRow {
  from_ref: string;
  to_ref: string;
  revision: number;
  status: string | null;
}

/**
 * `?1` a JSON array of recognition keys (a proposal is selected when one of
 * its targets has one of them, at most `?3` per key) or NULL, `?2` one
 * proposal id or NULL. The target key is the cited row's own
 * `json_array(source, producer, namespace, source account, external id)`;
 * a target that is not a canonical `transaction:<id>` pinned to its own parse
 * run finds no row and so no key.
 *
 * Newest first; proposals written in one tick (a whole group's pairs usually
 * are) are ordered by how much the matcher found in common: a provider link
 * id first, then a date within the window, an equal amount and an equal
 * counterparty, so the likely pair is not hidden behind similar rows.
 */
const CANDIDATE_TARGETS_SQL = `WITH proposals AS MATERIALIZED (
  SELECT p.id,p.status,p.target_refs_json,p.rationale_codes_json,p.rejection_conditions_json,p.created_at,
   4*(instr(p.rationale_codes_json,'"provider_link_id_equal"')>0)
   +(instr(p.rationale_codes_json,'"date_within_window"')>0)
   +(instr(p.rationale_codes_json,'"amount_equal"')>0)
   +(instr(p.rationale_codes_json,'"counterparty_equal"')>0) AS relevance
  FROM reconciliation_proposals p
  WHERE p.kind='pending_to_posted' AND p.stage='B' AND (?2 IS NULL OR p.id=?2)
), targets AS MATERIALIZED (
  SELECT p.id AS proposal_id,CAST(t.key AS INTEGER) AS position,
   json_extract(t.value,'$.kind') AS ref_kind,json_extract(t.value,'$.id') AS ref_id,
   json_extract(t.value,'$.revision') AS ref_revision
  FROM proposals p JOIN json_each(p.target_refs_json) t
), keyed AS MATERIALIZED (
  SELECT targets.*,o.status AS provider_status,o.as_of,o.currency AS unit_ref,
   dv.status AS value_status,dv.coefficient,dv.scale,
   CASE WHEN o.external_id IS NOT NULL THEN
    json_array(a.source_id,fr.producer_id,ses.external_id_namespace,o.source_account,o.external_id) END AS recognition_key
  FROM targets
  LEFT JOIN transaction_observations o ON targets.ref_kind='transaction'
   AND o.id=CAST(substr(targets.ref_id,13) AS INTEGER)
   AND targets.ref_id='transaction:'||o.id AND targets.ref_revision='parse_run:'||o.parse_run_id
  LEFT JOIN parse_runs pr ON pr.id=o.parse_run_id
  LEFT JOIN fetch_artifacts a ON a.id=pr.fetch_artifact_id
  LEFT JOIN fetch_runs fr ON fr.id=a.fetch_run_id
  LEFT JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
  LEFT JOIN observation_decimal_values dv ON dv.kind='transaction' AND dv.observation_id=o.id
   AND dv.policy_version='decimal-v1'
), ranked AS (
  SELECT keyed.proposal_id,row_number() OVER (PARTITION BY keyed.recognition_key
    ORDER BY p.created_at DESC,p.relevance DESC,p.id) AS key_position
  FROM keyed JOIN proposals p ON p.id=keyed.proposal_id
  WHERE keyed.recognition_key IN (SELECT value FROM json_each(?1))
), selected AS (
  SELECT p.id,p.created_at,p.relevance FROM proposals p
  WHERE ?1 IS NULL OR p.id IN (SELECT proposal_id FROM ranked WHERE key_position<=?3)
)
SELECT p.id AS proposal_id,p.status,p.rationale_codes_json,p.rejection_conditions_json,
 (SELECT max(d.revision) FROM decision_revisions d
   WHERE d.subject_kind='relation' AND d.subject_ref='proposal:'||p.id) AS proposal_revision,
 target.position,target.ref_kind,target.ref_id,target.ref_revision,target.provider_status,target.as_of,
 target.value_status,target.coefficient,target.scale,target.unit_ref,target.recognition_key,
 held.event_id AS holder_event_id,held.revision AS holder_revision,r.kind AS holder_kind,
 r.state AS holder_state,c.account_id AS holder_account_id,c.source_id AS holder_source_id,
 (SELECT json_group_array(json_object('key',hk.recognition_key,'role',hk.role))
   FROM card_purchase_recognition_keys hk
   WHERE hk.event_id=held.event_id AND hk.revision=held.revision) AS holder_keys_json
FROM selected s JOIN proposals p ON p.id=s.id
JOIN keyed target ON target.proposal_id=p.id
-- The live holder, by the key index; the current_* views would be materialized whole.
LEFT JOIN card_purchase_recognition_keys held ON held.recognition_key=target.recognition_key
 AND EXISTS(SELECT 1 FROM economic_event_revisions live WHERE live.event_id=held.event_id
  AND live.revision=held.revision AND live.superseded_by IS NULL)
LEFT JOIN economic_event_revisions r ON r.event_id=held.event_id AND r.revision=held.revision
LEFT JOIN card_purchase_recognitions c ON c.event_id=held.event_id AND c.revision=held.revision
ORDER BY s.created_at DESC,s.relevance DESC,p.id,target.position`;

/**
 * Per `[from, to]` triple of `?1`: the relation rows it has (what a plan pins
 * as `relation:pending_to_posted|<from>|<to>`) and the latest one's status,
 * latest by creation time and then by insertion order.
 */
const CANDIDATE_RELATIONS_SQL = `SELECT json_extract(w.value,'$[0]') AS from_ref,json_extract(w.value,'$[1]') AS to_ref,
 (SELECT count(*) FROM entity_relations r WHERE r.kind='${PENDING_POSTED_RELATION_KIND}'
   AND r.from_ref=json_extract(w.value,'$[0]') AND r.to_ref=json_extract(w.value,'$[1]')) AS revision,
 (SELECT r.status FROM entity_relations r WHERE r.kind='${PENDING_POSTED_RELATION_KIND}'
   AND r.from_ref=json_extract(w.value,'$[0]') AND r.to_ref=json_extract(w.value,'$[1]')
   ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS status
FROM json_each(?1) w`;

/** One proposal resolved for review; `view` is what the operator page shows. */
export interface LoadedCandidate {
  view: CardPurchaseCandidate;
  pending: PendingPostedTarget;
  posted: PendingPostedTarget;
  /** Whether a withdrawal of this link splits a merged event. */
  merged: boolean;
}

const RELATION_STATUSES = ["proposed", "accepted", "rejected", "released"] as const;

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function codes<T extends string>(text: string, allowed: readonly T[]): T[] {
  const value = parsed(text);
  return Array.isArray(value)
    ? value.filter((entry): entry is T => typeof entry === "string" && allowed.includes(entry as T))
    : [];
}

function holderOf(row: TargetRow): PendingPostedHolder | null {
  if (
    row.holder_event_id === null ||
    row.holder_revision === null ||
    (row.holder_kind !== "purchase" && row.holder_kind !== "refund") ||
    row.holder_state === null ||
    row.holder_account_id === null ||
    row.holder_source_id === null
  )
    return null;
  const keys = parsed(row.holder_keys_json);
  if (!Array.isArray(keys)) return null;
  return {
    eventId: row.holder_event_id,
    revision: row.holder_revision,
    kind: row.holder_kind as CardPurchaseKind,
    state: row.holder_state as EventState,
    accountId: row.holder_account_id,
    sourceId: row.holder_source_id,
    keys: keys.flatMap((entry: unknown) => {
      const record = entry as { key?: unknown; role?: unknown } | null;
      return typeof record?.key === "string" &&
        (record.role === "pending" || record.role === "posted")
        ? [{ key: record.key, role: record.role as CardPurchaseKeyRole }]
        : [];
    }),
  };
}

function roleOf(status: string | null): CardPurchaseKeyRole | null {
  if (status === "unconfirmed") return "pending";
  if (status === "posted" || status === "confirmed") return "posted";
  return null;
}

function amountOf(row: TargetRow): Quantity | null {
  if (row.value_status !== "exact" || row.coefficient === null || row.scale === null) return null;
  return exactQuantity(
    row.unit_ref ?? "unknown-unit",
    normalizeDecimal(BigInt(row.coefficient), row.scale),
    "decimal-v1",
  );
}

interface ResolvedTarget {
  target: PendingPostedTarget;
  side: CardPurchaseCandidateSide;
}

function targetOf(row: TargetRow): ResolvedTarget | null {
  const ref = { kind: row.ref_kind, id: row.ref_id, revision: row.ref_revision };
  if (!validSourceFactRef(ref)) return null;
  const holder = holderOf(row);
  return {
    target: {
      ref: ref as SourceFactRef,
      recognitionKey: row.recognition_key,
      role: roleOf(row.provider_status),
      holder,
    },
    side: {
      ref: ref as SourceFactRef,
      eventId: holder?.eventId ?? null,
      revision: holder?.revision ?? null,
      state: holder?.state ?? null,
      displayedAmount: amountOf(row),
      usageDate: row.as_of,
    },
  };
}

/**
 * Candidates selected by the recognition keys they touch, or one candidate by
 * its proposal id. A proposal that does not name exactly two targets, or
 * whose targets are not canonical transaction rows, is left out: it cannot be
 * reviewed through this flow.
 */
export async function loadPendingPostedCandidates(
  reader: CandidateReader,
  filter: { keys: readonly string[] } | { proposalId: string },
): Promise<LoadedCandidate[]> {
  const byKeys = "keys" in filter;
  if (byKeys && filter.keys.length === 0) return [];
  const rows = await reader.all<TargetRow>(CANDIDATE_TARGETS_SQL, [
    byKeys ? JSON.stringify([...new Set(filter.keys)]) : null,
    byKeys ? null : filter.proposalId,
    CANDIDATES_PER_KEY,
  ]);
  const grouped = new Map<string, TargetRow[]>();
  for (const row of rows)
    grouped.set(row.proposal_id, [...(grouped.get(row.proposal_id) ?? []), row]);
  const shaped: {
    first: TargetRow;
    pending: ResolvedTarget;
    posted: ResolvedTarget;
    relation: PendingPostedRelation;
  }[] = [];
  for (const [proposalId, targets] of grouped) {
    if (targets.length !== 2) continue;
    const [first, second] = [...targets].sort((a, b) => a.position - b.position);
    const pending = targetOf(first!);
    const posted = targetOf(second!);
    if (pending === null || posted === null) continue;
    const relation = pendingPostedRelation(proposalId, pending.target.ref, posted.target.ref);
    if (relation === null) continue;
    shaped.push({ first: first!, pending, posted, relation });
  }
  if (shaped.length === 0) return [];
  const relations = new Map(
    (
      await reader.all<RelationRow>(CANDIDATE_RELATIONS_SQL, [
        JSON.stringify(shaped.map(({ relation }) => [relation.fromRef, relation.toRef])),
      ])
    ).map((row) => [`${row.from_ref}\u0000${row.to_ref}`, row]),
  );
  return shaped.flatMap(({ first, pending, posted, relation }) => {
    const status = first.status as ProposalStatus;
    if (!PROPOSAL_STATUSES.includes(status)) return [];
    const stored = relations.get(`${relation.fromRef}\u0000${relation.toRef}`);
    const relationStatus =
      stored?.status != null && (RELATION_STATUSES as readonly string[]).includes(stored.status)
        ? (stored.status as (typeof RELATION_STATUSES)[number])
        : null;
    const rationaleCodes: RationaleCode[] = codes(first.rationale_codes_json, RATIONALE_CODES);
    const rejectionConditions: RejectionConditionCode[] = codes(
      first.rejection_conditions_json,
      REJECTION_CONDITION_CODES,
    );
    const review = pendingPostedReview({
      proposalStatus: status,
      relationStatus,
      pending: pending.target,
      posted: posted.target,
    });
    return [
      {
        view: {
          proposalId: first.proposal_id,
          proposalStatus: status,
          proposalRevision: first.proposal_revision ?? 0,
          relationStatus,
          relationRevision: stored?.revision ?? 0,
          providerLinked: rationaleCodes.includes("provider_link_id_equal"),
          rationaleCodes,
          rejectionConditions,
          pending: pending.side,
          posted: posted.side,
          actions: review.actions,
          blockers: review.blockers,
          relation,
        },
        pending: pending.target,
        posted: posted.target,
        merged: review.merged,
      },
    ];
  });
}
