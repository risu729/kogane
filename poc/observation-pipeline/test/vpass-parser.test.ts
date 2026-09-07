import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParsers } from "../src/parse.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { vpassStatementPage } from "../src/parsers/vpass.ts";
import { currentTransactions } from "../src/queries.ts";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  openStore,
  putRawObject,
  upsertSource,
} from "../src/store.ts";
import type { ArtifactMeta } from "../src/types.ts";

const FIXTURES = join(
  import.meta.dir,
  "..",
  "fixtures",
  "vpass-parser-boundaries",
);

function fixture(name: "web" | "customized"): Uint8Array {
  return readFileSync(join(FIXTURES, `${name}.json`));
}

function json(name: "web" | "customized"): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<
    string,
    unknown
  >;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function artifact(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "vpass",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "statement-page",
    artifactKey: "months/202608/top-000.json",
    fetchUnitKey: "card-001",
    statementState: null,
    period: null,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

describe("Vpass canonical Layer-B parser", () => {
  test("routes only the strict canonical statement-page JSON", () => {
    expect(PARSERS.filter((parser) => parser.accepts(artifact()))).toEqual([
      vpassStatementPage,
    ]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(artifact({ dataset: "month-discovery" })),
      ),
    ).toEqual([]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(artifact({ mime: "application/json; charset=utf-8" })),
      ),
    ).toEqual([]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(artifact({ sourceId: "myjcb" })),
      ),
    ).toEqual([]);
  });

  test("maps a posted web purchase with one liability-sign inversion", () => {
    const result = vpassStatementPage.parse(fixture("web"), artifact());
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "transaction",
      sourceAccount: "vpass:card-001",
      status: "posted",
      amountMinor: -1234,
      amountText: "-1234",
      amountScale: 0,
      currency: "JPY",
      counterparty: "架空商店",
      asOf: "2026-08-15",
      rawLocator:
        "json:$.body.content.WebMeisaiTopDisplayServiceBean.meisaiList[0]",
      extra: {
        data: [
          "4K",
          "005",
          "",
          "26/08/15",
          "架空商店",
          "1,234",
          "1回払い",
          "",
          "",
          "",
          "",
        ],
        _kogane: {
          statementFamily: "web",
          providerSubtype: "4K/005",
          observationSign: "outflow-negative-inflow-positive",
        },
      },
    });
  });

  test("maps unconfirmed purchase and refund while preserving foreign fields", () => {
    const result = vpassStatementPage.parse(fixture("customized"), artifact());
    const transactions = result.observations.filter((entry) => entry.kind === "transaction");
    expect(transactions.map((entry) => entry.amountMinor)).toEqual([-2000, 1500]);
    expect(
      transactions.every((entry) => entry.status === "unconfirmed"),
    ).toBeTrue();
    expect(result.observations[1]).toMatchObject({
      sourceAccount: "vpass:card-001",
      counterparty: "架空返金",
      asOf: "2026-08-17",
      extra: {
        genchiKin: "10.00",
        kanzanRate: "150.00",
        tukaRyaku: "AUD",
        uriageKbn: "6",
        _kogane: { providerSaleCode: "6" },
      },
    });
  });

  test("keeps an observed amountless 005 row with a warning instead of guessing", () => {
    const input = json("web");
    const row = (
      (
        (input["body"] as Record<string, unknown>)["content"] as Record<
          string,
          unknown
        >
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    (row[0]!["data"] as string[])[5] = "";
    const result = vpassStatementPage.parse(encode(input), artifact());
    expect(result.observations[0]).not.toHaveProperty("amountMinor");
    expect(result.warnings).toHaveLength(1);
  });

  test("rejects failed runs, missing card identity, schema drift, unknown subtype, and invalid dates", () => {
    expect(() =>
      vpassStatementPage.parse(
        fixture("web"),
        artifact({ runStatus: "failed", runFailureCount: 1 }),
      ),
    ).toThrow(/failure-free/u);
    expect(() =>
      vpassStatementPage.parse(
        fixture("web"),
        artifact({ fetchUnitKey: null }),
      ),
    ).toThrow(/fetch unit/u);
    expect(() =>
      vpassStatementPage.parse(
        fixture("web"),
        artifact({ artifactKey: "cards/card-002/months/202608/top-000.json" }),
      ),
    ).toThrow(/card identity/u);

    const drift = json("web");
    drift["unexpected"] = true;
    expect(() => vpassStatementPage.parse(encode(drift), artifact())).toThrow(
      /schema drift/u,
    );

    const subtype = json("web");
    const rows = (
      (
        (subtype["body"] as Record<string, unknown>)["content"] as Record<
          string,
          unknown
        >
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    (rows[0]!["data"] as string[])[1] = "999";
    expect(() => vpassStatementPage.parse(encode(subtype), artifact())).toThrow(
      /subtype/u,
    );

    const controlType = json("web");
    const controlRows = (
      (
        (controlType["body"] as Record<string, unknown>)["content"] as Record<
          string,
          unknown
        >
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    controlRows[0]!["shiharaiPatternFlag"] = "0";
    expect(() =>
      vpassStatementPage.parse(encode(controlType), artifact()),
    ).toThrow(/bounded safe integer/u);

    const date = json("customized");
    const customRows = (
      (
        (date["body"] as Record<string, unknown>)["content"] as Record<
          string,
          unknown
        >
      )["CustomizedMeisaiAnsDisplayServiceBean"] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    customRows[0]!["riyouDate"] = "26/02/30";
    expect(() => vpassStatementPage.parse(encode(date), artifact())).toThrow(
      /calendar date/u,
    );
  });

  test("selects every page from the latest successful card-month snapshot, including empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-vpass-current-"));
    try {
      const store = openStore(directory);
      upsertSource(store, {
        id: "vpass",
        provider: "Vpass",
        ingestion: "collector-r2",
      });
      const addSnapshot = (
        id: string,
        fetchedAt: string,
        bytes: Uint8Array,
      ) => {
        const fetchRunId = insertFetchRun(store, {
          sourceId: "vpass",
          externalRunId: id,
          tool: "test",
          startedAt: fetchedAt,
          completedAt: fetchedAt,
          status: "success",
          failureCount: 0,
        });
        const raw = putRawObject(store, bytes, "application/json");
        insertFetchArtifact(store, {
          fetchRunId,
          sourceId: "vpass",
          dataset: "statement-page",
          artifactKey: "months/202608/top-000.json",
          fetchUnitKey: "card-001",
          mime: "application/json",
          fetchedAt,
          sha256: raw.sha256,
        });
      };
      addSnapshot("old", "2026-09-01T00:00:00.000Z", fixture("web"));
      const empty = json("web");
      const emptyBean = (
        (empty["body"] as Record<string, unknown>)["content"] as Record<
          string,
          unknown
        >
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>;
      emptyBean["meisaiList"] = [];
      addSnapshot("new", "2026-09-02T00:00:00.000Z", encode(empty));
      expect(runParsers(store, [vpassStatementPage]).errors).toBe(0);
      expect(
        currentTransactions(store).filter((row) => row.source_id === "vpass"),
      ).toEqual([]);

      const incompleteRun = insertFetchRun(store, {
        sourceId: "vpass",
        externalRunId: "incomplete-newer",
        tool: "test",
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:00.000Z",
        status: "success",
        failureCount: 0,
      });
      const bytes = fixture("web");
      const raw = putRawObject(store, bytes, "application/json");
      const firstArtifact = insertFetchArtifact(store, {
        fetchRunId: incompleteRun,
        sourceId: "vpass",
        dataset: "statement-page",
        artifactKey: "months/202608/top-000.json",
        fetchUnitKey: "card-001",
        mime: "application/json",
        fetchedAt: "2026-09-03T00:00:00.000Z",
        sha256: raw.sha256,
      });
      insertFetchArtifact(store, {
        fetchRunId: incompleteRun,
        sourceId: "vpass",
        dataset: "statement-page",
        artifactKey: "months/202608/top-001.json",
        fetchUnitKey: "card-001",
        mime: "application/json",
        fetchedAt: "2026-09-03T00:00:00.000Z",
        sha256: raw.sha256,
      });
      const partial = vpassStatementPage.parse(
        bytes,
        artifact({ id: firstArtifact, fetchedAt: "2026-09-03T00:00:00.000Z" }),
      );
      const partialParseRun = insertParseRun(store, {
        artifactId: firstArtifact,
        parserName: vpassStatementPage.name,
        parserVersion: vpassStatementPage.version,
        parsedAt: "2026-09-03T00:01:00.000Z",
        status: "ok",
        warnings: partial.warnings,
      });
      for (const observation of partial.observations)
        insertObservation(store, partialParseRun, observation);

      expect(
        currentTransactions(store).filter((row) => row.source_id === "vpass"),
      ).toEqual([]);
      expect(runParsers(store, [vpassStatementPage]).errors).toBe(0);
      expect(
        currentTransactions(store).filter((row) => row.source_id === "vpass"),
      ).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
