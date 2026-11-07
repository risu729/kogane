// Fail-closed pins for the MoneyForward ME parsers (ADR 0004: refuse rather
// than guess). Every input is a synthetic mutation of the anonymous fixtures
// under tests/fixtures/observation-pipeline/moneyforward; nothing here is a
// provider value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  moneyForwardEvidenceOnly,
  moneyForwardMonthlyTransactions,
} from "../src/parsers/moneyforward-parser.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const text = (name: string): string =>
  readFileSync(join(FIXTURES_ROOT, "moneyforward", name), "utf8");
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const MONTH = text("account-01-month-2099-02.html");
const EMPTY = text("account-01-month-2099-03-empty.html");
const ACCOUNTS = text("accounts.html");
const DETAIL = text("account-detail-01.html");
const IDENTITY = `moneyforward-account-v1-${"a".repeat(64)}`;

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "moneyforward-me",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "monthly-transactions",
    artifactKey: "account-01-month-2099-02.html",
    fetchUnitKey: IDENTITY,
    statementState: null,
    period: null,
    url: null,
    mime: "text/html",
    fetchedAt: "2099-03-01T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

function replaced(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error("mutation target missing");
  return source.replace(from, to);
}

const monthly = (html: string, overrides: Partial<ArtifactMeta> = {}) =>
  moneyForwardMonthlyTransactions.parse(encode(html), meta(overrides));

// One tooltip table in the observed shape; `rows` is the tbody content.
const tooltip = (rows: string, thead = '<thead class="orange">') =>
  `<table id="tooltip" class="calendar-tooltip-table">${thead}<tr><th>内容</th><th>金額（円）</th></tr></thead><tbody>${rows}</tbody></table>`;
const row = (description: string, amount: string) =>
  `<tr><td>${description}</td><td>${amount}</td></tr>`;
const calendar = (body: string) => `<div id="calendar">${body}</div>`;

