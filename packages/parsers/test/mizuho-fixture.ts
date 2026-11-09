// Synthetic values only; structures reflect the authenticated form families.
const span = (id: string, value: string): string => `<span id="${id}">${value}</span>`;
export function mizuhoAccountCard(index = "000", number = "001-1234567"): string {
  return `<button class="btn-account" type="button">
    ${span(`txtAccType_${index}`, "普通預金")}${span(`txtBrnch_${index}`, "テスト支店")}
    ${span(`txtAccNo_${index}`, number)}${span(`txtCrntBalBrrwBal_${index}`, "1,234")}
    ${span(`txtCrntBalBrrwBalCrenCode_${index}`, "円")}${span(`txtBrrwUsblBal_${index}`, "1,234")}</button>`;
}
export const mizuhoAccountHtml = (cards = mizuhoAccountCard()): string =>
  `<!doctype html><form name="BALINQ_03010B">${cards}</form>`;
export function mizuhoHistoryRow(index = "000", amount = "+ 1", balance = "1,234"): string {
  return `<div class="box-row-tx-ditails"><div><div class="t1-1">
    ${span(`txtTransCntnt_${index}`, "テスト入金 &amp; fixture")}${span(`txtDate_${index}`, "2026年9月1日")}</div>
    <div class="t1-2"><p><span class="amount txt-green">${amount}<small>円</small></span></p>
    <p class="d-pc-hide">${span(`txtEachBal_${index}`, balance)}</p></div>
    <div class="t1-3"><p class="amount">${span(`txtEachBal_${index}`, balance)}<small>円</small></p></div></div></div>`;
}
export function mizuhoHistoryHtml(
  rows = mizuhoHistoryRow(),
  range = "1&nbsp;-&nbsp;1&nbsp;件",
  total = "1",
): string {
  return `<!doctype html><form name="ACCHST_04110B">${span("txtBrnch", "テスト支店")}
    ${span("txtTransType", "普通")}${span("txtAccNo", "1234567")}${rows}
    ${span("txtDispDetails", range)}${span("txtAllDispDetails", total)}</form>`;
}
/**
 * The empty history page as the collector stores it (issue 1145): the account
 * header and its currency-only amount, and no transaction block at all. The
 * structure follows the sanitized capture of fetch run 1481; every value is
 * invented.
 */
export function mizuhoEmptyHistoryHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><form name="ACCHST_04110B"><div><div><div><div><div>${span("txtBrnch", "テスト支店")}</div><div>${span("txtTransType", "普通")}${span("txtAccNo", "1234567")}</div></div></div><div><div><div><span class="amount"><small>円</small></span></div></div></div></div></div></form></body></html>`;
}
