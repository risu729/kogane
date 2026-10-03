import { describe, expect, test } from "bun:test";
import { myJcbCreditLedger, myJcbCreditStatement } from "../src/parsers/myjcb.ts";
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
    // An empty ledger without the heading states nothing, whatever its header
    // label: the collector's `unknown` for positions 7 and 8 agrees, with no
    // warning and no total.
    const emptyRow =
      '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はありません</div></div></div>';
    const emptyUnconfirmed = statementPage([], [UNCONFIRMED_HEAD]).replace(
      `${UNCONFIRMED_HEAD}</div>`,
      `${UNCONFIRMED_HEAD}</div>${emptyRow}`,
    );
    expect(emptyUnconfirmed).toContain("w-100per");
    for (const statementState of ["unknown", "unconfirmed", null] as const) {
      const empty = parse(emptyUnconfirmed, {
        ...misStated,
        artifactKey: "connection-a/credit-detail-07.html",
        statementState,
      });
      expect(empty.observations).toHaveLength(0);
      expect(empty.warnings).toEqual(["statement_total_not_confirmed"]);
    }
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

  test("the shared page reading already matches a head label broken by a <br> (ADR 0005 amendment f)", () => {
    // Every stored confirmed page shows 「今回の<br class="pc-none">お支払い金額」;
    // the page reading compares head labels with whitespace removed, so it
    // reads the page as confirmed, as the collector now does too.
    const observedHead =
      '<div class="cell">ご利用日</div><div class="cell"><span class="row">ご利用先など</span><span class="row">支払区分</span></div><div class="cell">今回の<br class="pc-none">お支払い金額</div>';
    const result = parse(statementPage([HEADING], [observedHead]), misStated);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      extra: { _kogane: { statementState: "confirmed", statementStateBasis: "page-heading" } },
    });
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

describe("a confirmed page under the usage header, proven by the page (1.2.0, ADR 0005 amendment d)", () => {
  // Synthetic rows in the production shape: the payment type inside the
  // combined ご利用先など／支払区分 cell, a two-character label, the amount.
  const USAGE_HEAD = "ご利用日 ご利用先など 支払区分 ご利用金額";
  const usageRow = (merchantCell: string, amount: string) =>
    `<div class="content"><div class="item-cell"><div class="cell">2026/05/20</div><div class="cell">${merchantCell}</div><div class="cell">架空</div><div class="cell">${amount}</div></div></div>`;
  const rows = [usageRow("架空商店A 1回払", "1,000円"), usageRow("架空商店B 1回払", "234円")];
  const usagePage = (ledgerRows: readonly string[], body = total) =>
    `<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1><h2>2026年6月お支払い分のカードご利用明細</h2><div class="detail-list-01"><div class="head">${USAGE_HEAD}</div>${ledgerRows.join("")}</div>${body}</body></html>`;

  test("yields the page total, recording how the page was proven and the label its ledger shows", () => {
    const result = parse(usagePage(rows));
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      metric: "credit_statement_payment_amount",
      amountText: "1234",
      asOf: "2026-06-15",
      extra: {
        _kogane: {
          statementState: "confirmed",
          statementStateBasis: "page-heading-usage-total-proof",
          ledgerAmountLabel: "ご利用金額",
        },
      },
    });
  });

  test("a page under the confirmed header is recorded exactly as in 1.1.0", () => {
    const confirmed = usagePage([]).replace(
      USAGE_HEAD,
      "ご利用日 ご利用先など 支払区分 今回のお支払い金額",
    );
    const kogane = (parse(confirmed).observations[0]!.extra as { _kogane: Record<string, unknown> })
      ._kogane;
    expect(kogane["statementStateBasis"]).toBe("page-heading");
    expect(Object.keys(kogane)).not.toContain("ledgerAmountLabel");
    // The whole 1.1.0 result, key order included, as the 1.1.0 source built it.
    expect(JSON.stringify(parse(confirmed))).toBe(
      JSON.stringify({
        observations: [
          {
            kind: "balance",
            sourceAccount: "myjcb:connection-a:root",
            metric: "credit_statement_payment_amount",
            amountMinor: 1234,
            amountText: "1234",
            amountScale: 0,
            instrument: "JPY",
            asOf: "2026-06-15",
            observedAt: artifact.fetchedAt,
            rawLocator: "html:dt[exact-statement-payment-total]+dd",
            extra: {
              _kogane: {
                canonicalDataset: "credit-detail",
                period: "2026-06",
                statementMonth: "202606",
                paymentDate: "2026-06-15",
                statementState: "confirmed",
                statementStateBasis: "page-heading",
                manifestStatementState: "confirmed",
                sourceAccountScope: "root-statement-aggregate",
                amountSign: "provider-statement-total",
                snapshotSemantics: "provider-reported-monthly-payment-amount",
              },
            },
          },
        ],
        warnings: [],
      }),
    );
  });

  test("an unproven page still fails as a conflict", () => {
    for (const content of [
      // An installment row, even though the sum matches.
      usagePage([usageRow("架空商店A 分割払い", "1,000円"), rows[1]!]),
      // No payment type in the cell.
      usagePage([usageRow("架空商店A", "1,000円"), rows[1]!]),
      // Sum and total differ.
      usagePage(rows, total.replace("1,234", "1,235")),
      // No total.
      usagePage(rows, ""),
      // No rows: nothing proves a non-zero total.
      usagePage([]),
      // Rows in a second ledger, which the stored ledger artifact would not hold.
      usagePage(
        [rows[0]!],
        `<div class="detail-list-01"><div class="head">${USAGE_HEAD}</div>${rows[1]!}</div>${total}`,
      ),
    ])
      expect(() => parse(content)).toThrow(/confirmation conflicts/u);
  });
});

