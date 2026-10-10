import type { CardOwnershipRole } from "../../domain/src/card-ownership-review.ts";

/**
 * The fallback never overwrites a recorded ownership judgement (including a
 * rejection, dated/joint/third-party claim) or a recorded contradiction.
 * History is deliberately conservative: resolving it uses the existing manual
 * review, not another self-declaration. No inference crosses same_account or
 * parent/child links. The same predicate runs inside the commit's receipt guard.
 */
export const OWNERSHIP_DECLARATION_CONTEXT_SQL = `SELECT
 (SELECT count(*) FROM entity_relations r
  WHERE r.kind IN ('liable_party','beneficial_owner') AND r.from_ref IN (?,?)) AS ownership_claims,
 (SELECT count(*) FROM entity_relations r WHERE r.kind='contradicts'
  AND (r.from_ref IN (SELECT value FROM json_each(?))
   OR r.to_ref IN (SELECT value FROM json_each(?)))) AS contrary_claims,
 (SELECT count(*) FROM accounts a JOIN current_account_mappings m ON m.account_id=a.id
  WHERE a.id=? AND m.source_account_id=? AND a.role=?
   AND a.status IN ('identified','provider-local')
   AND m.status IN ('identified','provider-local')) AS single_account_scope`;

export interface OwnershipDeclarationContext {
  ownership_claims: number;
  contrary_claims: number;
  single_account_scope: number;
}

export function ownershipDeclarationContextBinds(
  accountId: string,
  sourceAccountId: string,
  evidenceRefs: readonly string[],
  role: CardOwnershipRole,
): readonly string[] {
  const refs = JSON.stringify([
    accountId,
    "account:" + accountId,
    "source_account:" + sourceAccountId,
    ...evidenceRefs,
  ]);
  return [
    accountId,
    "account:" + accountId,
    refs,
    refs,
    accountId,
    sourceAccountId,
    role === "liable_party" ? "card-statement" : "deposit",
  ];
}

export function ownershipDeclarationBlockers(context: OwnershipDeclarationContext): string[] {
  return [
    ...(context.single_account_scope === 1 ? [] : ["single_account_scope_unconfirmed"]),
    ...(context.ownership_claims === 0 ? [] : ["ownership_claims_require_review"]),
    ...(context.contrary_claims === 0 ? [] : ["contrary_evidence_recorded"]),
  ];
}
