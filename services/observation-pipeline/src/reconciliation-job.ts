// The first reconciliation vertical slice (architecture addendum A10; root
// review 09 section 2: matching and its explanation before any net-worth
// screen).
//
// Chosen pair: **pending against posted inside one source**, on the Vpass
// statement page. That parser emits two provider displays of the same card and
// the same statement month -- the `customized` family with provider status
// `unconfirmed` (a pending authorisation) and the `web` family with `posted`
// (the statement line) -- under one `vpass:<card>` source account. It is the
// only pair in the deployed parser set where both sides of a pending/posted
// revision exist in one identifier namespace, so no cross-source ownership has
// to be established first (UC13, SC03). MyJCB's credit ledger has the same
// shape (`unconfirmed` and `confirmed` for one connection and period) and is
// the next entry to add to `RECONCILIATION_SLICES`.
//
// Nothing is accepted automatically. Auto-acceptance needs a link id the
// provider itself issued for the pair, exposed by the parser as
// `extra_json.$._kogane.providerLinkId`. Surveying the deployed parsers and
// `docs/sources/*.md`: MyJCB's third-party column survey mentions an approval
// number on the debit sections, which the deployed ledger parser does not read;
// SBI Shinsei (`txnReferenceNo`), SMBC Direct, SBI VC Trade (`cashflowId`,
// `executionId`), PayPay (`transactionNumber`) and V Point Pay expose a
// provider row id, which identifies one row (stage A) and does not link a
// pending row to its posted row; Vpass, Sony Bank, MoneyForward, Mobile Suica,
// Global Pass and SBI Securities' histories derive their external ids from a
// collector fingerprint, which is not a provider identifier at all. So no
// source currently supplies a pending-to-posted link id, every proposal this
// job writes stays `proposed`, and acceptance goes through
// `reconciliation-commands.ts` and the decision log.
import {
  quantityFromNormalizedDecimal,
  type Quantity,
} from "../../../packages/domain/src/values.ts";
import type { NormalizedDecimal } from "../../../poc/observation-pipeline/shared/normalized-decimal.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  DEFAULT_MATCH_OPTIONS,
  proposalIdentity,
  stageAProposals,
  stageBProposals,
  type MatchFact,
  type ReconciliationProposal,
} from "../../../packages/domain/src/reconcile.ts";
import type { TemporalValue } from "../../../packages/domain/src/time.ts";
import { acceptProposal } from "./reconciliation-commands.ts";

/** One source whose own displays are compared. Datasets, not free-form rules. */
export interface ReconciliationSlice {
  sourceId: string;
  /** Provider statuses that mean "not final yet" and "recorded", for this source only. */
  pendingStatuses: readonly string[];
  postedStatuses: readonly string[];
}

/**
 * Exactly one slice to start with (addendum 07 section 8: finish one vertical
 * slice before generalising). MyJCB is the documented next entry.
 */
export const RECONCILIATION_SLICES: readonly ReconciliationSlice[] = [
  { sourceId: "vpass", pendingStatuses: ["unconfirmed"], postedStatuses: ["posted"] },
];

/** Bounds: one sweep reads at most this many published rows and pairs inside bounded groups. */
export const SCAN_LIMIT = 1_000;
export const GROUP_LIMIT = 200;
export const WRITE_LIMIT = 500;

export interface ReconciliationSweepResult {
  /** Safe counts only; no amounts, provider text or account labels are logged. */
  slices: number;
  scanned: number;
  groups: number;
  groupsSkipped: number;
  proposed: number;
  written: number;
  autoAccepted: number;
}

/** Off unless explicitly enabled; the default deploy changes nothing readers see. */
export function reconciliationEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

interface FactRow {
  id: number;
  parse_run_id: number;
  source_account: string;
  external_id: string | null;
  status: string | null;
  as_of: string | null;
  counterparty: string | null;
  currency: string | null;
  source_id: string;
  producer_id: string;
  external_id_namespace: string | null;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
  value_basis: string | null;
  statement_period: string | null;
  provider_link_id: string | null;
  identity_origin: string | null;
}

