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
    const puts: Array<{
      key: string;
      body: Uint8Array;
      options: R2PutOptions;
    }> = [];
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
    expect(puts[0]!.key).toEndWith(".eml");
    expect(puts[1]!.key).toEndWith(".json");
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
    const memory = memoryBucket();
    await store(memory.bucket, parsed!);
    memory.puts.length = 0;
    await expect(store(memory.bucket, parsed!)).resolves.toMatchObject({
      duplicate: true,
    });
    expect(memory.puts).toHaveLength(0);
  });

  for (const failedSuffix of [".eml", ".json"] as const) {
    test(`repairs a verified pair after the first ${failedSuffix} PUT fails`, async () => {
      const parsed = await parseVPointPayEmail(notification("◇利用金額：1円"));
      const memory = memoryBucket(failedSuffix);
      await expect(store(memory.bucket, parsed!)).rejects.toThrow("synthetic_put_failure");
      expect(memory.objects).toHaveLength(failedSuffix === ".eml" ? 0 : 1);
      const retainedKey = memory.objects[0]?.key;

      await expect(store(memory.bucket, parsed!)).resolves.toMatchObject({
        duplicate: false,
      });
      expect(memory.objects).toHaveLength(2);
      if (retainedKey) expect(memory.puts.filter((key) => key === retainedKey)).toHaveLength(1);
      await expect(store(memory.bucket, parsed!)).resolves.toMatchObject({
        duplicate: true,
      });
    });
  }

  test("fails closed when the retained side of a partial pair was tampered", async () => {
    const parsed = await parseVPointPayEmail(notification("◇利用金額：1円"));
    const tampering: Array<{
      mutate(object: MemoryObject): void;
      error: string;
    }> = [
      {
        mutate: (object) => {
          object.size += 1;
        },
        error: "vpoint_pay_email_existing_object_size_mismatch",
      },
      {
        mutate: (object) => {
          object.httpMetadata = { contentType: "application/octet-stream" };
        },
        error: "vpoint_pay_email_existing_object_content_type_mismatch",
      },
      {
        mutate: (object) => {
          object.customMetadata = { ...object.customMetadata, eventType: "tampered" };
        },
        error: "vpoint_pay_email_existing_object_metadata_mismatch",
      },
      {
        mutate: (object) => {
          object.checksums = { sha256: new Uint8Array(32).buffer } as R2Checksums;
        },
        error: "vpoint_pay_email_existing_object_native_checksum_mismatch",
      },
    ];

    for (const tamper of tampering) {
      const memory = memoryBucket(".json");
      await expect(store(memory.bucket, parsed!)).rejects.toThrow("synthetic_put_failure");
      tamper.mutate(memory.objects[0]!);
      await expect(store(memory.bucket, parsed!)).rejects.toThrow(tamper.error);
      expect(memory.puts).toHaveLength(2);
    }
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

function store(
  bucket: R2Bucket,
  parsed: NonNullable<Awaited<ReturnType<typeof parseVPointPayEmail>>>,
) {
  return storeVPointPayEmail({
    bucket,
    parsed,
    envelopeFrom: "info@prepaid.smbc-card.com",
    envelopeTo: "vpointpay@takuk.me",
    expectedRecipient: "vpointpay@takuk.me",
  });
}

interface MemoryObject {
  key: string;
  size: number;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  checksums: R2Checksums;
}

function memoryBucket(failOnceSuffix?: ".eml" | ".json"): {
  bucket: R2Bucket;
  puts: string[];
  objects: MemoryObject[];
} {
  const objects: MemoryObject[] = [];
  const puts: string[] = [];
  let pendingFailure = failOnceSuffix;
  const bucket = {
    head: async (key: string) =>
      (objects.find((object) => object.key === key) ?? null) as unknown as R2Object,
    put: async (key: string, body: Uint8Array, options: R2PutOptions) => {
      puts.push(key);
      if (pendingFailure && key.endsWith(pendingFailure)) {
        pendingFailure = undefined;
        throw new Error("synthetic_put_failure");
      }
      const checksum = options.sha256;
      if (typeof checksum !== "string") throw new Error("test_requires_hex_sha256");
      objects.push({
        key,
        size: body.byteLength,
        httpMetadata: options.httpMetadata as R2HTTPMetadata,
        customMetadata: { ...(options.customMetadata ?? {}) },
        checksums: { sha256: hexToArrayBuffer(checksum) } as R2Checksums,
      });
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts, objects };
}

function hexToArrayBuffer(value: string): ArrayBuffer {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)).buffer;
}