describe("the credit ledger under the usage header (1.2.0)", () => {
  const USAGE_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"];
  const PAYMENT_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"];
  const ledgerArtifact = (state: "confirmed" | "unconfirmed"): ArtifactMeta => ({
    ...artifact,
    dataset: "credit-ledger",
    artifactKey: "connection-a/credit-ledger-01.json",
    statementState: state,
    period: "2026-06",
    mime: "application/json",
  });
  const ledger = (
    state: "confirmed" | "unconfirmed",
    headers: readonly string[],
    expanded: Record<string, string> = { ご利用金額: "1,000円", 摘要: "架空摘要" },
  ) =>
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        detailMonth: 1,
        period: "2026-06",
        state,
        headers,
        rows: [{ summaryCells: ["2026/05/20", "架空商店A 1回払", "架空", "1,000円"], expanded }],
      }),
    );

  test("a confirmed ledger under the usage header records the amount as the usage amount only", () => {
    const [row] = myJcbCreditLedger.parse(
      ledger("confirmed", USAGE_HEADERS),
      ledgerArtifact("confirmed"),
    ).observations;
    expect(row).toMatchObject({ status: "confirmed", amountText: "-1000" });
    const kogane = (row!.extra as { _kogane: Record<string, unknown> })._kogane;
    expect(kogane["amountBasis"]).toBe("confirmed-usage");
    expect(kogane["usageAmountText"]).toBe("1,000円");
    // Nothing on the row states this statement's payment for it.
    expect(Object.keys(kogane)).not.toContain("paymentAmountText");
  });

  test("the other header pairs are read as in 1.1.2", () => {
    const [confirmed] = myJcbCreditLedger.parse(
      ledger("confirmed", PAYMENT_HEADERS),
      ledgerArtifact("confirmed"),
    ).observations;
    expect((confirmed!.extra as { _kogane: Record<string, unknown> })._kogane).toMatchObject({
      amountBasis: "current-statement-payment",
      usageAmountText: "1,000円",
      paymentAmountText: "1,000円",
    });
    const [pending] = myJcbCreditLedger.parse(
      ledger("unconfirmed", USAGE_HEADERS, { 今回のお支払い金額: "1,000円" }),
      ledgerArtifact("unconfirmed"),
    ).observations;
    expect((pending!.extra as { _kogane: Record<string, unknown> })._kogane).toMatchObject({
      amountBasis: "unconfirmed-usage",
      usageAmountText: "1,000円",
      paymentAmountText: "1,000円",
    });
    // An unconfirmed ledger under the confirmed header is still refused, and a
    // confirmed ledger's expanded labels are a confirmed page's whatever its header.
    expect(() =>
      myJcbCreditLedger.parse(
        ledger("unconfirmed", PAYMENT_HEADERS),
        ledgerArtifact("unconfirmed"),
      ),
    ).toThrow(/provider contract/u);
    expect(() =>
      myJcbCreditLedger.parse(
        ledger("confirmed", USAGE_HEADERS, { 今回のお支払い金額: "1,000円" }),
        ledgerArtifact("confirmed"),
      ),
    ).toThrow(/expanded is invalid/u);
  });
});

