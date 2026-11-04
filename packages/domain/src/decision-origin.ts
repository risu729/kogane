/** Display classification of persisted decision provenance; never a grant or identity. */
export type DecisionOrigin = "delegated" | "operator" | "automatic" | "legacy" | "unknown";
export function isDecisionOrigin(value: unknown): value is DecisionOrigin {
  return (
    typeof value === "string" &&
    ["delegated", "operator", "automatic", "legacy", "unknown"].includes(value)
  );
}
