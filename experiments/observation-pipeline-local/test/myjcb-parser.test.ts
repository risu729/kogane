import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRunDirectory } from "../src/ingest.ts";
import { runParsers } from "../src/parse.ts";
import {
  myJcbCreditLedger,
  myJcbEvidenceOnly,
  myJcbPastMonthBalances,
} from "../../../packages/parsers/src/parsers/myjcb.ts";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { currentTransactions, latestBalances } from "../src/queries.ts";
import { openStore } from "../src/store.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";

const RUN = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "observation-pipeline", "myjcb", "2026-09-07", "run-synthetic");

function artifact(
  dataset: string,
  artifactKey: string,
  statementState: string | null = null,
  period: string | null = null,
  mime = "application/json",
): ArtifactMeta {
  return {
    id: 1,
    sourceId: "myjcb",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    artifactKey,
    statementState,
    period,
    url: null,
    mime,
    fetchedAt: "2026-09-07T00:01:00.000Z",
    sha256: "0".repeat(64),
  };
}

function fixture(path: string): Uint8Array {
  return readFileSync(join(RUN, "connection-a", path));
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(path))) as Record<string, unknown>;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("MyJCB canonical routing", () => {
  test("routes every observed success dataset once and never treats HTML rows as transactions", () => {
    const cases = [
      artifact(
        "credit-menu",
        "connection-a/credit-menu.html",
        null,
        null,
        "text/html; charset=utf-8",
      ),
      artifact("credit-past-months", "connection-a/credit-past-months.json"),
      artifact(
        "credit-detail",
        "connection-a/credit-detail-00.html",
        "unconfirmed",
        "2026年9月お支払い分",
        "text/html; charset=utf-8",
      ),
      artifact(
        "credit-ledger",
        "connection-a/credit-ledger-00.json",
        "unconfirmed",
        "2026年9月お支払い分",
      ),
      artifact("discovery", "connection-a/discovery.json"),
    ];
    expect(cases.map((meta) => PARSERS.filter((parser) => parser.accepts(meta)).length)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(myJcbEvidenceOnly.parse(fixture("credit-detail-00.html"), cases[2]!)).toEqual({
      observations: [],
      warnings: [],
    });
    expect(
      PARSERS.some((parser) =>
        parser.accepts(artifact("credit-csv", "connection-a/credit-01.csv")),
      ),
    ).toBe(false);
    expect(
      PARSERS.some((parser) =>
        parser.accepts(artifact("debit-detail", "connection-a/debit-detail-00.html")),
      ),
    ).toBe(false);
  });

  test("evidence-only HTML still proves its source surface after sanitization", () => {
    const menu = artifact(
      "credit-menu",
      "connection-a/credit-menu.html",
      null,
      null,
      "text/html; charset=utf-8",
    );
    const detail = artifact(
      "credit-detail",
      "connection-a/credit-detail-00.html",
      "unconfirmed",
      "2026年9月お支払い分",
      "text/html; charset=utf-8",
    );
    const generic = new TextEncoder().encode(
      "<html><body><p>sanitized but unrelated</p></body></html>",
    );
    expect(() => myJcbEvidenceOnly.parse(generic, menu)).toThrow(/metadata/u);
    expect(() => myJcbEvidenceOnly.parse(generic, detail)).toThrow(/surface marker/u);
  });
});

describe("MyJCB ledger transactions", () => {
  test("maps unconfirmed usage and confirmed payment without double-counting the HTML capture", () => {
    const pending = myJcbCreditLedger.parse(
      fixture("credit-ledger-00.json"),
      artifact(
        "credit-ledger",
        "connection-a/credit-ledger-00.json",
        "unconfirmed",
        "2026年9月お支払い分",
      ),
    );
    const posted = myJcbCreditLedger.parse(
      fixture("credit-ledger-02.json"),
      artifact(
        "credit-ledger",
        "connection-a/credit-ledger-02.json",
        "confirmed",
        "2026年7月お支払い分",
      ),
    );
    expect(pending.observations).toHaveLength(1);
    expect(posted.observations).toHaveLength(2);
    expect(pending.observations[0]).toMatchObject({
      kind: "transaction",
      sourceAccount: "myjcb:connection-a:root",
      status: "unconfirmed",
      amountMinor: -2000,
      currency: "JPY",
      asOf: "2026-09-01",
      rawLocator: "json:$.rows[0]",
      extra: {
        _kogane: {
          amountBasis: "unconfirmed-usage",
          usageAmountText: "2,000円",
          sourceAccountScope: "root-statement-aggregate",
          derivedFromArtifactKey: "connection-a/credit-detail-00.html",
        },
      },
    });
    const postedTransactions = posted.observations.filter((entry) => entry.kind === "transaction");
    expect(postedTransactions.map((entry) => entry.amountMinor)).toEqual([-400, 500]);
    expect(posted.observations[0]).toMatchObject({
      status: "confirmed",
      extra: {
        _kogane: {
          amountBasis: "current-statement-payment",
          usageAmountText: "1,200円",
          paymentAmountText: "400円",
        },
      },
    });
    const allTransactions = [...pending.observations, ...posted.observations].filter(
      (entry) => entry.kind === "transaction",
    );
    expect(new Set(allTransactions.map((entry) => entry.externalId)).size).toBe(3);
  });

  test("preserves identical provider rows by stable occurrence instead of merchant dedupe", () => {
    const input = json("credit-ledger-00.json");
    const rows = input["rows"] as unknown[];
    rows.push(structuredClone(rows[0]));
    const parsed = myJcbCreditLedger.parse(
      encode(input),
      artifact(
        "credit-ledger",
        "connection-a/credit-ledger-00.json",
        "unconfirmed",
        "2026年9月お支払い分",
      ),
    );
    expect(parsed.observations).toHaveLength(2);
    const transactions = parsed.observations.filter((entry) => entry.kind === "transaction");
    expect(new Set(transactions.map((entry) => entry.externalId)).size).toBe(2);
  });

  test("accepts either observed amount/payment cell order but rejects ambiguity", () => {
    const meta = artifact(
      "credit-ledger",
      "connection-a/credit-ledger-00.json",
      "unconfirmed",
      "2026年9月お支払い分",
    );
    const reversed = json("credit-ledger-00.json");
    const cells = (reversed["rows"] as Record<string, unknown>[])[0]!["summaryCells"] as string[];
    [cells[2], cells[3]] = [cells[3]!, cells[2]!];
    expect(myJcbCreditLedger.parse(encode(reversed), meta).observations[0]).toMatchObject({
      amountMinor: -2000,
      description: "一回払い",
      extra: { _kogane: { amountCellIndex: 3, paymentTypeCellIndex: 2 } },
    });

    const ambiguous = json("credit-ledger-00.json");
    ((ambiguous["rows"] as Record<string, unknown>[])[0]!["summaryCells"] as string[])[3] = "300円";
    expect(() => myJcbCreditLedger.parse(encode(ambiguous), meta)).toThrow(/exactly one/u);
  });

  test("fails closed on manifest mismatch, row drift, date drift, and amount drift", () => {
    const meta = artifact(
      "credit-ledger",
      "connection-a/credit-ledger-00.json",
      "unconfirmed",
      "2026年9月お支払い分",
    );
    expect(() =>
      myJcbCreditLedger.parse(fixture("credit-ledger-00.json"), { ...meta, period: "別期間" }),
    ).toThrow(/metadata/u);
    const extra = json("credit-ledger-00.json");
    (extra["rows"] as Record<string, unknown>[])[0]!["extra"] = true;
    expect(() => myJcbCreditLedger.parse(encode(extra), meta)).toThrow(/schema drift/u);
    const date = json("credit-ledger-00.json");
    ((date["rows"] as Record<string, unknown>[])[0]!["summaryCells"] as string[])[0] = "09/01";
    expect(() => myJcbCreditLedger.parse(encode(date), meta)).toThrow(/YYYY\/MM\/DD/u);
    const amount = json("credit-ledger-00.json");
    ((amount["rows"] as Record<string, unknown>[])[0]!["summaryCells"] as string[])[2] = "1,00円";
    expect(() => myJcbCreditLedger.parse(encode(amount), meta)).toThrow(/exact JPY/u);
    const spacedAmount = json("credit-ledger-00.json");
    ((spacedAmount["rows"] as Record<string, unknown>[])[0]!["summaryCells"] as string[])[2] =
      "2, 000円";
    expect(myJcbCreditLedger.parse(encode(spacedAmount), meta).observations[0]).toMatchObject({
      amountMinor: -2000,
    });
    const paddedDate = json("credit-ledger-00.json");
    ((paddedDate["rows"] as Record<string, unknown>[])[0]!["summaryCells"] as string[])[0] =
      "2026/09/ 01";
    const padded = myJcbCreditLedger.parse(encode(paddedDate), meta).observations[0]!;
    expect(padded.asOf).toBe("2026-09-01");
    expect((padded.extra["summaryCells"] as string[])[0]).toBe("2026/09/ 01");
    expect(() =>
      myJcbCreditLedger.parse(fixture("credit-ledger-00.json"), {
        ...meta,
        runStatus: "partial",
        runFailureCount: 1,
      }),
    ).toThrow(/successful/u);
  });
});

describe("MyJCB provider statement balances", () => {
  test("maps only provider-displayed monthly payment totals", () => {
    const parsed = myJcbPastMonthBalances.parse(
      fixture("credit-past-months.json"),
      artifact("credit-past-months", "connection-a/credit-past-months.json"),
    );
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.observations[1]).toMatchObject({
      kind: "balance",
      sourceAccount: "myjcb:connection-a:root",
      metric: "credit_statement_payment_amount",
      amountMinor: 1500,
      instrument: "JPY",
      asOf: "2025-12",
      rawLocator: "json:$.result.detailPastJsonInfo[0].payAmount",
      extra: {
        _kogane: { detailMonth: 9, snapshotSemantics: "provider-reported-monthly-payment-amount" },
      },
    });
    expect(parsed.observations[0]).toMatchObject({ amountMinor: 700, asOf: "2025-11" });
  });

  test("normalizes every absolute period form and preserves relative fallback without inventing a date", () => {
    const meta = artifact("credit-past-months", "connection-a/credit-past-months.json");
    const absolute = json("credit-past-months.json");
    const absoluteEntries = (absolute["result"] as Record<string, unknown>)[
      "detailPastJsonInfo"
    ] as Record<string, unknown>[];
    absoluteEntries[0]!["settlementYM"] = "２０２５年１２月";
    absoluteEntries[1]!["settlementYM"] = "2025/11";
    expect(
      myJcbPastMonthBalances
        .parse(encode(absolute), meta)
        .observations.map((observation) => observation.asOf),
    ).toEqual(["2025-11", "2025-12"]);

    const relative = json("credit-past-months.json");
    const relativeEntries = (relative["result"] as Record<string, unknown>)[
      "detailPastJsonInfo"
    ] as Record<string, unknown>[];
    relativeEntries[0]!["settlementYM"] = "detailMonth-9";
    const parsed = myJcbPastMonthBalances.parse(encode(relative), meta);
    expect(parsed.observations[1]!.asOf).toBeUndefined();
    expect(parsed.warnings).toHaveLength(1);
  });

  test("rejects duplicate months and malformed provider amounts", () => {
    const meta = artifact("credit-past-months", "connection-a/credit-past-months.json");
    const duplicate = json("credit-past-months.json");
    const entries = (duplicate["result"] as Record<string, unknown>)[
      "detailPastJsonInfo"
    ] as unknown[];
    entries.push(structuredClone(entries[0]));
    expect(() => myJcbPastMonthBalances.parse(encode(duplicate), meta)).toThrow(/duplicate/u);
    const amount = json("credit-past-months.json");
    (
      (amount["result"] as Record<string, unknown>)["detailPastJsonInfo"] as Record<
        string,
        unknown
      >[]
    )[0]!["payAmount"] = "1.50円";
    expect(() => myJcbPastMonthBalances.parse(encode(amount), meta)).toThrow(/exact JPY/u);
  });
});

