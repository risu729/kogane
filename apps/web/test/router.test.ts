import { describe, expect, test } from "bun:test";
import { isEvidencePath, routeFor } from "../src/evidence-app.tsx";
import { matchRoute } from "../src/router.tsx";

describe("evidence browser route matching", () => {
  test("one trailing slash opens the same evidence route", () => {
    for (const path of ["/evidence", "/schedules", "/runs/r_1", "/runs/r_1/artifacts/a_2"]) {
      expect(routeFor(`${path}/`)).toEqual(routeFor(path));
      expect(routeFor(path).kind).not.toBe("missing");
    }
    expect(routeFor("/runs/r_1/artifacts/a_2/")).toMatchObject({
      kind: "artifact",
      runId: "r_1",
      artifactId: "a_2",
    });
    expect(isEvidencePath("/evidence/")).toBe(true);
    expect(isEvidencePath("/evidence")).toBe(true);
    expect(isEvidencePath("/runs/r_1/")).toBe(true);
  });

  test("a trailing slash does not widen the evidence ids or paths", () => {
    for (const path of ["/runs/r_0/", "/runs/r_1/artifacts/a_01/", "/runs/r_1/extra/", "/runs/"])
      expect(routeFor(path).kind).toBe("missing");
    expect(routeFor("/evidence//").kind).toBe("missing");
    for (const path of ["/evidence-x", "/evidence/x", "/evidence//", "/transactions/"])
      expect(isEvidencePath(path)).toBe(false);
  });
});

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
      "/reconciliation/card-settlement-synthetic",
    ])
      expect(matchRoute(`${path}/`)).toEqual(matchRoute(path));
    expect(matchRoute("/reconciliation/card-settlement-synthetic/")).toEqual({
      name: "reconciliationReview",
      proposalId: "card-settlement-synthetic",
    });
    expect(matchRoute("/reconciliation")).toEqual({ name: "reconciliation" });
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
      "/reconciliation/x/extra/",
      "/reconciliation/a.b/",
      `/reconciliation/${"a".repeat(129)}/`,
      "/purchases/arbitrary/",
    ])
      expect(matchRoute(path).name).toBe("notFound");
  });
});
