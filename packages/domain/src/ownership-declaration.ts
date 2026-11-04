import { parseLocalDate } from "./time.ts";
import type { CardOwnershipRole } from "./card-ownership-review.ts";

const PREFIX = "ownership-declaration:";
export interface OwnershipSelfDeclaration {
  kind: "self-declared";
  scope: "sole-personal";
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
): string | null {
  if (!parseLocalDate(declaredOn)) return null;
  return `${PREFIX}sole-personal-v1:${role}:${declaredOn}`;
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
    /^ownership-declaration:sole-personal-v1:(liable_party|beneficial_owner):(\d{4}-\d{2}-\d{2})$/u.exec(
      markers[0]!,
    );
  if (!match || !parseLocalDate(match[2]!)) return { kind: "invalid" };
  return {
    kind: "self-declared",
    scope: "sole-personal",
    role: match[1] as CardOwnershipRole,
    declaredOn: match[2]!,
    providerNameVerified: false,
  };
}
