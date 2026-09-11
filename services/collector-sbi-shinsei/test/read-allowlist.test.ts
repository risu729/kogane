import { describe, expect, test } from "bun:test";
import { UnsafeReadRequestError, UnverifiedReadRouteError } from "../src/errors";
import { assertReadAllowed, liveReadsEnabled, READ_ROUTE_CATALOG } from "../src/read-allowlist";
import { SbiShinseiReadTransport } from "../src/transport";

describe("SBI Shinsei read allowlist", () => {
  test("only captured routes with strict schemas are production-enabled", () => {
    expect(READ_ROUTE_CATALOG.length).toBe(17);
    expect(liveReadsEnabled()).toBeTrue();
    for (const route of READ_ROUTE_CATALOG) {
      expect(route.productionEnabled).toBe(
        route.liveValidated && route.responseSchema !== "unknown",
      );
      expect(route.method).toBe("POST");
      expect(route.origin).toBe("https://bk.web.sbishinseibank.co.jp");
    }
    expect(READ_ROUTE_CATALOG.filter((route) => route.responseSchema !== "unknown")).toHaveLength(
      6,
    );
  });

  test("an authenticated-capture route with a schema is production-enabled", () => {
    const route = READ_ROUTE_CATALOG[0];
    expect(route.liveValidated).toBeTrue();
    expect(route.evidence).toBe("authenticated-capture");
    expect(
      assertReadAllowed({
        operation: route.operation,
        method: route.method,
        url: `${route.origin}${route.path}`,
      }).operation,
    ).toBe(route.operation);
  });

  test("origin, path and query must match exactly", () => {
    const route = READ_ROUTE_CATALOG[0];
    for (const url of [
      `https://example.invalid${route.path}`,
      `${route.origin}${route.path}/extra`,
      `${route.origin}${route.path}?next=1`,
    ]) {
      expect(() =>
        assertReadAllowed({
          operation: route.operation,
          method: route.method,
          url,
        }),
      ).toThrow(UnsafeReadRequestError);
    }
  });

  test("write-looking paths are rejected independently of the catalog", () => {
    const route = READ_ROUTE_CATALOG[0];
    expect(() =>
      assertReadAllowed({
        operation: route.operation,
        method: route.method,
        url: `${route.origin}/SFC/app/TransferAdapter/executeTransfer`,
      }),
    ).toThrow(UnsafeReadRequestError);
  });

  test("read-only exchange-rate is not rejected as an FX write", () => {
    const route = READ_ROUTE_CATALOG.find(
      (candidate) => candidate.operation === "common.exchange-rate",
    );
    if (!route) throw new Error("exchange-rate route is missing");
    expect(
      assertReadAllowed({
        operation: route.operation,
        method: route.method,
        url: `${route.origin}${route.path}`,
      }).operation,
    ).toBe(route.operation);
  });

  test("direct HTTP transport performs zero fetches even for enabled browser routes", async () => {
    let fetchCount = 0;
    const transport = new SbiShinseiReadTransport({
      fetch: async () => {
        fetchCount += 1;
        return new Response("{}");
      },
      session: {
        getAuthorization: () => "synthetic-authorization",
        getCsrfToken: () => "synthetic-csrf-token",
        rotateCsrfToken: () => undefined,
      },
    });
    await expect(
      transport.call({
        operation: "top.accounts-balance-and-activity",
      }),
    ).rejects.toBeInstanceOf(UnverifiedReadRouteError);
    expect(fetchCount).toBe(0);
  });

  test("local validation profile enables only captured routes with schemas", () => {
    const captured = READ_ROUTE_CATALOG.find(
      (route) => route.operation === "top.accounts-balance-and-activity",
    );
    if (!captured) throw new Error("captured route is missing");
    expect(
      assertReadAllowed(
        {
          operation: captured.operation,
          method: captured.method,
          url: `${captured.origin}${captured.path}`,
        },
        "local-captured-validation",
      ).operation,
    ).toBe(captured.operation);

    const bundleOnly = READ_ROUTE_CATALOG.find(
      (route) => route.operation === "account.casa-activity-specific-period",
    );
    if (!bundleOnly) throw new Error("bundle-only route is missing");
    expect(() =>
      assertReadAllowed(
        {
          operation: bundleOnly.operation,
          method: bundleOnly.method,
          url: `${bundleOnly.origin}${bundleOnly.path}`,
        },
        "local-captured-validation",
      ),
    ).toThrow(UnverifiedReadRouteError);
  });
});
