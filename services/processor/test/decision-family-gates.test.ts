// The command route's delegated gates read `DECISION_FAMILIES` instead of
// spelling the three decidable families out. This freezes the two inline
// checks they replaced and proves the route's gates answer exactly as before
// for every change kind (and malformed kinds), every route, and every family
// list an envelope can carry.
import { describe, expect, test } from "bun:test";
import { CHANGE_KINDS } from "../../../packages/application/src/index.ts";
import { delegatedDecisionAllowed, delegatedPlanAllowed } from "../src/change-commands.ts";

const KINDS: readonly unknown[] = [
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
  undefined,
  null,
  1,
  ["identity.assign"],
  { kind: "identity.assign" },
];

// --- Frozen legacy checks (change-commands.ts before DECISION_FAMILIES) -----
/** `approve` and `commit`: refused `capability_not_delegated` when this is false. */
function legacyDecision(planKind: string, commandFamilies: readonly string[]): boolean {
  const family = planKind.split(".")[0];
  return !(
    (family !== "identity" && family !== "relation" && family !== "card-settlement") ||
    !commandFamilies.includes(family)
  );
}
/** `plan`: refused `unsupported_semantics` when this is false. */
function legacyPlan(kind: unknown): boolean {
  return !(
    typeof kind !== "string" ||
    !["identity", "relation", "card-settlement"].includes(kind.split(".")[0]!)
  );
}
// ----------------------------------------------------------------------------

const FAMILIES = ["plan", "card-settlement", "relation", "identity"] as const;
const subsets = <T>(items: readonly T[]): T[][] =>
  items.reduce<T[][]>((all, item) => [...all, ...all.map((s) => [...s, item])], [[]]);

describe("the command route's delegated family gates are unchanged", () => {
  for (const route of ["approve", "commit"] as const)
    test(`${route}: every plan kind under every envelope family list`, () => {
      for (const kind of KINDS.filter((k): k is string => typeof k === "string"))
        for (const families of subsets(FAMILIES))
          expect([route, kind, families, delegatedDecisionAllowed(kind, families)]).toEqual([
            route,
            kind,
            families,
            legacyDecision(kind, families),
          ]);
    });

  test("plan: every requested kind, including non-strings", () => {
    for (const kind of KINDS)
      expect([kind, delegatedPlanAllowed(kind)]).toEqual([kind, legacyPlan(kind)]);
  });

  test("the change kinds a delegated client may plan and decide, and only those", () => {
    // Plain list, so a family added to DECISION_FAMILIES shows up here as a diff.
    expect(CHANGE_KINDS.filter((kind) => delegatedPlanAllowed(kind))).toEqual([
      "identity.assign",
      "identity.release-override",
      "relation.accept",
      "relation.reject",
      "card-settlement.accept",
      "card-settlement.reject",
      "card-settlement.withdraw",
    ]);
  });
});
