// The shared schema is the contract. Its shape is pinned here and again in
// services/evidence-browser/test/conformance.test.ts, so a change to what a
// server accepts or a client sends must be made in the schema and visible in
// both packages' tests; a one-sided edit fails.
import { describe, expect, test } from "bun:test";
import type { ApiMetadata } from "../shared/api-contract.ts";
import { validApiCapabilities, validApiResponse } from "../shared/api-validation.ts";
import {
  allowedQueryParameters,
  CENTRAL_STORE_CAPABILITIES,
  LIST_REQUEST_SCHEMA,
  listRequestSearch,
  LOCAL_STORE_CAPABILITIES,
  validIdentityReadMode,
  type ApiCapabilities,
} from "../shared/api-schema.ts";
import { capabilityState, clientFeatures, NO_FEATURES } from "../web/src/capabilities.ts";

describe("shared API schema", () => {
  test("the request schema and capability objects match their pinned contract", () => {
    expect(LIST_REQUEST_SCHEMA).toEqual({
      "/api/transactions": {
        source: "collectionFilters",
        account: "collectionFilters",
        from: "collectionFilters",
        to: "collectionFilters",
        q: "collectionFilters",
        offset: "paginationVersion:offset-v1",
        identityRead: "identityReadModes",
      },
      "/api/balances": {
        source: "collectionFilters",
        account: "collectionFilters",
        instrument: "collectionFilters",
        metric: "collectionFilters",
        view: "measureViews",
        offset: "paginationVersion:offset-v1",
        latestOffset: "paginationVersion:offset-v1",
        identityRead: "identityReadModes",
      },
      "/api/positions": {
        source: "collectionFilters",
        account: "collectionFilters",
        offset: "paginationVersion:offset-v1",
        identityRead: "identityReadModes",
      },
      "/api/artifacts": { source: "collectionFilters", cursor: "paginationVersion:offset-v1" },
      "/api/filter-options": { kind: "collectionFilters", view: "measureViews" },
    });
    expect(LOCAL_STORE_CAPABILITIES).toEqual({
      contractVersion: "observation-api-v1",
      readOnly: true,
      rawEvidence: true,
      liveCollectors: false,
      measureViews: [],
      identityReadModes: [],
      paginationVersion: "none",
      collectionFilters: false,
      organizedDisplay: false,
      financialProducts: false,
      evidenceHistory: false,
    });
    expect(CENTRAL_STORE_CAPABILITIES).toEqual({
      contractVersion: "observation-api-v1",
      readOnly: true,
      rawEvidence: true,
      liveCollectors: false,
      measureViews: ["balances", "summaries"],
      identityReadModes: ["latest", "as-recorded"],
      paginationVersion: "offset-v1",
      collectionFilters: true,
      organizedDisplay: true,
      financialProducts: true,
      evidenceHistory: true,
    });
  });

  test("servers derive accepted parameters from the same table the client sends from", () => {
    expect(allowedQueryParameters("/api/balances", CENTRAL_STORE_CAPABILITIES)).toEqual([
      "source",
      "account",
      "instrument",
      "metric",
      "view",
      "offset",
      "latestOffset",
      "identityRead",
    ]);
    expect(allowedQueryParameters("/api/artifacts", CENTRAL_STORE_CAPABILITIES)).toEqual([
      "source",
      "cursor",
    ]);
    // A read mode is sent only when advertised, and only an advertised one.
    const modes = new URLSearchParams("identityRead=as-recorded");
    expect(listRequestSearch("/api/positions", CENTRAL_STORE_CAPABILITIES, modes)).toBe(
      "?identityRead=as-recorded",
    );
    expect(
      listRequestSearch(
        "/api/positions",
        { ...CENTRAL_STORE_CAPABILITIES, identityReadModes: ["latest"] },
        modes,
      ),
    ).toBe("");
    expect(
      listRequestSearch(
        "/api/positions",
        CENTRAL_STORE_CAPABILITIES,
        new URLSearchParams("identityRead=snapshot"),
      ),
    ).toBe("");
    expect(listRequestSearch("/api/positions", LOCAL_STORE_CAPABILITIES, modes)).toBe("");
    expect(validIdentityReadMode("as-recorded", CENTRAL_STORE_CAPABILITIES)).toBe(true);
    expect(validIdentityReadMode("snapshot", CENTRAL_STORE_CAPABILITIES)).toBe(false);
    expect(validIdentityReadMode("latest", LOCAL_STORE_CAPABILITIES)).toBe(false);
    for (const path of Object.keys(LIST_REQUEST_SCHEMA))
      expect(allowedQueryParameters(path, LOCAL_STORE_CAPABILITIES)).toEqual([]);
    for (const path of ["/api/meta", "/api/overview", "/api/artifacts/1", "/api/raw/a"])
      expect(allowedQueryParameters(path, CENTRAL_STORE_CAPABILITIES)).toEqual([]);
    const params = new URLSearchParams(
      "cursor=1&source=demo-bank&account=x&unexpected=1&view=balances&source=other",
    );
    expect(listRequestSearch("/api/artifacts", CENTRAL_STORE_CAPABILITIES, params)).toBe(
      "?source=demo-bank&cursor=1",
    );
    expect(listRequestSearch("/api/balances", CENTRAL_STORE_CAPABILITIES, params)).toBe(
      "?source=demo-bank&account=x&view=balances",
    );
    expect(listRequestSearch("/api/balances", LOCAL_STORE_CAPABILITIES, params)).toBe("");
    const partial: ApiCapabilities = { ...CENTRAL_STORE_CAPABILITIES, measureViews: ["balances"] };
    expect(listRequestSearch("/api/balances", partial, new URLSearchParams("view=summaries"))).toBe(
      "",
    );
    expect(
      listRequestSearch("/api/filter-options", partial, new URLSearchParams("kind=balances&view=")),
    ).toBe("?kind=balances");
  });

  test("the metadata validator rejects capability objects outside the schema", () => {
    const metadata: ApiMetadata = {
      apiVersion: 1,
      source: { kind: "local-store", classification: "unknown" },
      capabilities: LOCAL_STORE_CAPABILITIES,
    };
    expect(validApiResponse("/api/meta", metadata)).toBe(true);
    expect(
      validApiResponse("/api/meta", { ...metadata, capabilities: CENTRAL_STORE_CAPABILITIES }),
    ).toBe(true);
    const legacy = { readOnly: true, rawEvidence: true, liveCollectors: false };
    expect(validApiResponse("/api/meta", { ...metadata, capabilities: legacy })).toBe(false);
    for (const broken of [
      { contractVersion: "observation-api-v2" },
      { measureViews: ["balances", "balances"] },
      { measureViews: ["totals"] },
      { identityReadModes: ["snapshot"] },
      { identityReadModes: ["latest", "latest"] },
      { paginationVersion: "keyset-v2" },
      { collectionFilters: "yes" },
      { readOnly: false },
      { liveCollectors: true },
    ])
      expect(validApiCapabilities({ ...CENTRAL_STORE_CAPABILITIES, ...broken })).toBe(false);
    for (const kind of ["central-store", "archive-store", "x"])
      expect(
        validApiResponse("/api/meta", { ...metadata, source: { ...metadata.source, kind } }),
      ).toBe(true);
    for (const kind of ["", "Central Store", "-x", 1])
      expect(
        validApiResponse("/api/meta", { ...metadata, source: { ...metadata.source, kind } }),
      ).toBe(false);
  });
});

