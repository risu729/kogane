import type { CardOwnershipRole } from "../../domain/src/card-ownership-review.ts";
import type { OwnershipDeclarationScope } from "../../domain/src/ownership-declaration.ts";

/**
 * The fallback never overwrites a recorded ownership judgement (including a
 * rejection, dated/joint/third-party claim) or a recorded contradiction.
 * History is deliberately conservative: resolving it uses the existing manual
 * review, not another self-declaration. No inference crosses same_account or
 * parent/child links. The same predicate runs inside the commit's receipt guard.
 *
 * `single_account_scope` checks the account's role and both statuses against
 * the scope's closed lists (`declarationAccountScope`): a sole-personal
 * declaration needs one individually scoped account; the owner default
 * (ADR 0082) also admits a card connection root (`card-statement-aggregate`),
 * because the owner decided that every unrecorded account is theirs. An
 * unresolved placeholder is never admitted by either.
 */
export const OWNERSHIP_DECLARATION_CONTEXT_SQL = `SELECT
 (SELECT count(*) FROM entity_relations r
  WHERE r.kind IN ('liable_party','beneficial_owner') AND r.from_ref IN (?,?)) AS ownership_claims,
 (SELECT count(*) FROM entity_relations r WHERE r.kind='contradicts'
  AND (r.from_ref IN (SELECT value FROM json_each(?))
   OR r.to_ref IN (SELECT value FROM json_each(?)))) AS contrary_claims,
 (SELECT count(*) FROM accounts a JOIN current_account_mappings m ON m.account_id=a.id
  WHERE a.id=? AND m.source_account_id=?
   AND a.role IN (SELECT value FROM json_each(?))
   AND a.status IN (SELECT value FROM json_each(?))
   AND m.status IN (SELECT value FROM json_each(?))) AS single_account_scope`;

export interface OwnershipDeclarationContext {
  ownership_claims: number;
  contrary_claims: number;
  single_account_scope: number;
}

/** The account roles and statuses a declaration of this scope and role may name. */
export function declarationAccountScope(
  role: CardOwnershipRole,
  scope: OwnershipDeclarationScope,
): { roles: readonly string[]; statuses: readonly string[] } {
  const individual = ["identified", "provider-local"];
  if (role === "beneficial_owner") return { roles: ["deposit"], statuses: individual };
  return scope === "owner-default"
    ? {
        roles: ["card-statement", "card-statement-aggregate"],
        statuses: [...individual, "aggregate"],
      }
    : { roles: ["card-statement"], statuses: individual };
}

export function ownershipDeclarationContextBinds(
  accountId: string,
  sourceAccountId: string,
  evidenceRefs: readonly string[],
  role: CardOwnershipRole,
  scope: OwnershipDeclarationScope = "sole-personal",
): readonly string[] {
  const admitted = declarationAccountScope(role, scope);
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
    JSON.stringify(admitted.roles),
    JSON.stringify(admitted.statuses),
    JSON.stringify(admitted.statuses),
  ];
}

export function ownershipDeclarationBlockers(context: OwnershipDeclarationContext): string[] {
  return [
    ...(context.single_account_scope === 1 ? [] : ["single_account_scope_unconfirmed"]),
    ...(context.ownership_claims === 0 ? [] : ["ownership_claims_require_review"]),
    ...(context.contrary_claims === 0 ? [] : ["contrary_evidence_recorded"]),
  ];
}
