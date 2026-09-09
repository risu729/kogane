import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSERS } from "../src/parsers/registry.ts";
import {
  sonyBankGrossBalance,
  sonyBankHistoryCsv,
  sonyBankHistoryJson,
  sonyBankWalletHistory,
} from "../src/parsers/sony-bank.ts";
import type { ArtifactMeta, Parser } from "../src/types.ts";
import { currentTransactions } from "../src/queries.ts";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  openStore,
  publishParseRun,
  putRawObject,
  upsertSource,
} from "../src/store.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "sony-bank-parser-boundaries");
const bytes = (name: string) => readFileSync(join(FIXTURES, name));
const meta = (dataset: string, mime = "application/json"): ArtifactMeta => ({
  id: 88,
  sourceId: "sony-bank",
  runStatus: "success",
  runFailureCount: 0,
  runWindow: { from: "2026-09-01", to: "2026-09-30" },
  dataset,
  url: null,
  mime,
  fetchedAt: "2026-09-01T00:00:00Z",
  sha256: "0".repeat(64),
});
const json = (name: string) =>
  JSON.parse(new TextDecoder().decode(bytes(name))) as Record<string, unknown>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const walletHtml = () => new TextDecoder().decode(bytes("wallet-history-2026-09.html"));
const walletBytes = (html: string) => new TextEncoder().encode(html);

describe("Sony Bank parser registry and provenance", () => {
  const cases: Array<[Parser, string, string]> = [
    [sonyBankGrossBalance, "gross-balance", "gross-balance.json"],
    [sonyBankHistoryJson, "yen-history-page-0001", "yen-history-page-0001.json"],
    [sonyBankHistoryCsv, "yen-history-csv", "yen-history.csv"],
    [sonyBankWalletHistory, "wallet-history-202609", "wallet-history-2026-09.html"],
  ];
  test("registers every source-separated parser and is deterministic", () => {
    for (const [parser, dataset, file] of cases) {
      expect(PARSERS.filter((entry) => entry === parser)).toHaveLength(1);
      const artifact = meta(
        dataset,
        file.endsWith(".csv")
          ? "text/csv"
          : file.endsWith(".html")
            ? "text/html; charset=UTF-8"
            : "application/json",
      );
      expect(parser.accepts(artifact)).toBeTrue();
      expect(parser.parse(bytes(file), artifact)).toEqual(parser.parse(bytes(file), artifact));
    }
  });
  test("maps gross balances and totals with raw locators", () => {
    const result = sonyBankGrossBalance.parse(bytes("gross-balance.json"), meta("gross-balance"));
    expect(result.observations).toHaveLength(17);
    expect(result.observations.filter((entry) => entry.kind === "balance")).toHaveLength(15);
    expect(result.observations.filter((entry) => entry.kind === "valuation")).toHaveLength(2);
    expect(result.observations[0]?.rawLocator).toBe("json:$.assetBalAcTypTyp[0]");
  });
  test("maps signed JSON transactions and after-balances without dropping source fields", () => {
    const result = sonyBankHistoryJson.parse(
      bytes("yen-history-page-0001.json"),
      meta("yen-history-page-0001"),
    );
    expect(result.observations).toHaveLength(4);
    expect(
      result.observations
        .filter((entry) => entry.kind === "transaction")
        .map((entry) => (entry.kind === "transaction" ? entry.amountMinor : null)),
    ).toEqual([1000, -500]);
    expect(result.observations[2]?.extra).toHaveProperty("applicationExchRt");
  });
  test("maps the exact official CSV header and both directions", () => {
    const result = sonyBankHistoryCsv.parse(
      bytes("yen-history.csv"),
      meta("yen-history-csv", "text/csv"),
    );
    expect(result.observations).toHaveLength(4);
    expect(result.observations[0]?.rawLocator).toBe("csv:row=2");
    const jsonResult = sonyBankHistoryJson.parse(
      bytes("yen-history-page-0001.json"),
      meta("yen-history-page-0001"),
    );
    expect(
      result.observations
        .filter((entry) => entry.kind === "transaction")
        .map((entry) => (entry.kind === "transaction" ? entry.externalId : null)),
    ).toEqual(
      jsonResult.observations
        .filter((entry) => entry.kind === "transaction")
        .map((entry) => (entry.kind === "transaction" ? entry.externalId : null)),
    );
  });
  test("maps WALLET rows and retains the paired desktop cells", () => {
    const result = sonyBankWalletHistory.parse(
      bytes("wallet-history-2026-09.html"),
      meta("wallet-history-202609", "text/html; charset=UTF-8"),
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "transaction",
      currency: "JPY",
      rawLocator: "html:table=0,row=0",
    });
    expect(result.observations[0]).not.toHaveProperty("amountMinor");
    expect(result.warnings).toHaveLength(1);
    expect(result.observations[0]?.extra).toHaveProperty("supplement");
  });
});

