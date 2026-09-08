import type { AccountConnection } from "./account-connections";

/** A reviewed provider name describes an MF connection, never a leaf account. */
export function connectionAccountLabel(
  currentLabel: string,
  method: "rule" | "manual",
  source: string,
  connection: AccountConnection | undefined,
): string {
  return source === "moneyforward-me" &&
    method !== "manual" &&
    connection &&
    connection.status !== "evidence-ineligible"
    ? `${connection.label}（個別口座未確定）`
    : currentLabel;
}