describe("the statement heading may carry its payment day (1.3.0, ADR 0005 amendment g)", () => {
  // The confirmed page's h2 as the round-5 survey shows it (structure only):
  // 「YYYY年MM月DD日(曜)お支払い分のカードご利用明細」. Pages parsed by 1.2.0
  // show the undated 「YYYY年M月お支払い分のカードご利用明細」.
  const UNDATED = "<h2>2026年6月お支払い分のカードご利用明細</h2>";
  const withHeadings = (...headings: readonly string[]) =>
    html().replace(UNDATED, headings.map((text) => `<h2>${text}</h2>`).join(""));

  test("a dated heading whose day is the total's payment date yields the same total", () => {
    const undated = parse(html());
    expect(undated.observations).toHaveLength(1);
    for (const heading of [
      "2026年06月15日(月)お支払い分のカードご利用明細",
      "2026年6月15日(月)お支払い分のカードご利用明細",
      "2026年 6月 <span>15日</span>\n(月) お支払い分の カードご利用明細",
    ])
      expect(parse(withHeadings(heading))).toEqual(undated);
  });

  test("a dated heading whose day is not the total's payment date fails the parse", () => {
    for (const heading of [
      "2026年6月16日(火)お支払い分のカードご利用明細",
      "2026年6月5日(金)お支払い分のカードご利用明細",
    ])
      expect(() => parse(withHeadings(heading))).toThrow(/heading date and payment date conflict/u);
    // Another month is the month conflict it always was.
    expect(() => parse(withHeadings("2026年7月15日(水)お支払い分のカードご利用明細"))).toThrow(
      /date and month conflict/u,
    );
  });

  test("any other shape, or two headings, is a missing or ambiguous period", () => {
    for (const headings of [
      ["2026年6月15日(祝)お支払い分のカードご利用明細"],
      ["2026年6月15日(月曜)お支払い分のカードご利用明細"],
      ["2026年6月15日月お支払い分のカードご利用明細"],
      ["2026年6月15日(月お支払い分のカードご利用明細"],
      ["2026年6月15日（月）お支払い分のカードご利用明細"],
      ["2026年6月15日お支払い分のカードご利用明細"],
      ["2026年6月31日(月)お支払い分のカードご利用明細"],
      ["2026年13月15日(月)お支払い分のカードご利用明細"],
      ["2026年6月15日(月)お支払い分のカードご利用明細書"],
      ["2026年6月15日(月)お支払い分のカードご利用明細", "2026年6月お支払い分のカードご利用明細"],
      [
        "2026年6月15日(月)お支払い分のカードご利用明細",
        "2026年6月15日(月)お支払い分のカードご利用明細",
      ],
    ])
      expect(() => parse(withHeadings(...headings))).toThrow(
        /statement period missing or ambiguous/u,
      );
  });

  test("a dated page with no total still reads as a missing total, as before", () => {
    expect(
      parse(withHeadings("2026年6月15日(月)お支払い分のカードご利用明細").replace(total, "")),
    ).toEqual({ observations: [], warnings: ["statement_total_missing"] });
  });
});

