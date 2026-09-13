import { describe, expect, test } from "bun:test";
import { MizuhoParseError, parseAccountPage, parseHistoryPage } from "../src/parsers.mjs";

// Entirely synthetic structure matching the observed official page families.
const span = (id, value) => `<span id="${id}">${value}</span>`;
function accountCard(index = "000", number = "001-1234567") {
  return `<button class="btn-account" type="button">
    ${span(`txtAccType_${index}`, "普通預金")}
    ${span(`txtBrnch_${index}`, "テスト支店")}
    ${span(`txtAccNo_${index}`, number)}
    ${span(`txtCrntBalBrrwBal_${index}`, "1,234")}
    ${span(`txtCrntBalBrrwBalCrenCode_${index}`, "円")}
    ${span(`txtBrrwUsblBal_${index}`, "1,234")}</button>`;
}
const accountPage = (cards = accountCard()) => `<form name="BALINQ_03010B">${cards}</form>`;
const account = () => parseAccountPage(accountPage()).accounts[0];
function historyRow(index = "000", amount = "+ 1", balance = "1,234") {
  return `<div class="box-row-tx-ditails"><div><div class="t1-1">
    ${span(`txtTransCntnt_${index}`, "テスト入金 &amp; fixture")}
    ${span(`txtDate_${index}`, "2026年9月1日")}</div>
    <div class="t1-2"><p><span class="amount txt-green">${amount}<small>円</small></span></p>
    <p class="d-pc-hide">${span(`txtEachBal_${index}`, balance)}</p></div>
    <div class="t1-3"><p class="amount">${span(`txtEachBal_${index}`, balance)}<small>円</small></p></div>
    </div></div>`;
}
function historyPage(rows = historyRow(), range = "1&nbsp;-&nbsp;1&nbsp;件", total = "1") {
  return `<form name="ACCHST_04110B">
    ${span("txtBrnch", "テスト支店")}${span("txtTransType", "普通")}${span("txtAccNo", "1234567")}
    ${rows}${span("txtDispDetails", range)}${span("txtAllDispDetails", total)}</form>`;
}
const failure = (fn, code) => {
  try {
    fn();
    throw new Error("Expected parser to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(MizuhoParseError);
    expect(error.code).toBe(code);
  }
};

describe("account HTML parser", () => {
  test("discovers separate account identities and exact integer JPY strings", () => {
    const result = parseAccountPage(accountPage(accountCard() + accountCard("001", "002-7654321")));
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toEqual({
      source: "mizuho",
      sourceIndex: "000",
      accountType: "ordinary-deposit",
      currency: "JPY",
      branchCode: "001",
      accountNumber: "1234567",
      branchName: "テスト支店",
      balanceYen: "1234",
      availableBalanceYen: "1234",
    });
    expect(result.accounts[1].branchCode).toBe("002");
  });
  test("supports negative balance and preserves yen precision above Number safe integers", () => {
    const result = parseAccountPage(accountPage().replaceAll("1,234", "-9,007,199,254,740,993"));
    expect(result.accounts[0].balanceYen).toBe("-9007199254740993");
  });
  test.each(["12,34", "1.25", "NaN", "1,234 円", "１,２３４", "", "01"])(
    "rejects invalid money %s",
    (money) => {
      failure(
        () => parseAccountPage(accountPage().replaceAll("1,234", money)),
        "invalid-yen-amount",
      );
    },
  );
  test("does not silently drop unsupported accounts", () => {
    failure(
      () => parseAccountPage(accountPage().replace("普通預金", "定期預金")),
      "unsupported-account-kind",
    );
    failure(() => parseAccountPage(accountPage().replace("円", "USD")), "unsupported-account-kind");
  });
  test("rejects missing/mismatched indexed fields and duplicate identities", () => {
    failure(
      () => parseAccountPage(accountPage().replace("txtAccNo_000", "txtAccNo_001")),
      "missing-or-duplicate-field",
    );
    failure(
      () => parseAccountPage(accountPage(accountCard() + accountCard("001"))),
      "duplicate-account",
    );
    failure(
      () => parseAccountPage(accountPage(accountCard() + accountCard())),
      "duplicate-row-index",
    );
  });
  test("rejects authentication, provider error, malformed and unobserved empty pages", () => {
    failure(
      () => parseAccountPage('<form name="LOGBNK_00000B"></form>'),
      "authentication-required",
    );
    failure(() => parseAccountPage("<p>50010</p>"), "unrecognized-page");
    failure(() => parseAccountPage(accountPage("")), "unrecognized-empty-state");
    failure(
      () => parseAccountPage(accountPage().replace("001-1234567", "masked-***")),
      "invalid-account-identifier",
    );
    failure(() => parseAccountPage(accountPage() + accountPage()), "unrecognized-page");
  });
  test("errors never include private provider text", () => {
    try {
      parseAccountPage(accountPage().replaceAll("1,234", "private-secret"));
    } catch (error) {
      expect(String(error)).toBe("MizuhoParseError: invalid-yen-amount");
    }
  });
});

describe("history HTML parser", () => {
  test("selects the signed movement instead of balance and deduplicates responsive balance only", () => {
    const result = parseHistoryPage(historyPage(), account());
    expect(result.transactions).toEqual([
      {
        sourceIndex: "000",
        date: "2026-09-01",
        description: "テスト入金 & fixture",
        amountYen: "1",
        balanceAfterYen: "1234",
      },
    ]);
    expect(result.displayedRange).toEqual({ from: 1, to: 1, total: 1 });
    expect(result.hasMore).toBe(false);
  });
  test("preserves identical transactions as separate rows and reports partial-page coverage", () => {
    const result = parseHistoryPage(
      historyPage(historyRow() + historyRow("001"), "1 - 2 件", "3"),
      account(),
    );
    expect(result.transactions).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });
  test("supports debit and valid leap date", () => {
    const result = parseHistoryPage(
      historyPage(historyRow("000", "- 1,000")).replace("2026年9月1日", "2024年2月29日"),
      account(),
    );
    expect(result.transactions[0].amountYen).toBe("-1000");
    expect(result.transactions[0].date).toBe("2024-02-29");
  });
  test("rejects contradictory mobile and desktop balances", () => {
    failure(
      () => parseHistoryPage(historyPage().replace("1,234", "1,235"), account()),
      "conflicting-responsive-balances",
    );
  });
  test("requires sign and JPY, never infers movement direction from color", () => {
    failure(
      () => parseHistoryPage(historyPage(historyRow("000", "1")), account()),
      "invalid-yen-amount",
    );
    failure(
      () => parseHistoryPage(historyPage(historyRow("000", "+ 1 000")), account()),
      "invalid-yen-amount",
    );
    failure(
      () => parseHistoryPage(historyPage().replace("円", "USD"), account()),
      "unsupported-transaction-currency",
    );
  });
  test.each(["2026年2月29日", "2026年13月1日", "2026/09/01"])(
    "rejects invalid or unobserved date %s",
    (date) => {
      failure(
        () => parseHistoryPage(historyPage().replace("2026年9月1日", date), account()),
        "invalid-transaction-date",
      );
    },
  );
  test("verifies the account against prior discovery", () => {
    failure(
      () => parseHistoryPage(historyPage().replace("1234567", "7654321"), account()),
      "account-mismatch",
    );
    failure(
      () => parseHistoryPage(historyPage().replace("1234567", "001-1234567"), account()),
      "invalid-account-identifier",
    );
    failure(
      () => parseHistoryPage(historyPage().replace("テスト支店", "別支店"), account()),
      "account-mismatch",
    );
    failure(
      () => parseHistoryPage(historyPage(), { ...account(), currency: "USD" }),
      "invalid-account-context",
    );
  });
  test("requires row count to agree with range and total", () => {
    failure(
      () => parseHistoryPage(historyPage(historyRow(), "1 - 2 件", "2"), account()),
      "inconsistent-row-count",
    );
    failure(
      () => parseHistoryPage(historyPage(historyRow(), "2 - 2 件", "1"), account()),
      "inconsistent-row-count",
    );
    failure(
      () => parseHistoryPage(historyPage(historyRow(), "1 件", "1"), account()),
      "invalid-displayed-range",
    );
  });
  test("rejects missing transaction fields and duplicate page-local indices", () => {
    failure(
      () => parseHistoryPage(historyPage().replace("txtDate_000", "txtDate_001"), account()),
      "missing-or-duplicate-field",
    );
    failure(
      () => parseHistoryPage(historyPage(historyRow() + historyRow(), "1 - 2 件", "2"), account()),
      "duplicate-row-index",
    );
    failure(
      () => parseHistoryPage(historyPage("", "0 - 0 件", "0"), account()),
      "unrecognized-empty-state",
    );
  });
});