describe("MyJCB end-to-end run gate", () => {
  test("ingests repeated datasets by artifact key and parses only the canonical financial artifacts", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-myjcb-")));
    const ingested = ingestRunDirectory(store, RUN, { id: "myjcb", provider: "MyJCB" });
    expect(ingested.artifacts).toBe(7);
    const parsed = runParsers(store);
    expect(parsed).toMatchObject({ parsed: 7, errors: 0, blocked: 0, observations: 5 });
    expect(
      (store.db.query("SELECT COUNT(*) AS n FROM transaction_observations").get() as { n: number })
        .n,
    ).toBe(3);
    expect(
      (store.db.query("SELECT COUNT(*) AS n FROM balance_observations").get() as { n: number }).n,
    ).toBe(2);
    expect(latestBalances(store).filter((row) => row.source_id === "myjcb")).toMatchObject([
      { as_of: "2025-12", amount_minor: "1500" },
    ]);
  });

  test("a newer ledger snapshot replaces duplicate and disappeared pending rows", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-myjcb-current-")));
    ingestRunDirectory(store, RUN, { id: "myjcb", provider: "MyJCB" });
    runParsers(store);

    const nextRun = cloneRun("123e4567-e89b-42d3-a456-426614174002", (manifest, directory) => {
      const artifact = manifest.artifacts.find(
        (candidate) =>
          candidate.dataset === "credit-ledger" && candidate.statementState === "unconfirmed",
      )!;
      const relative = artifact.key.slice(artifact.key.indexOf("connection-a/"));
      const path = join(directory, ...relative.split("/"));
      const ledger = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      ledger["rows"] = [];
      const bytes = encode(ledger);
      writeFileSync(path, bytes);
      artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
      artifact.bytes = bytes.byteLength;

      const pastArtifact = manifest.artifacts.find(
        (candidate) => candidate.dataset === "credit-past-months",
      )!;
      const pastRelative = pastArtifact.key.slice(pastArtifact.key.indexOf("connection-a/"));
      const pastPath = join(directory, ...pastRelative.split("/"));
      const past = JSON.parse(readFileSync(pastPath, "utf8")) as Record<string, unknown>;
      (past["result"] as Record<string, unknown>)["detailPastJsonInfo"] = [];
      const pastBytes = encode(past);
      writeFileSync(pastPath, pastBytes);
      pastArtifact.sha256 = createHash("sha256").update(pastBytes).digest("hex");
      pastArtifact.bytes = pastBytes.byteLength;
    });
    ingestRunDirectory(store, nextRun, { id: "myjcb", provider: "MyJCB" });
    runParsers(store);

    expect(
      (store.db.query("SELECT COUNT(*) AS n FROM transaction_observations").get() as { n: number })
        .n,
    ).toBe(5);
    expect(currentTransactions(store).filter((row) => row.source_id === "myjcb")).toHaveLength(2);
    expect(latestBalances(store).filter((row) => row.source_id === "myjcb")).toHaveLength(0);
  });

  test("current statement metric uses provider detailMonth within an absolute/fallback mix", () => {
    const mixedRun = cloneRun("123e4567-e89b-42d3-a456-426614174003", (manifest, directory) => {
      const artifact = manifest.artifacts.find(
        (candidate) => candidate.dataset === "credit-past-months",
      )!;
      const relative = artifact.key.slice(artifact.key.indexOf("connection-a/"));
      const path = join(directory, ...relative.split("/"));
      const input = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const entries = (input["result"] as Record<string, unknown>)["detailPastJsonInfo"] as Record<
        string,
        unknown
      >[];
      entries[0]!["settlementYM"] = "detailMonth-9";
      const bytes = encode(input);
      writeFileSync(path, bytes);
      artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
      artifact.bytes = bytes.byteLength;
    });
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-myjcb-mixed-period-")));
    ingestRunDirectory(store, mixedRun, { id: "myjcb", provider: "MyJCB" });
    runParsers(store);
    expect(latestBalances(store).filter((row) => row.source_id === "myjcb")).toMatchObject([
      { as_of: null, amount_minor: "1500" },
    ]);
  });

  test("a failed run with canonical-looking bytes remains evidence only", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-myjcb-failed-"));
    const connection = join(directory, "connection-a");
    mkdirSync(connection, { recursive: true });
    writeFileSync(join(connection, "credit-ledger-00.json"), fixture("credit-ledger-00.json"));
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        runId: "123e4567-e89b-42d3-a456-426614174001",
        startedAt: "2026-09-07T00:00:00.000Z",
        completedAt: "2026-09-07T00:01:00.000Z",
        status: "partial",
        artifacts: [
          {
            dataset: "credit-ledger",
            key: "raw/myjcb/2026/09/07/123e4567-e89b-42d3-a456-426614174001/connection-a/credit-ledger-00.json",
            mediaType: "application/json",
            statementState: "unconfirmed",
            period: "2026年9月お支払い分",
          },
        ],
        failures: [{ operation: "collect" }],
      }),
    );
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-myjcb-failed-store-")));
    ingestRunDirectory(store, directory, { id: "myjcb", provider: "MyJCB" });
    expect(runParsers(store)).toMatchObject({ parsed: 0, blocked: 1, observations: 0 });
  });
});

interface MutableFixtureManifest {
  runId: string;
  artifacts: {
    dataset: string;
    key: string;
    statementState?: string;
    sha256: string;
    bytes: number;
  }[];
}

function cloneRun(
  runId: string,
  mutate: (manifest: MutableFixtureManifest, directory: string) => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), "kogane-myjcb-clone-"));
  cpSync(RUN, directory, { recursive: true });
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MutableFixtureManifest;
  const previousRunId = manifest.runId;
  manifest.runId = runId;
  for (const artifact of manifest.artifacts) {
    artifact.key = artifact.key.replace(previousRunId, runId);
  }
  mutate(manifest, directory);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return directory;
}
