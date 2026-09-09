import type { IdentityStatus, IdentityOrigin } from "./identity-contract.ts";
import type { AccountConnection } from "./account-connection-contract.ts";
import type { FinancialProductClaim } from "./financial-products.ts";

/** Effective interpretation alongside, never in place of, the stored source fields. */
export interface OrganizedAccount {
  connection?: AccountConnection;
  referenceId: string;
  targetId: string;
  label: string;
  status: IdentityStatus;
  revision: number;
  method: "rule" | "manual";
  reason: string;
}
export interface OrganizedInstrument extends Omit<OrganizedAccount, "connection"> {
  role: "unit" | "security" | "trade-unit" | "usage-unit";
  namespace: string;
  scope: string;
  value: string;
  nameEvidence?: {
    reason: "manual" | "provider-current" | "observed-japanese-script";
    origin: IdentityOrigin | null;
  };
}
export interface ObservationOrganization {
  /** Current, evidence-backed product interpretation of this observation only. */
  product?: FinancialProductClaim;
  state: "organized" | "unavailable";
  lineage: "current" | "historical" | null;
  account: OrganizedAccount | null;
  instruments: OrganizedInstrument[];
  /** Account mapping revision this row was decorated with under the response's read mode. */
  mappingRevision?: number;
  /** Policy release of the sealed identity run the row was recorded under. */
  identityRelease?: string;
}
