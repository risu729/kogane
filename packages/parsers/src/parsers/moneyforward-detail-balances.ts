import { parse } from "parse5";
import type { ArtifactMeta, BalanceObservation, ParseResult, Parser } from "../types.ts";
import { moneyForwardEvidenceOnly } from "./moneyforward-parser.ts";
import type { MoneyForwardDomNode } from "./moneyforward.ts";
import { containerScopeKey, COVERAGE_POLICY_VERSION } from "./coverage.ts";

type Node = MoneyForwardDomNode;
const children = (node: Node): Node[] => (node.childNodes ?? []).filter((n) => n.tagName);
const attr = (node: Node, name: string): string | undefined =>
  node.attrs?.find((a) => a.name === name)?.value;
const hasClass = (node: Node, name: string): boolean =>
  (attr(node, "class") ?? "").split(/\s+/u).includes(name);
function all(node: Node): Node[] {
  return [node, ...(node.childNodes ?? []).flatMap(all)];
}
function text(node: Node): string {
  return (node.value ?? (node.childNodes ?? []).map(text).join("")).replace(/\s+/gu, " ").trim();
}
function fail(code: string): never {
  throw new Error(`moneyforward_detail_${code}`);
}
function integer(value: string, suffix: string): string {
  const number = value.endsWith(suffix) ? value.slice(0, -suffix.length).trim() : "";
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u.test(number) || number.length > 40)
    fail("quantity_unparsed");
  return BigInt(number.replaceAll(",", "")).toString();
}
function rows(table: Node, headers: readonly string[], width = headers.length): Node[][] {
  if (all(table).some((n) => n.tagName && !n.sourceCodeLocation?.endTag)) fail("table_incomplete");
  const sections = children(table);
  if (sections.length !== 2 || sections[0]?.tagName !== "thead" || sections[1]?.tagName !== "tbody")
    fail("table_structure_unsupported");
  const head = children(sections[0]!);
  if (head.length !== 1 || head[0]?.tagName !== "tr") fail("header_unsupported");
  const cells = children(head[0]!);
  if (
    cells.some((c) => c.tagName !== "th") ||
    JSON.stringify(cells.map(text)) !== JSON.stringify(headers)
  )
    fail("header_unsupported");
  const body = children(sections[1]!);
  if (body.length < 1 || body.length > 64) fail("row_count_unsupported");
  return body.map((row) => {
    const values = children(row);
    if (row.tagName !== "tr" || values.length !== width || values.some((c) => c.tagName !== "td"))
      fail("row_shape_unsupported");
    return values;
  });
}
const BANK = ["名称", "種類", "番号", "残高"];
const CARD = ["名称", "種類", "番号", "引き落とし予定額"];
const POINTS = ["名称", "種類", "ポイント・マイル数", "換算レート", "現在の価値"];
const DEBT = ["名称", "残高", "取得日"];
const header = (table: Node): string =>
  JSON.stringify(
    children(table)
      .filter((n) => n.tagName === "thead")
      .flatMap(children)
      .flatMap(children)
      .map(text),
  );

