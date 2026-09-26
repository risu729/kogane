import { ownershipReviewEvidenceRefs } from "../../../domain/src/ownership-review.ts";
import {
  validCardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import type {
  CardOwnershipReview,
  CardOwnershipSide,
  CardOwnershipClaim,
} from "../../../domain/src/card-ownership-review.ts";
import { cardSettlementReadinessCtes } from "../../../read-model/src/card-settlement-readiness.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

interface Candidate {
  id: string;
  facts_json: string;
  revision: number;
  status: CardSettlementStatus;
  statement_current: number;
  bank_current: number;
}
interface Mapping {
  source_account_id: string;
  id: string;
  account_id: string;
  revision: number;
  ownership_revision: number;
  last_row: number;
}
interface Claim {
  id: string;
  to_ref: string;
  status: CardOwnershipClaim["status"];
  valid_from: string | null;
  valid_to: string | null;
  evidence_refs_json: string;
  decision_revision_id: string;
}

/**
 * The candidate `?1` with its source currentness, judged for that candidate
 * alone through the keyed form of `card_settlement_readiness`
 * (card-settlement-readiness.ts) rather than the whole view.
 */
export const CARD_OWNERSHIP_CANDIDATE_SQL = `WITH chosen AS (SELECT ?1 AS id), ${cardSettlementReadinessCtes()}
SELECT c.id,c.facts_json,c.revision,c.status,r.statement_current,r.bank_current
FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id JOIN readiness r ON r.id=c.id`;

/** Operator review only: known mappings and recorded claims, never an inferred party. */
export async function queryCardOwnership(
  sql: SqlExecutor,
  proposalId: string,
): Promise<CardOwnershipReview | null> {
  const rows = await sql.all<Candidate>(CARD_OWNERSHIP_CANDIDATE_SQL, [proposalId]);
  const row = rows[0];
  if (!row) return null;
  const facts: unknown = JSON.parse(row.facts_json);
  if (!validCardSettlementFacts(facts)) throw new Error("card_settlement_facts_invalid");
  const sides: CardOwnershipSide[] = [];
  for (const [role, fact, current] of [
    ["liable_party", facts.statement, row.statement_current],
    ["beneficial_owner", facts.bankDebit, row.bank_current],
  ] as const) {
    const match = /^(balance|transaction):([0-9]+)$/u.exec(fact.ref.id);
    const parse = /^parse_run:([0-9]+)$/u.exec(fact.ref.revision);
    const mappings =
      match &&
      parse &&
      match[1] === fact.ref.kind &&
      Number.isSafeInteger(Number(match[2])) &&
      Number.isSafeInteger(Number(parse[1]))
        ? await sql.all<Mapping>(
            `SELECT o.source_account_id,m.id,m.account_id,m.revision,
      (SELECT count(*) FROM entity_relations r WHERE r.kind=?3 AND r.from_ref IN(m.account_id,'account:'||m.account_id)) AS ownership_revision,
      COALESCE((SELECT max(r.rowid) FROM entity_relations r WHERE r.kind=?3 AND r.from_ref IN(m.account_id,'account:'||m.account_id)),0) AS last_row
      FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
      WHERE o.kind=?1 AND o.observation_id=?2 AND o.parse_run_id=?4 LIMIT 2`,
            [fact.ref.kind, Number(match[2]), role, Number(parse[1])],
          )
        : [];
    const mapping = mappings.length === 1 ? mappings[0]! : null;
    const blockers: string[] = [];
    if (row.status !== "proposed") blockers.push("candidate_not_proposed");
    if (current !== 1 || row.statement_current !== 1 || row.bank_current !== 1)
      blockers.push("source_changed");
    if (fact.accountId === null) blockers.push("account_not_resolved");
    else if (mapping && mapping.account_id !== fact.accountId)
      blockers.push("account_context_changed");
    if (!mapping) blockers.push("account_mapping_unresolved");
    const claims = mapping
      ? await sql.all<Claim>(
          `SELECT r.id,r.to_ref,r.status,r.valid_from,r.valid_to,r.evidence_refs_json,r.decision_revision_id
      FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
      WHERE r.kind=?1 AND r.from_ref IN(?2,'account:'||?2) AND r.rowid<=?3
       AND NOT EXISTS(SELECT 1 FROM entity_relations n WHERE n.kind=r.kind AND n.from_ref IN(?2,'account:'||?2)
        AND n.to_ref=r.to_ref AND n.rowid>r.rowid AND n.rowid<=?3)
      ORDER BY r.rowid DESC LIMIT 51`,
          [role, mapping.account_id, mapping.last_row],
        )
      : [];
    sides.push({
      role,
      sourceId: fact.sourceId,
      sourceAccount: fact.sourceAccount,
      fact: fact.ref,
      accountId: mapping?.account_id ?? null,
      sourceAccountId: mapping?.source_account_id ?? null,
      mappingId: mapping?.id ?? null,
      mappingRevision: mapping?.revision ?? 0,
      ownershipRevision: mapping?.ownership_revision ?? 0,
      evidenceRefs: mapping ? ownershipReviewEvidenceRefs(row.id, fact.ref, mapping.id) : [],
      blockers,
      claims: claims.slice(0, 50).map((claim) => {
        const evidence: unknown = JSON.parse(claim.evidence_refs_json);
        if (!Array.isArray(evidence) || !evidence.every((ref) => typeof ref === "string"))
          throw new Error("ownership_evidence_invalid");
        return {
          id: claim.id,
          partyRef: claim.to_ref,
          status: claim.status,
          validFrom: claim.valid_from,
          validTo: claim.valid_to,
          evidenceRefs: evidence,
          decisionRevisionId: claim.decision_revision_id,
        };
      }),
      claimsTruncated: claims.length > 50,
    });
  }
  return { proposalId: row.id, revision: row.revision, status: row.status, sides };
}
