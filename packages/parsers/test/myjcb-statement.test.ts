import { describe, expect, test } from "bun:test";
import { myJcbCreditStatement } from "../src/parsers/myjcb.ts";
import type { ArtifactMeta } from "../src/types.ts";

const artifact: ArtifactMeta = {
  id: 1,
  sourceId: "myjcb",
  dataset: "credit-detail",
  artifactKey: "connection-a/credit-detail-03.html",
  runStatus: "success",
  runFailureCount: 0,
  statementState: "confirmed",
  period: "2026-06",
  url: null,
  mime: "text/html; charset=utf-8",
  fetchedAt: "2026-09-13T00:00:00.000Z",
  sha256: "a".repeat(64),
};
const total =
  '<dl class="list"><dt>2026年6月15日(月)お支払い金額合計</dt><dd><span>1,234</span>円</dd></dl>';
const html = (body = total) =>
  `<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1><h2>2026年6月お支払い分のカードご利用明細</h2><div class="detail-list-01"></div>${body}</body></html>`;
const parse = (body = html(), meta = artifact) =>
  myJcbCreditStatement.parse(new TextEncoder().encode(body), meta);

describe("authoritative MyJCB statement totals", () => {
  test("accepts CORE's normalized HTML media type without allowing other encodings", () => {
    for (const mime of ["text/html", "text/html; charset=utf-8"]) {
      const meta = { ...artifact, mime };
      expect(myJcbCreditStatement.accepts(meta)).toBe(true);
      expect(parse(html(), meta).observations).toHaveLength(1);
    }
    for (const mime of ["application/json", "text/plain", "text/html; charset=shift_jis"])
      expect(myJcbCreditStatement.accepts({ ...artifact, mime })).toBe(false);
    expect(() =>
      myJcbCreditStatement.parse(new Uint8Array([0xff]), { ...artifact, mime: "text/html" }),
    ).toThrow();
  });
  test("records the provider total and actual due date, ignoring usage and subtotals", () => {
    const result = parse(html("<dl><dt>お支払い小計</dt><dd>999円</dd></dl>" + total));
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "balance",
      sourceAccount: "myjcb:connection-a:root",
      metric: "credit_statement_payment_amount",
      amountText: "1234",
      amountScale: 0,
      instrument: "JPY",
      asOf: "2026-06-15",
      extra: {
        _kogane: { period: "2026-06", paymentDate: "2026-06-15", statementState: "confirmed" },
      },
    });
  });
  test("archived HTML can establish exact statement facts without omitted manifest metadata", () => {
    expect(
      parse(html(), { ...artifact, statementState: null, period: null }).observations,
    ).toHaveLength(1);
  });
  test("absent or mutable totals do not invent an amount or due date", () => {
    expect(parse(html("")).observations).toHaveLength(0);
    const pending = html().replace("(確定分)", "(未確定分)");
    expect(
      parse(pending, { ...artifact, statementState: "unconfirmed" }).observations,
    ).toHaveLength(0);
  });
  test("refunds and zero remain provider values, never converted into debit obligations", () => {
    expect(parse(html().replace("1,234", "-1,234")).observations[0]).toMatchObject({
      amountText: "-1234",
    });
    expect(parse(html().replace("1,234", "0")).observations[0]).toMatchObject({ amountText: "0" });
  });
  test("conflicting dates, metadata, duplicate totals and missing exact dates fail closed", () => {
    for (const content of [
      html(total + total),
      html().replace("6月15日", "6月31日"),
      html().replace("6月15日", "7月15日"),
      html().replace("15日(月)", ""),
      html().replace("1,234", "1,23"),
      html().replace("</dl>", "<dd>500円</dd></dl>"),
    ])
      expect(() => parse(content)).toThrow();
    expect(() => parse(html(), { ...artifact, period: "2026-07" })).toThrow();
    expect(() =>
      parse(html(), {
        ...artifact,
        artifactKey: "connection-a/credit-detail-00.html",
        statementState: null,
      }),
    ).toThrow();
  });
  test("the existing artifact success and sanitization boundary still applies", () => {
    expect(() => parse(html(), { ...artifact, runStatus: "failed", runFailureCount: 1 })).toThrow();
    expect(() => parse(html("<script>alert(1)</script>" + total))).toThrow();
  });
});

