/** A connection groups provider views. It never establishes leaf-account equivalence. */
export interface AccountConnection {
  label: string;
  status: "confirmed" | "unresolved" | "evidence-ineligible";
  relation: "same-provider-connection" | "candidate";
  relatedSource: string | null;
  reason: string;
  leafBinding: "unresolved";
  evidenceArtifactIds: number[];
  revision: number;
}
