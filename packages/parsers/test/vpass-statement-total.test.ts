import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta, BalanceObservation } from "../src/types.ts";
import { vpassStatementPage } from "../src/parsers/vpass.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

// Invented statement header added to the existing synthetic transaction fixture.
// The provider field shape is verified independently; no capture enters tests.
function web() {
  const root = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, "vpass-parser-boundaries/web.json"), "utf8"),
  );
  root.body.content.WebMeisaiTopDisplayServiceBean.saiseiStatus = "0";
  root.body.content.WebMeisaiTopDisplayServiceBean.webMeisaiTopK3Vo = {
    payTotal: "8,765",
    seikyuYm: "202608",
    shiharaiDate: "2026年8月26日",
    accountNo: "SYNTHETIC-NOT-EMITTED",
    userName: "SYNTHETIC-NOT-EMITTED",
  };
  return root;
}
const artifact: ArtifactMeta = {
  id: 1,
  sourceId: "vpass",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "statement-page",
  url: null,
  mime: "application/json",
  artifactKey: "months/202608/top-000.json",
  fetchUnitKey: "card-001",
  fetchedAt: "2026-08-30T00:00:00.000Z",
  sha256: "0".repeat(64),
};
function parse(value: unknown, meta: ArtifactMeta = artifact) {
  return vpassStatementPage.parse(new TextEncoder().encode(JSON.stringify(value)), meta);
}
function header(value: ReturnType<typeof web>): Record<string, unknown> {
  return value.body.content.WebMeisaiTopDisplayServiceBean.webMeisaiTopK3Vo;
}
function bill(value: ReturnType<typeof parse>): BalanceObservation | undefined {
  return value.observations.find(
    (observation): observation is BalanceObservation => observation.kind === "balance",
  );
}

describe("Vpass provider-reported finalized statement total", () => {
  test("the total is independent of transaction sums, with a separate exact payment date", () => {
    const result = parse(web());
    expect(
      result.observations.filter((observation) => observation.kind === "transaction"),
    ).toHaveLength(1);
    expect(bill(result)).toMatchObject({
      kind: "balance",
      sourceAccount: "vpass:card-001",
      metric: "credit_statement_payment_amount",
      amountMinor: 8765,
      amountText: "8765",
      amountScale: 0,
      instrument: "JPY",
      asOf: "2026-08-01",
      observedAt: artifact.fetchedAt,
      rawLocator: "json:$.body.content.WebMeisaiTopDisplayServiceBean.webMeisaiTopK3Vo.payTotal",
      extra: {
        _kogane: {
          period: "2026-08",
          paymentDate: "2026-08-26",
          pageIndex: 0,
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      },
    });
    expect(JSON.stringify(bill(result))).not.toContain("SYNTHETIC-NOT-EMITTED");
  });

  test("a provider total can exist without transaction rows", () => {
    const root = web();
    root.body.content.WebMeisaiTopDisplayServiceBean.meisaiList = [];
    expect(parse(root).observations).toHaveLength(1);
    expect(bill(parse(root))?.amountMinor).toBe(8765);
  });

  test("pagination never emits a second copy of the statement header", () => {
    const result = parse(web(), { ...artifact, artifactKey: "months/202608/top-001.json" });
    expect(bill(result)).toBeUndefined();
    expect(result.observations).toHaveLength(1);
  });

  test("missing totals retain existing transaction output", () => {
    const root = web();
    delete header(root)["payTotal"];
    const baseline = parse(root);
    const result = parse(web());
    expect(baseline.observations).toEqual(
      result.observations.filter((observation) => observation.kind === "transaction"),
    );
    expect(baseline.warnings).toEqual(result.warnings);
  });

  test("a still-creating statement is not an authoritative final total", () => {
    const root = web();
    root.body.content.WebMeisaiTopDisplayServiceBean.saiseiStatus = "1";
    expect(bill(parse(root))).toBeUndefined();
  });

  test("customized amounts remain unsettled and never become a final bill", () => {
    const root = JSON.parse(
      readFileSync(join(FIXTURES_ROOT, "vpass-parser-boundaries/customized.json"), "utf8"),
    );
    const customized = root.body.content.CustomizedMeisaiAnsDisplayServiceBean;
    Object.assign(customized, { shiharaiKin1: "8,765", shiharaiKin2: "100", shiharaiKin3: "50" });
    expect(bill(parse(root))).toBeUndefined();
  });

  for (const [amount, expected] of [
    ["0", 0],
    ["-500", -500],
    ["１２,３４５", 12345],
  ] as const) {
    test(`provider sign and exact integer are preserved: ${amount}`, () => {
      const root = web();
      header(root)["payTotal"] = amount;
      expect(bill(parse(root))?.amountMinor).toBe(expected);
    });
  }

  for (const malformed of ["", "1.5", "8,76", "NaN", "9007199254740992", null, 8765]) {
    test(`malformed provider total fails the artifact: ${String(malformed)}`, () => {
      const root = web();
      header(root)["payTotal"] = malformed;
      expect(() => parse(root)).toThrow();
    });
  }

  for (const [field, value] of [
    ["seikyuYm", "202607"],
    ["seikyuYm", undefined],
    ["shiharaiDate", "2026年2月30日"],
    ["shiharaiDate", "26/08/26"],
    ["shiharaiDate", undefined],
  ] as const) {
    test(`malformed/conflicting ${field} fails the artifact: ${String(value)}`, () => {
      const root = web();
      header(root)[field] = value;
      expect(() => parse(root)).toThrow();
    });
  }

  test("the provider payment date is not replaced by the statement month", () => {
    const root = web();
    header(root)["shiharaiDate"] = "2026年9月1日";
    expect(bill(parse(root))?.extra).toMatchObject({
      _kogane: { period: "2026-08", paymentDate: "2026-09-01" },
    });
  });

  test("an unknown creation state fails when a total is present", () => {
    const root = web();
    root.body.content.WebMeisaiTopDisplayServiceBean.saiseiStatus = "unknown";
    expect(() => parse(root)).toThrow("unsupported creation status");
  });
});
