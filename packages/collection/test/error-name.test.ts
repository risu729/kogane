import { expect, test } from "bun:test";
import { LOGGED_ERROR_NAMES, loggedErrorName } from "../src/error-name";
import { CollectionLeaseAbort } from "../src/schedule-lease";

test("runtime error names and the lease's abort are logged as themselves", () => {
  expect(loggedErrorName(new Error("synthetic"))).toBe("Error");
  expect(loggedErrorName(new TypeError("synthetic"))).toBe("TypeError");
  expect(loggedErrorName(new RangeError("synthetic"))).toBe("RangeError");
  expect(loggedErrorName(new SyntaxError("synthetic"))).toBe("SyntaxError");
  expect(loggedErrorName(new ReferenceError("synthetic"))).toBe("ReferenceError");
  expect(loggedErrorName(new EvalError("synthetic"))).toBe("EvalError");
  expect(loggedErrorName(new URIError("synthetic"))).toBe("URIError");
  expect(loggedErrorName(new AggregateError([], "synthetic"))).toBe("AggregateError");
  expect(loggedErrorName(new DOMException("synthetic", "AbortError"))).toBe("AbortError");
  expect(loggedErrorName(new DOMException("synthetic", "TimeoutError"))).toBe("TimeoutError");
  expect(loggedErrorName(new DOMException("synthetic", "DataCloneError"))).toBe("DataCloneError");
  expect(loggedErrorName(new CollectionLeaseAbort("collection_lease_lost"))).toBe(
    "CollectionLeaseAbort",
  );
});

test("any other name is `other`, and the message is never read", () => {
  const named = (name: unknown) => Object.assign(new Error("synthetic provider text"), { name });
  for (const name of [
    "synthetic provider text",
    "SyntheticProviderToken42",
    "error",
    "Error ",
    "non_error",
    "",
    42,
    null,
  ])
    expect(loggedErrorName(named(name))).toBe("other");
  class SyntheticClientError extends Error {
    override name = "SyntheticClientError";
  }
  expect(loggedErrorName(new SyntheticClientError("synthetic"))).toBe("other");
  const throwing = new Error("synthetic");
  Object.defineProperty(throwing, "name", {
    get() {
      throw new Error("synthetic getter");
    },
  });
  expect(loggedErrorName(throwing)).toBe("other");
  // A Proxy names nothing of its own: a revoked one or a throwing trap is
  // `other`, and a trap's answer still has to be a closed code.
  const { proxy, revoke } = Proxy.revocable(new Error("synthetic"), {});
  revoke();
  expect(loggedErrorName(proxy)).toBe("other");
  const trap = new Proxy(new Error("synthetic"), {
    getPrototypeOf() {
      throw new Error("synthetic trap");
    },
  });
  expect(loggedErrorName(trap)).toBe("other");
  const renamed = new Proxy(new Error("synthetic"), { get: () => "SyntheticProviderToken42" });
  expect(loggedErrorName(renamed)).toBe("other");
});

test("a thrown value that is not an Error is `non_error`", () => {
  for (const value of [
    "synthetic provider text",
    42,
    null,
    undefined,
    { name: "Error" },
    Object.create(null),
    Object.setPrototypeOf(new Error("synthetic"), null),
  ])
    expect(loggedErrorName(value)).toBe("non_error");
});

test("every logged name is a closed code", () => {
  const samples: unknown[] = [
    new Error("synthetic"),
    Object.assign(new Error("synthetic"), { name: "anything at all" }),
    "synthetic",
  ];
  for (const sample of samples)
    expect(LOGGED_ERROR_NAMES as readonly string[]).toContain(loggedErrorName(sample));
});
