import { afterEach, expect, spyOn, test } from "bun:test";
import { MyJcbReadClient } from "../src/client";
import { CookieJar } from "../src/cookie-jar";
import { safeErrorDetails } from "../../collector-diagnostics/src/index";
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); });

test("read failures retain numeric HTTP status but no response body", async () => {
  const mocked = spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-statement-body", { status: 429 }));
  restore = () => mocked.mockRestore();
  let error: unknown;
  try { await new MyJcbReadClient(new CookieJar(), "test").get("mypage"); }
  catch (caught) { error = caught; }
  expect(safeErrorDetails(error)).toMatchObject({ httpStatus: 429, category: "http", errorType: "StopConditionError" });
  expect(JSON.stringify(safeErrorDetails(error))).not.toContain("private-statement-body");
});
