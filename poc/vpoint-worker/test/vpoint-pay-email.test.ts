import { describe, expect, test } from "bun:test";
import { parseVPointPayEmail } from "../src/vpoint-pay-email";

describe("V Point Pay notification email", () => {
  test("normalizes an explicit point-funded usage without changing signs", async () => {
    const parsed = await parseVPointPayEmail(notification([
      "◇利用先：テスト加盟店",
      "◇利用金額：1,234円",
      "（内、利用Vポイント数： 200ポイント）",
      "＜ご利用後の残高＞",
      "1,000円",
    ].join("\r\n")));
    expect(parsed?.event.eventType).toBe("usage");
    expect(parsed?.event.amountYen).toBe(1234);
    expect(parsed?.event.usedPoints).toBe(200);
    expect(parsed?.event.merchant).toBe("テスト加盟店");
  });

  test("finds the original notification in a forwarded rfc822 attachment", async () => {
    const inner = notification(
      "◇取引内容：Vポイントからチャージ\r\n◇チャージ金額：500円",
      "【VポイントPay】チャージ受付のお知らせ",
    );
    const boundary = "forwarded-message";
    const outer = new TextEncoder().encode([
      "From: owner@example.invalid",
      "To: vpoint@example.invalid",
      "Subject: Fwd: notification",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      "",
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(inner).toString("base64"),
      `--${boundary}--`,
    ].join("\r\n"));
    const parsed = await parseVPointPayEmail(outer);
    expect(parsed?.event.eventType).toBe("charge");
    expect(parsed?.event.amountYen).toBe(500);
    expect(parsed?.event.detail).toBe("Vポイントからチャージ");
  });

  test("rejects a lookalike sender", async () => {
    const raw = notification("◇利用金額：1円");
    const text = new TextDecoder().decode(raw).replace(
      "info@prepaid.smbc-card.com",
      "attacker@example.invalid",
    );
    expect(await parseVPointPayEmail(new TextEncoder().encode(text))).toBeNull();
  });
});

function notification(
  text: string,
  subject = "【VポイントPay】ご利用のお知らせ",
): Uint8Array {
  return new TextEncoder().encode([
    "From: V Point Pay <info@prepaid.smbc-card.com>",
    "To: owner@example.invalid",
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "Date: Sun, 31 Aug 2026 12:00:00 +0900",
    "Message-ID: <synthetic@example.invalid>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
  ].join("\r\n"));
}
