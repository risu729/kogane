import type { SbiShinseiCredential } from "./types";

export function parseCredential(value: string): SbiShinseiCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SBI Shinsei credential secret is not valid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, [
    "branchNumber",
    "accountNumber",
    "powerDirectPassword",
  ])) {
    throw new Error("SBI Shinsei credential secret has an invalid shape");
  }
  if (
    typeof parsed.branchNumber !== "string" ||
    !/^\d+$/u.test(parsed.branchNumber) ||
    typeof parsed.accountNumber !== "string" ||
    !/^\d+$/u.test(parsed.accountNumber) ||
    typeof parsed.powerDirectPassword !== "string" ||
    parsed.powerDirectPassword.length === 0
  ) {
    throw new Error("SBI Shinsei credential secret has invalid fields");
  }
  return {
    branchNumber: parsed.branchNumber,
    accountNumber: parsed.accountNumber,
    powerDirectPassword: parsed.powerDirectPassword,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}