describe("Sony Bank fail-closed boundaries", () => {
  test("rejects schema, enum, cardinality, and pagination drift", () => {
    const extra = json("yen-history-page-0001.json");
    extra.unknown = true;
    expect(() => sonyBankHistoryJson.parse(encode(extra), meta("yen-history-page-0001"))).toThrow(
      "schema drift",
    );
    const enumDrift = json("yen-history-page-0001.json");
    (
      enumDrift.transactionHistInfo as Array<Record<string, unknown>>
    )[0]!.additionAndSubtractionSegment = "3";
    expect(() =>
      sonyBankHistoryJson.parse(encode(enumDrift), meta("yen-history-page-0001")),
    ).toThrow("enum drift");
    const cardinality = json("gross-balance.json");
    (cardinality.assetBalAcTypTyp as unknown[]).pop();
    expect(() => sonyBankGrossBalance.parse(encode(cardinality), meta("gross-balance"))).toThrow(
      "cardinality drift",
    );
    const pagination = json("yen-history-page-0001.json");
    pagination.countCnt = 4;
    expect(() =>
      sonyBankHistoryJson.parse(encode(pagination), meta("yen-history-page-0001")),
    ).toThrow("pagination is incomplete");
    const csv = new TextDecoder()
      .decode(bytes("yen-history.csv"))
      .replace("預入額,引出額", "引出額,預入額");
    expect(() =>
      sonyBankHistoryCsv.parse(new TextEncoder().encode(csv), meta("yen-history-csv", "text/csv")),
    ).toThrow("header drift");
  });

  test("rejects non-success runs, currency confusion, signed source amounts, and dates outside the run window", () => {
    const partial = {
      ...meta("yen-history-page-0001"),
      runStatus: "partial" as const,
      runFailureCount: 1,
    };
    expect(() => sonyBankHistoryJson.parse(bytes("yen-history-page-0001.json"), partial)).toThrow(
      "successful failure-free",
    );
    const inconsistent = { ...meta("gross-balance"), runFailureCount: 1 };
    expect(() => sonyBankGrossBalance.parse(bytes("gross-balance.json"), inconsistent)).toThrow(
      "successful failure-free",
    );

    const currency = json("yen-history-page-0001.json");
    (currency.transactionHistInfo as Array<Record<string, unknown>>)[0]!.currencyCd = "USD";
    expect(() =>
      sonyBankHistoryJson.parse(encode(currency), meta("yen-history-page-0001")),
    ).toThrow("dataset currency mismatch");
    const signed = json("yen-history-page-0001.json");
    (signed.transactionHistInfo as Array<Record<string, unknown>>)[1]!.transactionAmt = "-500";
    expect(() => sonyBankHistoryJson.parse(encode(signed), meta("yen-history-page-0001"))).toThrow(
      "must be unsigned",
    );
    const outside = json("yen-history-page-0001.json");
    (outside.transactionHistInfo as Array<Record<string, unknown>>)[0]!.transactionDt =
      "2026/08/31";
    expect(() => sonyBankHistoryJson.parse(encode(outside), meta("yen-history-page-0001"))).toThrow(
      "outside the fetch window",
    );
    const missingWindow = { ...meta("yen-history-page-0001") };
    delete missingWindow.runWindow;
    expect(() =>
      sonyBankHistoryJson.parse(bytes("yen-history-page-0001.json"), missingWindow),
    ).toThrow("window is missing");
  });

  test("accepts an exact terminal page and rejects invalid calendar instants", () => {
    const page = json("yen-history-page-0001.json");
    delete page.currencyMst;
    delete page.ordinaryDepAcInfo;
    page.countCnt = 4;
    page.returnCnt = 1;
    page.transactionHistInfo = (page.transactionHistInfo as unknown[]).slice(0, 1);
    expect(
      sonyBankHistoryJson.parse(encode(page), meta("yen-history-page-0002")).observations,
    ).toHaveLength(2);

    const gross = json("gross-balance.json");
    gross.updateDttm = "2026/02/30 00:00:00";
    expect(() => sonyBankGrossBalance.parse(encode(gross), meta("gross-balance"))).toThrow(
      "calendar date",
    );
  });

  test("binds CSV media charset to bytes and supports exact Shift-JIS", () => {
    expect(
      sonyBankHistoryCsv.parse(
        bytes("yen-history.csv"),
        meta("yen-history-csv", "text/csv; charset=UTF-8"),
      ).observations,
    ).toHaveLength(4);
    const shiftJis = Buffer.from(
      "juaI+JP6LJNFl3YsjlGNbI/ulfEsksqJ3SyXYZP8inosiPiPb4p6LI23iPiOY42CCjIwMjYvMDkvMDEsk72WvJP8i+AsjYeQrINmgVuDXixKUFksMTAwMCwsMjUwMAoyMDI2LzA5LzAyLJO9lryPb4vgLI2HkKyDZoFbg14sSlBZLCw1MDAsMjAwMAo=",
      "base64",
    );
    expect(
      sonyBankHistoryCsv.parse(shiftJis, meta("yen-history-csv", "text/csv; charset=Shift_JIS"))
        .observations,
    ).toHaveLength(4);
    expect(() =>
      sonyBankHistoryCsv.parse(
        bytes("yen-history.csv"),
        meta("yen-history-csv", "text/csv; charset=Shift_JIS"),
      ),
    ).toThrow("declared charset");
    expect(() =>
      sonyBankHistoryCsv.parse(
        bytes("yen-history.csv"),
        meta("yen-history-csv", "text/csv; charset=EBCDIC"),
      ),
    ).toThrow("charset drift");
  });

  test("binds CSV rows to the requested currency and requires unsigned directional columns", () => {
    const foreign = [
      "取引日,摘要,参考情報,通貨,預入額,引出額,差引残高,為替レート",
      "2026/09/01,匿名入金,合成データ,USD,10.00,,25.00,150.25",
    ].join("\n");
    expect(
      sonyBankHistoryCsv.parse(
        new TextEncoder().encode(foreign),
        meta("foreign-history-usd-csv", "text/csv"),
      ).observations,
    ).toHaveLength(2);
    expect(() =>
      sonyBankHistoryCsv.parse(
        new TextEncoder().encode(foreign.replace(",USD,", ",EUR,")),
        meta("foreign-history-usd-csv", "text/csv"),
      ),
    ).toThrow("dataset currency mismatch");
    expect(() =>
      sonyBankHistoryCsv.parse(
        new TextEncoder().encode(foreign.replace(",10.00,,", ",-10.00,,")),
        meta("foreign-history-usd-csv", "text/csv"),
      ),
    ).toThrow("must be unsigned");
  });

  test("enforces WALLET exact pairing, schema, selected month, and row month", () => {
    const html = walletHtml();
    expect(() =>
      sonyBankWalletHistory.parse(
        walletBytes(html.replace("<tbody>", "<tbody><tr><td>drift</td></tr>")),
        meta("wallet-history-202609", "text/html; charset=UTF-8"),
      ),
    ).toThrow("cardinality drift");
    expect(() =>
      sonyBankWalletHistory.parse(
        walletBytes(html.replace("</thead>", "<tr><th>extra</th></tr></thead>")),
        meta("wallet-history-202609", "text/html; charset=UTF-8"),
      ),
    ).toThrow("table schema drift");
    expect(() =>
      sonyBankWalletHistory.parse(
        walletBytes(html.replace('<option value="20260831"', '<option value="20260831" selected')),
        meta("wallet-history-202609", "text/html; charset=UTF-8"),
      ),
    ).toThrow("selected month drift");
    expect(() =>
      sonyBankWalletHistory.parse(
        walletBytes(html.replace("20260930", "20260931")),
        meta("wallet-history-202609", "text/html; charset=UTF-8"),
      ),
    ).toThrow("calendar date");
    expect(() =>
      sonyBankWalletHistory.parse(
        walletBytes(html.replace("2026/09/01", "2026/08/31")),
        meta("wallet-history-202609", "text/html; charset=UTF-8"),
      ),
    ).toThrow("outside the selected month");
  });

  test("keeps duplicate WALLET rows distinct and accepts explicit direction and pending state", () => {
    const html = walletHtml();
    const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/u)?.[1];
    expect(body).toBeDefined();
    const duplicate = html.replace("</tbody>", `${body}</tbody>`);
    const duplicateResult = sonyBankWalletHistory.parse(
      walletBytes(duplicate),
      meta("wallet-history-202609", "text/html; charset=UTF-8"),
    );
    expect(duplicateResult.observations).toHaveLength(2);
    expect(
      new Set(
        duplicateResult.observations.map((entry) =>
          entry.kind === "transaction" ? entry.externalId : undefined,
        ),
      ).size,
    ).toBe(2);

    const signed = html.replace("JPY 1200", "JPY -1200").replace("2026/09/02", "未確定");
    expect(
      sonyBankWalletHistory.parse(
        walletBytes(signed),
        meta("wallet-history-202609", "text/html; charset=UTF-8"),
      ).observations[0],
    ).toMatchObject({ amountMinor: -1200, status: "pending" });
  });
});

