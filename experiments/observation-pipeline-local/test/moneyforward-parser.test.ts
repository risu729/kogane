import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  moneyForwardEvidenceOnly,
  moneyForwardMonthlyTransactions,
} from "../../../packages/parsers/src/parsers/moneyforward-parser.ts";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { currentTransactions } from "../src/queries.ts";
import {
  insertFetchArtifact,
  insertFetchRun,
  openStore,
  putRawObject,
  upsertSource,
} from "../src/store.ts";
import { runParsers } from "../src/parse.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";

const fixture = (name: string): Uint8Array =>
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "tests",
      "fixtures",
      "observation-pipeline",
      "moneyforward",
      name,
    ),
  );

const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "moneyforward-me",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "monthly-transactions",
  artifactKey: "account-01-month-2099-02.html",
  fetchUnitKey: `moneyforward-account-v1-${"a".repeat(64)}`,
  statementState: null,
  period: null,
  url: null,
  mime: "text/html; charset=utf-8",
  fetchedAt: "2099-03-01T00:00:00.000Z",
  sha256: "0".repeat(64),
  ...overrides,
});

describe("moneyforward Layer B parsers", () => {
  test("decodes only static provider description concatenation and retains the captured cell", () => {
    const parseDescription = (description: string) =>
      moneyForwardMonthlyTransactions.parse(
        new TextEncoder().encode(
          new TextDecoder()
            .decode(fixture("account-01-month-2099-02.html"))
            .replace("ANONYMOUS PURCHASE", description),
        ),
        meta(),
      );
    const template = "' + 'ANONYMOUS PURCHASE'+ ''+ '' + '";
    const result = parseDescription(template);
    expect(moneyForwardMonthlyTransactions.version).toBe("2.0.2");
    expect(result.observations[0]).toMatchObject({
      kind: "transaction",
      description: "ANONYMOUS PURCHASE",
      amountMinor: -1234,
      extra: {
        cells: [template, "'+\"\"+'-1,234'+'"],
        _kogane: { descriptionEncoding: "static-string-concatenation" },
      },
    });
    const decoded = result.observations[0]!;
    const plain = parseDescription("ANONYMOUS PURCHASE").observations[0]!;
    if (decoded.kind !== "transaction" || plain.kind !== "transaction")
      throw new Error("Expected transaction observations");
    expect(decoded.externalId).toBe(plain.externalId);
    for (const [encoded, expected] of [
      [String.raw`' + 'BOOK\'S + SHOP' + '' + '`, "BOOK'S + SHOP"],
      [String.raw`' + "BOOK 'quoted'" + ' \\ shop' + '`, "BOOK 'quoted' \\ shop"],
      [String.raw`' + '\u65e5\u672c' + '\x20SHOP' + '`, "日本 SHOP"],
      [String.raw`' + '\uD83D\uDE00 SHOP' + '' + '`, "😀 SHOP"],
      ["C++ BOOKS", "C++ BOOKS"],
      ["+ PLUS SHOP", "+ PLUS SHOP"],
      ["O'BRIEN + SONS", "O'BRIEN + SONS"],
    ]) {
      expect(parseDescription(encoded!).observations[0]).toMatchObject({ description: expected });
    }
    for (const invalid of [
      "' + fetch('https://invalid.test') + '",
      "' + 'SHOP' + variable + '",
      "' + `SHOP` + '",
      "' + 'SHOP' + 1 + '",
      "' + 'SHOP' +",
      "' + 'SHOP' + + '",
      "' + '' + '",
      String.raw`' + '\uD800' + '`,
      String.raw`' + '\0SHOP' + '`,
      String.raw`' + '\uZZZZ' + '`,
      "' + " + Array(17).fill("'SHOP'").join("+") + " + '",
    ])
      expect(() => parseDescription(invalid)).toThrow(/description template/u);
  });

  test("routes canonical central text/html without relaxing UTF-8 or metadata validation", () => {
    for (const [parser, dataset, artifactKey] of [
      [moneyForwardMonthlyTransactions, "monthly-transactions", "account-01-month-2099-02.html"],
      [moneyForwardEvidenceOnly, "accounts-index", "accounts.html"],
      [moneyForwardEvidenceOnly, "account-detail", "account-detail-01.html"],
    ] as const) {
      const source = meta({ dataset, artifactKey });
      const central = { ...source, mime: "text/html" };
      expect(parser.accepts(central)).toBe(true);
      expect(parser.parse(fixture(artifactKey), central)).toEqual(
        parser.parse(fixture(artifactKey), source),
      );
      expect(() => parser.parse(new Uint8Array([0xff]), central)).toThrow();
      expect(parser.accepts({ ...central, mime: "text/html; charset=shift_jis" })).toBe(false);
      expect(() =>
        parser.parse(fixture(artifactKey), { ...central, statementState: "confirmed" }),
      ).toThrow();
    }
  });
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
      sourceAccount: `moneyforward-me:moneyforward-account-v1-${"a".repeat(64)}`,
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

  test("rejects incomplete and unrecognized empty snapshots without clearing complete rows", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-moneyforward-incomplete-")));
    upsertSource(store, {
      id: "moneyforward-me",
      provider: "MoneyForward ME",
      ingestion: "collector-r2",
    });
    addSnapshot(store, "old", "2099-03-01T00:00:00.000Z", fixture("account-01-month-2099-02.html"));
    const invalid = [
      "<div>temporary error</div>",
      '<div id="calendar"><p>temporary error</p></div>',
      '<div id="calendar"></div><form>login</form>',
      '<div id="calendar">',
      tooltip("2099-02-03").replace("</tbody></table></div>", ""),
      tooltip("2098-02-03"),
      tooltip("2099-02-03").replace("-123", "-1 23"),
      tooltip("2099-01-31").replace("-123", "unsigned"),
    ];
    invalid.forEach((html, index) => {
      expect(() =>
        moneyForwardMonthlyTransactions.parse(new TextEncoder().encode(html), meta()),
      ).toThrow();
      addSnapshot(
        store,
        `invalid-${index}`,
        `2099-03-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`,
        new TextEncoder().encode(html),
      );
    });
    const result = runParsers(store);
    expect(result.errors).toBe(invalid.length);
    expect(currentTransactions(store)).toHaveLength(2);
    store.db.close();
  });

  // Twelve on-disk stores and twelve parser passes: the slowest test in this
  // file, ~0.4-1.0s locally but an order of magnitude more on a loaded CI
  // runner. An explicit budget keeps that from reading as a failure.
  test("preserves identical occurrences across twelve-month overlap and refetches", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-moneyforward-overlap-")));
    upsertSource(store, {
      id: "moneyforward-me",
      provider: "MoneyForward ME",
      ingestion: "collector-r2",
    });
    for (let month = 1; month <= 12; month += 1) {
      const label = `2099-${String(month).padStart(2, "0")}`;
      const previous = month === 1 ? "2098-12" : `2099-${String(month - 1).padStart(2, "0")}`;
      const bytes = new TextEncoder().encode(
        tooltip(`${label}-03`, 2) + tooltip(`${previous}-28`).replace(' id="calendar"', ""),
      );
      const artifactKey = `account-01-month-${label}.html`;
      const first = moneyForwardMonthlyTransactions.parse(bytes, meta({ artifactKey }));
      const second = moneyForwardMonthlyTransactions.parse(bytes, meta({ artifactKey }));
      expect(first).toEqual(second);
      expect(
        new Set(
          first.observations.map((row) => (row.kind === "transaction" ? row.externalId : null)),
        ).size,
      ).toBe(2);
      addSnapshot(store, `old-${month}`, "2100-01-01T00:00:00.000Z", bytes, artifactKey);
      addSnapshot(store, `new-${month}`, "2100-01-02T00:00:00.000Z", bytes, artifactKey);
    }
    expect(runParsers(store).errors).toBe(0);
    expect(currentTransactions(store)).toHaveLength(24);
    // A separate account's month must not supersede account 01.
    addSnapshot(
      store,
      "other-account",
      "2100-01-03T00:00:00.000Z",
      new TextEncoder().encode(tooltip("2099-02-03")),
      "account-02-month-2099-02.html",
    );
    expect(runParsers(store).errors).toBe(0);
    expect(currentTransactions(store)).toHaveLength(25);
    store.db.close();
  }, 30_000);

  test("failed and partial runs cannot emit or clear a complete month", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-moneyforward-failed-")));
    upsertSource(store, {
      id: "moneyforward-me",
      provider: "MoneyForward ME",
      ingestion: "collector-r2",
    });
    addSnapshot(store, "old", "2099-03-01T00:00:00.000Z", fixture("account-01-month-2099-02.html"));
    for (const status of ["failed", "partial"] as const) {
      expect(() =>
        moneyForwardMonthlyTransactions.parse(
          fixture("account-01-month-2099-02.html"),
          meta({ runStatus: status, runFailureCount: 1 }),
        ),
      ).toThrow();
      addSnapshot(
        store,
        status,
        "2099-03-02T00:00:00.000Z",
        fixture("account-01-month-2099-03-empty.html"),
        undefined,
        status,
      );
    }
    const result = runParsers(store);
    expect(result.blocked).toBe(2);
    expect(result.observations).toBe(2);
    expect(currentTransactions(store)).toHaveLength(2);
    store.db.close();
  });

  test("allows whitespace around fixed template operators but never inside amount digits", () => {
    const original = tooltip("2099-02-03");
    const valid = new TextEncoder().encode(original.replace("-123", `' + "" + '-123' + '`));
    expect(moneyForwardMonthlyTransactions.parse(valid, meta()).observations).toHaveLength(1);
    const invalid = new TextEncoder().encode(original.replace("-123", `' + "" + '-1 23' + '`));
    expect(() => moneyForwardMonthlyTransactions.parse(invalid, meta())).toThrow(/amount/u);
  });

  test("account identity survives ordinal changes and legacy ordinal metadata fails closed", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-moneyforward-identity-")));
    upsertSource(store, {
      id: "moneyforward-me",
      provider: "MoneyForward ME",
      ingestion: "collector-r2",
    });
    const bytes = new TextEncoder().encode(tooltip("2099-02-03"));
    const identity = `moneyforward-account-v1-${"a".repeat(64)}`;
    addSnapshot(store, "before", "2099-03-01T00:00:00.000Z", bytes);
    addSnapshot(
      store,
      "after",
      "2099-03-02T00:00:00.000Z",
      bytes,
      "account-02-month-2099-02.html",
      "success",
      identity,
    );
    expect(runParsers(store).errors).toBe(0);
    expect(currentTransactions(store)).toHaveLength(1);
    const before = moneyForwardMonthlyTransactions.parse(bytes, meta());
    const after = moneyForwardMonthlyTransactions.parse(
      bytes,
      meta({ artifactKey: "account-02-month-2099-02.html" }),
    );
    expect(
      before.observations[0]?.kind === "transaction" &&
        after.observations[0]?.kind === "transaction" &&
        before.observations[0].externalId === after.observations[0].externalId,
    ).toBe(true);
    const missingIdentity = meta();
    delete missingIdentity.fetchUnitKey;
    expect(() => moneyForwardMonthlyTransactions.parse(bytes, missingIdentity)).toThrow(
      /identity/u,
    );
    for (const fetchUnitKey of [null, "account", "moneyforward-account-v1-raw"]) {
      expect(() => moneyForwardMonthlyTransactions.parse(bytes, meta({ fetchUnitKey }))).toThrow(
        /identity/u,
      );
    }
    addSnapshot(
      store,
      "empty-after",
      "2099-03-03T00:00:00.000Z",
      fixture("account-01-month-2099-03-empty.html"),
      "account-02-month-2099-02.html",
      "success",
      identity,
    );
    expect(runParsers(store).errors).toBe(0);
    expect(currentTransactions(store)).toHaveLength(0);
    store.db.close();
  });
});

