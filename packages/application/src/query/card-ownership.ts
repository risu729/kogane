import { ownershipReviewEvidenceRefs } from "../../../domain/src/ownership-review.ts";
import type { OwnershipDeclarationScope } from "../../../domain/src/ownership-declaration.ts";
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
import {
  OWNERSHIP_DECLARATION_CONTEXT_SQL,
  ownershipDeclarationContextBinds,
  ownershipDeclarationBlockers,
  type OwnershipDeclarationContext,
} from "../../../read-model/src/ownership-declaration.ts";

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

/**
 * ?1 the role, ?2 the account, ?3 the last relation rowid the pin counted: per
 * owner (through either alias of the account), its current claim, up to 51
 * newest first. The current claim is the newest decision (`accepted`,
 * `rejected` or `released`) in insertion order, or the newest proposal when
 * the owner has no decision; a claim whose decision was superseded shows
 * nothing for its owner. The first check hides a row behind a later decision
 * (or behind any later row, for a proposal), the second hides a proposal
 * behind any decision of its owner; each is a keyed lookup, the first a
 * rowid range as the shipped text's. A proposal recorded after a decision changes nothing
 * (INV07), so the review still shows, and offers to reject, the accepted owner
 * the readers adopt (`card-settlement-ownership.ts`; ADR 0017's amendment of
 * 2026-11-06).
 */
export const CARD_OWNERSHIP_CLAIMS_SQL = `SELECT r.id,r.to_ref,r.status,r.valid_from,r.valid_to,r.evidence_refs_json,r.decision_revision_id
      FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
      WHERE r.kind=?1 AND r.from_ref IN(?2,'account:'||?2) AND r.rowid<=?3
       AND NOT EXISTS(SELECT 1 FROM entity_relations n WHERE n.kind=r.kind AND n.from_ref IN(?2,'account:'||?2)
        AND n.to_ref=r.to_ref AND n.rowid>r.rowid AND n.rowid<=?3 AND (n.status<>'proposed' OR r.status='proposed'))
       AND (r.status<>'proposed' OR NOT EXISTS(SELECT 1 FROM entity_relations n WHERE n.kind=r.kind
        AND n.from_ref IN(?2,'account:'||?2) AND n.to_ref=r.to_ref AND n.rowid<=?3 AND n.status<>'proposed'))
      ORDER BY r.rowid DESC LIMIT 51`;

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
      ? await sql.all<Claim>(CARD_OWNERSHIP_CLAIMS_SQL, [
          role,
          mapping.account_id,
          mapping.last_row,
        ])
      : [];
    const evidenceRefs = mapping ? ownershipReviewEvidenceRefs(row.id, fact.ref, mapping.id) : [];
    const context = (scope: OwnershipDeclarationScope) =>
      mapping
        ? sql.first<OwnershipDeclarationContext>(
            OWNERSHIP_DECLARATION_CONTEXT_SQL,
            ownershipDeclarationContextBinds(
              mapping.account_id,
              mapping.source_account_id,
              evidenceRefs,
              role,
              scope,
            ),
          )
        : Promise.resolve(null);
    const declarationContext = await context("sole-personal");
    const defaultContext = await context("owner-default");
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
      evidenceRefs,
      blockers,
      selfDeclarationBlockers: [
        ...blockers,
        ...(declarationContext
          ? ownershipDeclarationBlockers(declarationContext)
          : ["account_mapping_unresolved"]),
      ],
      ownerDefaultBlockers: [
        ...blockers,
        ...(defaultContext
          ? ownershipDeclarationBlockers(defaultContext)
          : ["account_mapping_unresolved"]),
      ],
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
