import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParsers } from "../src/parse.ts";
import { ingestRunDirectory } from "../src/ingest.ts";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass.ts";
import { currentTransactions } from "../src/queries.ts";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  listArtifacts,
  openStore,
  publishParseRun,
  putRawObject,
  upsertSource,
} from "../src/store.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";

const FIXTURES = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "observation-pipeline",
  "vpass-parser-boundaries",
);

function fixture(name: "web" | "customized"): Uint8Array {
  return readFileSync(join(FIXTURES, `${name}.json`));
}

function json(name: "web" | "customized"): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, unknown>;
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
    expect(PARSERS.filter((parser) => parser.accepts(artifact()))).toEqual([vpassStatementPage]);
    expect(
      PARSERS.filter((parser) => parser.accepts(artifact({ dataset: "month-discovery" }))),
    ).toEqual([]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(artifact({ mime: "application/json; charset=utf-8" })),
      ),
    ).toEqual([]);
    expect(PARSERS.filter((parser) => parser.accepts(artifact({ sourceId: "myjcb" })))).toEqual([]);
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
      rawLocator: "json:$.body.content.WebMeisaiTopDisplayServiceBean.meisaiList[0]",
      extra: {
        data: ["4K", "005", "", "26/08/15", "架空商店", "1,234", "1回払い", "", "", "", ""],
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
    expect(transactions.every((entry) => entry.status === "unconfirmed")).toBeTrue();
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
      ((input["body"] as Record<string, unknown>)["content"] as Record<string, unknown>)[
        "WebMeisaiTopDisplayServiceBean"
      ] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    (row[0]!["data"] as string[])[5] = "";
    const result = vpassStatementPage.parse(encode(input), artifact());
    expect(result.observations[0]).not.toHaveProperty("amountMinor");
    expect(result.warnings).toHaveLength(1);
  });

  test("validates every observed presentation row shape before emitting nothing", () => {
    const input = json("web");
    const rows = (
      ((input["body"] as Record<string, unknown>)["content"] as Record<string, unknown>)[
        "WebMeisaiTopDisplayServiceBean"
      ] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    rows.unshift(
      webRow("45", ["45", "ご利用明細", "", "", ""]),
      webRow("4C", ["4C", "", "合計", ""]),
      webRow("4K", ["4K", "002", "", "注記"]),
    );
    expect(vpassStatementPage.parse(encode(input), artifact()).observations).toHaveLength(1);

    const drift = structuredClone(input);
    const driftRows = (
      (
        ((drift as Record<string, unknown>)["body"] as Record<string, unknown>)[
          "content"
        ] as Record<string, unknown>
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    driftRows[0]!["maxIndex"] = "5";
    expect(() => vpassStatementPage.parse(encode(drift), artifact())).toThrow(/metadata/u);

    const missingRequired = structuredClone(input);
    const missingRows = (
      (
        ((missingRequired as Record<string, unknown>)["body"] as Record<string, unknown>)[
          "content"
        ] as Record<string, unknown>
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    (missingRows[1]!["data"] as string[])[2] = "";
    expect(() => vpassStatementPage.parse(encode(missingRequired), artifact())).toThrow(
      /non-empty/u,
    );
  });

  test("binds provider success and customized page metadata to the artifact", () => {
    const providerError = json("web");
    (providerError["header"] as Record<string, unknown>)["resultCode"] = "9999";
    expect(() => vpassStatementPage.parse(encode(providerError), artifact())).toThrow(
      /not successful/u,
    );

    expect(() =>
      vpassStatementPage.parse(
        fixture("customized"),
        artifact({ artifactKey: "months/202608/answer-000.json" }),
      ),
    ).toThrow(/page kind/u);
    expect(() =>
      vpassStatementPage.parse(
        fixture("customized"),
        artifact({ artifactKey: "months/202608/top-001.json" }),
      ),
    ).toThrow(/page kind/u);

    for (const [field, value] of [
      ["pageFlg", "2"],
      ["pageSize", "100"],
      ["responseCnt", 2],
      ["total", "2"],
      ["seikyuYM", "202607"],
    ] as const) {
      const input = json("customized");
      const bean = (
        (input["body"] as Record<string, unknown>)["content"] as Record<string, unknown>
      )["CustomizedMeisaiAnsDisplayServiceBean"] as Record<string, unknown>;
      bean[field] = value;
      expect(() => vpassStatementPage.parse(encode(input), artifact())).toThrow();
    }
  });

  test("ingests a nested Vpass manifest and carries its Layer-A unit into parsing", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-vpass-ingest-"));
    const state = mkdtempSync(join(tmpdir(), "kogane-vpass-ingest-state-"));
    try {
      mkdirSync(join(directory, "months", "202608"), { recursive: true });
      writeFileSync(join(directory, "months", "202608", "top-000.json"), fixture("web"));
      writeFileSync(
        join(directory, "manifest.json"),
        JSON.stringify({
          runId: "vpass-unit-contract",
          startedAt: "2026-09-07T00:00:00.000Z",
          completedAt: "2026-09-07T00:00:01.000Z",
          status: "success",
          failures: [],
          artifacts: [
            {
              dataset: "statement-page",
              key: "raw/vpass/2026/09/07/vpass-unit-contract/months/202608/top-000.json",
              fetchUnitKey: "card-001",
              mediaType: "application/json",
            },
          ],
        }),
      );
      const store = openStore(state);
      expect(
        ingestRunDirectory(store, directory, { id: "vpass", provider: "Vpass" }).artifacts,
      ).toBe(1);
      expect(listArtifacts(store)[0]?.fetchUnitKey).toBe("card-001");
      expect(runParsers(store, [vpassStatementPage])).toMatchObject({
        parsed: 1,
        observations: 1,
        errors: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("rejects failed runs, missing card identity, schema drift, unknown subtype, and invalid dates", () => {
    expect(() =>
      vpassStatementPage.parse(
        fixture("web"),
        artifact({ runStatus: "failed", runFailureCount: 1 }),
      ),
    ).toThrow(/failure-free/u);
    expect(() =>
      vpassStatementPage.parse(fixture("web"), artifact({ fetchUnitKey: null })),
    ).toThrow(/fetch unit/u);
    expect(() =>
      vpassStatementPage.parse(
        fixture("web"),
        artifact({ artifactKey: "cards/card-002/months/202608/top-000.json" }),
      ),
    ).toThrow(/card identity/u);

    const drift = json("web");
    drift["unexpected"] = true;
    expect(() => vpassStatementPage.parse(encode(drift), artifact())).toThrow(/schema drift/u);

    const subtype = json("web");
    const rows = (
      ((subtype["body"] as Record<string, unknown>)["content"] as Record<string, unknown>)[
        "WebMeisaiTopDisplayServiceBean"
      ] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    (rows[0]!["data"] as string[])[1] = "999";
    expect(() => vpassStatementPage.parse(encode(subtype), artifact())).toThrow(/subtype/u);

    const controlType = json("web");
    const controlRows = (
      ((controlType["body"] as Record<string, unknown>)["content"] as Record<string, unknown>)[
        "WebMeisaiTopDisplayServiceBean"
      ] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    controlRows[0]!["shiharaiPatternFlag"] = "0";
    expect(() => vpassStatementPage.parse(encode(controlType), artifact())).toThrow(
      /bounded safe integer/u,
    );

    const date = json("customized");
    const customRows = (
      ((date["body"] as Record<string, unknown>)["content"] as Record<string, unknown>)[
        "CustomizedMeisaiAnsDisplayServiceBean"
      ] as Record<string, unknown>
    )["meisaiList"] as Record<string, unknown>[];
    customRows[0]!["riyouDate"] = "26/02/30";
    expect(() => vpassStatementPage.parse(encode(date), artifact())).toThrow(/calendar date/u);
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
        card = "card-001",
        month = "202608",
        status: "success" | "failed" = "success",
      ) => {
        const fetchRunId = insertFetchRun(store, {
          sourceId: "vpass",
          externalRunId: id,
          tool: "test",
          startedAt: fetchedAt,
          completedAt: fetchedAt,
          status,
          failureCount: status === "success" ? 0 : 1,
        });
        const raw = putRawObject(store, bytes, "application/json");
        insertFetchArtifact(store, {
          fetchRunId,
          sourceId: "vpass",
          dataset: "statement-page",
          artifactKey: `months/${month}/top-000.json`,
          fetchUnitKey: card,
          mime: "application/json",
          fetchedAt,
          sha256: raw.sha256,
        });
      };
      addSnapshot("old", "2026-09-01T00:00:00.000Z", fixture("web"));
      const empty = json("web");
      const emptyBean = (
        (empty["body"] as Record<string, unknown>)["content"] as Record<string, unknown>
      )["WebMeisaiTopDisplayServiceBean"] as Record<string, unknown>;
      emptyBean["meisaiList"] = [];
      addSnapshot("new", "2026-09-02T00:00:00.000Z", encode(empty));
      addSnapshot("other-card", "2026-09-02T00:00:00.000Z", fixture("web"), "card-002");
      addSnapshot("other-month", "2026-09-02T00:00:00.000Z", fixture("web"), "card-001", "202609");
      addSnapshot(
        "failed-newest",
        "2026-09-04T00:00:00.000Z",
        fixture("web"),
        "card-001",
        "202608",
        "failed",
      );
      expect(runParsers(store, [vpassStatementPage])).toMatchObject({ errors: 0, blocked: 1 });
      const isolated = currentTransactions(store).filter((row) => row.source_id === "vpass");
      expect(isolated).toHaveLength(2);
      expect(isolated.map((row) => row.source_account).sort()).toEqual([
        "vpass:card-001",
        "vpass:card-002",
      ]);
      expect(isolated.some((row) => row.external_id?.includes(":202609:"))).toBeTrue();

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
      publishParseRun(store, firstArtifact, vpassStatementPage.name, partialParseRun);

      expect(currentTransactions(store).filter((row) => row.source_id === "vpass")).toHaveLength(2);
      expect(runParsers(store, [vpassStatementPage]).errors).toBe(0);
      expect(currentTransactions(store).filter((row) => row.source_id === "vpass")).toHaveLength(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function webRow(rowType: string, data: string[]): Record<string, unknown> {
  return {
    columnsSize: data.length,
    columnsSizeS: String(data.length),
    data,
    maxIndex: String(data.length - 1),
    rowType,
    shiharaiPatternFlag: 0,
  };
}
