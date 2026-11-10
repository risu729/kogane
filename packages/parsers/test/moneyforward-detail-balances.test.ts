import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { moneyForwardDetailBalances as parser } from "../src/parsers/moneyforward-detail-balances.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { coverageClaimViolations } from "../../domain/src/coverage.ts";

const bank = readFileSync(
  new URL(
    "../../../tests/fixtures/observation-pipeline/moneyforward/bank-detail-balances.html",
    import.meta.url,
  ),
  "utf8",
);
export const detailMeta: ArtifactMeta = {
  id: 1,
  sourceId: "moneyforward-me",
  dataset: "account-detail",
  artifactKey: "account-detail-01.html",
  fetchUnitKey: `moneyforward-account-v2-${"a".repeat(64)}`,
  runStatus: "success",
  runFailureCount: 0,
  statementState: null,
  period: null,
  url: null,
  mime: "text/html",
  fetchedAt: "2099-02-01T00:00:00Z",
  sha256: "a".repeat(64),
};
const parse = (html = bank, overrides: Partial<ArtifactMeta> = {}) =>
  parser.parse(new TextEncoder().encode(html), { ...detailMeta, ...overrides });
const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const cardMain = `<section class="accounts-form"><h1 class="heading-small">引き落とし予定額：未定</h1>
<table class="table-bordered"><thead><tr>${["名称", "種類", "番号", "引き落とし予定額"].map((v) => `<th>${v}</th>`).join("")}</tr></thead>
<tbody>${row(["Synthetic card", "Synthetic", "synthetic", "-", "-"])}</tbody></table></section>`;
const points = `<section id="portfolio_det_po" class="margin-top"><table class="table-bordered table-pns">
<thead><tr>${["名称", "種類", "ポイント・マイル数", "換算レート", "現在の価値"].map((v) => `<th>${v}</th>`).join("")}</tr></thead>
<tbody><tr><td>Synthetic reward</td><td>Synthetic</td><td class="number">2,400ポイント</td><td class="number">0.50</td><td class="number">1,200円</td></tr></tbody></table></section>`;
const debt = `<section id="portfolio_det_po" class="margin-top"><table class="table-bordered table-pns"><thead><tr><th>名称</th><th>残高</th><th>取得日</th></tr></thead>
<tbody><tr><td>Synthetic debt</td><td class="restrict-premium-text"><a href="/premium">プレミアム限定</a></td><td class="entry-date">2099/01/01</td></tr></tbody></table></section>`;
const card = bank
  .replace(/<section class="accounts-form">[\s\S]*?<\/section>/u, cardMain)
  .replace("</body>", `${debt}${points}</body>`);

describe("MoneyForward observed detail measures", () => {
  test("publishes one exact provider JPY aggregate, no native AUD or duplicate product balances", () => {
    const result = parse();
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "balance",
      sourceAccount: `moneyforward-me:${detailMeta.fetchUnitKey}`,
      metric: "reported_account_value_jpy",
      amountText: "1300",
      amountScale: 0,
      instrument: "JPY",
      observedAt: detailMeta.fetchedAt,
    });
    expect(result.observations[0]).not.toHaveProperty("asOf");
    expect(result.issues?.map((i) => i.message)).toContain(
      "moneyforward_detail_product_balance_missing",
    );
    expect(result.coverage?.[0]).toMatchObject({
      completeness: "complete",
      observedCount: 1,
      membershipComplete: true,
    });
    expect(coverageClaimViolations(result.coverage![0]!)).toEqual([]);
  });
  test("full headers distinguish the same-ID gated debt and point tables", () => {
    const result = parse(card);
    expect(
      result.observations.map((o) =>
        o.kind === "balance" ? [o.metric, o.amountText, o.instrument] : [],
      ),
    ).toEqual([
      ["reported_point_quantity", "2400", "POINT"],
      ["reported_point_value_jpy", "1200", "JPY"],
    ]);
    expect(result.issues?.map((i) => i.message)).toEqual([
      "moneyforward_detail_card_payment_undetermined",
      "moneyforward_detail_card_debt_premium_gated",
      "moneyforward_detail_securities_holdings_unobserved",
    ]);
    expect(result.observations.every((o) => o.asOf === undefined)).toBe(true);
    expect(coverageClaimViolations(result.coverage![0]!)).toEqual([]);
  });
  test("a gated card without points is partial, never a complete empty or zero balance", () => {
    const result = parse(card.replace(points, ""));
    expect(result.observations).toEqual([]);
    expect(result.coverage?.[0]).toMatchObject({
      completeness: "partial",
      membershipComplete: false,
      absenceMeaning: "unknown",
    });
    expect(coverageClaimViolations(result.coverage![0]!)).toEqual([]);
  });
  test("rejects changed totals, headers, rows, currencies, malformed quantities and truncation", () => {
    for (const html of [
      bank.replace("資産総額：1,300円", "資産総額：1,301円"),
      bank.replace("<th>残高</th>", "<th>Unknown</th>"),
      bank.replace("<td>1,100円</td>", "<td>1,100AUD</td>"),
      bank.replace("<td>1,100円</td>", "<td>1,10円</td>"),
      bank.replace("<td>1,100円</td>", "<td>-1,100円</td>"),
      bank.replace("<td>1,100円</td>", "<td>1,100円</td><td>extra</td>"),
      bank.replace("<td>1,100円</td>", "<td><span>1,100円</span></td>"),
      bank.replace("<td>1,100円</td>", "<td>1,100円"),
      bank.replace('<section class="accounts-form">', '<section class="other">'),
      card.replace("0.50", "0.5"),
      card.replace("1,200円", "1,201円"),
      card.replace("2,400ポイント", "2,400マイル"),
      card.replace(points, points + points),
      card.replace("プレミアム限定", "1,000円"),
      card.replace("<th>ポイント・マイル数</th>", "<th>残高</th>"),
    ])
      expect(() => parse(html)).toThrow();
  });
  test("preserves run and account identity admission, including historical stored shapes", () => {
    expect(() => parse(bank, { runStatus: "partial" })).toThrow();
    expect(() => parse(bank, { fetchUnitKey: "account-01" })).toThrow();
    expect(() => parse(bank, { statementState: "confirmed" })).toThrow();
    expect(() => parse(bank, { artifactKey: "account-detail-65.html" })).toThrow();
    expect(() => parse(bank.replace(/<section[\s\S]*?<\/section>/gu, ""))).toThrow();
    expect(
      parse(bank, { fetchUnitKey: `moneyforward-account-v1-${"b".repeat(64)}` }).observations,
    ).toHaveLength(1);
  });
  test("requires explicit document and target-section closures before claiming membership", () => {
    const bankWithPoints = bank.replace("</body>", `${points}</body>`);
    expect(parse(bankWithPoints).observations).toHaveLength(3);
    const recentTableStart = '<table id="cf-detail-table">';
    const truncated = bankWithPoints.slice(
      0,
      bankWithPoints.indexOf(recentTableStart) + recentTableStart.length,
    );
    for (const html of [
      truncated,
      bankWithPoints.replace("</html>", ""),
      bankWithPoints.replace("</body>", ""),
    ])
      expect(() => parse(html)).toThrow("moneyforward_detail_document_incomplete");
    expect(() => parse(bank.replace("</tbody></table></section>", "</tbody></table>"))).toThrow(
      "moneyforward_detail_account_section_incomplete",
    );
    expect(() => parse(bankWithPoints.replace(points, points.replace("</section>", "")))).toThrow(
      "moneyforward_detail_portfolio_section_incomplete",
    );
  });
});