describe("a schedule page is never a statement (1.4.0, ADR 0005 amendment j)", () => {
  // The round-9 survey's shapes, synthetic text: the ボーナス払い page's h1
  // 「ボーナス#回払いご利用代金明細(未確定分)」 (# a digit) over three h2s, one of
  // them in the dated statement heading's exact form, one empty
  // `detail-list-01` and three tables; the ショッピングスキップ払い page's h1
  // 「ショッピングスキップ払いご利用明細(未確定分)」. No date, amount or label
  // here is a provider value.
  const DATED = "<h2>2026年6月15日(月)お支払い分のカードご利用明細</h2>";
  const emptyLedger =
    '<div class="detail-list-01"><div class="head"><div class="cell">ご利用日</div></div><div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はございません</div></div></div></div>';
  const schedulePage = (h1: string, extra = "") =>
    `<!doctype html><html><body><h1>MyJCB</h1><h1>${h1}</h1>${extra}<h2>架空の見出し</h2>${DATED}<h2>架空の案内</h2>${emptyLedger}<table></table><table></table><table></table></body></html>`;
  const position7: ArtifactMeta = {
    ...artifact,
    artifactKey: "connection-a/credit-detail-07.html",
    statementState: "unknown",
    period: null,
  };
  const refused = { observations: [], warnings: ["schedule_page_not_statement"] };
  const notConfirmed = { observations: [], warnings: ["statement_total_not_confirmed"] };

  test("the bonus page, whose h2 matches the dated heading, is refused with the closed code", () => {
    for (const count of ["2", "12", "２", "１２"])
      expect(
        parse(schedulePage(`ボーナス${count}回払いご利用代金明細(未確定分)`), position7),
      ).toEqual(refused);
    // Whitespace inside the h1 is removed before the comparison.
    expect(
      parse(schedulePage("ボーナス 2 回払い<span>ご利用代金明細</span>\n(未確定分)"), position7),
    ).toEqual(refused);
    // The manifest's state and period are not inputs to the decision.
    expect(
      parse(schedulePage("ボーナス2回払いご利用代金明細(未確定分)"), {
        ...position7,
        statementState: null,
        period: "detailMonth-7",
      }),
    ).toEqual(refused);
  });

  test("the skip-payment page stored as a month is refused the same way", () => {
    expect(
      parse(schedulePage("ショッピングスキップ払いご利用明細(未確定分)"), {
        ...position7,
        artifactKey: "connection-a/credit-detail-08.html",
      }),
    ).toEqual(refused);
  });

  test("the schedule h1 wins over a confirmed heading, a dated h2 and a total", () => {
    // Not observed: a page that also claims to be a closed statement. It is
    // never read as one while a schedule h1 is on it.
    const both = schedulePage(
      "ボーナス2回払いご利用代金明細(未確定分)",
      "<h1>カードご利用代金明細(確定分)</h1>",
    ).replace("</body>", `${total}</body>`);
    expect(parse(both, { ...artifact, artifactKey: "connection-a/credit-detail-07.html" })).toEqual(
      refused,
    );
  });

  test("near misses of the bonus h1 are not schedule pages and read as before", () => {
    for (const h1 of [
      "ボーナス回払いご利用代金明細(未確定分)",
      "ボーナス二回払いご利用代金明細(未確定分)",
      "ボーナス2回払いご利用代金明細（未確定分）",
      "ボーナス2回払いご利用代金明細(確定分)",
      "ボーナス2回払いご利用代金明細",
      "架空ボーナス2回払いご利用代金明細(未確定分)",
    ])
      expect(parse(schedulePage(h1), position7)).toEqual(notConfirmed);
    // Two bonus h1s are not exactly one.
    expect(
      parse(
        schedulePage(
          "ボーナス2回払いご利用代金明細(未確定分)",
          "<h1>ボーナス2回払いご利用代金明細(未確定分)</h1>",
        ),
        position7,
      ),
    ).toEqual(notConfirmed);
  });

  test("a confirmed statement is read exactly as in 1.3.0", () => {
    const result = parse(html());
    expect(result.observations).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  test("the empty-month page states no total: a reason, never a zero (INV05)", () => {
    // The page positions 3–6 showed byte for byte (round 9): h1
    // 「カードご利用代金明細」 without 「(確定分)」, no h2, no ledger, no table,
    // no form, the phrase 「当該月の請求はございません」. The second paragraph is
    // synthetic and stands for the page's other text.
    const emptyMonth =
      "<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細</h1><p>当該月の請求はございません</p><p>架空のお支払い案内</p></body></html>";
    for (const meta of [
      { ...artifact, statementState: "unknown", period: null },
      { ...artifact, statementState: null, period: null },
    ] satisfies ArtifactMeta[])
      expect(parse(emptyMonth, meta)).toEqual(notConfirmed);
  });
});
