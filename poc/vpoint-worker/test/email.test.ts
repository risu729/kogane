import { describe, expect, test } from "bun:test";
import {
  extractVPointEmailCode,
  VPOINT_EMAIL_SUBJECT,
} from "../src/email";

describe("V Point authentication email", () => {
  test("extracts the only code from the message preamble", async () => {
    expect(await extractVPointEmailCode(message([
      "認証コードを入力してください。",
      "123456",
      "有効時間は1分間です。",
      "--------------------",
      "https://example.invalid/faq/12345",
    ].join("\r\n")))).toBe("123456");
  });

  test("ignores other subjects and ambiguous preambles", async () => {
    expect(await extractVPointEmailCode(message("1234", "other"))).toBeNull();
    expect(await extractVPointEmailCode(message("1234 and 5678"))).toBeNull();
  });
});

function message(text: string, subject = VPOINT_EMAIL_SUBJECT): Uint8Array {
  const encodedSubject = Buffer.from(subject).toString("base64");
  return new TextEncoder().encode([
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
  ].join("\r\n"));
}