describe("Sony Bank current source views", () => {
  test("prefers official CSV over the overlapping provider JSON transactions", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-sony-current-")));
    upsertSource(store, { id: "sony-bank", provider: "Sony Bank", ingestion: "collector-r2" });
    const fetchRunId = insertFetchRun(store, {
      sourceId: "sony-bank",
      externalRunId: "sony-source-view-test",
      tool: "import-run",
      startedAt: "2026-09-30T00:00:00Z",
      completedAt: "2026-09-30T00:01:00Z",
      status: "success",
      window: { from: "2026-09-01", to: "2026-09-30" },
    });

    const add = (parser: Parser, dataset: string, mime: string, body: Uint8Array) => {
      const raw = putRawObject(store, body, mime);
      const artifactId = insertFetchArtifact(store, {
        fetchRunId,
        sourceId: "sony-bank",
        dataset,
        mime,
        fetchedAt: "2026-09-30T00:01:00Z",
        sha256: raw.sha256,
      });
      const artifact = { ...meta(dataset, mime), id: artifactId, sha256: raw.sha256 };
      const parseRunId = insertParseRun(store, {
        artifactId,
        parserName: parser.name,
        parserVersion: parser.version,
        parsedAt: "2026-09-30T00:02:00Z",
        status: "ok",
        warnings: [],
      });
      for (const observation of parser.parse(body, artifact).observations) {
        if (observation.kind === "transaction") insertObservation(store, parseRunId, observation);
      }
      publishParseRun(store, artifactId, parser.name, parseRunId);
    };

    // Insert CSV first so source-view priority, not append order, selects it.
    add(sonyBankHistoryCsv, "yen-history-csv", "text/csv", bytes("yen-history.csv"));
    add(
      sonyBankHistoryJson,
      "yen-history-page-0001",
      "application/json",
      bytes("yen-history-page-0001.json"),
    );
    const current = currentTransactions(store);
    expect(current).toHaveLength(2);
    expect(
      current.every((row) => row.parser === `sony-bank-history-csv@${sonyBankHistoryCsv.version}`),
    ).toBeTrue();
  });

  test("keeps a reused WALLET approval number distinct across statement months", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-sony-wallet-identity-")));
    upsertSource(store, { id: "sony-bank", provider: "Sony Bank", ingestion: "collector-r2" });
    const september = bytes("wallet-history-2026-09.html");
    const august = walletBytes(
      walletHtml()
        .replaceAll("20260930", "SYNTHETIC-MONTH")
        .replaceAll("20260831", "20260731")
        .replaceAll("SYNTHETIC-MONTH", "20260831")
        .replaceAll("2026/09/01", "2026/08/01")
        .replaceAll("2026/09/02", "2026/08/02"),
    );
    const add = (runId: string, dataset: string, body: Uint8Array, fetchedAt: string) => {
      const fetchRunId = insertFetchRun(store, {
        sourceId: "sony-bank",
        externalRunId: runId,
        tool: "import-run",
        startedAt: fetchedAt,
        completedAt: fetchedAt,
        status: "success",
      });
      const raw = putRawObject(store, body, "text/html; charset=UTF-8");
      const artifactId = insertFetchArtifact(store, {
        fetchRunId,
        sourceId: "sony-bank",
        dataset,
        mime: "text/html; charset=UTF-8",
        fetchedAt,
        sha256: raw.sha256,
      });
      const artifact = {
        ...meta(dataset, "text/html; charset=UTF-8"),
        id: artifactId,
        fetchedAt,
        sha256: raw.sha256,
      };
      const parseRunId = insertParseRun(store, {
        artifactId,
        parserName: sonyBankWalletHistory.name,
        parserVersion: sonyBankWalletHistory.version,
        parsedAt: fetchedAt,
        status: "ok",
        warnings: [],
      });
      for (const observation of sonyBankWalletHistory.parse(body, artifact).observations) {
        if (observation.kind === "transaction") insertObservation(store, parseRunId, observation);
      }
      publishParseRun(store, artifactId, sonyBankWalletHistory.name, parseRunId);
    };

    add("wallet-september-old", "wallet-history-202609", september, "2026-09-07T00:00:00Z");
    add("wallet-august", "wallet-history-202608", august, "2026-09-07T00:01:00Z");
    add("wallet-september-new", "wallet-history-202609", september, "2026-09-07T00:02:00Z");

    const current = currentTransactions(store);
    expect(current).toHaveLength(2);
    expect(current.map((row) => row.as_of).sort()).toEqual(["2026-08-01", "2026-09-01"]);
  });
});
