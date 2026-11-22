import { describe, expect, test } from "bun:test";
import { localFailureLine } from "../src/local/failure";

// The local CLI's failure line carries closed codes only (README, "Local
// verification"): a thrown name is whatever its thrower chose and a message
// can carry what the bank's page said, so neither is printed as text.
describe("local CLI failure line", () => {
  const PRIVATE = "private-provider-text";
  test.each([
    ["a custom name", Object.assign(new Error(PRIVATE), { name: "PrivatePageName" }), "Error"],
    ["a runtime type", new TypeError(PRIVATE), "TypeError"],
    ["a non-Error value", PRIVATE, "UnknownError"],
    [
      "a throwing name getter",
      Object.defineProperty(new Error(PRIVATE), "name", {
        get() {
          throw new Error(PRIVATE);
        },
      }),
      "Error",
    ],
  ])("an error with %s is a closed errorType and no message", (_label, error, errorType) => {
    const line = localFailureLine(error);
    expect(line).toEqual({ event: "sbi-shinsei-local-failed", errorType });
    expect(JSON.stringify(line)).not.toMatch(/private|Private/u);
  });
});
