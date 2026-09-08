/** Persisted DB projection; the coefficient is an arbitrary-precision integer, not a JS Number. */
export interface NormalizedDecimal {
  policyVersion: "decimal-v1";
  status: "exact" | "missing" | "unparsed" | "conflict";
  coefficient: string | null;
  scale: number | null;
  basis: "minor_units" | "decimal_text" | "agreement" | "none";
}
export function validNormalizedDecimal(value: unknown): value is NormalizedDecimal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    row.policyVersion !== "decimal-v1" ||
    typeof row.status !== "string" ||
    !["exact", "missing", "unparsed", "conflict"].includes(row.status) ||
    typeof row.basis !== "string" ||
    !["minor_units", "decimal_text", "agreement", "none"].includes(row.basis)
  )
    return false;
  if (row.status !== "exact")
    return row.coefficient === null && row.scale === null && row.basis === "none";
  return (
    row.basis !== "none" &&
    typeof row.coefficient === "string" &&
    row.coefficient.length <= 4096 &&
    /^(?:0|-?[1-9][0-9]*)$/u.test(row.coefficient) &&
    typeof row.scale === "number" &&
    Number.isSafeInteger(row.scale) &&
    row.scale >= 0 &&
    row.scale <= 4096 &&
    (row.coefficient !== "0" || row.scale === 0)
  );
}
export function isNormalizedZero(value: NormalizedDecimal | undefined): boolean {
  return value?.status === "exact" && value.coefficient === "0";
}
