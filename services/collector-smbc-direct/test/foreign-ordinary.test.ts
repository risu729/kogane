import { expect, test } from "bun:test";
import iconv from "iconv-lite";
import { sanitizeForeignBalance, sanitizeForeignHistory } from "../src/foreign-ordinary";
import { DirectProfile } from "../src/smbc";

const balance = `<html><input name="_TOKEN" value="synthetic-session-secret"><script>const session = "synthetic-session-secret";</script>
<dl class="detail-list03"><dt class="title -small01 -green01">通貨：A$</dt><dd>
<dl class="detail-list07 -black01"><dt>現在残高</dt><dd class="detail -large02"><span class="foreignCurrency">A$</span><span class="price _t-bold">1,234.56</span></dd></dl>
<dl class="detail-list07"><dt>円貨換算金額</dt><dd><span class="price">120,000</span></dd></dl>
<dl class="list"><dt>現在の参考為替レート(外貨→円)</dt><dd class="detail _t-right">97.205円</dd></dl>
</dd></dl></html>`;
const range = { start: "2099-01-01", end: "2099-01-31" };
const emptyDataScript = String.raw`<script>function getData() { return JSON.parse("".replace(/&quot;/g, '\"')); } var meisaiListJSONData = getData();</script>`;
const history = `<html>${emptyDataScript}<input name="_TOKEN" value="synthetic-session-secret"><p>2099年1月1日 - 2099年1月31日 の明細</p>
<div class="card-box03 -alert01"><div class="inner"><dl><dt class="title">エラーコード:PC-AIFDDT1-00134-E</dt><dd class="detail">指定期間の入出金はございません。</dd></dl></div></div></html>`;

test("the sanitizer retains only reviewed AUD financial fields and strips tokens and executable HTML", () => {
  const result = sanitizeForeignBalance(balance);
  expect(result).toEqual({
    currency: "AUD",
    amount: "1234.56",
    yenEquivalent: "120000",
    referenceRate: "97.205",
  });
  expect(JSON.stringify(result)).not.toContain("synthetic-session-secret");
  for (const changed of [
    balance.replace("通貨：A$", "通貨：US$"),
    balance.replace("1,234.56", "1,2.34"),
    balance.replace("1,234.56", "12 34.56"),
    balance.replace("97.205円", "不明"),
    balance + balance,
  ])
    expect(() => sanitizeForeignBalance(changed)).toThrow();
});

test("only an explicit empty response for the exact requested range is retained", () => {
  expect(sanitizeForeignHistory(history, range)).toEqual({
    currency: "AUD",
    range,
    emptyCode: "PC-AIFDDT1-00134-E",
    transactions: [],
  });
  for (const changed of [
    history.replace("00134", "99999"),
    history.replace("入出金はございません", "処理できません"),
    history.replace("2099年1月31日", "2099年1月30日"),
    history + "<table><tbody></tbody></table>",
    history.replace('JSON.parse(""', 'JSON.parse("{}"'),
    "<html>login required</html>",
  ])
    expect(() => sanitizeForeignHistory(changed, range)).toThrow();
});

