import { describe, expect, test } from "bun:test";
import {
  parsePrestiaBankBalancePage,
  prestiaBankBalances,
  sanitizePrestiaBankPage,
} from "../src/parsers/prestia-bank-html.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { prestiaBankHtml, prestiaBankRow } from "./prestia-bank-fixture.ts";
const meta = (): ArtifactMeta => ({
  id: 1,
  sourceId: "prestia",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "prestia-bank-balance-html",
  artifactKey: "balance.html",
  fetchUnitKey: "balance-summary",
  url: null,
  mime: "text/html",
  fetchedAt: "2040-01-23T06:00:00.000Z",
  sha256: "0".repeat(64),
});
const run = (html = prestiaBankHtml(), artifact = meta()) =>
  prestiaBankBalances.parse(new TextEncoder().encode(sanitizePrestiaBankPage(html)), artifact);
describe("PRESTIA bank observed mobile balance capture", () => {
  test("preserves native currency scale, distinct term contracts and bank aggregate FX", () => {
    const result = run();
    const eur = result.observations.find(
      (o) => o.kind === "balance" && o.instrument === "EUR" && o.metric === "available_balance",
    )!;
    expect(eur).toMatchObject({
      kind: "balance",
      sourceAccount: "prestia-bank:account:24682468:EUR",
      metric: "available_balance",
      amountText: "12.3400",
      amountScale: 4,
      instrument: "EUR",
    });
    expect("amountMinor" in eur).toBe(false);
    expect(
      result.observations.find((o) => o.kind === "balance" && o.instrument === "KWD"),
    ).toMatchObject({ amountText: "0.00750", amountScale: 5 });
    expect(
      result.observations.find(
        (o) => o.kind === "balance" && o.metric === "term_deposit_principal",
      ),
    ).toMatchObject({
      sourceAccount: "prestia-bank:account:24682468:EUR:deposit:54321",
      amountText: "700.230",
      amountScale: 3,
      extra: { depositNumber: "54321", maturityDate: "2040-02-29" },
    });
    const fx = result.observations.filter(
      (o) => o.kind === "valuation" && o.metric === "provider_yen_equivalent",
    );
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({
      sourceAccount: "prestia-bank:group:foreign-deposits",
      subject: "foreign-deposits",
      amountText: "98765",
      currency: "JPY",
      extra: {
        _kogane: {
          valuationBasis: "bank-latest-ttb",
          aggregationRule: "non-additive",
          allocation: "not-stated",
        },
      },
    });
    expect(result.coverage?.[0]).toMatchObject({ completeness: "complete", observedCount: 12 });
    expect(result.coverage?.[0]?.observedCount).toBe(result.observations.length);
    expect(result.issues).toHaveLength(4);
  });
  test("monthly averages and current aggregates are separate, nonadditive provider evidence", () => {
    const result = run();
    const averages = result.observations.filter(
      (o) => "metric" in o && o.metric.startsWith("provider_monthly_average_"),
    );
    expect(averages).toHaveLength(3);
    expect(averages[0]).toMatchObject({
      metric: "provider_monthly_average_total_relationship_balance",
      sourceAccount: "prestia-bank:relationship",
      amountText: "125678",
      extra: {
        _kogane: {
          aggregationRule: "non-additive",
          timeBasis: "provider-monthly-average",
          periodStatus: "not-stated",
          periodBasis: "provider-reference-at-previous-business-day",
        },
      },
    });
    expect(
      result.observations.find((o) => "metric" in o && o.metric === "provider_balance_group_total"),
    ).toMatchObject({ amountText: "1032" });
    expect(
      run(prestiaBankHtml().replace("125,678 JPY", "-")).observations.filter(
        (o) => "metric" in o && o.metric === "provider_monthly_average_total_relationship_balance",
      ),
    ).toHaveLength(0);
  });
  test("groups by explicit headings inside the mobile page's single inner wrapper", () => {
    const flat = prestiaBankHtml()
      .replaceAll('<div class="inner"><div class="heading-h3">', '<div class="heading-h3">')
      .replaceAll("</p></div>", "</p>")
      .replaceAll("</table></div>", "</table>")
      .replace("<h2>口座残高一覧</h2>", '<h2>口座残高一覧</h2><div class="inner">')
      .replace("</section>", "</div></section>");
    const expected = run();
    expect(run(flat).observations).toEqual(expected.observations);
  });
  test("missing supported detail tables never establish a complete snapshot or sanitized capture", () => {
    for (const index of [1, 2, 3]) {
      const incomplete = prestiaBankHtml().replace(
        new RegExp(
          `<table class="table table-normal mc_table-normal__${index} [^"]*">[\\s\\S]*?<\\/table>`,
          "u",
        ),
        "",
      );
      expect(incomplete).not.toBe(prestiaBankHtml());
      expect(() => parsePrestiaBankBalancePage(incomplete)).toThrow("incomplete-detail-topology");
      expect(() => sanitizePrestiaBankPage(incomplete)).toThrow("incomplete-detail-topology");
      const clean = sanitizePrestiaBankPage(prestiaBankHtml());
      const truncated = clean.replace(
        new RegExp(
          `<table class="table table-normal mc_table-normal__${index} [^"]*">[\\s\\S]*?<\\/table>`,
          "u",
        ),
        "",
      );
      expect(() => prestiaBankBalances.parse(new TextEncoder().encode(truncated), meta())).toThrow(
        "incomplete-detail-topology",
      );
    }
  });
  test("operation cells cannot retain arbitrary direct text, spans or hidden state", () => {
    const input = prestiaBankHtml()
      .replaceAll(
        "<td>詳細へ</td>",
        '<td>synthetic-operation-secret<span>synthetic-operation-token</span><input value="synthetic-hidden-token"></td>',
      )
      .replaceAll(
        '<a href="/private?action=transfer" onclick="transfer()">詳細へ</a>',
        "synthetic-operation-secret<span>synthetic-operation-token</span>",
      );
    const clean = sanitizePrestiaBankPage(input);
    expect(clean).not.toContain("synthetic-operation");
    expect(clean).not.toContain("synthetic-hidden-token");
    expect(sanitizePrestiaBankPage(clean)).toBe(clean);
    expect(run(input).observations).toEqual(run().observations);
    const tampered = clean.replace("<td></td>", "<td>synthetic-operation-secret</td>");
    expect(() => prestiaBankBalances.parse(new TextEncoder().encode(tampered), meta())).toThrow(
      "unsanitized-provider-capture",
    );
  });
  test("unknown financial notes and explicit average periods fail closed instead of being lost", () => {
    for (const note of [
      "月間平均総取引残高の計算期間：2040年1月1日から2040年1月23日",
      "この集計は合成の別の計算方式です。",
      "本日の合成レートで円換算しました。",
    ]) {
      const input = prestiaBankHtml().replace("</section>", `<p>${note}</p></section>`);
      expect(() => parsePrestiaBankBalancePage(input)).toThrow("unknown-financial-note");
      expect(() => sanitizePrestiaBankPage(input)).toThrow("unknown-financial-note");
    }
    const appended = prestiaBankHtml().replace(
      "参考値です。",
      "参考値です。計算期間は2040年1月です。",
    );
    expect(() => run(appended)).toThrow("unknown-financial-note");
    expect(run(prestiaBankHtml().replace("</section>", "<p> </p></section>")).observations).toEqual(
      run().observations,
    );
    for (const period of [
      "<div>合成平均期間2040年1月</div>",
      "<span>合成平均期間2040年1月</span>",
      "合成平均期間2040年1月",
    ]) {
      const input = prestiaBankHtml().replace("</section>", `${period}</section>`);
      expect(() => parsePrestiaBankBalancePage(input)).toThrow("unknown-financial-text");
      expect(() => sanitizePrestiaBankPage(input)).toThrow("unknown-financial-text");
    }
  });
  test("preserves known display freshness and reflection timing notices outside group headings", () => {
    const display =
      "お客様の残高一覧です。時間帯等によっては、最新の情報が表示されない場合があります。";
    const timing =
      "営業日07:11以降翌営業日09:22 まで、および土・日・祝休日（日本標準時）に受付した海外送金取引は、翌営業日の09:22以降に残高および取引履歴に反映されます。";
    const premium =
      "プレミアム・デポジット円投資型において満期時に元本が外貨に交換された場合、満期日の翌営業日09:22以降にプレスティア マルチマネー口座外貨普通預金の残高に反映されます。";
    const input = prestiaBankHtml()
      .replace("<h2>口座残高一覧</h2>", `<h2>口座残高一覧</h2><p>${display}</p><p>${timing}</p>`)
      .replace("合計を表示しております。</p>", `合計を表示しております。 ${timing} ${premium}</p>`);
    const original = parsePrestiaBankBalancePage(input);
    const clean = sanitizePrestiaBankPage(input);
    expect(original.notes).toHaveLength(4);
    expect(parsePrestiaBankBalancePage(clean)).toEqual(original);
    expect(clean).toContain(display);
    expect(clean).toContain(timing);
    expect(clean).toContain(premium);
    expect(sanitizePrestiaBankPage(clean)).toBe(clean);
  });
  test("validates responsive duplicates and retains the provider caption without inventing a period", () => {
    const headings = ["口座", "口座番号", "通貨", "利用可能額", ""];
    const responsive =
      '<div class="mc_cardTbl mc_cardTbl_account mc_hide">' +
      [
        ["合成円口座", "3141592", "JPY", "314 JPY", "synthetic-action-secret"],
        ["合成投資円口座", "24682468", "JPY", "718 JPY", "synthetic-action-secret"],
      ]
        .map(
          (values) =>
            '<div class="mc_cardTbl_row">' +
            values
              .map(
                (value, index) =>
                  `<div class="mc_cardTbl_thtd"><div class="mc_cardTbl_th">${headings[index]}${index === 3 ? '<span class="mc_dtline">:</span>' : ""}</div><div class="mc_cardTbl_td">${value}</div></div>`,
              )
              .join("") +
            "</div>",
        )
        .join("") +
      "</div>";
    const input = prestiaBankHtml()
      .replace(
        '<div class="inner"><div class="heading-h3">',
        '<div class="inner"><a class="btn-print">印刷する</a><div class="mc_acHead"><span>口座を表示する</span></div><div class="btn-area"><a class="btn">ホーム</a></div><span class="heading-caption">(2040/01/23 09:17)</span><div class="heading-h3">',
      )
      .replace(
        '</div><div class="inner"><div class="heading-h3"><h3>外貨普通預金・外貨定期預金</h3>',
        `${responsive}</div><div class="inner"><div class="heading-h3"><h3>外貨普通預金・外貨定期預金</h3>`,
      );
    const parsed = parsePrestiaBankBalancePage(input);
    const clean = sanitizePrestiaBankPage(input);
    expect(parsed.providerCaption).toEqual({
      text: "(2040/01/23 09:17)",
      localDateTime: "2040-01-23T09:17:00",
    });
    expect(parsePrestiaBankBalancePage(clean)).toEqual(parsed);
    expect(clean).not.toContain("synthetic-action-secret");
    expect(run(input).observations[0]?.extra).toMatchObject({
      providerCaption: parsed.providerCaption,
    });
    expect(() =>
      run(
        input.replace('<div class="mc_cardTbl_td">314 JPY', '<div class="mc_cardTbl_td">315 JPY'),
      ),
    ).toThrow("conflicting-responsive-balances");
    expect(() =>
      run(
        input.replace(
          '<div class="mc_cardTbl_thtd">',
          '<div class="mc_cardTbl_thtd"><span>合成平均期間2040年1月</span>',
        ),
      ),
    ).toThrow("unknown-responsive-layout");
    expect(() => run(input.replace("(2040/01/23 09:17)", "(2040/02/30 09:17)"))).toThrow(
      "invalid-maturity-date",
    );
    expect(() => run(input.replace("ホーム", "合成平均期間2040年1月"))).toThrow(
      "unknown-financial-text",
    );
  });
  test("exact decimal text remains authoritative for known subminor precision and large values", () => {
    const result = run(
      prestiaBankHtml(
        prestiaBankRow("USD", "1.234") +
          prestiaBankRow("AUD", "99999999999999999999.00", "13571357"),
      ),
    );
    const rows = result.observations.filter(
      (o) => o.kind === "balance" && ["USD", "AUD"].includes(o.instrument),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amountText: "1.234", amountScale: 3 });
    expect("amountMinor" in rows[0]!).toBe(false);
    expect("amountMinor" in rows[1]!).toBe(false);
  });
  test("sanitizer is idempotent, removes credentials/actions/owner PII, preserves financial evidence", () => {
    const input = prestiaBankHtml().replace(
      "12.3400 EUR",
      '<span onclick="leak()">12.3400 EUR</span><script>synthetic-secret</script>',
    );
    const clean = sanitizePrestiaBankPage(input);
    expect(sanitizePrestiaBankPage(clean)).toBe(clean);
    for (const sensitive of [
      "synthetic-secret",
      "synthetic-token",
      "synthetic-owner",
      "onclick",
      "href=",
      "action=",
      "<input",
      "<script",
      "PRESTIAHEADERFORM",
    ])
      expect(clean).not.toContain(sensitive);
    expect(clean).toContain("24682468");
    expect(parsePrestiaBankBalancePage(clean).accounts).toHaveLength(6);
    expect(clean).toContain("最新のTTBレート");
    expect(clean).toContain("前営業日時点");
    expect(() => prestiaBankBalances.parse(new TextEncoder().encode(input), meta())).toThrow(
      "unsanitized-provider-capture",
    );
    expect(() =>
      prestiaBankBalances.parse(
        new TextEncoder().encode(
          clean.replace("</form>", '<input value="synthetic-token"></form>'),
        ),
        meta(),
      ),
    ).toThrow("unsanitized-provider-capture");
  });
  test("unknown layouts, duplicates and ambiguous amounts fail closed with value-free errors", () => {
    for (const input of [
      prestiaBankHtml().replace("利用可能額", "現在残高"),
      prestiaBankHtml().replace("うち外貨部分", "未知の集計"),
      prestiaBankHtml(prestiaBankRow() + prestiaBankRow()),
      prestiaBankHtml().replace("12.3400 EUR", "12,34 EUR"),
      prestiaBankHtml().replace("12.3400 EUR", "12.3400 USD"),
      prestiaBankHtml().replace("12.3400 EUR", "-"),
      prestiaBankHtml().replace("2040/02/29", "2041/02/29"),
      prestiaBankHtml().replace("最新のTTBレート", "独自計算"),
      prestiaBankHtml().replace("前営業日時点", "独自時点"),
    ]) {
      expect(() => run(input)).toThrow();
      try {
        run(input);
      } catch (error) {
        expect((error as Error).message).toMatch(/^[a-z-]+$/u);
      }
    }
  });
  test("requires exactly the registered dataset and failure-free terminal run", () => {
    expect(PARSERS).toContain(prestiaBankBalances);
    for (const changed of [
      { runStatus: "partial" as const, unitScopeEligibility: "unit-independent-v1" as const },
      { runFailureCount: 1 },
      { runStatus: "failed" as const },
    ])
      expect(() => run(prestiaBankHtml(), { ...meta(), ...changed })).toThrow(
        "unsuccessful-fetch-run",
      );
    for (const changed of [
      { sourceId: "prestia-bank" },
      { dataset: null },
      { artifactKey: "other.html" },
      { fetchUnitKey: "balance" },
      { mime: "application/json" },
    ])
      expect(prestiaBankBalances.accepts({ ...meta(), ...changed })).toBe(false);
  });
});
