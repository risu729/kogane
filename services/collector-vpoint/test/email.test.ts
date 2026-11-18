import { describe, expect, test } from "bun:test";
import { extractVPointEmailCode, isCollectorRecipient, VPOINT_EMAIL_SUBJECT } from "../src/email";

describe("V Point authentication email", () => {
  test("accepts the Web OTP and V Point Pay recipient aliases", () => {
    const recipients = [
      "synthetic-vpoint-auth@example.invalid",
      "synthetic-vpoint-pay@example.invalid",
    ];
    expect(isCollectorRecipient("SYNTHETIC-VPOINT-AUTH@EXAMPLE.INVALID", recipients)).toBeTrue();
    expect(isCollectorRecipient("synthetic-vpoint-pay@example.invalid", recipients)).toBeTrue();
    expect(isCollectorRecipient("other@example.invalid", recipients)).toBeFalse();
  });

  test("extracts the only code from the message preamble", async () => {
    expect(
      await extractVPointEmailCode(
        message(
          [
            "認証コードを入力してください。",
            "123456",
            "有効時間は1分間です。",
            "--------------------",
            "https://example.invalid/faq/12345",
          ].join("\r\n"),
        ),
      ),
    ).toBe("123456");
  });

  test("ignores other subjects and ambiguous preambles", async () => {
    expect(await extractVPointEmailCode(message("1234", "other"))).toBeNull();
    expect(await extractVPointEmailCode(message("1234 and 5678"))).toBeNull();
  });
});

function message(text: string, subject = VPOINT_EMAIL_SUBJECT): Uint8Array {
  const encodedSubject = Buffer.from(subject).toString("base64");
  return new TextEncoder().encode(
    [
      `Subject: =?UTF-8?B?${encodedSubject}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
    ].join("\r\n"),
  );
}
