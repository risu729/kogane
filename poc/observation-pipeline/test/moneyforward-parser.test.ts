import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  moneyForwardEvidenceOnly,
  moneyForwardMonthlyTransactions,
} from "../src/parsers/moneyforward-parser.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { currentTransactions } from "../src/queries.ts";
import {
  insertFetchArtifact,
  insertFetchRun,
  openStore,
  putRawObject,
  upsertSource,
} from "../src/store.ts";
import { runParsers } from "../src/parse.ts";
import type { ArtifactMeta } from "../src/types.ts";

const fixture = (name: string): Uint8Array =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "moneyforward", name));

const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "moneyforward-me",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "monthly-transactions",
  artifactKey: "account-01-month-2099-02.html",
  statementState: null,
  period: null,
  url: null,
  mime: "text/html; charset=utf-8",
  fetchedAt: "2099-03-01T00:00:00.000Z",
  sha256: "0".repeat(64),
  ...overrides,
});

describe("moneyforward Layer B parsers", () => {
  test("registers exactly one parser for each MoneyForward provider artifact", () => {
    const monthly = meta();
    const accounts = meta({ dataset: "accounts-index", artifactKey: "accounts.html" });
    const detail = meta({ dataset: "account-detail", artifactKey: "account-detail-01.html" });
    expect(PARSERS.filter((parser) => parser.accepts(monthly))).toEqual([
      moneyForwardMonthlyTransactions,
    ]);
    expect(PARSERS.filter((parser) => parser.accepts(accounts))).toEqual([
      moneyForwardEvidenceOnly,
    ]);
    expect(PARSERS.filter((parser) => parser.accepts(detail))).toEqual([moneyForwardEvidenceOnly]);
  });

  test("emits only the selected month from the canonical monthly view", () => {
    const result = moneyForwardMonthlyTransactions.parse(
      fixture("account-01-month-2099-02.html"),
      meta(),
    );
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(2);
    const transactions = result.observations.filter(
      (observation) => observation.kind === "transaction",
    );
    expect(transactions.map((observation) => observation.amountMinor)).toEqual([-1234, 500]);
    expect(result.observations.map((observation) => observation.asOf)).toEqual([
      "2099-02-03",
      "2099-02-03",
    ]);
    expect(result.observations[0]).toMatchObject({
      kind: "transaction",
      sourceAccount: "moneyforward-me:account-01",
      currency: "JPY",
      description: "ANONYMOUS PURCHASE",
      rawLocator: "html:tooltip=0:row=0",
      extra: {
        _kogane: {
          canonicalDataset: "monthly-transactions",
          adjacentCalendarRows: "validated-but-not-emitted",
        },
      },
    });
    expect(result.observations[0]).not.toHaveProperty("observedAt");
    expect(result.observations[0]).not.toHaveProperty("status");
  });

  test("treats a complete empty monthly fragment as an empty snapshot", () => {
    expect(
      moneyForwardMonthlyTransactions.parse(
        fixture("account-01-month-2099-03-empty.html"),
        meta({ artifactKey: "account-01-month-2099-03.html" }),
      ),
    ).toEqual({ observations: [], warnings: [] });
  });

  test("validates evidence-only full documents without duplicating monthly transactions", () => {
    expect(
      moneyForwardEvidenceOnly.parse(
        fixture("accounts.html"),
        meta({ dataset: "accounts-index", artifactKey: "accounts.html" }),
      ),
    ).toEqual({ observations: [], warnings: [] });
    expect(
      moneyForwardEvidenceOnly.parse(
        fixture("account-detail-01.html"),
        meta({ dataset: "account-detail", artifactKey: "account-detail-01.html" }),
      ),
    ).toEqual({ observations: [], warnings: [] });
  });

  test("fails closed on run, metadata, date binding, row, header, amount, and document drift", () => {
    const original = new TextDecoder().decode(fixture("account-01-month-2099-02.html"));
    const changed = (from: string, to: string): Uint8Array => {
      if (!original.includes(from)) throw new Error("mutation target missing");
      return new TextEncoder().encode(original.replace(from, to));
    };
    expect(() =>
      moneyForwardMonthlyTransactions.parse(
        fixture("account-01-month-2099-02.html"),
        meta({ runStatus: "partial", runFailureCount: 1 }),
      ),
    ).toThrow(/successful failure-free/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(
        fixture("account-01-month-2099-02.html"),
        meta({ period: "2099-02" }),
      ),
    ).toThrow(/metadata/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(changed("2099-02-03", "2099-02-30"), meta()),
    ).toThrow(/calendar date/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(changed("2099-02-03", "date-missing"), meta()),
    ).toThrow(/cardinality/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(changed("<th>内容</th>", "<th>摘要</th>"), meta()),
    ).toThrow(/header/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(
        changed("<td>'+\"\"+'-1,234'+'</td>", "<td>1234</td>"),
        meta(),
      ),
    ).toThrow(/signed JPY/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(
        changed("<td>ANONYMOUS PURCHASE</td>", "<td><b>ANONYMOUS PURCHASE</b></td>"),
        meta(),
      ),
    ).toThrow(/row shape/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(
        new TextEncoder().encode(`<html>${original}</html>`),
        meta(),
      ),
    ).toThrow(/fragment/u);
  });

  test("latest successful empty monthly snapshot clears older current rows", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-moneyforward-current-")));
    upsertSource(store, {
      id: "moneyforward-me",
      provider: "MoneyForward ME",
      ingestion: "collector-r2",
    });
    addSnapshot(
      store,
      "run-old",
      "2099-03-01T00:00:00.000Z",
      fixture("account-01-month-2099-02.html"),
    );
    addSnapshot(
      store,
      "run-new",
      "2099-03-02T00:00:00.000Z",
      fixture("account-01-month-2099-03-empty.html"),
      "account-01-month-2099-02.html",
    );
    expect(runParsers(store).errors).toBe(0);
    expect(currentTransactions(store).filter((row) => row.source_id === "moneyforward-me")).toEqual(
      [],
    );
    store.db.close();
  });
});

function addSnapshot(
  store: ReturnType<typeof openStore>,
  externalRunId: string,
  fetchedAt: string,
  bytes: Uint8Array,
  artifactKey = "account-01-month-2099-02.html",
): void {
  const runId = insertFetchRun(store, {
    sourceId: "moneyforward-me",
    externalRunId,
    tool: "test",
    startedAt: fetchedAt,
    completedAt: fetchedAt,
    status: "success",
    failureCount: 0,
  });
  const object = putRawObject(store, bytes, "text/html; charset=utf-8");
  insertFetchArtifact(store, {
    fetchRunId: runId,
    sourceId: "moneyforward-me",
    dataset: "monthly-transactions",
    artifactKey,
    mime: "text/html; charset=utf-8",
    fetchedAt,
    sha256: object.sha256,
  });
}