function fields(form: string): string {
  return `<input name="_FRAMEID" value="root"><input name="_TARGETID" value="root"><input name="_LUID" value="synthetic-luid"><input name="_TOKEN" value="synthetic-token"><input name="_FORMID" value="${form}"><input name="_SUBINDEX" value=""><input name="accountBranchCode" value=""><input name="accountItemCode" value=""><input name="accountNo" value="">`;
}
const top = `<form name="TPALTOP">${fields("TPALTOP")}<input name="moudaiBrNo" value="0123"><input name="moudaiAcNo" value="0000001"></form><form name="DIRECTHEADERFORM">${fields("DIRECTHEADERFORM")}</form><a class="card-box01 -noPadding -overflow01 -shadow01" onclick="directib.TPALTOP.accountDetail('0123','synthetic-foreign-code','001234','TPALTOPaccountGaikaFutsuDetail')"></a>`;
const detail = balance.replace(
  "</dd></dl></html>",
  `<a href="javascript:;" id="0" data-event="/accountinquiry/AIFDDTLmeisai">入出金明細</a></dd></dl><form name="AIFDDTL">${fields("AIFDDTL")}<input name="selectDateStare" value="2099年1月1日"><input name="selectDateEnd" value="2099年1月31日"><input name="firstEndDate" value="2099年1月31日"></form></html>`,
);
function context(accountNo = "001234"): string {
  return `<dl class="item"><dt class="title">合成 支店 外貨<br>${accountNo}</dt></dl><dl class="detail-list07 -flexEnd -account"><dt class="title">通貨・現在残高</dt><dd class="detail">A$ <span class="price">1,234.56</span></dd></dl>`;
}
const queryForm = `<form name="AIFDDT1">${fields("AIFDDT1")}${["From", "To"].flatMap((side) => ["Year", "Month", "Day"].map((part) => `<select name="select${side}${part}"><option value="01">01</option></select>`)).join("")}</form>`;
function profile(wrongAccount = false) {
  const requests: Array<{ path: string; body: string }> = [];
  const selected = DirectProfile.import(
    { baseURL: "https://direct3.smbc.co.jp", loginURL: "https://direct.smbc.co.jp" },
    { branchNo: "999", accountNo: "0000001", password: "synthetic-password" },
    {
      cookies: [],
      topPage: { html: top, url: "https://direct3.smbc.co.jp/ib/web/top/TPALTOPacctList.smbc" },
    },
    {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ path: url.pathname, body: String(init?.body) });
        const page = url.pathname.endsWith("TPALTOPacctList.smbc")
          ? top
          : url.pathname.endsWith("TPALTOPaccountGaikaFutsuDetail.smbc")
            ? detail
            : url.pathname.endsWith("AIFDDTLmeisai.smbc")
              ? context(wrongAccount ? "991234" : "001234") + queryForm
              : context() + history;
        const response = new Response(Uint8Array.from(iconv.encode(page, "Shift_JIS")).buffer, {
          headers: { "content-type": "text/html; charset=Shift_JIS" },
        });
        Object.defineProperty(response, "url", { value: url.toString() });
        return response;
      },
    },
  );
  return { selected, requests };
}

test("foreign reads preserve observed form blanks and bind the server-selected AUD account", async () => {
  const { selected, requests } = profile();
  expect(await selected.getForeignBalance()).toMatchObject({ currency: "AUD", amount: "1234.56" });
  expect(await selected.getForeignHistory(range)).toMatchObject({
    currency: "AUD",
    range,
    transactions: [],
  });
  const detailRequest = requests.find((request) =>
    request.path.endsWith("TPALTOPaccountGaikaFutsuDetail.smbc"),
  )!;
  expect(new URLSearchParams(detailRequest.body).get("accountNo")).toBe("001234");
  expect(new URLSearchParams(detailRequest.body).get("accountItemCode")).toBe(
    "synthetic-foreign-code",
  );
  expect(new URLSearchParams(detailRequest.body).get("moudaiAcNo")).toBe("0000001");
  const entry = requests.find((request) => request.path.endsWith("AIFDDTLmeisai.smbc"))!;
  expect(entry.body).toContain("%94N");
  expect(entry.body).not.toContain("%E5%B9%B4");
  const query = requests.find((request) => request.path.endsWith("AIFDDT1meisai.smbc"))!;
  for (const request of [entry, query]) {
    const body = new URLSearchParams(request.body);
    for (const name of ["accountBranchCode", "accountItemCode", "accountNo"])
      expect(body.get(name)).toBe("");
    expect(body.get("accountSelect")).toBe("0");
  }
  expect(new URLSearchParams(query.body).get("selectFromMonth")).toBe("01");
  expect(new URLSearchParams(query.body).get("shoriTaibu")).toBe("05");
  const changed = profile(true);
  await expect(changed.selected.getForeignHistory(range)).rejects.toThrow(
    "foreign_history_account_mismatch",
  );
  expect(changed.requests.some((request) => request.path.endsWith("AIFDDT1meisai.smbc"))).toBe(
    false,
  );
});
