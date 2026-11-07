import { parseLocalDate } from "./time.ts";
import type { CardOwnershipRole } from "./card-ownership-review.ts";

const PREFIX = "ownership-declaration:";
/**
 * `sole-personal`: the owner's assertion for one account (a person picks it).
 * `owner-default`: the owner's standing decision of 2026-11-07 (ADR 0082) that
 * an account with no recorded owner is the owner's, applied to one account by
 * whoever plans it, a delegated agent included. Both name one role, one
 * account and the day it was applied; neither is provider-name verification.
 */
export type OwnershipDeclarationScope = "sole-personal" | "owner-default";
/** The party an `owner-default` declaration names, the same for every account. */
export const OWNER_DEFAULT_PARTY = "party:owner";
export interface OwnershipSelfDeclaration {
  kind: "self-declared";
  scope: OwnershipDeclarationScope;
  role: CardOwnershipRole;
  declaredOn: string;
  providerNameVerified: false;
}
export type OwnershipDeclarationReading =
  | { kind: "absent" }
  | { kind: "invalid" }
  | OwnershipSelfDeclaration;

/** A human assertion, not a provider/KYC proof or an effective ownership date. */
export function ownershipDeclarationRef(
  role: CardOwnershipRole,
  declaredOn: string,
  scope: OwnershipDeclarationScope = "sole-personal",
): string | null {
  if (!parseLocalDate(declaredOn)) return null;
  return `${PREFIX}${scope}-v1:${role}:${declaredOn}`;
}

export function ownershipDeclarationRequested(refs: readonly string[]): boolean {
  return refs.some((ref) => ref.startsWith(PREFIX));
}

/** Closed and role-specific: no name, principal id, or guessed owner enters the marker. */
export function readOwnershipDeclaration(refs: readonly string[]): OwnershipDeclarationReading {
  const markers = refs.filter((ref) => ref.startsWith(PREFIX));
  if (markers.length === 0) return { kind: "absent" };
  if (markers.length !== 1) return { kind: "invalid" };
  const match =
    /^ownership-declaration:(sole-personal|owner-default)-v1:(liable_party|beneficial_owner):(\d{4}-\d{2}-\d{2})$/u.exec(
      markers[0]!,
    );
  if (!match || !parseLocalDate(match[3]!)) return { kind: "invalid" };
  return {
    kind: "self-declared",
    scope: match[1] as OwnershipDeclarationScope,
    role: match[2] as CardOwnershipRole,
    declaredOn: match[3]!,
    providerNameVerified: false,
  };
}
