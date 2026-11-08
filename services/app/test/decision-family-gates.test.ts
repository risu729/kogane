// `kogane.command.approve` and `.commit` derive the capability a plan's kind
// needs from `DECISION_FAMILIES` instead of three spelled-out comparisons.
// This freezes the function it replaced and proves the derived one answers
// exactly as before for every change kind, malformed kinds, and both tools.
import { describe, expect, it } from "vitest";
import { CHANGE_KINDS, DelegatedOperationError } from "../../../packages/application/src/index";
import {
  decisionCapabilityFor,
  EXECUTABLE_DECISION_CAPABILITIES,
} from "../src/delegated-decision-tools";

const KINDS: readonly string[] = [
  ...CHANGE_KINDS,
  "",
  ".",
  "identity",
  "relation.",
  "card-settlement.unknown-verb",
  "card-settlementx.accept",
  "Identity.assign",
  "plan.accept",
  "__proto__.accept",
  ".identity",
];

// --- Frozen legacy (delegated-decision-tools.ts before DECISION_FAMILIES) ---
const LEGACY_EXECUTABLE_DECISION_CAPABILITIES = [
  "commands.decide.card-settlement",
  "commands.decide.relation",
  "commands.decide.identity",
];
function legacyCapability(kind: string): string {
  const family = kind.split(".")[0];
  if (family === "identity" || family === "relation" || family === "card-settlement")
    return `commands.decide.${family}`;
  throw new DelegatedOperationError("operation_not_delegable");
}
// ----------------------------------------------------------------------------

function outcome(gate: (kind: string) => string, kind: string): unknown {
  try {
    return { capability: gate(kind) };
  } catch (error) {
    return error instanceof DelegatedOperationError ? { refused: error.code } : { threw: error };
  }
}

describe("the decision tools' capability gate is unchanged", () => {
  it("lists the same capabilities, in the same order", () => {
    expect([...EXECUTABLE_DECISION_CAPABILITIES]).toEqual(LEGACY_EXECUTABLE_DECISION_CAPABILITIES);
  });

  for (const tool of ["kogane.command.approve", "kogane.command.commit"])
    it(`${tool} requires the same capability, or refuses with the same code, for every kind`, () => {
      for (const kind of KINDS)
        expect([tool, kind, outcome(decisionCapabilityFor, kind)]).toEqual([
          tool,
          kind,
          outcome(legacyCapability, kind),
        ]);
    });
});
