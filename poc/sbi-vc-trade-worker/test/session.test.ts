import { describe, expect, test } from "bun:test";
import { applySessionUpdates, cookieHeader, parseGatewayMeta, parseSession } from "../src/session";

const seed = {
  cookies: {
    vctBffSid: "sid",
    jSessionId: "jsession",
    awsAlbApp: ["app0", "app1", "app2", "app3"],
    awsAlb: "alb",
    awsAlbCors: "cors",
  },
  secureKey: "secure",
};

describe("session material", () => {
  test("builds only the eight observed cookies", () => {
    const header = cookieHeader(parseSession(seed));
    expect(header).toContain("vct_bff_sid=sid");
    expect(header).toContain("AWSALBAPP-3=app3");
    expect(header).not.toContain("__cf_bm");
    expect(header.split("; ")).toHaveLength(8);
  });

  test("applies allowlisted Set-Cookie rotation and ignores bot cookies", () => {
    const result = applySessionUpdates(
      parseSession(seed),
      [
        "AWSALB=rotated; Path=/; Secure",
        "__cf_bm=ignored; Path=/; Secure",
        "JSESSIONID=jsession; Path=/; Secure",
      ],
      { status: "OK", secureKey: "secure2" },
    );
    expect(result.updateCount).toBe(2);
    expect(result.session.cookies.awsAlb).toBe("rotated");
    expect(result.session.secureKey).toBe("secure2");
  });

  test("rejects cookie delimiters", () => {
    expect(() => parseSession({ ...seed, secureKey: "bad\nvalue" })).toThrow(
      "invalid_session_seed",
    );
  });

  test("accepts only a gateway envelope with status", () => {
    expect(parseGatewayMeta({ meta: { status: "OK" }, body: {} })).toEqual({ status: "OK" });
    expect(() => parseGatewayMeta({ body: {} })).toThrow("invalid_gateway_envelope");
  });
});
