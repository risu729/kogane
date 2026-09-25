// The first reconciliation vertical slice (architecture addendum A10; root
// review 09 section 2: matching and its explanation before any net-worth
// screen).
//
// Pending/posted pairs stay inside one source account and billing period.
// Vpass uses unconfirmed/posted; MyJCB uses unconfirmed/confirmed. MyJCB's
// posted payment can be an installment slice, so only rows whose explicit
// usage and payment totals agree participate in the pending purchase match,
// and only under a known payment month: an absolute label, or a relative
// `detailMonth-N` label resolved from the row's capture time
// (`statementPeriodOf`, `comparablePayment`). A MyJCB confirmed row takes part
// in stage B only (`inStageA`).
//
// // Nothing is accepted automatically. Auto-acceptance needs a link id the
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
import type { NormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";
import {
  cardStatementPeriod,
  comparableCardPayment,
  statementPeriod,
} from "../../../packages/domain/src/card-purchase.ts";
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
 * Explicit supported provider status families; installment comparability is
 * checked before MyJCB facts enter the matcher.
 */
export const RECONCILIATION_SLICES: readonly ReconciliationSlice[] = [
  { sourceId: "vpass", pendingStatuses: ["unconfirmed"], postedStatuses: ["posted"] },
  { sourceId: "myjcb", pendingStatuses: ["unconfirmed"], postedStatuses: ["confirmed"] },
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
  /** `_kogane.period` verbatim (MyJCB's label, possibly the relative `detailMonth-N`). */
  period_label: string | null;
  /** The `fetched_at` of the row's artifact: the capture a relative label is resolved from. */
  fetched_at: string | null;
  provider_link_id: string | null;
  identity_origin: string | null;
  usage_amount_text: string | null;
  payment_amount_text: string | null;
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
 coalesce(${jsonText("$._kogane.statementMonth")},replace(${jsonText("$._kogane.period")},'-','')) AS statement_period,
 ${jsonText("$._kogane.period")} AS period_label,a.fetched_at,
 ${jsonText("$._kogane.providerLinkId")} AS provider_link_id,
 ${jsonText("$._kogane.identityOrigin")} AS identity_origin,
 ${jsonText("$._kogane.usageAmountText")} AS usage_amount_text,
 ${jsonText("$._kogane.paymentAmountText")} AS payment_amount_text
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

/**
 * The statement period a row is paired under. Vpass: its `statementMonth` as
 * stored. MyJCB: the payment month `YYYY-MM`, read as recognition reads it: an
 * absolute label (`YYYY年M月お支払い分`, or a `statementMonth`), else a relative
 * `detailMonth-N` resolved from the capture time of the row's own artifact
 * (`cardStatementPeriod`; relative-statement-period-v1 places `detailMonth-0`
 * and `detailMonth-1`). Null when neither places the month. The raw relative
 * label is never a group: it is a position in the provider's list on the
 * capture day, so rows of different payment months share it over time.
 */
function statementPeriodOf(row: FactRow): string | null {
  if (row.source_id !== "myjcb") return row.statement_period;
  return (
    statementPeriod(row.statement_period) ??
    cardStatementPeriod({
      sourceId: row.source_id,
      statementPeriod: row.period_label,
      capturedAt: row.fetched_at,
    })
  );
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
    statementPeriod: statementPeriodOf(row),
    // Ownership is a separate judgement; this slice never guesses one (UC23).
    ownerRef: null,
  };
}

/** Facts are paired inside one source account and statement period, and each group is bounded. */
export function groupFacts(facts: readonly MatchFact[]): Map<string, MatchFact[]> {
  const groups = new Map<string, MatchFact[]>();
  for (const fact of facts) {
    const key = `${fact.sourceAccount}\u0000${fact.statementPeriod ?? ""}`;
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
    const groups = groupFacts(
      rows.results.filter(comparablePayment).map((row) => factOf(row, slice)),
    );
    for (const facts of groups.values()) {
      if (facts.length > GROUP_LIMIT) {
        result.groupsSkipped += 1;
        continue;
      }
      result.groups += 1;
      // Stage C (cross-source correspondence) needs an established owner on
      // both sides and a second source in the slice; it is not run yet.
      const proposals = [
        ...stageAProposals(facts.filter(inStageA), DEFAULT_MATCH_OPTIONS),
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

/** MyJCB's posted amount can be an installment slice. Only a provider row with
 * equal, positive usage/payment amounts participates in pending-to-posted
 * matching. The rule is the domain's `comparableCardPayment`, which reads the
 * ledger parser's display text (`1,200円`) through the same grammar card
 * purchase recognition uses.
 *
 * A MyJCB confirmed row must also carry a known payment month, read as
 * recognition reads it (`statementPeriodOf`). The collector writes the
 * relative fallback `detailMonth-N` for every month the past-months API does
 * not label (docs/sources/myjcb.md: the first connection's menu lists months
 * 0..8 and the API only 9..17). That label is a position in the provider's
 * month list on the capture day, so it names a month only together with its
 * capture time, and a position the rule does not place (`detailMonth-2` and
 * beyond) names none. This job pairs only inside a known payment month; the
 * recognition lane's candidate pass pairs such a row by its usage month. */
function comparablePayment(row: FactRow): boolean {
  if (row.source_id === "myjcb" && row.status === "confirmed" && statementPeriodOf(row) === null)
    return false;
  return comparableCardPayment({
    sourceId: row.source_id,
    status: row.status,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
  });
}

/**
 * MyJCB confirmed rows are admitted for pending-to-posted matching (stage B)
 * only. Their stage A pairs would be one confirmed row re-captured by every
 * daily run under a collector fingerprint (never auto-acceptable): each ledger
 * month is re-captured daily while the provider lists it, so a sparse month
 * yields a candidate per pair of captures, and every written candidate is
 * re-checked by each sweep. No confirmed MyJCB row took part in the lane before
 * `comparableCardPayment` read the ledger's display text, and stage B does not
 * need them in stage A.
 */
function inStageA(fact: MatchFact): boolean {
  return !(fact.scope.sourceId === "myjcb" && fact.settlementState === "posted");
}