const jsonText = (path: string) =>
  `CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json,'${path}')='text'
     AND length(json_extract(t.extra_json,'${path}')) BETWEEN 1 AND 256
   THEN json_extract(t.extra_json,'${path}') END`;

/**
 * Published transaction observations of one source with a pending or posted
 * status. Only the publication projection is read (docs/publication-gate.md),
 * so an unadopted successful parse never produces a candidate.
 */
export const factQuery = `SELECT t.id,t.parse_run_id,t.source_account,t.external_id,t.status,t.as_of,
 t.counterparty,t.currency,a.source_id,fr.producer_id,ses.external_id_namespace,
 d.status AS value_status,d.coefficient,d.scale,d.basis AS value_basis,
 ${jsonText("$._kogane.statementMonth")} AS statement_period,
 ${jsonText("$._kogane.providerLinkId")} AS provider_link_id,
 ${jsonText("$._kogane.identityOrigin")} AS identity_origin
FROM transaction_observations t
JOIN parse_runs p ON p.id=t.parse_run_id
JOIN published_parse_runs pub ON pub.parse_run_id=p.id
JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
JOIN fetch_runs fr ON fr.id=a.fetch_run_id
JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
LEFT JOIN observation_decimal_values d
 ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
WHERE a.source_id=?1 AND t.status IN (SELECT value FROM json_each(?2))
ORDER BY t.source_account,t.id
LIMIT ?3`;

function quantityOf(row: FactRow): Quantity {
  const normalized: NormalizedDecimal = {
    policyVersion: "decimal-v1",
    status:
      row.value_status === "exact" ||
      row.value_status === "missing" ||
      row.value_status === "unparsed" ||
      row.value_status === "conflict"
        ? row.value_status
        : "missing",
    coefficient: row.coefficient,
    scale: row.scale,
    basis:
      row.value_basis === "minor_units" ||
      row.value_basis === "decimal_text" ||
      row.value_basis === "agreement"
        ? row.value_basis
        : "none",
  };
  return quantityFromNormalizedDecimal(row.currency ?? "unknown-unit", normalized);
}

function occurredOf(row: FactRow): TemporalValue {
  if (row.as_of !== null && /^\d{4}-\d{2}-\d{2}$/u.test(row.as_of))
    return { kind: "local-date", value: row.as_of, zone: null, basis: "provider" };
  return { kind: "unknown", reasonCode: "provider_date_absent" };
}

/** A collector fingerprint is not a provider identifier, and it is not treated as one. */
function originOf(row: FactRow): MatchFact["identifierOrigin"] {
  if (row.identity_origin === null) return "unknown";
  return row.identity_origin.includes("fingerprint") || row.identity_origin.includes("occurrence")
    ? "collector-fingerprint"
    : "provider";
}

export function factOf(row: FactRow, slice: ReconciliationSlice): MatchFact {
  return {
    ref: {
      kind: "transaction",
      id: `transaction:${row.id}`,
      // The parse run is the immutable version the claim was read in.
      revision: `parse_run:${row.parse_run_id}`,
    },
    scope: {
      sourceId: row.source_id,
      // A re-authenticated connection is a different epoch, so ids never cross it.
      credentialEpoch: `${row.producer_id}/${row.external_id_namespace ?? "-"}`,
      accountNamespace: row.source_account,
    },
    sourceAccount: row.source_account,
    externalId: row.external_id,
    identifierOrigin: originOf(row),
    providerLinkId: row.provider_link_id,
    settlementState: slice.pendingStatuses.includes(row.status ?? "")
      ? "pending"
      : slice.postedStatuses.includes(row.status ?? "")
        ? "posted"
        : "unknown",
    quantity: quantityOf(row),
    occurred: occurredOf(row),
    counterparty: row.counterparty,
    statementPeriod: row.statement_period,
    // Ownership is a separate judgement; this slice never guesses one (UC23).
    ownerRef: null,
  };
}

