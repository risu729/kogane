import { describe, expect, test } from "bun:test";
import { parseCredentials, parseCredentialSecrets, validateCreditCsvText } from "../src/collector";

describe("MyJCB connection configuration", () => {
  test("keeps independent password, passkey, and session bootstraps separate", () => {
    const credentials = parseCredentials(
      JSON.stringify([
        {
          connectionId: "account-one",
          bootstrapMode: "password",
          userId: "synthetic-user",
          password: "synthetic-password",
        },
        {
          connectionId: "account-passkey",
          bootstrapMode: "passkey",
          credentialId: "b3fbc8d2-b0fe-4a70-9b2d-f5cb4b321c33",
          privateKey: "c3ludGhldGljLXBrY3M4",
          rpId: "my.jcb.co.jp",
          userHandle: "c3ludGhldGljLXVzZXI",
          counter: 0,
          discoverable: true,
        },
        {
          connectionId: "account-two",
          bootstrapMode: "session",
          userAgent: "Synthetic Browser",
          cookies: [
            {
              name: "synthetic-session",
              value: "synthetic-value",
              domain: "my.jcb.co.jp",
              path: "/",
              secure: true,
            },
          ],
        },
      ]),
    );
    expect(credentials.map((value) => [value.connectionId, value.bootstrapMode])).toEqual([
      ["account-one", "password"],
      ["account-passkey", "passkey"],
      ["account-two", "session"],
    ]);
  });

  test("rejects exported passkeys with a stateful signature counter", () => {
    expect(() =>
      parseCredentials(
        JSON.stringify([
          {
            connectionId: "stateful-passkey",
            bootstrapMode: "passkey",
            credentialId: "b3fbc8d2-b0fe-4a70-9b2d-f5cb4b321c33",
            privateKey: "c3ludGhldGljLXBrY3M4",
            rpId: "my.jcb.co.jp",
            userHandle: "c3ludGhldGljLXVzZXI",
            counter: 1,
            discoverable: true,
          },
        ]),
      ),
    ).toThrow("stateful passkey counter");
  });

  test("accepts Bitwarden legacy GUID-shaped credential IDs", () => {
    const [credential] = parseCredentials(
      JSON.stringify([
        {
          connectionId: "legacy-guid-passkey",
          bootstrapMode: "passkey",
          credentialId: "00112233-4455-0677-0899-aabbccddeeff",
          privateKey: "c3ludGhldGljLXBrY3M4",
          rpId: "my.jcb.co.jp",
          userHandle: "c3ludGhldGljLXVzZXI",
          counter: 0,
          discoverable: true,
        },
      ]),
    );
    expect(credential?.bootstrapMode).toBe("passkey");
  });

  test("rejects duplicate namespaces", () => {
    expect(() =>
      parseCredentials(
        JSON.stringify([
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
        ]),
      ),
    ).toThrow("unique");
  });

  test("combines one-account-per-secret payloads", () => {
    const credentials = parseCredentialSecrets([
      JSON.stringify({
        connectionId: "split-one",
        bootstrapMode: "password",
        userId: "one",
        password: "one",
      }),
      JSON.stringify({
        connectionId: "split-two",
        bootstrapMode: "password",
        userId: "two",
        password: "two",
      }),
    ]);
    expect(credentials.map((item) => item.connectionId)).toEqual(["split-one", "split-two"]);
  });

  test("finds the 12-column CSV header after metadata lines", () => {
    const header = [
      "ご利用者",
      "カテゴリ",
      "ご利用日",
      "ご利用先など",
      "ご利用金額(￥)",
      "支払区分",
      "今回回数",
      "訂正サイン",
      "お支払い金額(￥)",
      "国内／海外",
      "摘要",
      "備考",
    ].join(",");
    expect(() => validateCreditCsvText(`お支払い日,2026年1月1日\r\n${header}\r\n`)).not.toThrow();
  });
});
