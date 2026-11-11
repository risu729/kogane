import { encode } from "iconv-lite";
export function historyResponse(html: string): Response {
  return new Response(new Uint8Array(encode(html, "shift_jis")));
}
export const syntheticSession = {
  cookieHeader: "ASP.NET_SessionId=a; sc_auth=b; TS0184138d=c",
  formBody: "baseVariable=synthetic-private-state",
  userAgent: "synthetic-agent",
};
export function historyRow(day: string, amount = "-100"): string {
  return `<tr><td><input name="printCheck"></td><td>${day}</td><td>物販</td><td>合成店舗</td><td></td><td></td><td>1000</td><td>${amount}</td></tr>`;
}
export function historyPage(rows: string): string {
  return `<html><input type="hidden" name="baseVariable" value="synthetic-private-state"><select name="specifyYearMonth"></select><table><tr><td></td><td>月日</td><td>種別</td><td>利用場所</td><td>種別</td><td>利用場所</td><td>残高</td><td>入金・利用額</td></tr>${rows}</table></html>`;
}
export const walkPages = [
  historyPage(historyRow("08/29").repeat(98) + historyRow("08/28") + historyRow("08/28", "")),
  historyPage(historyRow("08/28").repeat(2) + historyRow("08/27", "")),
];
export const emptyPage = `<title>ご案内</title><p>利用履歴がありません。</p><form action="/cm/lb/Message.aspx"><input type="hidden" name="baseVariable" value="synthetic-private-state"><input type="hidden" name="returnUrlList" value="synthetic-navigation-state"><input type="hidden" name="checkScreenTransfer" value="synthetic-transfer-state"></form>`;
