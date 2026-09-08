import type { IdentityInput, IdentityPlan } from "./types.ts";
import { sbiIdentity } from "./sbi.ts";
import { otherIdentity } from "./other.ts";
export function resolveIdentity(input: IdentityInput): IdentityPlan {
  return input.sourceId === "sbi-securities" ? sbiIdentity(input) : otherIdentity(input);
}