export const moneyForwardDetailBalances: Parser = {
  name: "moneyforward-detail-balances",
  version: "1.0.0",
  accepts: (a: ArtifactMeta) =>
    a.sourceId === "moneyforward-me" &&
    a.dataset === "account-detail" &&
    (a.mime === "text/html" || a.mime === "text/html; charset=utf-8"),
  parse(bytes, artifact): ParseResult {
    if (!moneyForwardDetailBalances.accepts(artifact)) fail("metadata_unsupported");
    // Reuse the frozen boundary's run, identity, size, UTF-8 and document checks.
    moneyForwardEvidenceOnly.parse(bytes, artifact);
    const document = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      sourceCodeLocationInfo: true,
    }) as unknown as Node;
    const sections = all(document).filter(
      (n) => n.tagName === "section" && hasClass(n, "accounts-form"),
    );
    if (sections.length !== 1) fail("account_surface_unsupported");
    const section = sections[0]!;
    const main = children(section).filter(
      (n) => n.tagName === "table" && hasClass(n, "table-bordered"),
    );
    const headings = children(section).filter(
      (n) => n.tagName === "h1" && hasClass(n, "heading-small"),
    );
    if (main.length !== 1 || headings.length !== 1) fail("account_surface_unsupported");
    const observations: BalanceObservation[] = [];
    const unavailable: string[] = [];
    const emit = (
      metric: string,
      amount: string,
      instrument: string,
      locator: string,
      cells: string[],
    ) => {
      observations.push({
        kind: "balance",
        sourceAccount: `moneyforward-me:${artifact.fetchUnitKey!}`,
        metric,
        amountText: amount,
        amountScale: 0,
        instrument,
        observedAt: artifact.fetchedAt,
        rawLocator: locator,
        extra: {
          cells,
          _kogane: {
            sourceView: "account-detail",
            amountBasis: "provider-reported",
            providerAsOf: "not-observed",
          },
        },
      });
    };
    const mainHeader = header(main[0]!);
    if (mainHeader === JSON.stringify(BANK)) {
      const bankRows = rows(main[0]!, BANK);
      if (bankRows.some((cells) => cells.some((cell) => children(cell).length !== 0)))
        fail("bank_cell_shape_unobserved");
      const amounts = bankRows.map((cells) =>
        text(cells[3]!) === "-" ? null : integer(text(cells[3]!), "円"),
      );
      const heading = text(headings[0]!);
      if (!heading.startsWith("資産総額：")) fail("bank_heading_unsupported");
      const total = integer(heading.slice("資産総額：".length), "円");
      if (
        amounts
          .filter((value) => value !== null)
          .reduce((sum, value) => sum + BigInt(value), 0n) !== BigInt(total)
      )
        fail("bank_total_mismatch");
      // Only the provider's aggregate has a stable scope. The duplicate deposit
      // table and unidentified product rows never become additional balances.
      emit(
        "reported_account_value_jpy",
        total,
        "JPY",
        "html:section.accounts-form>h1.heading-small",
        [heading],
      );
      if (amounts.includes(null)) unavailable.push("product_balance_missing");
    } else if (mainHeader === JSON.stringify(CARD)) {
      const cardRows = rows(main[0]!, CARD, 5);
      if (
        text(headings[0]!) !== "引き落とし予定額：未定" ||
        cardRows.some((cells) => text(cells[3]!) !== "-" || text(cells[4]!) !== "-")
      )
        fail("card_payment_shape_unobserved");
      unavailable.push("card_payment_undetermined");
    } else fail("account_kind_unobserved");
    const portfolios = all(document).filter(
      (n) => n.tagName === "section" && attr(n, "id") === "portfolio_det_po",
    );
    const seen = new Set<string>();
    for (const portfolio of portfolios) {
      const tables = all(portfolio).filter(
        (n) => n.tagName === "table" && hasClass(n, "table-pns"),
      );
      if (tables.length !== 1) fail("portfolio_structure_unsupported");
      const table = tables[0]!;
      const shape = header(table);
      if (seen.has(shape)) fail("portfolio_duplicate");
      seen.add(shape);
      if (shape === JSON.stringify(POINTS)) {
        const pointRows = rows(table, POINTS);
        if (pointRows.length !== 1) fail("point_scope_unobserved");
        const values = pointRows[0]!.map(text);
        const quantity = integer(values[2]!, "ポイント");
        if (
          pointRows[0]!.some((cell) => children(cell).length !== 0) ||
          pointRows[0]!.slice(2).some((cell) => !hasClass(cell, "number")) ||
          !/^(?:0|[1-9]\d*)\.\d{2}$/u.test(values[3]!)
        )
          fail("point_rate_unparsed");
        const value = integer(values[4]!, "円");
        const rate = BigInt(values[3]!.replace(".", ""));
        if (BigInt(quantity) * rate !== BigInt(value) * 100n) fail("point_value_mismatch");
        emit(
          "reported_point_quantity",
          quantity,
          "POINT",
          "html:portfolio:points:row=0:quantity",
          values,
        );
        emit("reported_point_value_jpy", value, "JPY", "html:portfolio:points:row=0:value", values);
      } else if (shape === JSON.stringify(DEBT)) {
        const debtRows = rows(table, DEBT);
        if (
          debtRows.some(
            (cells) =>
              !all(cells[1]!).some((n) => hasClass(n, "restrict-premium-text")) ||
              !text(cells[1]!).includes("プレミアム限定") ||
              !hasClass(cells[2]!, "entry-date") ||
              !/^\d{4}\/\d{2}\/\d{2}$/u.test(text(cells[2]!)),
          )
        )
          fail("card_debt_shape_unobserved");
        unavailable.push("card_debt_premium_gated");
      } else fail("portfolio_kind_unobserved");
    }
    unavailable.push("securities_holdings_unobserved");
    return {
      observations,
      warnings: [],
      issues: unavailable.map((code) => ({
        code: "row_unreadable",
        locator: `html:account-detail:${code}`,
        severity: "warning",
        impact: "field",
        message: `moneyforward_detail_${code}`,
      })),
      coverage: [
        {
          claimId: `container:${containerScopeKey(artifact)}`,
          scopeKey: containerScopeKey(artifact),
          mode: "complete-container",
          completeness: observations.length ? "complete" : "partial",
          membershipComplete: observations.length > 0,
          observedCount: observations.length,
          expectedCount: observations.length || null,
          evidenceRefs: ["html:section.accounts-form"],
          policyVersion: COVERAGE_POLICY_VERSION,
          failureCause: null,
          absenceMeaning: observations.length ? "not-applicable" : "unknown",
        },
      ],
    };
  },
};
