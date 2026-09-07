import { describe, expect, test } from "bun:test";
import {
  parseVPointPayEmail,
  shouldForwardToMailbox,
  storeVPointPayEmail,
} from "../src/vpoint-pay-email";

describe("V Point Pay notification email", () => {
  test("normalizes an explicit point-funded usage without changing signs", async () => {
    const parsed = await parseVPointPayEmail(
      notification(
        [
          "◇利用先：テスト加盟店",
          "◇利用金額：1,234円",
          "（内、利用Vポイント数： 200ポイント）",
          "＜ご利用後の残高＞",
          "1,000円",
        ].join("\r\n"),
      ),
    );
    expect(parsed?.event.eventType).toBe("usage");
    expect(parsed?.event.amountYen).toBe(1234);
    expect(parsed?.event.usedPoints).toBe(200);
    expect(parsed?.event.merchant).toBe("テスト加盟店");
    expect(parsed?.delivery).toBe("direct");
    expect(shouldForwardToMailbox(parsed ?? null)).toBeTrue();
  });

  test("finds the original notification in a forwarded rfc822 attachment", async () => {
    const inner = notification(
      "◇取引内容：Vポイントからチャージ\r\n◇チャージ金額：500円",
      "【VポイントPay】チャージ受付のお知らせ",
    );
    const boundary = "forwarded-message";
    const outer = new TextEncoder().encode(
      [
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
      ].join("\r\n"),
    );
    const parsed = await parseVPointPayEmail(outer);
    expect(parsed?.event.eventType).toBe("charge");
    expect(parsed?.event.amountYen).toBe(500);
    expect(parsed?.event.detail).toBe("Vポイントからチャージ");
    expect(parsed?.delivery).toBe("forwarded-rfc822");
    expect(shouldForwardToMailbox(parsed ?? null)).toBeFalse();
  });

  test("rejects a lookalike sender", async () => {
    const raw = notification("◇利用金額：1円");
    const text = new TextDecoder()
      .decode(raw)
      .replace("info@prepaid.smbc-card.com", "attacker@example.invalid");
    expect(await parseVPointPayEmail(new TextEncoder().encode(text))).toBeNull();
    expect(shouldForwardToMailbox(null)).toBeTrue();
  });

  test("stores both evidence objects with exact native SHA-256 checksums", async () => {
    const parsed = await parseVPointPayEmail(notification("◇利用金額：1円"));
    expect(parsed).not.toBeNull();
    const puts: Array<{ key: string; body: Uint8Array; options: R2PutOptions }> = [];
    const bucket = {
      head: async () => null,
      put: async (key: string, body: Uint8Array, options: R2PutOptions) => {
        puts.push({ key, body, options });
        return null;
      },
    } as unknown as R2Bucket;
    const stored = await storeVPointPayEmail({
      bucket,
      parsed: parsed!,
      envelopeFrom: "info@prepaid.smbc-card.com",
      envelopeTo: "vpointpay@takuk.me",
      expectedRecipient: "vpointpay@takuk.me",
    });
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.options.sha256).toBe(await sha256Hex(put.body));
    }
    expect(stored.event).toMatchObject({
      schemaVersion: "vpoint-pay-email-event-v2",
      sourceProvenance: {
        delivery: "direct",
        storedMessageScope: "smtp-message",
        sourceVerification: "source_unverified",
        envelopeFrom: "info@prepaid.smbc-card.com",
        envelopeTo: "vpointpay@takuk.me",
        authenticationProvenance: "not-exposed-by-cloudflare-email-event",
      },
    });
  });

  test("fails closed before storage when the direct SMTP envelope sender is a lookalike", async () => {
    const parsed = await parseVPointPayEmail(notification("◇利用金額：1円"));
    const puts: string[] = [];
    const bucket = {
      head: async () => null,
      put: async (key: string) => {
        puts.push(key);
        return null;
      },
    } as unknown as R2Bucket;
    await expect(
      storeVPointPayEmail({
        bucket,
        parsed: parsed!,
        envelopeFrom: "attacker@example.invalid",
        envelopeTo: "vpointpay@takuk.me",
        expectedRecipient: "vpointpay@takuk.me",
      }),
    ).rejects.toThrow("vpoint_pay_email_envelope_sender_invalid");
    expect(puts).toHaveLength(0);
  });

  test("does not rewrite an immutable duplicate pair", async () => {
    const parsed = await parseVPointPayEmail(notification("◇利用金額：1円"));
    const bucket = {
      head: async () => ({ key: "existing" }),
      put: async () => {
        throw new Error("must_not_write");
      },
    } as unknown as R2Bucket;
    await expect(
      storeVPointPayEmail({
        bucket,
        parsed: parsed!,
        envelopeFrom: "info@prepaid.smbc-card.com",
        envelopeTo: "vpointpay@takuk.me",
        expectedRecipient: "vpointpay@takuk.me",
      }),
    ).resolves.toMatchObject({ duplicate: true });
  });

  test("does not treat an RFC Authentication-Results header as trusted EmailEvent provenance", async () => {
    const raw = new TextEncoder().encode(
      new TextDecoder()
        .decode(notification("◇利用金額：1円"))
        .replace(
          "From: V Point Pay",
          "Authentication-Results: attacker.invalid; dkim=pass header.d=prepaid.smbc-card.com\r\nFrom: V Point Pay",
        ),
    );
    const parsed = await parseVPointPayEmail(raw);
    const bucket = {
      head: async () => null,
      put: async () => null,
    } as unknown as R2Bucket;
    const stored = await storeVPointPayEmail({
      bucket,
      parsed: parsed!,
      envelopeFrom: "info@prepaid.smbc-card.com",
      envelopeTo: "vpointpay@takuk.me",
      expectedRecipient: "vpointpay@takuk.me",
    });
    expect(stored.event.sourceProvenance).toMatchObject({
      sourceVerification: "source_unverified",
      authenticationProvenance: "not-exposed-by-cloudflare-email-event",
    });
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function notification(text: string, subject = "【VポイントPay】ご利用のお知らせ"): Uint8Array {
  return new TextEncoder().encode(
    [
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
    ].join("\r\n"),
  );
}
