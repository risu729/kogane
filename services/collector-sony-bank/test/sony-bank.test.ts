import { describe, expect, test } from "bun:test";
import {
  CookieBag,
  parseCredential,
  sanitizeWalletHtml,
  selectedWalletMonth,
  splitSetCookie,
  validateHistoryPage,
  walletMonths,
} from "../src/sony-bank";

describe("Sony Bank credential", () => {
  test("accepts only the captured field shape", () => {
    expect(
      parseCredential(
        JSON.stringify({ branchNum: "001", accountNum: "1234567", loginPwd: "secret" }),
      ),
    ).toEqual({ branchNum: "001", accountNum: "1234567", loginPwd: "secret" });
    expect(() => parseCredential("{}")).toThrow();
  });
});
describe("Sony Bank cookie handling", () => {
  test("does not split the comma inside Expires", () => {
    expect(
      splitSetCookie("FSID=a; Expires=Mon, 31 Aug 2026 00:00:00 GMT; Path=/, ct1=b; Path=/"),
    ).toHaveLength(2);
  });

  test("keeps cookie names without exposing values", () => {
    const headers = new Headers({
      "set-cookie": "FSID=a; Path=/, ct1=b; Path=/",
    });
    const jar = new CookieBag();
    jar.absorb(headers);
    expect(jar.names()).toEqual(["FSID", "ct1"]);
    expect(jar.header()).toContain("FSID=a");
  });
});

describe("Sony Bank WALLET HTML", () => {
  test("extracts months without retaining session values", () => {
    const html = `
      <form name="nablarch_form3" method="post">
        <select name="W131301.referenceDate">
          <option value="20260831">2026年8月(当月分)</option>
          <option value="20260731">2026年7月</option>
        </select>
        <input type="hidden" name="nablarch_hidden" value="secret">
      </form>
      <a href="/p/example;jsessionid=session.WEB01">明細</a>
    `;
    expect(walletMonths(html)).toEqual([
      { value: "20260831", label: "2026年8月(当月分)", submitName: "nablarch_form3_1" },
      { value: "20260731", label: "2026年7月", submitName: "nablarch_form3_2" },
    ]);
    const sanitized = sanitizeWalletHtml(html);
    expect(sanitized).not.toContain("session.WEB01");
    expect(sanitized).not.toContain('value="secret"');
  });

  test("does not double-decode month labels", () => {
    const html = `
      <form name="nablarch_form3">
        <select name="W131301.referenceDate">
          <option value="20260831">A&amp;quot;B</option>
        </select>
      </form>
    `;
    expect(walletMonths(html)[0]?.label).toBe("A&quot;B");
  });

  test("identifies the actual selected month, including HTML default selection", () => {
    const explicit = `
      <form name="nablarch_form3"><select name="W131301.referenceDate">
        <option value="20260831">August</option>
        <option selected="selected" value="20260731">July</option>
      </select></form>
    `;
    expect(selectedWalletMonth(explicit)).toBe("20260731");
    expect(selectedWalletMonth(explicit.replace(' selected="selected"', ""))).toBe("20260831");
    expect(
      selectedWalletMonth(
        explicit.replace('<option value="20260831">', '<option selected value="20260831">'),
      ),
    ).toBeNull();
  });
});

describe("Sony Bank history pagination", () => {
  test("accepts exact pages and rejects total changes and short pages", () => {
    const first = validateHistoryPage(
      {
        transactionHistInfo: [{}, {}, {}],
        countCnt: "4",
      },
      0,
      null,
    );
    expect(first).toEqual({ rowCount: 3, total: 4, terminal: false });
    expect(
      validateHistoryPage(
        {
          transactionHistInfo: [{}],
          countCnt: 4,
        },
        1,
        first.total,
      ),
    ).toEqual({ rowCount: 1, total: 4, terminal: true });
    expect(() =>
      validateHistoryPage(
        {
          transactionHistInfo: [{}],
          countCnt: 5,
        },
        1,
        first.total,
      ),
    ).toThrow("pagination_total_changed");
    expect(() =>
      validateHistoryPage(
        {
          transactionHistInfo: [{}],
          countCnt: 4,
        },
        0,
        null,
      ),
    ).toThrow("pagination_length_mismatch");
    expect(() => validateHistoryPage({ countCnt: 0 }, 0, null)).toThrow("pagination_invalid");
  });
});