describe("the statement state is the page's own (1.1.0)", () => {
  const CONFIRMED_HEAD = "ご利用日 ご利用先など 支払区分 今回のお支払い金額";
  const UNCONFIRMED_HEAD = "ご利用日 ご利用先など 支払区分 ご利用金額";
  const HEADING = "カードご利用代金明細(確定分)";
  const ledger = (head: string) =>
    `<div class="detail-list-01"><div class="head">${head}</div></div>`;
  /** A statement page with the given h1 headings and ledger headers; synthetic. */
  const statementPage = (headings: readonly string[], heads: readonly string[]) =>
    `<!doctype html><html><body><h1>MyJCB</h1>${headings.map((text) => `<h1>${text}</h1>`).join("")}<h2>2026年6月お支払い分のカードご利用明細</h2>${heads.map(ledger).join("")}${total}</body></html>`;
  /** Position 1 as the collector recorded it before it read the page. */
  const misStated: ArtifactMeta = {
    ...artifact,
    artifactKey: "connection-a/credit-detail-01.html",
    statementState: "unconfirmed",
    period: "detailMonth-1",
  };

  test("a closed page the manifest recorded as unconfirmed yields its total", () => {
    const result = parse(statementPage([HEADING], [CONFIRMED_HEAD]), misStated);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      metric: "credit_statement_payment_amount",
      amountText: "1234",
      asOf: "2026-06-15",
      extra: {
        _kogane: {
          period: "2026-06",
          statementState: "confirmed",
          statementStateBasis: "page-heading",
          // The manifest's reading stays visible beside the page's.
          manifestStatementState: "unconfirmed",
        },
      },
    });
    expect(result.warnings).toEqual(["statement_state_differs_from_manifest"]);
    // The same for a manifest that recorded no state it could prove, and for
    // a closed page without a ledger.
    expect(
      parse(statementPage([HEADING], [CONFIRMED_HEAD]), { ...misStated, statementState: "unknown" })
        .observations,
    ).toHaveLength(1);
    expect(parse(statementPage([HEADING], []), misStated).observations).toHaveLength(1);
  });

  test("an agreeing manifest adds no warning and is recorded as well", () => {
    const result = parse(statementPage([HEADING], [CONFIRMED_HEAD]));
    expect(result.warnings).toEqual([]);
    expect(result.observations[0]?.extra).toMatchObject({
      _kogane: { statementState: "confirmed", manifestStatementState: "confirmed" },
    });
    expect(
      parse(statementPage([HEADING], [CONFIRMED_HEAD]), { ...artifact, statementState: null })
        .observations[0]?.extra,
    ).toMatchObject({ _kogane: { manifestStatementState: null } });
  });

  test("a page that does not state it is closed yields no total, whatever the manifest says", () => {
    // Unconfirmed headers and no heading: the mutable statement.
    const mutable = parse(statementPage([], [UNCONFIRMED_HEAD]));
    expect(mutable.observations).toHaveLength(0);
    expect(mutable.warnings).toEqual([
      "statement_total_not_confirmed",
      "statement_state_differs_from_manifest",
    ]);
    expect(parse(statementPage([], [UNCONFIRMED_HEAD]), misStated).warnings).toEqual([
      "statement_total_not_confirmed",
    ]);
    // The collector's `unknown` for a page without the heading agrees.
    expect(
      parse(statementPage([], [UNCONFIRMED_HEAD]), { ...misStated, statementState: "unknown" })
        .warnings,
    ).toEqual(["statement_total_not_confirmed"]);
    // A confirmed header without the heading proves nothing more than before.
    expect(parse(statementPage([], [CONFIRMED_HEAD])).observations).toHaveLength(0);
    expect(parse(statementPage(["カードご利用代金明細(未確定分)"], [])).observations).toHaveLength(
      0,
    );
  });

  test("a page whose heading and ledger headers disagree fails the parse", () => {
    for (const content of [
      statementPage([HEADING], [UNCONFIRMED_HEAD]),
      statementPage([HEADING, HEADING], [CONFIRMED_HEAD]),
      statementPage([HEADING], [`${CONFIRMED_HEAD} ご利用金額`]),
      statementPage([HEADING], [CONFIRMED_HEAD, UNCONFIRMED_HEAD]),
      statementPage([], [CONFIRMED_HEAD, UNCONFIRMED_HEAD]),
    ]) {
      // Fails for the manifest that agrees with neither and for one that agrees.
      expect(() => parse(content, misStated)).toThrow(/confirmation conflicts/u);
      expect(() => parse(content)).toThrow(/confirmation conflicts/u);
    }
  });

  test("position 0 is never finalized, even when its page states it is closed", () => {
    expect(() =>
      parse(statementPage([HEADING], [CONFIRMED_HEAD]), {
        ...misStated,
        artifactKey: "connection-a/credit-detail-00.html",
      }),
    ).toThrow(/cannot be finalized/u);
  });
});
