import { describe, expect, test } from "bun:test";
import { parseCredentials } from "../src/collector";

describe("MyJCB connection configuration", () => {
  test("keeps independent password and session bootstraps separate", () => {
    const credentials = parseCredentials(JSON.stringify([
      {
        connectionId: "account-one",
        bootstrapMode: "password",
        userId: "synthetic-user",
        password: "synthetic-password",
      },
      {
        connectionId: "account-two",
        bootstrapMode: "session",
        userAgent: "Synthetic Browser",
        cookies: [{
          name: "synthetic-session",
          value: "synthetic-value",
          domain: "my.jcb.co.jp",
          path: "/",
          secure: true,
        }],
      },
    ]));
    expect(credentials.map((value) => [value.connectionId, value.bootstrapMode])).toEqual([
      ["account-one", "password"],
      ["account-two", "session"],
    ]);
  });

  test("rejects duplicate namespaces", () => {
    expect(() => parseCredentials(JSON.stringify([
      {
        connectionId: "duplicate",
        bootstrapMode: "password",
        userId: "one",
        password: "one",
      },
      {
        connectionId: "duplicate",
        bootstrapMode: "password",
        userId: "two",
        password: "two",
      },
    ]))).toThrow("unique");
  });
});
