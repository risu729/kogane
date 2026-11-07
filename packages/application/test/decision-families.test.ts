// `DECISION_FAMILIES` is the one list of change-kind families an MCP client
// may plan, approve and commit. The App's decision tools, the delegated
// envelope and the Processor's command route used to spell the three families
// out each on its own; this file freezes those spellings and proves the
// derived gates in this package answer exactly as they did, for every change
// kind and a set of malformed kinds.
import { describe, expect, test } from "bun:test";
import type { OperationCall } from "../src/audit/call.ts";
import { CHANGE_KINDS } from "../src/command/contract.ts";
import {
  DECISION_CAPABILITIES,
  DECISION_FAMILIES,
  DELEGATION_CAPABILITIES,
  decisionFamilyOf,
  type DelegatedPrincipal,
} from "../src/delegation/contract.ts";
import {
  delegatedCommandFamilyAllowed,
  executionFor,
  validDelegatedExecution,
} from "../src/delegation/execution.ts";

/** Every change kind, then kinds no planner accepts but a gate must still answer. */
const GATE_KINDS: readonly string[] = [
  ...CHANGE_KINDS,
  "",
  ".",
  "identity",
  "relation.",
  "card-settlement.unknown-verb",
  "identity.assign.extra",
  "card-settlementx.accept",
  "Identity.assign",
  "plan.accept",
  "__proto__.accept",
  "constructor.accept",
  ".identity",
  " identity.assign",
];

// --- Frozen legacy spellings (before DECISION_FAMILIES) ---------------------
const LEGACY_DELEGATION_CAPABILITIES = [
  "commands.plan",
  "commands.decide.card-settlement",
  "commands.decide.relation",
  "commands.decide.identity",
  "schedules.maintenance.update",
  "schedules.survey.decide",
  "schedules.job.update",
  "operations.import.request",
  "operations.replay.request",
  "operations.projection.request",
  "operations.collection.request",
  "operations.session.refresh",
  "operations.read",
];
function legacyCommandFamilies(capabilities: readonly string[]): string[] {
  return [
    ...(capabilities.includes("commands.plan") ? ["plan" as const] : []),
    ...(capabilities.includes("commands.decide.card-settlement")
      ? ["card-settlement" as const]
      : []),
    ...(capabilities.includes("commands.decide.relation") ? ["relation" as const] : []),
    ...(capabilities.includes("commands.decide.identity") ? ["identity" as const] : []),
  ];
}
function legacyFamiliesValid(v: { commandFamilies: unknown }): boolean {
  return (
    Array.isArray(v.commandFamilies) &&
    v.commandFamilies.length <= 4 &&
    new Set(v.commandFamilies).size === v.commandFamilies.length &&
    v.commandFamilies.every((f) =>
      ["plan", "card-settlement", "relation", "identity"].includes(String(f)),
    )
  );
}
function legacyFamilyAllowed(call: OperationCall | undefined, kind: string): boolean {
  const family = kind.split(".")[0];
  return (
    call?.actor.principalKind === "delegated" &&
    call.step === "confirm" &&
    !!call.delegatedExecution?.confirmsAuditId &&
    (family === "identity" || family === "relation" || family === "card-settlement") &&
    call.delegatedExecution.commandFamilies.includes(family)
  );
}
// ----------------------------------------------------------------------------

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => [...all, ...all.map((s) => [...s, item])], [[]]);
}
const COMMAND_CAPABILITIES = LEGACY_DELEGATION_CAPABILITIES.slice(0, 4);
const OTHER_CAPABILITIES = LEGACY_DELEGATION_CAPABILITIES.slice(4);
const FAMILY_WORDS = ["plan", "card-settlement", "relation", "identity", "card-purchase"];

const principal = (capabilities: readonly string[]): DelegatedPrincipal => ({
  kind: "delegated",
  id: "mcp-client:owner-synthetic",
  delegator: "owner-synthetic",
  capabilities: capabilities as DelegatedPrincipal["capabilities"],
  scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
  notAfter: "2026-10-09T00:10:00.000Z",
  delegationRef: `dlg_${"0".repeat(64)}`,
  budget: { writesPerDay: 200 },
});

describe("DECISION_FAMILIES is the one decidable-family list", () => {
  test("the capability vocabulary is byte-identical to the spelled-out list it replaced", () => {
    expect(JSON.stringify(DELEGATION_CAPABILITIES)).toBe(
      JSON.stringify(LEGACY_DELEGATION_CAPABILITIES),
    );
    expect(DECISION_CAPABILITIES).toEqual(DECISION_FAMILIES.map((f) => `commands.decide.${f}`));
  });

  test("decisionFamilyOf answers every kind as the three spelled-out comparisons did", () => {
    for (const kind of GATE_KINDS) {
      const family = kind.split(".")[0];
      const legacy =
        family === "identity" || family === "relation" || family === "card-settlement"
          ? family
          : null;
      expect([kind, decisionFamilyOf(kind)]).toEqual([kind, legacy]);
    }
  });

  test("executionFor attenuates commandFamilies exactly as before, for every capability subset", () => {
    for (const held of subsets(COMMAND_CAPABILITIES)) {
      for (const others of [[], OTHER_CAPABILITIES]) {
        const capabilities = [...others, ...held];
        const families = executionFor(principal(capabilities)).commandFamilies;
        expect(JSON.stringify(families)).toBe(JSON.stringify(legacyCommandFamilies(capabilities)));
      }
    }
  });

  test("validDelegatedExecution accepts exactly the family lists it accepted before", () => {
    const base = executionFor(principal(LEGACY_DELEGATION_CAPABILITIES));
    const lists: unknown[][] = [];
    for (const subset of subsets(FAMILY_WORDS)) lists.push(subset, [...subset].reverse());
    lists.push(["plan", "plan"], ["relation", "relation"], [1], [null], ["Plan"]);
    for (const commandFamilies of lists) {
      const value = { ...base, commandFamilies };
      expect([commandFamilies, validDelegatedExecution(value)]).toEqual([
        commandFamilies,
        legacyFamiliesValid(value),
      ]);
    }
  });

  test("delegatedCommandFamilyAllowed decides every kind, call shape and family list as before", () => {
    const calls: (OperationCall | undefined)[] = [undefined];
    for (const commandFamilies of subsets(FAMILY_WORDS.slice(0, 4)))
      for (const principalKind of ["delegated", "agent"])
        for (const step of ["confirm", "prepare"])
          for (const confirmsAuditId of [`aud_${"0".repeat(8)}`, undefined])
            calls.push({
              actor: { principalKind },
              step,
              delegatedExecution: { commandFamilies, confirmsAuditId },
            } as unknown as OperationCall);
    for (const kind of GATE_KINDS)
      for (const call of calls)
        expect([kind, delegatedCommandFamilyAllowed(call, kind)]).toEqual([
          kind,
          legacyFamilyAllowed(call, kind),
        ]);
  });
});