describe("client behaviour depends on capabilities, never on the connection name", () => {
  const metadata = (kind: string, capabilities: ApiCapabilities): ApiMetadata => ({
    apiVersion: 1,
    source: { kind, classification: "financial" },
    capabilities,
  });
  test("renaming the source kind leaves every feature and request unchanged", () => {
    for (const capabilities of [CENTRAL_STORE_CAPABILITIES, LOCAL_STORE_CAPABILITIES]) {
      const named = capabilityState(metadata("central-store", capabilities));
      const renamed = capabilityState(metadata("renamed-store", capabilities));
      const local = capabilityState(metadata("local-store", capabilities));
      expect(named.known && renamed.known && local.known).toBe(true);
      expect(clientFeatures(renamed.capabilities!)).toEqual(clientFeatures(named.capabilities!));
      expect(clientFeatures(local.capabilities!)).toEqual(clientFeatures(named.capabilities!));
      const params = new URLSearchParams("source=demo-bank&view=summaries");
      expect(listRequestSearch("/api/balances", renamed.capabilities!, params)).toBe(
        listRequestSearch("/api/balances", named.capabilities!, params),
      );
    }
  });
  test("different capabilities under the same name behave differently", () => {
    const central = clientFeatures(CENTRAL_STORE_CAPABILITIES);
    const local = clientFeatures(LOCAL_STORE_CAPABILITIES);
    expect(central).toEqual({
      serverFilters: true,
      serverPaging: true,
      identities: true,
      evidenceHistory: true,
    });
    expect(local).toEqual(NO_FEATURES);
    expect(
      clientFeatures({ ...CENTRAL_STORE_CAPABILITIES, identityReadModes: [] }).identities,
    ).toBe(false);
  });
  test("capabilities are unknown while metadata is loading and no feature is assumed", () => {
    expect(capabilityState(undefined)).toEqual({ known: false });
    expect(NO_FEATURES).toEqual({
      serverFilters: false,
      serverPaging: false,
      identities: false,
      evidenceHistory: false,
    });
  });
});
