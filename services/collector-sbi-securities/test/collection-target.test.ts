import { describe, expect, test } from "bun:test";
import { collectionTarget } from "../src/collection-target";

describe("COLLECTION_TARGET stays legacy unless it says shared (U09, D12/D13)", () => {
  test("an unset, empty or unknown value keeps the deployed path", () => {
    for (const value of [undefined, "", "legacy", "Shared", " shared", "shared ", "SHARED", "1"]) {
      expect(collectionTarget(value)).toBe("legacy");
    }
  });

  test("only the exact word switches the run to the shared bucket", () => {
    expect(collectionTarget("shared")).toBe("shared");
  });
});
