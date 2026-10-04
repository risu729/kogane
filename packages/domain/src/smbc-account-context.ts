// ADR 0034: the account explicitly selected by a successful authenticated
// SMBC request. This is request provenance, never a provider ownership claim.
import { hasExactKeys, isRecord } from "./guards.ts";

export interface SmbcAccountContext {
  basis: "authenticated-request-v1";
  accountType: "ordinary";
  branchCode: string;
  accountNumber: string;
}

export function validSmbcAccountContext(value: unknown): value is SmbcAccountContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["basis", "accountType", "branchCode", "accountNumber"]) &&
    value.basis === "authenticated-request-v1" &&
    value.accountType === "ordinary" &&
    typeof value.branchCode === "string" &&
    /^[0-9]{3}$/u.test(value.branchCode) &&
    typeof value.accountNumber === "string" &&
    /^[0-9]{7}$/u.test(value.accountNumber)
  );
}

/** SMBC requests pad the branch to four digits; retain its three-digit code.
 * Unknown layouts supply no comparison evidence. Never pad an account number,
 * read a password, or turn a login into an ownership assertion. */
export function smbcAccountContext(branch: string, account: string): SmbcAccountContext | null {
  const branchCode = /^(?:0)?([0-9]{3})$/u.exec(branch)?.[1];
  if (branchCode === undefined || !/^[0-9]{7}$/u.test(account)) return null;
  return {
    basis: "authenticated-request-v1",
    accountType: "ordinary",
    branchCode,
    accountNumber: account,
  };
}
