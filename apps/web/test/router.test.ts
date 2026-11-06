import { describe, expect, test } from "bun:test";
import { matchRoute } from "../src/router.tsx";

describe("route matching", () => {
  test("one trailing slash opens the same route on every path, not only segment routes", () => {
    const purchase = `purchase_${"a".repeat(64)}`;
    for (const path of [
      "/transactions",
      "/artifacts/7",
      "/observations/balance/3",
      `/confirm/${"c".repeat(64)}`,
      `/purchases/${purchase}`,
      "/reconciliation/card-settlement-synthetic/ownership",
    ])
      expect(matchRoute(`${path}/`)).toEqual(matchRoute(path));
    expect(matchRoute(`/purchases/${purchase}/`)).toEqual({ name: "purchase", eventId: purchase });
    expect(matchRoute("/reconciliation/card-settlement-synthetic/ownership/")).toEqual({
      name: "cardOwnership",
      proposalId: "card-settlement-synthetic",
    });
  });

  test("a trailing slash does not widen what an id may be", () => {
    for (const path of [
      `/purchases/purchase_${"a".repeat(64)}/extra/`,
      `/purchases/purchase_${"a".repeat(63)}/`,
      "/reconciliation/x/ownership/extra/",
      "/purchases/arbitrary/",
    ])
      expect(matchRoute(path).name).toBe("notFound");
  });
});