describe("moneyforward monthly transactions refuse drift", () => {
  test("the unchanged fixture still parses (baseline for every mutation)", () => {
    expect(
      monthly(MONTH).observations.map((o) => o.kind === "transaction" && o.amountMinor),
    ).toEqual([-1234, 500]);
  });

  test("run, metadata and identity preconditions", () => {
    expect(() => monthly(MONTH, { runStatus: "partial" })).toThrow(/successful failure-free/u);
    expect(() => monthly(MONTH, { runFailureCount: 1 })).toThrow(/successful failure-free/u);
    expect(() => monthly(MONTH, { statementState: "confirmed" })).toThrow(/metadata is invalid/u);
    expect(() => monthly(MONTH, { url: "https://example.invalid/" })).toThrow(
      /metadata is invalid/u,
    );
    expect(() => monthly(MONTH, { mime: "text/plain" })).toThrow(/metadata is invalid/u);
    expect(() => monthly(MONTH, { artifactKey: "account-65-month-2099-02.html" })).toThrow(
      /artifact key is invalid/u,
    );
    expect(() => monthly(MONTH, { artifactKey: "account-01-month-2099-13.html" })).toThrow(
      /artifact key is invalid/u,
    );
    expect(() => monthly(MONTH, { fetchUnitKey: null })).toThrow(/account identity/u);
    expect(() =>
      monthly(MONTH, { fetchUnitKey: `moneyforward-account-v3-${"a".repeat(64)}` }),
    ).toThrow(/account identity/u);
  });

  test("byte-level refusals: empty, NUL and malformed UTF-8", () => {
    expect(() => moneyForwardMonthlyTransactions.parse(new Uint8Array(), meta())).toThrow(
      /HTML size is invalid/u,
    );
    expect(() => monthly(`${MONTH}\0`)).toThrow(/contains NUL/u);
    expect(() =>
      moneyForwardMonthlyTransactions.parse(new Uint8Array([0x3c, 0xff, 0x3e]), meta()),
    ).toThrow(/not valid UTF-8/u);
  });

  test("surface markers: full documents, scripts, foreign tables and calendar count", () => {
    expect(() => monthly(`<!doctype html>${MONTH}`)).toThrow(/HTML fragment/u);
    expect(() => monthly(`${MONTH}<div id="calendar"></div>`)).toThrow(/calendar surface marker/u);
    expect(() => monthly(`${MONTH}<script></script>`)).toThrow(/calendar surface marker/u);
    expect(() => monthly(`${MONTH}<table><tr><td>x</td></tr></table>`)).toThrow(
      /calendar surface marker/u,
    );
    // An empty calendar is a snapshot only in the audited empty structure.
    expect(monthly(EMPTY, { artifactKey: "account-01-month-2099-03.html" })).toEqual({
      observations: [],
      warnings: [],
    });
    expect(() => monthly(calendar(""), { artifactKey: "account-01-month-2099-03.html" })).toThrow(
      /empty surface marker/u,
    );
    expect(() =>
      monthly(`${EMPTY}<p></p>`, { artifactKey: "account-01-month-2099-03.html" }),
    ).toThrow(/empty surface marker/u);
  });

  test("date tokens must bind one-to-one and near each tooltip", () => {
    // An extra date with no tooltip is a cardinality disagreement.
    expect(() => monthly(`${MONTH}<p>2099-02-04</p>`)).toThrow(/cardinality disagree/u);
    // A date too far before its tooltip does not bind.
    expect(() =>
      monthly(calendar(`2099-02-03${"x".repeat(120)}${tooltip(row("A", "+1"))}`)),
    ).toThrow(/date binding is invalid/u);
    // Two tooltips after one date would share it; the trailing date keeps the
    // counts equal so only the binding rule can refuse.
    expect(() =>
      monthly(calendar(`2099-02-03${tooltip(row("A", "+1"))}${tooltip(row("B", "+2"))}2099-02-04`)),
    ).toThrow(/date binding is invalid/u);
    // A tooltip with no preceding date cannot bind either.
    expect(() => monthly(calendar(`${tooltip(row("A", "+1"))}2099-02-04`))).toThrow(
      /date binding is invalid/u,
    );
    // Only the selected month and its two neighbours are plausible.
    expect(() => monthly(calendar(`2099-04-01${tooltip(row("A", "+1"))}`))).toThrow(
      /outside the declared calendar month/u,
    );
    expect(() => monthly(calendar(`2098-12-31${tooltip(row("A", "+1"))}`))).toThrow(
      /outside the declared calendar month/u,
    );
    expect(() => monthly(calendar(`2099-02-29${tooltip(row("A", "+1"))}`))).toThrow(
      /calendar date/u,
    );
  });

  test("tooltip table structure, rows and header", () => {
    // A row closed implicitly has no end tag in the source.
    expect(() =>
      monthly(
        calendar(`2099-02-03${tooltip("<tr><td>A</td><td>+1</td><tr><td>B</td><td>+2</td></tr>")}`),
      ),
    ).toThrow(/incomplete element/u);
    expect(() =>
      monthly(calendar(`2099-02-03${tooltip(row("A", "+1"), '<thead class="blue">')}`)),
    ).toThrow(/table structure is invalid/u);
    expect(() =>
      monthly(
        calendar(
          `2099-02-03${replaced(tooltip(row("A", "+1")), "</thead>", "<tr><th>内容</th><th>金額（円）</th></tr></thead>")}`,
        ),
      ),
    ).toThrow(/unsupported child/u);
    expect(() =>
      monthly(
        calendar(
          `2099-02-03${replaced(tooltip(row("A", "+1")), "<th>金額（円）</th>", "<td>金額（円）</td>")}`,
        ),
      ),
    ).toThrow(/header is invalid/u);
    expect(() =>
      monthly(
        calendar(
          `2099-02-03${replaced(tooltip(row("A", "+1")), "<th>金額（円）</th>", "<th>金額（円）</th><th>メモ</th>")}`,
        ),
      ),
    ).toThrow(/header is invalid/u);
    expect(() => monthly(calendar(`2099-02-03${tooltip(row("A", "+1").repeat(1_001))}`))).toThrow(
      /row cardinality is invalid/u,
    );
    expect(() =>
      monthly(calendar(`2099-02-03${tooltip("<tr><td>A</td><td>+1</td><td>x</td></tr>")}`)),
    ).toThrow(/row shape is invalid/u);
    expect(() =>
      monthly(calendar(`2099-02-03${tooltip("<tr><th>A</th><td>+1</td></tr>")}`)),
    ).toThrow(/row shape is invalid/u);
    expect(() => monthly(calendar(`2099-02-03${tooltip(row("", "+1"))}`))).toThrow(
      /description is invalid/u,
    );
    expect(() => monthly(calendar(`2099-02-03${tooltip(row("A", " "))}`))).toThrow(
      /amount is invalid/u,
    );
  });

  test("amounts are exact signed JPY integers or refused", () => {
    const amount = (value: string) => monthly(calendar(`2099-02-03${tooltip(row("A", value))}`));
    const minor = (value: string) => {
      const observation = amount(value).observations[0]!;
      return observation.kind === "transaction" ? observation.amountMinor : undefined;
    };
    expect(minor("-1,234")).toBe(-1234);
    expect(minor("▲5")).toBe(-5);
    expect(minor("-0")).toBe(0);
    for (const value of ["1234", "+1.5", "+1,23", "+01", "--1", "+", "'+\"-\"+'1'+'"]) {
      expect(() => amount(value)).toThrow(/exact signed JPY integer/u);
    }
    expect(() => amount("+9,007,199,254,740,993")).toThrow(/exceeds range/u);
  });

  test("description templates decode literal concatenation only", () => {
    const description = (value: string) => {
      const observation = monthly(calendar(`2099-02-03${tooltip(row(value, "+1"))}`))
        .observations[0]!;
      return observation.kind === "transaction" ? observation.description : undefined;
    };
    expect(description(`' + 'A\\u0042' + "\\x43" + '`)).toBe("ABC");
    expect(description(`' + 'A\\'B' + '`)).toBe("A'B");
    for (const value of [
      // No closing envelope.
      `' + 'A'`,
      // A bare identifier is an expression, not a literal.
      `' + A + '`,
      // An unterminated literal.
      `' + 'A + '`,
      // Unknown escape.
      `' + 'A\\q' + '`,
      // Short \x and \u escapes.
      `' + '\\x4' + '`,
      `' + '\\u00g1' + '`,
      // Dangling and missing operators.
      `' + 'A' + + '`,
      `' + 'A' 'B' + '`,
      // More than sixteen terms.
      `' + ${Array.from({ length: 17 }, () => "'A'").join(" + ")} + '`,
      // Decodes to nothing, a control character, or a lone surrogate.
      `' + '' + '`,
      `' + '\\x01' + '`,
      `' + '\\ud800' + '`,
    ]) {
      expect(() => description(value)).toThrow(/description template is invalid/u);
    }
  });
});

