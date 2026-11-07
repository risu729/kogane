import { expect, test } from "bun:test";
import { safeFailureCode } from "../src/collection/failure-code.ts";

const CLASSES: [() => Error, string][] = [
  [() => new AggregateError([], "synthetic private message"), "AggregateError"],
  [() => new EvalError("synthetic private message"), "EvalError"],
  [() => new RangeError("synthetic private message"), "RangeError"],
  [() => new ReferenceError("synthetic private message"), "ReferenceError"],
  [() => new SyntaxError("synthetic private message"), "SyntaxError"],
  [() => new TypeError("synthetic private message"), "TypeError"],
  [() => new URIError("synthetic private message"), "URIError"],
  [() => new Error("synthetic private message"), "Error"],
];
const named = (error: Error, name: unknown): Error =>
  Object.defineProperty(error, "name", { value: name });

test("only finite built-in diagnostic classes are emitted, regardless of writable names", () => {
  for (const [make, expected] of CLASSES) {
    expect(safeFailureCode(make())).toBe(expected);
    for (const name of [
      "synthetic_private_key_123",
      "private/path",
      "private\ntext",
      "Custom_Error2",
      "TypeError",
      "",
      "A".repeat(65),
      null,
      42,
      {},
    ])
      expect(safeFailureCode(named(make(), name))).toBe(expected);
  }
  class CustomError extends Error {}
  expect(safeFailureCode(new CustomError("synthetic private message"))).toBe("Error");
  for (const value of [null, undefined, "private text", 42, { name: "TypeError" }])
    expect(safeFailureCode(value)).toBe("unknown");
});

test("all bounded ASCII names and lengths leave all eight built-in classifications unchanged", () => {
  let cases = 0;
  for (const [make, expected] of CLASSES) {
    for (let byte = 0; byte < 128; byte++) {
      const character = String.fromCharCode(byte);
      expect(safeFailureCode(named(make(), character + "Error"))).toBe(expected);
      expect(safeFailureCode(named(make(), "Error" + character))).toBe(expected);
      cases += 2;
    }
    for (let length = 1; length <= 66; length++) {
      expect(safeFailureCode(named(make(), "A".repeat(length)))).toBe(expected);
      cases++;
    }
  }
  expect(cases).toBe(2576);
});

test("diagnostics never read throwing name or constructor accessors", () => {
  const unreadableName = Object.defineProperty(new Error(), "name", {
    get() {
      throw new Error("synthetic private getter");
    },
  });
  const unreadableConstructor = Object.defineProperty(new Error(), "constructor", {
    get() {
      throw new Error("synthetic private constructor");
    },
  });
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("synthetic private prototype");
    },
  });
  expect(safeFailureCode(unreadableName)).toBe("Error");
  expect(safeFailureCode(unreadableConstructor)).toBe("Error");
  expect(safeFailureCode(hostileProxy)).toBe("unknown");
});
