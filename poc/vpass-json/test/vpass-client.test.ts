import { describe, expect, test } from "bun:test";
import { adler32, extractAvailableMonths, objectAt } from "../src/vpass-client";

describe("Vpass request wrapper helpers", () => {
  test("computes the captured Adler-32 endpoint hash", () => {
    expect(adler32("/memapi/jaxrs/web_meisai/web_meisai_top/v1")).toBe(1_494_552_592);
  });

  test("walks JSON objects without accepting arrays", () => {
    const value = { body: { content: { ok: true } } };
    expect(objectAt(value, "body", "content")).toEqual({ ok: true });
    expect(objectAt(value, "body", "missing")).toBeNull();
  });
});

describe("available statement months", () => {
  test("merges all observed response families and rejects invalid values", () => {
    const response = {
      body: {
        content: {
          WebMeisaiTopDisplayServiceBean: {
            seikyuYMList: [
              { name: "August", value: "202608" },
              { name: "invalid", value: "2026-07" },
            ],
          },
          WebMeisaiCommonDisplayServiceBean: {
            comSeikyuYMList: [
              { name: "July", value: "202607" },
              { name: "duplicate", value: "202608" },
            ],
          },
          CustomizedMeisaiAnsDisplayServiceBean: {
            seikyuYMList: [{ name: "June", value: "202606" }],
          },
        },
      },
    };

    expect(extractAvailableMonths(response)).toEqual(["202608", "202607", "202606"]);
  });
});
