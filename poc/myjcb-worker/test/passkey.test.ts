import { describe, expect, test } from "bun:test";
import {
  base64UrlToBase64,
  bitwardenCredentialIdToBase64,
  humanChallengeReason,
} from "../src/login-protection";
import { StopConditionError } from "../src/types";

describe("Bitwarden passkey conversion", () => {
  test("converts a Bitwarden UUID credential ID to the raw CDP form", () => {
    expect(bitwardenCredentialIdToBase64("00112233-4455-4677-8899-aabbccddeeff")).toBe(
      "ABEiM0RVRneImaq7zN3u/w==",
    );
  });

  test("converts Bitwarden base64url fields to padded base64", () => {
    expect(base64UrlToBase64("-_8")).toBe("+/8=");
    expect(bitwardenCredentialIdToBase64("b64.-_8")).toBe("+/8=");
  });
});

describe("safe passkey diagnostics", () => {
  test("keeps the diagnostic code separate from the upstream message", () => {
    const error = new StopConditionError("sensitive upstream detail", "passkey-assertion");
    expect(error.code).toBe("passkey-assertion");
    expect(error.code).not.toContain(error.message);
  });

  test("does not mistake login-page help text for a secret-question challenge", () => {
    const html = "<p>秘密の質問を忘れた場合</p>";
    expect(humanChallengeReason(html, true)).toBeUndefined();
    expect(humanChallengeReason(html, false)).toBe("secret-question");
  });
});