function tooltip(date: string, occurrences = 1): string {
  return `<div id="calendar">${date}<table id="tooltip" class="calendar-tooltip-table"><thead class="orange"><tr><th>内容</th><th>金額（円）</th></tr></thead><tbody>${"<tr><td>SYNTHETIC</td><td>-123</td></tr>".repeat(occurrences)}</tbody></table></div>`;
}

function addSnapshot(
  store: ReturnType<typeof openStore>,
  externalRunId: string,
  fetchedAt: string,
  bytes: Uint8Array,
  artifactKey = "account-01-month-2099-02.html",
  status: "success" | "partial" | "failed" = "success",
  fetchUnitKey = `moneyforward-account-v1-${(artifactKey.startsWith("account-02-") ? "b" : "a").repeat(64)}`,
): void {
  const runId = insertFetchRun(store, {
    sourceId: "moneyforward-me",
    externalRunId,
    tool: "test",
    startedAt: fetchedAt,
    completedAt: fetchedAt,
    status,
    failureCount: status === "success" ? 0 : 1,
  });
  const object = putRawObject(store, bytes, "text/html; charset=utf-8");
  insertFetchArtifact(store, {
    fetchRunId: runId,
    sourceId: "moneyforward-me",
    dataset: "monthly-transactions",
    artifactKey,
    fetchUnitKey,
    mime: "text/html; charset=utf-8",
    fetchedAt,
    sha256: object.sha256,
  });
}
