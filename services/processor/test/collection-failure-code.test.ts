import { expect, test } from "bun:test";
import { safeFailureCode } from "../src/collection/failure-code.ts";

const named = (name: unknown): Error =>
  Object.defineProperty(new Error("synthetic private message"), "name", { value: name });

test("ordinary classes remain diagnostic codes and messages never become codes", () => {
  expect(safeFailureCode(new Error("synthetic private message"))).toBe("Error");
  expect(safeFailureCode(new TypeError("synthetic private message"))).toBe("TypeError");
  expect(safeFailureCode(named(""))).toBe("Error");
  expect(safeFailureCode(named("Custom_Error2"))).toBe("Custom_Error2");
  for (const value of [null, undefined, "private text", 42, { name: "TypeError" }])
    expect(safeFailureCode(value)).toBe("unknown");
  for (const name of [null, undefined, 0, 42, {}, "private/path", "private\ntext", "éError"])
    expect(safeFailureCode(named(name))).toBe("unknown");
});

test("all ASCII first and remaining characters and lengths through 66 obey the closed grammar", () => {
  const first = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const rest = first + "0123456789_";
  let cases = 0;
  for (let byte = 0; byte < 128; byte++) {
    const character = String.fromCharCode(byte);
    expect(safeFailureCode(named(character + "Error"))).toBe(
      first.includes(character) ? character + "Error" : "unknown",
    );
    expect(safeFailureCode(named("Error" + character))).toBe(
      rest.includes(character) ? "Error" + character : "unknown",
    );
    cases += 2;
  }
  for (let length = 1; length <= 66; length++) {
    const name = "A".repeat(length);
    expect(safeFailureCode(named(name))).toBe(length <= 64 ? name : "unknown");
    cases++;
  }
  expect(cases).toBe(322);
});

test("a throwing name or constructor cannot escape diagnostic classification", () => {
  const unreadableName = Object.defineProperty(new Error(), "name", {
    get() {
      throw new Error("synthetic private getter");
    },
  });
  const unreadableConstructor = Object.defineProperty(named(""), "constructor", {
    get() {
      throw new Error("synthetic private constructor");
    },
  });
  expect(safeFailureCode(unreadableName)).toBe("unknown");
  expect(safeFailureCode(unreadableConstructor)).toBe("unknown");
});
