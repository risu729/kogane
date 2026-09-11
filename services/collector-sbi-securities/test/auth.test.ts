import { describe, expect, test } from "bun:test";
import { parseCredential } from "../src/auth";

describe("SBI_CREDENTIAL_JSON", () => {
  test("keeps only the passkey fields used by the Worker", () => {
    expect(
      parseCredential(
        JSON.stringify({
          rpId: "sbisec.co.jp",
          origin: "https://login.sbisec.co.jp/some/path",
          credentialId: "b64.AAE",
          keyValue: "private-key",
          userHandle: "b64.AQI",
          counter: 0,
          username: "must-not-be-used",
          password: "must-not-be-used",
        }),
      ),
    ).toEqual({
      rpId: "sbisec.co.jp",
      origin: "https://login.sbisec.co.jp",
      credentialId: "b64.AAE",
      keyValue: "private-key",
      userHandle: "b64.AQI",
      counter: 0,
    });
  });

  test("rejects non-HTTPS origins and negative counters", () => {
    expect(() =>
      parseCredential(
        JSON.stringify({
          rpId: "sbisec.co.jp",
          origin: "http://login.sbisec.co.jp",
          credentialId: "b64.AAE",
          keyValue: "private-key",
          counter: 0,
        }),
      ),
    ).toThrow("must use HTTPS");
    expect(() =>
      parseCredential(
        JSON.stringify({
          rpId: "sbisec.co.jp",
          origin: "https://login.sbisec.co.jp",
          credentialId: "b64.AAE",
          keyValue: "private-key",
          counter: -1,
        }),
      ),
    ).toThrow("non-negative integer");
  });
});
