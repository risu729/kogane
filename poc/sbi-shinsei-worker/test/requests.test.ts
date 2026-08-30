import { describe, expect, test } from "bun:test";
import { noBodyRequest, yenDepositAccountRequest } from "../src/requests";

describe("SBI Shinsei captured request shapes", () => {
  test("captured bootstrap and top reads have no request body", () => {
    expect(noBodyRequest("common.security-connect")).toEqual({
      operation: "common.security-connect",
    });
    expect(noBodyRequest("common.validate-token")).toEqual({
      operation: "common.validate-token",
    });
    expect(noBodyRequest("top.accounts-balance-and-activity")).toEqual({
      operation: "top.accounts-balance-and-activity",
    });
  });

  test("yen deposit request has only requestParam.screenGroupID", () => {
    expect(yenDepositAccountRequest("SYNTHETIC_SCREEN_GROUP")).toEqual({
      operation: "yen-deposit.account",
      body: {
        requestParam: { screenGroupID: "SYNTHETIC_SCREEN_GROUP" },
      },
    });
  });
});
