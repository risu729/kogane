import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ingestRunDirectory } from "../src/ingest.ts";
import { runParsers } from "../src/parse.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { currentTransactions, latestBalances } from "../src/queries.ts";
import { openStore } from "../src/store.ts";
import { vPointBalanceInfo, vPointHistoryPage, vPointSmfgPoint } from "../src/parsers/v-point.ts";
import type { ArtifactMeta } from "../src/types.ts";

const fixture = (name: string): Uint8Array =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "v-point", `${name}.json`));
const meta = (dataset: string, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "v-point",
  runStatus: "success",
  runFailureCount: 0,
  dataset,
  url: null,
  mime: "application/json",
  fetchedAt: "2099-01-05T00:00:00.000Z",
  sha256: "0".repeat(64),
  ...overrides,
});
const mutate = (name: string, edit: (value: Record<string, any>) => void): Uint8Array => {
  const value = JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, any>;
  edit(value);
  return new TextEncoder().encode(JSON.stringify(value));
};

describe("V Point Layer B routing and run gate", () => {
  test("registers exactly the three financial Layer-A artifact families", () => {
    for (const dataset of ["balance-info", "smfg-point", "history-page-0001"]) {
      expect(PARSERS.filter((parser) => parser.accepts(meta(dataset)))).toHaveLength(1);
    }
    for (const dataset of ["vmoney-history-page-0001", "collection-summary"]) {
      expect(PARSERS.filter((parser) => parser.accepts(meta(dataset)))).toHaveLength(0);
    }
    expect(vPointBalanceInfo.accepts(meta("balance-info", { mime: "text/json" }))).toBe(false);
  });

  test("failed and partial runs emit no observations even when called directly", () => {
    for (const parser of [vPointBalanceInfo, vPointSmfgPoint, vPointHistoryPage]) {
      const dataset =
        parser === vPointBalanceInfo
          ? "balance-info"
          : parser === vPointSmfgPoint
            ? "smfg-point"
            : "history-page-0001";
      expect(() => parser.parse(fixture(dataset), meta(dataset, { runStatus: "failed" }))).toThrow(
        /successful failure-free/u,
      );
      expect(() => parser.parse(fixture(dataset), meta(dataset, { runFailureCount: 1 }))).toThrow(
        /successful failure-free/u,
      );
    }
  });

  test("current queries use only the newest complete id-less snapshot", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-v-point-current-")));
    ingestRunDirectory(store, runFixture("00000000-0000-4000-8000-000000000001", false), {
      id: "v-point",
      provider: "V Point",
    });
    runParsers(store);
    ingestRunDirectory(store, runFixture("00000000-0000-4000-8000-000000000002", true), {
      id: "v-point",
      provider: "V Point",
    });
    runParsers(store);
    expect(currentTransactions(store).filter((row) => row.source_id === "v-point")).toHaveLength(1);
    expect(latestBalances(store).filter((row) => row.source_id === "v-point")).toHaveLength(3);
  });
});

function runFixture(runId: string, newest: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), "kogane-v-point-run-"));
  const values: Record<string, Record<string, any>> = Object.fromEntries(
    ["balance-info", "smfg-point", "history-page-0001"].map((name) => [
      name,
      JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, any>,
    ]),
  );
  if (newest) {
    values["balance-info"]!.results.common = values["balance-info"]!.results.common.slice(0, 1);
    values["balance-info"]!.results.store = [];
    values["history-page-0001"]!.results.history =
      values["history-page-0001"]!.results.history.slice(1);
    values["history-page-0001"]!.results.total = 1;
  }
  const artifacts = Object.entries(values).map(([dataset, value]) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    writeFileSync(join(directory, `${dataset}.json`), bytes);
    return {
      dataset,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    };
  });
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: "vpoint-worker-poc-v2",
      source: "v-point",
      runId,
      startedAt: newest ? "2099-01-06T00:00:00.000Z" : "2099-01-05T00:00:00.000Z",
      completedAt: newest ? "2099-01-06T00:00:02.000Z" : "2099-01-05T00:00:02.000Z",
      status: "success",
      artifacts,
      failures: [],
    }),
  );
  return directory;
}

