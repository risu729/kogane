// Fail-closed pins for the MyJCB ledger, past-month, menu and discovery
// parsers (ADR 0004: refuse rather than guess). Inputs are synthetic
// mutations of the collector-shaped fixtures under
// tests/fixtures/observation-pipeline/myjcb; nothing is a provider value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  myJcbCreditLedger,
  myJcbEvidenceOnly,
  myJcbPastMonthBalances,
} from "../src/parsers/myjcb.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const RUN = join(FIXTURES_ROOT, "myjcb", "2026-09-07", "run-synthetic", "connection-a");
const text = (name: string): string => readFileSync(join(RUN, name), "utf8");
const json = (name: string): Record<string, unknown> =>
  JSON.parse(text(name)) as Record<string, unknown>;
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

function meta(dataset: string, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "myjcb",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    statementState: null,
    period: null,
    fetchedAt: "2026-09-07T00:01:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

describe("myjcb credit ledger", () => {
  const confirmed = {
    artifactKey: "connection-a/credit-ledger-02.json",
    statementState: "confirmed",
    period: "2026年7月お支払い分",
  } as const;
  type Ledger = Record<string, unknown> & {
    rows: { summaryCells: string[]; expanded: Record<string, string> }[];
  };
  const ledger = (): Ledger => json("credit-ledger-02.json") as Ledger;
  const parse = (value: unknown, overrides: Partial<ArtifactMeta> = {}) =>
    myJcbCreditLedger.parse(encode(value), meta("credit-ledger", { ...confirmed, ...overrides }));
  const withCells = (cells: string[]) => {
    const value = ledger();
    value.rows = [{ ...value.rows[0]!, summaryCells: cells }];
    return value;
  };

  test("artifact metadata must match the stored ledger identity", () => {
    expect(parse(ledger()).observations).toHaveLength(2);
    expect(() => parse(ledger(), { runStatus: "failed" })).toThrow(
      "require a successful, failure-free fetch run",
    );
    expect(() => parse(ledger(), { artifactKey: "connection-a/credit-ledger-18.json" })).toThrow(
      "credit-ledger artifact key is invalid",
    );
    expect(() => parse(ledger(), { statementState: "unknown" })).toThrow(
      "statement state is missing or unsupported",
    );
    expect(() => parse(ledger(), { period: "" })).toThrow("period is missing or invalid");
    expect(() => parse(ledger(), { period: null })).toThrow("period is missing or invalid");
    expect(() => parse({ ...ledger(), schemaVersion: 2 })).toThrow(
      "credit-ledger identity does not match its artifact key",
    );
    expect(() => parse(ledger(), { artifactKey: "connection-a/credit-ledger-03.json" })).toThrow(
      "credit-ledger identity does not match its artifact key",
    );
    expect(() => parse(ledger(), { period: "2026年8月お支払い分" })).toThrow(
      "credit-ledger metadata does not match the collector manifest",
    );
    expect(() => parse({ ...ledger(), state: "unconfirmed" })).toThrow(
      "credit-ledger metadata does not match the collector manifest",
    );
  });

  test("headers and rows are closed shapes", () => {
    expect(() => parse({ ...ledger(), headers: ["ご利用日", "ご利用先など", "支払区分"] })).toThrow(
      "headers do not match the provider contract",
    );
    expect(() => parse({ ...ledger(), rows: {} })).toThrow("rows must be a bounded array");
    expect(() => parse(withCells(["2026/06/15", "架空店", "400円"]))).toThrow(
      "summaryCells is invalid",
    );
    const expanded = ledger();
    expanded.rows[0]!.expanded["今回のお支払い金額"] = "400円";
    expect(() => parse(expanded)).toThrow("rows[0].expanded is invalid");
  });

  test("dates and the single exact amount cell are required", () => {
    for (const date of ["2026-06-15", "26/06/15", "2026/6/15"]) {
      expect(() => parse(withCells([date, "架空店", "400円", "分割払い"]))).toThrow(
        "summaryCells[0] must use YYYY/MM/DD",
      );
    }
    expect(() => parse(withCells(["2026/06/31", "架空店", "400円", "分割払い"]))).toThrow(
      "summaryCells[0] is not a calendar date",
    );
    // Neither or both amount cells exact: the amount is never chosen by guess.
    expect(() => parse(withCells(["2026/06/15", "架空店", "400.5円", "分割払い"]))).toThrow(
      "does not have exactly one exact JPY amount cell",
    );
    expect(() => parse(withCells(["2026/06/15", "架空店", "400円", "500円"]))).toThrow(
      "does not have exactly one exact JPY amount cell",
    );
    expect(() => parse(withCells(["2026/06/15", "", "400円", "分割払い"]))).toThrow(
      "summaryCells[1] is empty",
    );
  });
});

describe("myjcb past-month balances", () => {
  const ok = { artifactKey: "connection-a/credit-past-months.json" };
  type Past = Record<string, unknown> & {
    result: Record<string, unknown> & { detailPastJsonInfo: Record<string, unknown>[] };
  };
  const past = (): Past => json("credit-past-months.json") as Past;
  const parse = (value: unknown, overrides: Partial<ArtifactMeta> = {}) =>
    myJcbPastMonthBalances.parse(
      encode(value),
      meta("credit-past-months", { ...ok, ...overrides }),
    );
  const withItem = (change: Record<string, unknown>) => {
    const value = past();
    value.result.detailPastJsonInfo[0] = { ...value.result.detailPastJsonInfo[0]!, ...change };
    return value;
  };

  test("artifact metadata and JSON-RPC envelope", () => {
    expect(parse(past()).observations).toHaveLength(2);
    expect(() => parse(past(), { artifactKey: "connection-a/past.json" })).toThrow(
      "credit-past-months artifact metadata is invalid",
    );
    expect(() => parse(past(), { period: "2025年12月お支払い分" })).toThrow(
      "credit-past-months artifact metadata is invalid",
    );
    for (const change of [{ jsonrpc: "1.0" }, { id: 30100601 }, { id: "030100701" }]) {
      expect(() => parse({ ...past(), ...change })).toThrow(
        "credit-past-months JSON-RPC metadata is invalid",
      );
    }
    for (const change of [
      { errId: "E001" },
      { errMessage: null },
      { detailPastJsonInfo: Array.from({ length: 19 }, () => ({})) },
    ]) {
      const value = past();
      Object.assign(value.result, change);
      expect(() => parse(value)).toThrow("credit-past-months result is invalid");
    }
  });

  test("items: month range, duplicates, flags and amounts", () => {
    expect(() => parse(withItem({ detailMonth: "18" }))).toThrow("detailMonth is invalid");
    expect(() => parse(withItem({ detailMonth: "09" }))).toThrow("detailMonth is invalid");
    expect(() => parse(withItem({ detailMonth: "10" }))).toThrow("duplicate detailMonth");
    expect(() => parse(withItem({ detailAvailableFlag: "true" }))).toThrow(
      "detailAvailableFlag must be boolean",
    );
    expect(() => parse(withItem({ payAmount: "1,500.5円" }))).toThrow(/payAmount/u);
    expect(() => parse(withItem({ settlementYM: "" }))).toThrow("settlementYM is empty");
    // A hidden or unavailable amount is skipped, never recorded as zero.
    const hidden = parse(withItem({ payAmountDispFlag: false, payAmount: "" }));
    expect(hidden.observations).toHaveLength(1);
    // A relative period is kept with a warning and no invented asOf.
    const relative = parse(withItem({ settlementYM: "前月お支払い分" }));
    expect(relative.warnings).toEqual([
      "json:$.result.detailPastJsonInfo[0].settlementYM has no absolute year-month; current selection falls back to detailMonth",
    ]);
  });
});

describe("myjcb evidence-only menu and discovery", () => {
  const menu = text("credit-menu.html");
  const menuMeta = {
    mime: "text/html; charset=utf-8",
    artifactKey: "connection-a/credit-menu.html",
  };
  const parseMenu = (value: string, overrides: Partial<ArtifactMeta> = {}) =>
    myJcbEvidenceOnly.parse(encode(value), meta("credit-menu", { ...menuMeta, ...overrides }));
  const discoveryMeta = { artifactKey: "connection-a/discovery.json" };
  const discovery = () =>
    json("discovery.json") as Record<string, unknown> & { cards: Record<string, unknown>[] };
  const parseDiscovery = (value: unknown, overrides: Partial<ArtifactMeta> = {}) =>
    myJcbEvidenceOnly.parse(encode(value), meta("discovery", { ...discoveryMeta, ...overrides }));

  test("sanitized menu HTML: complete, inert and correctly keyed", () => {
    expect(parseMenu(menu)).toEqual({ observations: [], warnings: [] });
    expect(() => parseMenu(menu.replace("</html>", ""))).toThrow("is not a complete document");
    expect(() => parseMenu(`<div>${menu}</div>`)).toThrow("is not a complete document");
    for (const injected of [
      "<script></script>",
      '<a href="x">x</a>',
      '<p data-id="1"></p>',
      "<p>1234 5678 9012 3456</p>",
      '<input value="secret">',
    ]) {
      expect(() => parseMenu(menu.replace("<main>", `<main>${injected}`))).toThrow(
        "crossed the active-content or sensitive-value boundary",
      );
    }
    expect(() => parseMenu(menu, { artifactKey: "connection-a/menu.html" })).toThrow(
      "credit-menu metadata is invalid",
    );
    expect(() => parseMenu(menu, { period: "2026年9月お支払い分" })).toThrow(
      "credit-menu metadata is invalid",
    );
    expect(() => parseMenu(menu.replace("generalJsonShikibetuId", "other"))).toThrow(
      "credit-menu metadata is invalid",
    );
  });

  test("discovery: header, bounds, card identities and unobserved hints", () => {
    expect(parseDiscovery(discovery())).toEqual({ observations: [], warnings: [] });
    expect(() =>
      parseDiscovery(discovery(), { artifactKey: "connection-a/discover.json" }),
    ).toThrow("myjcb discovery metadata is invalid");
    expect(() => parseDiscovery({ ...discovery(), bootstrapMode: "cookie" })).toThrow(
      "myjcb discovery header is invalid",
    );
    expect(() => parseDiscovery({ ...discovery(), cookieCount: 0 })).toThrow(
      "cookieCount is below its supported range",
    );
    expect(() => parseDiscovery({ ...discovery(), periodCount: 34 })).toThrow(
      "periodCount is above its supported range",
    );
    expect(() => parseDiscovery({ ...discovery(), limitations: [1] })).toThrow(
      "myjcb discovery collections are invalid",
    );
    const card = discovery().cards[0]!;
    for (const [cards, message] of [
      [[{ ...card, extra: true }], "cards[0] schema drift"],
      [[{ localId: "card-001" }], "cards[0] schema drift"],
      [[{ ...card, localId: "card-1" }], "card identity is invalid or duplicated"],
      [[card, card], "card identity is invalid or duplicated"],
      [[{ ...card, switchCandidate: "false" }], "switchCandidate must be boolean"],
      [[{ ...card, issuerHint: "x" }], "myjcb discovery issuerHint is unobserved"],
      [[{ ...card, productHint: "JCB X" }], "myjcb discovery productHint is unsupported"],
    ] as const) {
      expect(() => parseDiscovery({ ...discovery(), cards })).toThrow(message);
    }
  });
});