describe("moneyforward evidence-only documents refuse drift", () => {
  const evidence = (html: string, overrides: Partial<ArtifactMeta>) =>
    moneyForwardEvidenceOnly.parse(encode(html), meta(overrides));
  const index = { dataset: "accounts-index", artifactKey: "accounts.html" };
  const detail = { dataset: "account-detail", artifactKey: "account-detail-01.html" };

  test("the unchanged fixtures validate and emit nothing", () => {
    expect(evidence(ACCOUNTS, index)).toEqual({ observations: [], warnings: [] });
    expect(evidence(DETAIL, detail)).toEqual({ observations: [], warnings: [] });
  });

  test("documents must be complete and metadata exact", () => {
    expect(() => evidence("<div></div>", index)).toThrow(/complete HTML document/u);
    expect(() => evidence("<html><head></head></html>", index)).toThrow(/complete HTML document/u);
    expect(() => evidence(ACCOUNTS, { ...index, runStatus: "failed" })).toThrow(
      /successful failure-free/u,
    );
    expect(() => evidence(ACCOUNTS, { ...index, period: "2099-02" })).toThrow(
      /metadata is invalid/u,
    );
  });

  test("accounts index requires one bounded account table", () => {
    expect(() => evidence(ACCOUNTS, { ...index, artifactKey: "accounts-2.html" })).toThrow(
      /accounts-index artifact key/u,
    );
    expect(() => evidence(replaced(ACCOUNTS, 'id="account-table"', 'id="other"'), index)).toThrow(
      /accounts-index surface marker/u,
    );
    const link = '<tr><td><a href="/accounts/show/anonymous-account">x</a></td></tr>';
    expect(() =>
      evidence(replaced(ACCOUNTS, "</tbody>", `${link.repeat(64)}</tbody>`), index),
    ).toThrow(/accounts-index surface marker/u);
  });

  test("account detail requires its identity, key and unique markers", () => {
    expect(() => evidence(DETAIL, { ...detail, fetchUnitKey: "account-01" })).toThrow(
      /account identity/u,
    );
    expect(() => evidence(DETAIL, { ...detail, artifactKey: "account-detail-65.html" })).toThrow(
      /account-detail artifact key/u,
    );
    expect(() =>
      evidence(replaced(DETAIL, 'content="anonymous-csrf"', 'content=""'), detail),
    ).toThrow(/csrf surface marker/u);
    expect(() =>
      evidence(replaced(DETAIL, 'content="anonymous-csrf"', 'content="has space"'), detail),
    ).toThrow(/csrf surface marker/u);
    expect(() =>
      evidence(
        replaced(
          DETAIL,
          '<input name="service[id]"',
          '<input name="account[id_hash]" value="other"><input name="service[id]"',
        ),
        detail,
      ),
    ).toThrow(/account\[id_hash\] surface marker/u);
    expect(() =>
      evidence(replaced(DETAIL, 'name="service[id]"', 'name="service[name]"'), detail),
    ).toThrow(/service\[id\] surface marker/u);
    expect(() =>
      evidence(replaced(DETAIL, 'id="cf-detail-table"', 'id="other-table"'), detail),
    ).toThrow(/recent transaction table surface marker/u);
  });
});