describe("V Point balances", () => {
  test("preserves every expiry bucket and numeric enum without assigning enum meanings", () => {
    const parsed = vPointBalanceInfo.parse(fixture("balance-info"), meta("balance-info"));
    expect(parsed.observations).toHaveLength(3);
    expect(
      parsed.observations.map((value) => ("amountMinor" in value ? value.amountMinor : null)),
    ).toEqual([120, 30, 20]);
    expect(parsed.observations[0]).toMatchObject({
      kind: "balance",
      sourceAccount: "v-point:common:bucket-0",
      metric: "available_point_bucket",
      instrument: "V_POINT",
      rawLocator: "json:$.results.common[0]",
      extra: {
        point_type: 7,
        _kogane: { pointType: 7, pointTypeMeaning: "unmapped-provider-enum", getMonth: 4 },
      },
    });
    expect(parsed.observations[2]).toMatchObject({
      sourceAccount: "v-point:store-limited:group-0:item-0",
      extra: { allianceName: "ANONYMOUS ALLIANCE" },
    });
  });

  test("keeps the two SMFG displays separate without claiming their accounting meaning", () => {
    const parsed = vPointSmfgPoint.parse(fixture("smfg-point"), meta("smfg-point"));
    expect(
      parsed.observations.map((value) => [
        value.sourceAccount,
        "amountMinor" in value ? value.amountMinor : null,
      ]),
    ).toEqual([
      ["v-point:smfg:smbc", 11],
      ["v-point:smfg:smcc", 22],
    ]);
    expect(
      parsed.observations.every(
        (value) =>
          (value.extra._kogane as Record<string, unknown>).providerBreakdownMeaning ===
          "not-inferred",
      ),
    ).toBe(true);
  });

  test("fails closed on envelope, nested schema, type, and non-empty V Money drift", () => {
    expect(() =>
      vPointBalanceInfo.parse(
        mutate("balance-info", (v) => {
          v.extra = true;
        }),
        meta("balance-info"),
      ),
    ).toThrow(/schema drift/u);
    expect(() =>
      vPointBalanceInfo.parse(
        mutate("balance-info", (v) => {
          v.results.common[0].extra = true;
        }),
        meta("balance-info"),
      ),
    ).toThrow(/schema drift/u);
    expect(() =>
      vPointBalanceInfo.parse(
        mutate("balance-info", (v) => {
          v.results.common[0].point = "120";
        }),
        meta("balance-info"),
      ),
    ).toThrow(/safe integer/u);
    expect(() =>
      vPointBalanceInfo.parse(
        mutate("balance-info", (v) => {
          v.results.tmoney = { point: 1 };
        }),
        meta("balance-info"),
      ),
    ).toThrow(/schema drift/u);
  });
});

describe("V Point history", () => {
  test("uses the provider point sign, preserves numeric enums, and invents no stable id", () => {
    const parsed = vPointHistoryPage.parse(fixture("history-page-0001"), meta("history-page-0001"));
    expect(parsed.observations).toHaveLength(2);
    expect(
      parsed.observations.map((value) => ("amountMinor" in value ? value.amountMinor : null)),
    ).toEqual([-40, 65]);
    expect(parsed.observations[0]).toMatchObject({
      kind: "transaction",
      sourceAccount: "v-point:member",
      currency: "V_POINT",
      asOf: "2099-01-02",
      description: "ANONYMOUS USE",
      counterparty: "ANONYMOUS STORE",
      rawLocator: "json:$.results.history[0]",
      extra: {
        point_div: 91,
        point_type: 37,
        _kogane: {
          pointDivisionMeaning: "unmapped-provider-enum",
          pointTypeMeaning: "unmapped-provider-enum",
          amountSignOrigin: "provider-point-field",
          providerStableId: "unavailable",
        },
      },
    });
    expect(parsed.observations[1]).toMatchObject({ asOf: "2099-01-04" });
    expect(parsed.observations.every((value) => !("externalId" in value))).toBe(true);
  });

  test("retains identical occurrences rather than deduplicating an id-less provider row", () => {
    const duplicated = mutate("history-page-0001", (v) => {
      v.results.history = [v.results.history[0], v.results.history[0]];
      v.results.total = 2;
    });
    const parsed = vPointHistoryPage.parse(duplicated, meta("history-page-0001"));
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.observations[0]).not.toHaveProperty("externalId");
    expect(parsed.observations[1]).not.toHaveProperty("externalId");
    expect(parsed.observations.map((value) => value.rawLocator)).toEqual([
      "json:$.results.history[0]",
      "json:$.results.history[1]",
    ]);
  });

  test("fails closed on pagination, calendar, graph, row schema, and enum type drift", () => {
    expect(() =>
      vPointHistoryPage.parse(fixture("history-page-0001"), meta("history-page-0002")),
    ).toThrow(/pagination/u);
    expect(() =>
      vPointHistoryPage.parse(
        mutate("history-page-0001", (v) => {
          v.results.history[0].date_use = "20990230";
        }),
        meta("history-page-0001"),
      ),
    ).toThrow(/calendar date/u);
    expect(() =>
      vPointHistoryPage.parse(
        mutate("history-page-0001", (v) => {
          v.results.graph.monthly[0].extra = 1;
        }),
        meta("history-page-0001"),
      ),
    ).toThrow(/schema drift/u);
    expect(() =>
      vPointHistoryPage.parse(
        mutate("history-page-0001", (v) => {
          delete v.results.history[0].reason;
        }),
        meta("history-page-0001"),
      ),
    ).toThrow(/missing reason/u);
    expect(() =>
      vPointHistoryPage.parse(
        mutate("history-page-0001", (v) => {
          v.results.history[0].point_div = "91";
        }),
        meta("history-page-0001"),
      ),
    ).toThrow(/safe integer/u);
  });
});
