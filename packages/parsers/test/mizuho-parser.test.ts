import { describe, expect, test } from "bun:test";
import {
  MizuhoParseError,
  parseAccountPage,
  parseHistoryPage,
  sanitizeMizuhoPage,
} from "../src/parsers/mizuho-html.ts";
import { mizuhoAccountList, mizuhoOrdinaryHistory } from "../src/parsers/mizuho.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta, Parser } from "../src/types.ts";
import {
  mizuhoAccountCard,
  mizuhoAccountHtml,
  mizuhoHistoryHtml,
  mizuhoHistoryRow,
} from "./mizuho-fixture.ts";

const account = () => parseAccountPage(mizuhoAccountHtml()).accounts[0]!;
function meta(history = false, from = 1, to = 1): ArtifactMeta {
  return {
    id: 1,
    sourceId: "mizuho-bank",
    runStatus: "success",
    runFailureCount: 0,
    dataset: history ? "mizuho-ordinary-history-html" : "mizuho-account-list-html",
    artifactKey: history ? `ordinary/001-1234567/history/${from}-${to}.html` : "account-list.html",
    fetchUnitKey: history ? `ordinary:001:1234567:page:${from}:${to}` : "account-list",
    url: null,
    mime: "text/html",
    fetchedAt: "2026-09-13T06:11:00.000Z",
    sha256: "0".repeat(64),
  };
}
const run = (parser: Parser, html: string, artifact = meta()) =>
  parser.parse(new TextEncoder().encode(html), artifact);
function rejects(fn: () => unknown, code: string): void {
  expect(fn).toThrow(MizuhoParseError);
  expect(fn).toThrow(code);
}

describe("Mizuho typed HTML readers", () => {
  test("ordinary account discovery preserves separate branch/account identities", () => {
    const result = parseAccountPage(
      mizuhoAccountHtml(mizuhoAccountCard() + mizuhoAccountCard("001", "002-7654321")),
    );
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toMatchObject({
      branchCode: "001",
      accountNumber: "1234567",
      currency: "JPY",
      balanceYen: "1234",
    });
  });
  test.each(["12,34", "1.25", "NaN", "1,234 円", "１,２３４", "", "01"])(
    "rejects malformed yen %s",
    (money) => {
      rejects(
        () => parseAccountPage(mizuhoAccountHtml().replaceAll("1,234", money)),
        "invalid-yen-amount",
      );
    },
  );
  test("rejects unsupported kind, missing identity, duplicate rows and auth/error/empty pages", () => {
    rejects(
      () => parseAccountPage(mizuhoAccountHtml().replace("普通預金", "定期預金")),
      "unsupported-account-kind",
    );
    rejects(
      () => parseAccountPage(mizuhoAccountHtml().replace("txtAccNo_000", "txtAccNo_001")),
      "missing-or-duplicate-field",
    );
    rejects(
      () => parseAccountPage(mizuhoAccountHtml(mizuhoAccountCard() + mizuhoAccountCard())),
      "duplicate-row-index",
    );
    rejects(
      () => parseAccountPage('<form name="LOGBNK_00000B"></form>'),
      "authentication-required",
    );
    rejects(() => parseAccountPage("<p>50010</p>"), "unrecognized-page");
    rejects(() => parseAccountPage(mizuhoAccountHtml("")), "unrecognized-empty-state");
  });
  test("selects signed movement, not balance, and deduplicates responsive balance only", () => {
    const result = parseHistoryPage(mizuhoHistoryHtml(), account());
    expect(result.transactions).toEqual([
      {
        sourceIndex: "000",
        date: "2026-09-01",
        description: "テスト入金 & fixture",
        amountYen: "1",
        balanceAfterYen: "1234",
      },
    ]);
    rejects(
      () => parseHistoryPage(mizuhoHistoryHtml().replace("1,234", "1,235"), account()),
      "conflicting-responsive-balances",
    );
  });
  test("checks account, amount sign, date and exact displayed count", () => {
    rejects(
      () => parseHistoryPage(mizuhoHistoryHtml().replace("1234567", "7654321"), account()),
      "account-mismatch",
    );
    rejects(
      () => parseHistoryPage(mizuhoHistoryHtml(mizuhoHistoryRow("000", "1")), account()),
      "invalid-yen-amount",
    );
    rejects(
      () =>
        parseHistoryPage(mizuhoHistoryHtml().replace("2026年9月1日", "2026年2月29日"), account()),
      "invalid-transaction-date",
    );
    rejects(
      () => parseHistoryPage(mizuhoHistoryHtml(mizuhoHistoryRow(), "1 - 2 件", "2"), account()),
      "inconsistent-row-count",
    );
    rejects(
      () => parseHistoryPage(mizuhoHistoryHtml("", "0 - 0 件", "0"), account()),
      "unrecognized-empty-state",
    );
  });
});