/** Facts are paired inside one source account and statement period, and each group is bounded. */
export function groupFacts(facts: readonly MatchFact[]): Map<string, MatchFact[]> {
  const groups = new Map<string, MatchFact[]>();
  for (const fact of facts) {
    const key = `${fact.sourceAccount} ${fact.statementPeriod ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }
  return groups;
}

async function writeProposal(
  db: D1Database,
  proposal: ReconciliationProposal,
  now: string,
): Promise<boolean> {
  const digest = await canonicalDigest(proposalIdentity(proposal));
  const result = await db
    .prepare(`INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,
      rationale_codes_json,rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,'proposed',NULL,?,?
      WHERE NOT EXISTS(SELECT 1 FROM reconciliation_proposals WHERE proposal_digest=?)`)
    .bind(
      `rp_${digest}`,
      proposal.kind,
      proposal.stage,
      JSON.stringify(proposal.targetRefs),
      proposal.method,
      proposal.policyRelease,
      JSON.stringify(proposal.rationaleCodes),
      JSON.stringify(proposal.rejectionConditions),
      JSON.stringify(proposal.evidenceRefs),
      digest,
      now,
      digest,
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * One bounded sweep. Writes candidates and nothing else, unless a candidate is
 * strictly evidenced by a provider link id, in which case the acceptance is
 * still recorded as a decision through `acceptProposal` (INV07). Re-running the
 * sweep over the same published rows writes nothing new: the proposal digest is
 * unique.
 */
export async function reconciliationSweep(
  db: D1Database,
  options: { slices?: readonly ReconciliationSlice[]; now?: string } = {},
): Promise<ReconciliationSweepResult> {
  const slices = options.slices ?? RECONCILIATION_SLICES;
  const now = options.now ?? new Date().toISOString();
  const result: ReconciliationSweepResult = {
    slices: slices.length,
    scanned: 0,
    groups: 0,
    groupsSkipped: 0,
    proposed: 0,
    written: 0,
    autoAccepted: 0,
  };
  for (const slice of slices) {
    const rows = await db
      .prepare(factQuery)
      .bind(
        slice.sourceId,
        JSON.stringify([...slice.pendingStatuses, ...slice.postedStatuses]),
        SCAN_LIMIT,
      )
      .all<FactRow>();
    result.scanned += rows.results.length;
    const groups = groupFacts(rows.results.map((row) => factOf(row, slice)));
    for (const facts of groups.values()) {
      if (facts.length > GROUP_LIMIT) {
        result.groupsSkipped += 1;
        continue;
      }
      result.groups += 1;
      // Stage C (cross-source correspondence) needs an established owner on
      // both sides and a second source in the slice; it is not run yet.
      const proposals = [
        ...stageAProposals(facts, DEFAULT_MATCH_OPTIONS),
        ...stageBProposals(facts, DEFAULT_MATCH_OPTIONS),
      ];
      result.proposed += proposals.length;
      for (const proposal of proposals) {
        if (result.written >= WRITE_LIMIT) break;
        if (await writeProposal(db, proposal, now)) result.written += 1;
        if (!proposal.autoAcceptable) continue;
        const digest = await canonicalDigest(proposalIdentity(proposal));
        const accepted = await acceptProposal(db, {
          operationId: `reconciliation-${digest}`,
          actorId: "rule:reconciliation-v1",
          actorVerification: "server",
          proposalId: `rp_${digest}`,
          expectedStatus: "proposed",
          method: "rule",
          reason: `provider link evidence: ${proposal.rationaleCodes.join(",")}`,
        });
        if (accepted.ok && !accepted.replayed) result.autoAccepted += 1;
      }
    }
  }
  return result;
}
