import type { IdentityStatus, IdentityOrigin } from "./identity-contract.ts";

/** Effective interpretation alongside, never in place of, the stored source fields. */
export interface OrganizedAccount {
  referenceId: string;
  targetId: string;
  label: string;
  status: IdentityStatus;
  revision: number;
  method: "rule" | "manual";
  reason: string;
}
export interface OrganizedInstrument extends OrganizedAccount {
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
  state: "organized" | "unavailable";
  lineage: "current" | "historical" | null;
  account: OrganizedAccount | null;
  instruments: OrganizedInstrument[];
}
