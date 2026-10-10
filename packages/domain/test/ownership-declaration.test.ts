import { expect, test } from "bun:test";
import { ownershipDeclarationRef, readOwnershipDeclaration } from "../src/ownership-declaration.ts";
import { ownershipReviewRequested } from "../src/ownership-review.ts";

test("a self-declaration records a sole-personal role and date, never provider verification", () => {
  for (const role of ["liable_party", "beneficial_owner"] as const) {
    const ref = ownershipDeclarationRef(role, "2028-02-29")!;
    expect(readOwnershipDeclaration(["balance:1", ref])).toEqual({
      kind: "self-declared",
      scope: "sole-personal",
      role,
      declaredOn: "2028-02-29",
      providerNameVerified: false,
    });
    expect(ownershipReviewRequested([ref])).toBe(true);
  }
  expect(readOwnershipDeclaration(["balance:1"])).toEqual({ kind: "absent" });
  expect(ownershipDeclarationRef("liable_party", "2027-02-29")).toBeNull();
});

test("the reserved provenance namespace fails closed on malformed, multiple or unsupported claims", () => {
  const valid = ownershipDeclarationRef("liable_party", "2026-10-10")!;
  for (const refs of [
    ["ownership-declaration:"],
    [valid, valid],
    [valid, ownershipDeclarationRef("beneficial_owner", "2026-10-10")!],
    [valid.replace("sole-personal-v1", "joint-v1")],
    [valid.replace("sole-personal-v1", "provider-verified-v1")],
    [valid.replace("liable_party", "owner")],
    [valid.replace("2026-10-10", "2026-02-30")],
    [valid + ":verified"],
  ]) {
    expect(readOwnershipDeclaration(refs)).toEqual({ kind: "invalid" });
    expect(ownershipReviewRequested(refs)).toBe(true);
  }
});
