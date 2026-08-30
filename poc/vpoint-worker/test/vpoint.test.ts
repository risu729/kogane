import { describe, expect, test } from "bun:test";
import {
  collectVPoint,
  historyForm,
  parseSessionCookie,
  vMoneyHistoryForm,
} from "../src/vpoint";

describe("V Point session", () => {
  test("accepts a Cookie header without logging or splitting it", () => {
    expect(parseSessionCookie("session=value; other=value2")).toBe(
      "session=value; other=value2",
    );
    expect(() => parseSessionCookie("")).toThrow();
    expect(() => parseSessionCookie("session=value\r\nInjected: yes")).toThrow();
  });
});

describe("V Point history form", () => {
  test("matches the live My Page request fields", () => {
    const form = historyForm(2);
    expect(form.get("page")).toBe("2");
    expect(form.get("get_graph")).toBe("1");
    expect(form.get("sort")).toBe("use");
    expect(form.get("filter_save")).toBe("1");
    expect(form.get("filter_use")).toBe("1");
    expect(form.get("filter_cancel")).toBe("1");
    expect(form.get("filter_expired")).toBe("1");
    expect(form.get("filter_transfer")).toBe("1");
    expect(form.get("filter_correct")).toBe("1");
    expect(form.get("filter_extend")).toBe("1");
    expect(form.get("filter_reissue")).toBe("1");
    expect(form.get("filter_date")).toBe("");
  });
});

describe("V Money history form", () => {
  test("matches the current My Page request fields", () => {
    const form = vMoneyHistoryForm(3);
    expect(form.get("page")).toBe("3");
    expect(form.get("sort")).toBe("use");
    expect(form.get("filter_use")).toBe("1");
    expect(form.get("filter_charge")).toBe("1");
    expect(form.get("filter_use_cancel")).toBe("1");
    expect(form.get("filter_charge_cancel")).toBe("1");
    expect(form.get("filter_expired")).toBe("1");
    expect(form.get("filter_transfer")).toBe("1");
    expect(form.get("filter_refund")).toBe("1");
    expect(form.get("filter_date")).toBe("");
  });
});

describe("V Point collection", () => {
  test("walks all declared history pages and stores raw JSON", async () => {
    const seenPointPages: string[] = [];
    const seenVMoneyPages: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/balance_info") {
        return jsonResponse({
          status: { code: "0000" },
          results: { common: [], store: [] },
        });
      }
      if (path === "/api/smfg_point") {
        return jsonResponse({
          status: { code: "0000" },
          results: { get_point: { point_smbc: 0, point_smcc: 0 } },
        });
      }
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("expected FormData");
      const page = String(form.get("page"));
      if (path === "/api/tmoney_history") {
        seenVMoneyPages.push(page);
        return jsonResponse({
          status: { code: "0000" },
          results: {
            total: 2,
            history: [{ money: 100 }, { money: -50 }],
          },
        });
      }
      seenPointPages.push(page);
      const count = page === "3" ? 1 : 30;
      return jsonResponse({
        status: { code: "0000" },
        results: {
          total: 61,
          history: Array.from({ length: count }, () => ({ point: 1 })),
          graph: {},
        },
      });
    };

    const result = await collectVPoint({
      sessionCookie: "session=value",
      fetcher,
    });
    expect(seenPointPages).toEqual(["1", "2", "3"]);
    expect(seenVMoneyPages).toEqual(["1"]);
    expect(result.historyTotal).toBe(61);
    expect(result.historyPageCount).toBe(3);
    expect(result.vMoneyHistoryTotal).toBe(2);
    expect(result.vMoneyHistoryPageCount).toBe(1);
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual([
      "balance-info.json",
      "smfg-point.json",
      "history-page-0001.json",
      "history-page-0002.json",
      "history-page-0003.json",
      "vmoney-history-page-0001.json",
      "collection-summary.json",
    ]);
  });

  test("reports an expired session without persisting the response", async () => {
    const fetcher = async () => jsonResponse({
      status: { code: "0010" },
      results: {},
    });
    await expect(collectVPoint({
      sessionCookie: "session=value",
      fetcher,
    })).rejects.toThrow("expired");
  });

  test("stores an empty V Money response for accounts without history", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/tmoney_history") {
        return jsonResponse({ status: { code: "0000" }, results: {} });
      }
      if (path === "/api/tpoint_history") {
        return jsonResponse({
          status: { code: "0000" },
          results: { total: 0, history: [], graph: {} },
        });
      }
      return jsonResponse({ status: { code: "0000" }, results: {} });
    };
    const result = await collectVPoint({
      sessionCookie: "session=value",
      fetcher,
    });
    expect(result.vMoneyHistoryTotal).toBe(0);
    expect(result.vMoneyHistoryPageCount).toBe(1);
    expect(result.artifacts.some((artifact) =>
      artifact.filename === "vmoney-history-page-0001.json"
    )).toBe(true);
  });
});

function jsonResponse(value: unknown): Response {
  return Response.json(value, { status: 200 });
}
