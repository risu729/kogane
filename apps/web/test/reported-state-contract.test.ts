// The wire contract of `GET /api/v2/reported-state` against answers the query
// itself produces (packages/application/test/reported-state-world.ts): a
// valid answer passes, and an answer that adds a total, claims complete
// liabilities or computes net assets is refused rather than displayed.
import { describe, expect, test } from "bun:test";
import {
  reportedStateBody,
  reportedStateWorld,
} from "../../../packages/application/test/reported-state-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  validApiCapabilities,
  validApiResponse,
} from "../../../packages/observation-shared/src/api-validation.ts";
import { validReportedState } from "../../../packages/observation-shared/src/reported-state-contract.ts";
import { clientFeatures } from "../src/capabilities.ts";
import { tokyoToday } from "../src/reported-state-api.ts";
import { matchRoute } from "../src/router.tsx";

const PATH = "/api/v2/reported-state";

describe("reported state HTTP contract", () => {
  test("the query's answers are valid on every date", async () => {
    const store = reportedStateWorld();
    for (const date of ["2026-09-01", "2026-09-08", "2026-09-10", "2026-09-26"]) {
      const body = await reportedStateBody(store, date);
      expect(validApiResponse(PATH, body)).toBe(true);
    }
    const body = await reportedStateBody(store, "2026-09-10");
    expect(body.accounts.length).toBeGreaterThan(0);
    expect(body.payables.length).toBeGreaterThan(0);
  });

  test("a figure the contract does not name is refused", async () => {
    const body = await reportedStateBody(reportedStateWorld(), "2026-09-10");
    const mutate = (change: (copy: Record<string, any>) => void): boolean => {
      const copy = structuredClone(body) as Record<string, any>;
      change(copy);
      return validReportedState(copy);
    };
    expect(mutate(() => {})).toBe(true);
    expect(mutate((copy) => (copy["total"] = "80000"))).toBe(false);
    expect(mutate((copy) => (copy["accounts"][0]["subtotal"] = "1"))).toBe(false);
    expect(mutate((copy) => (copy["coverage"]["liabilitiesCoverage"] = "complete"))).toBe(false);
    expect(mutate((copy) => (copy["coverage"]["netAssets"] = "80000"))).toBe(false);
    expect(mutate((copy) => (copy["coverage"]["liabilitiesMissing"] = []))).toBe(false);
    expect(mutate((copy) => (copy["payables"][0]["status"] = "paid"))).toBe(false);
    expect(mutate((copy) => (copy["accounts"][0]["snapshots"] = []))).toBe(false);
    expect(mutate((copy) => (copy["accounts"][0]["snapshots"][0]["freshness"] = "fresh"))).toBe(
      false,
    );
    expect(mutate((copy) => delete copy["coverage"])).toBe(false);
  });

  test("the capability, the feature and the route", () => {
    expect(validApiCapabilities({ ...CENTRAL_STORE_CAPABILITIES, reportedStateOnDate: true })).toBe(
      true,
    );
    expect(clientFeatures(CENTRAL_STORE_CAPABILITIES).reportedStateOnDate).toBe(false);
    expect(
      clientFeatures({ ...CENTRAL_STORE_CAPABILITIES, reportedStateOnDate: true })
        .reportedStateOnDate,
    ).toBe(true);
    expect(matchRoute("/state")).toEqual({ name: "reportedState" });
    expect(matchRoute("/state/2026-09-10")).toEqual({
      name: "notFound",
      path: "/state/2026-09-10",
    });
  });

  test("today is asked in Asia/Tokyo", () => {
    // 23:30 UTC on 9/9 is 08:30 on 9/10 in Tokyo.
    expect(tokyoToday(Date.parse("2026-09-09T23:30:00Z"))).toBe("2026-09-10");
    expect(tokyoToday(Date.parse("2026-09-10T14:59:59Z"))).toBe("2026-09-10");
    expect(tokyoToday(Date.parse("2026-09-10T15:00:00Z"))).toBe("2026-09-11");
  });
});
