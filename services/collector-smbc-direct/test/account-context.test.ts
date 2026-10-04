import { expect, test } from "bun:test";
import { DirectProfile } from "../src/smbc";

test("a successful balance records the account actually selected by its request", async () => {
  const credentials = { branchNo: "123", accountNo: "0012345", password: "never-store-this" };
  const requests: Record<string, unknown>[] = [];
  const profile = DirectProfile.import(
    { baseURL: "https://direct3.smbc.co.jp", loginURL: "https://direct.smbc.co.jp" },
    credentials,
    {
      cookies: [],
      topPage: {
        url: "https://direct3.smbc.co.jp/ib/web/top/TPALTOP.smbc",
        html: '<form name="TPALTOP"><input name="_TOKEN" value="synthetic"><input name="_FORMID" value="synthetic"></form><form name="DIRECTHEADERFORM"><input name="synthetic" value="synthetic"></form>',
      },
    },
    {
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        // A caller changing its credential object while a request is in flight
        // must not change the evidence describing the already-sent request.
        credentials.accountNo = "9999999";
        return new Response(
          JSON.stringify({ success: true, response: { ajaxSavingAccountBalance: "1,000" } }),
        );
      },
    },
  );
  const result = await profile.getBalance();
  expect(requests).toEqual([
    { accountBranchCode: "0123", accountItemCode: "2206", accountNo: "0012345" },
  ]);
  expect(result.account).toEqual({
    basis: "authenticated-request-v1",
    accountType: "ordinary",
    branchCode: "123",
    accountNumber: "0012345",
  });
  expect(JSON.stringify(result.account)).not.toContain("never-store-this");
});

const topHtml =
  '<form name="TPALTOP"><input name="_TOKEN" value="synthetic"><input name="_FORMID" value="synthetic"></form><form name="DIRECTHEADERFORM"><input name="synthetic" value="synthetic"></form>';
for (const accepted of [true, false]) {
  test("transactions pin the requested account; response accepted=" + accepted, async () => {
    const credentials = { branchNo: "123", accountNo: "0012345", password: "never-store-this" };
    const selections: URLSearchParams[] = [];
    const profile = DirectProfile.import(
      { baseURL: "https://direct3.smbc.co.jp", loginURL: "https://direct.smbc.co.jp" },
      credentials,
      {
        cookies: [],
        topPage: { url: "https://direct3.smbc.co.jp/ib/web/top/TPALTOP.smbc", html: topHtml },
      },
      {
        fetch: async (input, init) => {
          const url = String(input);
          let body: string;
          if (url.includes("accountFutsuDetail")) {
            selections.push(new URLSearchParams(String(init?.body)));
            body =
              '<form name="AIFCDT3"><input name="_TOKEN" value="synthetic"><input name="_FORMID" value="synthetic"></form>';
          } else if (url.includes("Ajaxkikannshokai")) {
            body = JSON.stringify({
              success: accepted,
              response: {
                accntHstCount: "0",
                meisai: [],
                shoukaiServerStopFlag: "0",
                nyukinGoukei: "0",
                syukkinGoukei: "0",
              },
            });
          } else {
            // Includes the awaited continueSession before the selection request.
            credentials.branchNo = "999";
            credentials.accountNo = "9999999";
            body = topHtml;
          }
          const response = new Response(body);
          Object.defineProperty(response, "url", { value: url });
          return response;
        },
      },
    );
    const pending = profile.getTransactions({ start: "2099-01-01", end: "2099-01-31" });
    if (accepted) {
      const result = await pending;
      expect(result.account).toEqual({
        basis: "authenticated-request-v1",
        accountType: "ordinary",
        branchCode: "123",
        accountNumber: "0012345",
      });
      expect(JSON.stringify(result.account)).not.toContain("never-store-this");
    } else {
      await expect(pending).rejects.toThrow("transactions_rejected");
    }
    expect(selections).toHaveLength(1);
    expect(selections[0]!.get("accountBranchCode")).toBe("0123");
    expect(selections[0]!.get("accountNo")).toBe("0012345");
  });
}
