// The recipient check of V Point Pay notification mail (ADR 0115).
//
// The collector is the only place that compares the SMTP recipient with the
// V Point Pay routing address: the parser records the recipient but takes no
// configuration. These tests run the Worker's email handler against the
// recipient the deployed Wrangler config binds (`VPOINT_PAY_EMAIL_RECIPIENT`
// is not overridden in vitest.config.ts), so they fail if the guard stops
// applying to the configured value. The address is read from the binding and
// never copied here; the mail bytes are synthetic.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readTerminal } from "../../../packages/collection/src/index";
import { VPOINT_PAY_EMAIL_SOURCE } from "../src/shared-run";
import { parseVPointPayEmail, prepareVPointPayEmail } from "../src/vpoint-pay-email";
import worker from "../src/worker";

afterEach(() => vi.restoreAllMocks());

const OFFICIAL_SENDER = "info@prepaid.smbc-card.com";
const FORWARD_TO = "synthetic-forward@example.invalid";

function configuredRecipient(): string {
  const recipient = (env as unknown as { VPOINT_PAY_EMAIL_RECIPIENT?: string })
    .VPOINT_PAY_EMAIL_RECIPIENT;
  if (!recipient) throw new Error("VPOINT_PAY_EMAIL_RECIPIENT_not_bound");
  return recipient;
}

function notification(marker: string): Uint8Array {
  const subject = btoa(
    String.fromCharCode(...new TextEncoder().encode("【VポイントPay】ご利用のお知らせ")),
  );
  return new TextEncoder().encode(
    [
      `From: V Point Pay <${OFFICIAL_SENDER}>`,
      "To: synthetic-vpoint-pay@example.invalid",
      `Subject: =?UTF-8?B?${subject}?=`,
      "Date: Sun, 31 Aug 2026 12:00:00 +0900",
      `Message-ID: <${marker}@example.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "◇利用金額：1円",
    ].join("\r\n"),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function emailEnv(): Env {
  return {
    ...env,
    SCHEDULE_DB: undefined,
    VPOINT_EMAIL_FORWARD_TO: FORWARD_TO,
  } as unknown as Env;
}

async function deliver(to: string, raw: Uint8Array): Promise<string[]> {
  const forwarded: string[] = [];
  const message = {
    from: OFFICIAL_SENDER,
    to,
    raw: new Response(raw).body!,
    forward: async (target: string) => {
      forwarded.push(target);
    },
  } as unknown as ForwardableEmailMessage;
  for (const level of ["log", "error"] as const)
    vi.spyOn(console, level).mockImplementation(() => undefined);
  await worker.email!(message, emailEnv(), {} as unknown as ExecutionContext);
  return forwarded;
}

describe("the collector checks the V Point Pay recipient at receipt", () => {
  test("the binding under test is the configured routing address, not the OTP alias", () => {
    expect(configuredRecipient()).toMatch(/^[^\s@]+@[^\s@]+$/u);
    expect(configuredRecipient().toLowerCase()).not.toBe(
      String((env as unknown as { VPOINT_EMAIL_RECIPIENT?: string }).VPOINT_EMAIL_RECIPIENT),
    );
  });

  test("an official notification sent to the configured recipient is stored", async () => {
    const raw = notification("synthetic-recipient-accepted");
    // Upper case and padding are the same mailbox.
    const forwarded = await deliver(` ${configuredRecipient().toUpperCase()} `, raw);
    const read = await readTerminal(env.DATA, VPOINT_PAY_EMAIL_SOURCE, await sha256Hex(raw));
    expect(read.outcome).toBe("found");
    // A direct notification is also passed on to the owner's mailbox.
    expect(forwarded).toEqual([FORWARD_TO]);
  });

  test("the same notification sent to another mailbox is never stored", async () => {
    const [local, domain] = configuredRecipient().split("@") as [string, string];
    const otpAlias = (env as unknown as { VPOINT_EMAIL_RECIPIENT: string }).VPOINT_EMAIL_RECIPIENT;
    for (const [index, other] of [
      `other-${local}@${domain}`,
      `${local}@other.${domain}`,
      // The Web OTP alias reaches the same Worker but is not the V Point Pay recipient.
      otpAlias,
      "synthetic-elsewhere@example.invalid",
    ].entries()) {
      const raw = notification(`synthetic-recipient-refused-${index}`);
      const forwarded = await deliver(other, raw);
      const read = await readTerminal(env.DATA, VPOINT_PAY_EMAIL_SOURCE, await sha256Hex(raw));
      expect(read.outcome, `mailbox ${index}`).toBe("missing");
      // The mail is not lost: it is passed on unparsed, as any non-target mail.
      expect(forwarded).toEqual([FORWARD_TO]);
    }
  });

  test("preparing the evidence refuses another recipient against the configured one", async () => {
    const parsed = await parseVPointPayEmail(notification("synthetic-recipient-prepare"));
    if (!parsed) throw new Error("fixture_not_parsed");
    const [local, domain] = configuredRecipient().split("@") as [string, string];
    await expect(
      prepareVPointPayEmail({
        parsed,
        envelopeFrom: OFFICIAL_SENDER,
        envelopeTo: `other-${local}@${domain}`,
        expectedRecipient: configuredRecipient(),
      }),
    ).rejects.toThrow("vpoint_pay_email_envelope_invalid");
    await expect(
      prepareVPointPayEmail({
        parsed,
        envelopeFrom: OFFICIAL_SENDER,
        envelopeTo: configuredRecipient(),
        expectedRecipient: configuredRecipient(),
      }),
    ).resolves.toMatchObject({ event: { schemaVersion: "vpoint-pay-email-event-v2" } });
  });
});