describe("Mizuho provider-capture sanitization", () => {
  test("drops hidden and unknown text even nested inside preserved amounts", () => {
    const html = mizuhoHistoryHtml().replace(
      "<small>円</small>",
      '<span hidden>private-secret</span><span style="display:none">private-secret</span><small>円</small>',
    );
    const sanitized = sanitizeMizuhoPage(html);
    expect(sanitized).not.toContain("private-secret");
    expect(parseHistoryPage(sanitized, account()).transactions[0]?.amountYen).toBe("1");
  });
  test.each([mizuhoAccountHtml(), mizuhoHistoryHtml()])(
    "removes auth inputs, executable content, URLs and event attributes",
    (original) => {
      const poisoned = original
        .replace("<form ", '<form action="https://secret.example/token" onclick="private-secret" ')
        .replace(
          "</form>",
          '<input type="hidden" name="_TOKEN" value="private-secret"><script>private-secret</script><style>private-secret</style><a href="https://secret.example">private-secret</a></form>',
        );
      const result = sanitizeMizuhoPage(poisoned);
      for (const forbidden of [
        "private-secret",
        "https:",
        "input",
        "script",
        "style",
        "onclick",
        "action=",
        "_TOKEN",
      ])
        expect(result).not.toContain(forbidden);
      expect(result).toContain('charset="utf-8"');
      if (original.includes("BALINQ_03010B"))
        expect(parseAccountPage(result)).toEqual(parseAccountPage(original));
      else
        expect(parseHistoryPage(result, account())).toEqual(parseHistoryPage(original, account()));
      expect(sanitizeMizuhoPage(result)).toBe(result);
    },
  );
});

describe("Mizuho registered observation parsers", () => {
  test("registry routes only matching source, dataset, artifact and successful unit", () => {
    expect(PARSERS.filter((p) => p.accepts(meta())).map((p) => p.name)).toEqual([
      "mizuho-account-list",
    ]);
    expect(PARSERS.filter((p) => p.accepts(meta(true))).map((p) => p.name)).toEqual([
      "mizuho-ordinary-history",
    ]);
    expect(
      PARSERS.filter((p) => p.accepts({ ...meta(), dataset: null })).map((p) => p.name),
    ).toEqual(["mizuho-account-list"]);
    expect(
      PARSERS.filter((p) => p.accepts({ ...meta(true), dataset: null })).map((p) => p.name),
    ).toEqual(["mizuho-ordinary-history"]);
    expect(mizuhoAccountList.accepts({ ...meta(), sourceId: "smbc-bank" })).toBe(false);
    expect(
      mizuhoOrdinaryHistory.accepts({ ...meta(true), fetchUnitKey: "ordinary/001-1234567" }),
    ).toBe(false);
    rejects(
      () =>
        run(mizuhoAccountList, mizuhoAccountHtml(), {
          ...meta(),
          runStatus: "partial",
          runFailureCount: 1,
        }),
      "unsuccessful-fetch-unit",
    );
  });
  test("emits current and available balances without floating-point rounding", () => {
    const result = run(
      mizuhoAccountList,
      mizuhoAccountHtml().replaceAll("1,234", "9,007,199,254,740,993"),
    );
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({
      kind: "balance",
      metric: "account_balance",
      sourceAccount: "mizuho-bank:ordinary:001:1234567",
      amountText: "9007199254740993",
      amountScale: 0,
      instrument: "JPY",
    });
    expect(result.observations[0]).not.toHaveProperty("amountMinor");
    expect(result.observations[1]).toMatchObject({ metric: "available_balance" });
  });
  test("preserves duplicate transactions with distinct content-occurrence IDs", () => {
    const result = run(
      mizuhoOrdinaryHistory,
      mizuhoHistoryHtml(mizuhoHistoryRow() + mizuhoHistoryRow("001"), "1 - 2 件", "3"),
      meta(true, 1, 2),
    );
    expect(result.observations).toHaveLength(2);
    const ids = result.observations.map((o) => (o.kind === "transaction" ? o.externalId : ""));
    expect(new Set(ids).size).toBe(2);
    expect(result.coverage?.[0]).toMatchObject({
      scopeKey: "mizuho-bank/mizuho-ordinary-history-html/unit=ordinary:001:1234567:page:1:2",
      observedCount: 2,
      expectedCount: 2,
      membershipComplete: true,
    });
    expect(result.observations[0]?.extra).toMatchObject({
      _kogane: { coverageScope: "observed-page-only", hasMore: true },
    });
  });
  test("identity survives row index, page-range and collection timestamp changes", () => {
    const first = run(mizuhoOrdinaryHistory, mizuhoHistoryHtml(), meta(true));
    const second = run(
      mizuhoOrdinaryHistory,
      mizuhoHistoryHtml(mizuhoHistoryRow("099"), "2 - 2 件", "2"),
      { ...meta(true, 2, 2), fetchedAt: "2026-09-14T06:11:00.000Z" },
    );
    expect(first.observations[0]?.kind === "transaction" && first.observations[0].externalId).toBe(
      second.observations[0]?.kind === "transaction" && second.observations[0].externalId,
    );
    rejects(
      () => run(mizuhoOrdinaryHistory, mizuhoHistoryHtml(), meta(true, 1, 2)),
      "artifact-page-range-mismatch",
    );
  });
});
