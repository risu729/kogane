import { describe, expect, test } from "bun:test";
import {
  collectVPointPay,
  enumerateMonths,
  makeDeviceId,
  probeVPointPayApi,
} from "../src/vpoint-pay";

const DEVICE_UUID = "00112233-4455-6677-8899-aabbccddeeff";

describe("V Point Pay device header", () => {
  test("reproduces the protected DEX transformation deterministically", () => {
    expect(makeDeviceId(DEVICE_UUID, 1_750_000_000)).toBe(
      "1750000000-1750112233-1794556677-1750008899-aabd3acddeeff",
    );
  });

  test("rejects malformed UUIDs", () => {
    expect(() => makeDeviceId("not-a-uuid", 1_750_000_000)).toThrow();
  });
});

describe("V Point Pay history months", () => {
  test("walks an inclusive year boundary", () => {
    expect(enumerateMonths("202511", "202602")).toEqual(["202511", "202512", "202601", "202602"]);
  });
});

describe("V Point Pay collection", () => {
  test("probes the public app settings without an access token", async () => {
    let accessToken: string | null = "unexpected";
    await probeVPointPayApi({
      deviceUuid: DEVICE_UUID,
      fetcher: async (_input, init) => {
        accessToken = new Headers(init?.headers).get("x-vapp-access-token");
        return Response.json({ maintenance: false });
      },
    });
    expect(accessToken).toBeNull();
  });

  test("refreshes first, rotates the token, then captures every available month", async () => {
    const seen: Array<{ path: string; token: string | null; device: string | null }> = [];
    let rotated = "";
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({
        path: `${url.pathname}${url.search}`,
        token: headers.get("x-vapp-access-token"),
        device: headers.get("device_id"),
      });
      if (url.pathname.endsWith("/token")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          grant_type: "refresh_token",
          authorization_code: "",
          refresh_token: "old-refresh",
        });
        return Response.json({
          access_token: "access-value",
          refresh_token: "new-refresh",
          created_at: 1,
          expires_in: 3600,
        });
      }
      if (url.pathname.endsWith("/balance")) {
        return Response.json({
          currency_code: "JPY",
          account_balance: "100",
          charge_limit: {},
          inquiry_period: "202607",
        });
      }
      const month = url.searchParams.get("target_month");
      return Response.json({
        tran_month: month,
        agr_num: "masked-in-test",
        crd_num_last_4_digits: "0000",
        tran_list: month === "202608" ? [{ tran_amt: "10" }] : [],
      });
    };

    const result = await collectVPointPay({
      credential: {
        refreshToken: "old-refresh",
        deviceUuid: DEVICE_UUID,
      },
      saveRotatedRefreshToken: async (value) => {
        rotated = value;
      },
      fetcher,
      now: new Date("2026-08-31T00:00:00Z"),
    });

    expect(rotated).toBe("new-refresh");
    expect(result.earliestMonth).toBe("202607");
    expect(result.latestMonth).toBe("202608");
    expect(result.transactionMonthCount).toBe(2);
    expect(result.transactionCount).toBe(1);
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual([
      "balance.json",
      "transactions-202607.json",
      "transactions-202608.json",
      "collection-summary.json",
    ]);
    expect(seen.every((request) => request.device?.startsWith("17"))).toBe(true);
    expect(seen[0]?.token).toBeNull();
    expect(seen.slice(1).every((request) => request.token === "access-value")).toBe(true);
  });
});
