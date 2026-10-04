// Entirely synthetic. Only the provider's fixed headings and table topology
// are mirrored; no customer value, identifier, label or date is reproduced.
const table = (className: string, content: string) =>
  `<table class="table ${className}">${content}</table>`;
const summary = (index: number, label: string, amount: string) =>
  table(
    `table-form mc_table-form__${index}`,
    `<tbody><tr><th>${label}</th><td>${amount}</td></tr></tbody>`,
  );
export function prestiaBankRow(currency = "EUR", amount = "12.3400", account = "24682468") {
  return `<tr><td>合成外貨口座</td><td>${account}</td><td>${currency}</td><td>${amount} ${currency}</td><td><a href="/private?action=transfer" onclick="transfer()">詳細へ</a></td></tr>`;
}
export function prestiaBankHtml(
  foreignRows = prestiaBankRow() +
    prestiaBankRow("CHF", "4.123", "13571357") +
    prestiaBankRow("KWD", "0.00750", "86428642"),
): string {
  const ordinaryHeader =
    "<thead><tr><th>口座</th><th>口座番号</th><th>通貨</th><th>利用可能額</th><th></th></tr></thead>";
  const termHeader =
    "<thead><tr><th>口座</th><th>口座番号</th><th>預入番号</th><th>満期日</th><th>通貨</th><th>預入金額</th><th></th></tr></thead>";
  const detail = (index: number, header: string, rows: string) =>
    table(
      `table-normal mc_table-normal__${index} mc_cardTbl_origin mc_hide`,
      `${header}<tbody>${rows}</tbody>`,
    );
  const group = (heading: string, content: string) =>
    `<div class="inner"><div class="heading-h3"><h3>${heading}</h3></div>${content}</div>`;
  return `<html><head><script>secretCookie='synthetic-secret'</script></head><body><p>合成所有者様 synthetic-owner@example.test</p><form name="PRESTIAHEADERFORM"><input value="synthetic-token"></form><form name="ACKZDSP" action="/bank"><input name="csrf" value="synthetic-token"><main><h1>口座残高</h1><section class="card"><h2>口座残高一覧</h2>${group(
    "円普通預金・円定期預金",
    summary(1, "総額", "1,032 JPY") +
      detail(
        1,
        ordinaryHeader,
        "<tr><td>合成円口座</td><td>3141592</td><td>JPY</td><td>314 JPY</td><td>詳細へ</td></tr><tr><td>合成投資円口座</td><td>24682468</td><td>JPY</td><td>718 JPY</td><td>詳細へ</td></tr>",
      ),
  )}${group("外貨普通預金・外貨定期預金", summary(2, "総額", "98,765 JPY") + detail(2, ordinaryHeader, foreignRows) + detail(3, termHeader, "<tr><td>合成外貨定期</td><td>24682468</td><td>54321</td><td>2040/02/29</td><td>EUR</td><td>700.230 EUR</td><td>詳細へ</td></tr>") + "<p>総額は、外貨建て預入金額を最新のTTBレートにて円換算した金額の合計を表示しております。</p>")}${group("プレミアム・デポジット（仕組預金）", summary(3, "総額", "-"))}${group("投資信託", summary(4, "評価額合計", "-"))}${group("合同運用指定金銭信託", summary(5, "総額", "42 JPY"))}${group("借入", summary(6, "総額", "-"))}${group("円当座預金", summary(7, "総額", "-"))}${group("", table("table-form mc_table-form__8", "<tbody><tr><th>月間平均総取引残高</th><td>125,678 JPY</td></tr><tr><th>うち外貨部分</th><td>111,111 JPY</td></tr><tr><th>うち流動性預金部分</th><td>1,579 JPY</td></tr></tbody>") + "<p>流動性預金とは定期預金を除いた円および外貨のすべての預金残高を示します。上記の月間平均総取引残高は前営業日時点の情報をもとに計算した参考値です。</p>")}</section></main></form></body></html>`;
}
