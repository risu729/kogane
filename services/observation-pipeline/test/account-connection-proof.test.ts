import { expect, test } from "bun:test";
import { readConnectionDetail, verifyShinseiConnection } from "../src/account-connection-proof";
const html = (number = "1234567") =>
  `<html><body><h1>SBI新生銀行</h1><table class="table table-bordered"><tr><th>名称</th><th>種類</th><th>番号</th><th>残高</th></tr><tr><td>架空支店(123)</td><td>円普通預金</td><td>${number}</td><td>0</td></tr><tr><td>架空支店(123)</td><td>SBIハイパー預金</td><td>${number}</td><td>0</td></tr></table></body></html>`;
const section = (responseParam: object, nationalid = "1231234567") => ({
  requestParam: { nationalid },
  responseParam,
  errorInfo: { statusID: "00000", statusMessage: "Success" },
});
const fixtures = () => ({
  top: {
    header: { adapterResultCode: "0" },
    responseParam: {
      overview: section({
        savingsDetails: [{ accountNo: "111111111111111" }, { accountNo: "222222222222222" }],
      }),
      activity: section({ accountNo: "111111111111111" }),
    },
  },
  summary: {
    header: { adapterResultCode: "0" },
    responseParam: {
      branchFetch: section({ branchCode: "0123", branchName: "架空支店" }),
      summary: section({}),
      category: section({}),
    },
  },
});
test("proves only a connection from exact branch+number and preserves distinct leaf accounts", () => {
  const { top, summary } = fixtures();
  expect(verifyShinseiConnection(readConnectionDetail(html()), top, summary)).toEqual({
    directSourceAccounts: ["sbi-shinsei:111111111111111", "sbi-shinsei:222222222222222"],
  });
});
test("same institution and branch names do not suffice when the number differs", () => {
  const { top, summary } = fixtures();
  expect(() =>
    verifyShinseiConnection(readConnectionDetail(html("7654321")), top, summary),
  ).toThrow("connection_number_mismatch");
});
test("rejects inconsistent principal, duplicate leaf accounts, changed product scope and failed provider responses", () => {
  const a = fixtures();
  a.summary.responseParam.category.requestParam.nationalid = "9999999999";
  expect(() => verifyShinseiConnection(readConnectionDetail(html()), a.top, a.summary)).toThrow(
    "connection_principal_conflict",
  );
  const b = fixtures();
  b.top.responseParam.overview.responseParam = {
    savingsDetails: [{ accountNo: "111111111111111" }, { accountNo: "111111111111111" }],
  };
  expect(() => verifyShinseiConnection(readConnectionDetail(html()), b.top, b.summary)).toThrow(
    "connection_leaf_inventory_invalid",
  );
  const c = fixtures();
  expect(() =>
    verifyShinseiConnection(
      readConnectionDetail(html().replace("SBIハイパー預金", "別の商品")),
      c.top,
      c.summary,
    ),
  ).toThrow("connection_product_scope_changed");
  c.top.header.adapterResultCode = "1";
  expect(() => verifyShinseiConnection(readConnectionDetail(html()), c.top, c.summary)).toThrow(
    "connection_direct_response_failed",
  );
});
test("rejects ambiguous institution or summary evidence", () => {
  expect(() => readConnectionDetail(html().replace("</h1>", "</h1><h1>三井住友銀行</h1>"))).toThrow(
    "connection_provider_heading_ambiguous",
  );
  expect(() => readConnectionDetail(html().replace("番号", "ID"))).toThrow(
    "connection_summary_shape",
  );
});
