// Fail-closed pins for the V Point Pay notification-event parser (ADR 0004:
// refuse rather than guess). Inputs are synthetic mutations of the anonymous
// fixtures under tests/fixtures/observation-pipeline/v-point-pay-parser-boundaries.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vPointPayNotificationEvent } from "../src/parsers/v-point-pay.ts";
import type { ArtifactMeta, ParseResult } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(FIXTURES_ROOT, "v-point-pay-parser-boundaries", `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "v-point-pay",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "notification-event",
    artifactKey: "normalized-event.json",
    url: null,
    mime: "application/json",
    fetchedAt: "2026-08-05T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

const parse = (value: unknown, overrides: Partial<ArtifactMeta> = {}) =>
  vPointPayNotificationEvent.parse(encode(value), meta(overrides));
const usage = (change: Record<string, unknown> = {}) => ({ ...fixture("usage"), ...change });

// Every address here is synthetic except the provider's public notification
// sender. The parser checks the sender; the recipient is only recorded, and
// the collector compares it with its configured address at receipt (ADR 0115).
const SENDER = "info@prepaid.smbc-card.com";
const RECIPIENT = "synthetic-vpoint-pay@example.invalid";

// The Layer A provenance block of a schema-v2 event, in its direct form, as
// provenance v1 (stored before 1.1.0) records it.
type Form = (id: string) => Record<string, unknown>;
const direct: Form = (id) => ({
  schemaVersion: "vpoint-pay-email-source-provenance-v1",
  delivery: "direct",
  storedMessageScope: "smtp-message",
  sourceVerification: "source_unverified",
  envelopeFrom: SENDER,
  envelopeTo: RECIPIENT,
  outerMessageSha256: id,
  authenticationProvenance: "not-exposed-by-cloudflare-email-event",
});
// The forwarded form: the envelope names the forwarder, not the provider.
const forwarded: Form = (id) => ({
  ...direct(id),
  delivery: "forwarded-rfc822",
  storedMessageScope: "forwarded-rfc822-part",
  envelopeFrom: "Forwarder@Example.invalid",
  outerMessageSha256: "f".repeat(64),
});
// Provenance v2 adds the stored message's RFC 5322 From.
const withMessageFrom =
  (form: Form, messageFrom: string = SENDER): Form =>
  (id: string) => ({
    ...form(id),
    schemaVersion: "vpoint-pay-email-source-provenance-v2",
    messageFrom,
  });
const v2 = (provenance: (id: string) => unknown, base: Record<string, unknown> = usage()) => {
  const event: Record<string, unknown> = { ...base, schemaVersion: "vpoint-pay-email-event-v2" };
  return { ...event, sourceProvenance: provenance(event["id"] as string) };
};
const contradicts = "sourceProvenance contradicts the Layer A contract";

describe("v-point-pay notification events refuse drift", () => {
  const frozen = (version: string) => {
    const file = JSON.parse(
      readFileSync(
        join(FIXTURES_ROOT, "v-point-pay-parser-boundaries", `expected-${version}.json`),
        "utf8",
      ),
    ) as { parser: string; version: string; results: Record<string, ParseResult> };
    expect(file.parser).toBe(vPointPayNotificationEvent.name);
    expect(file.version).toBe(version);
    return file.results;
  };
  const NAMES = ["balance-addition", "charge", "declined", "usage"];

  test("release 1.1.0 preserves every complete fixture result frozen from 1.0.1", () => {
    expect(vPointPayNotificationEvent.version).toBe("1.1.0");
    const results = frozen("1.0.1");
    expect(Object.keys(results).sort()).toEqual(NAMES);
    for (const [name, expected] of Object.entries(results)) {
      expect(parse(fixture(name)), name).toEqual(expected);
    }
  });

  test("release 1.1.0 reads every v2 event 1.0.2 accepted exactly as 1.0.2 did", () => {
    // expected-1.0.2.json froze 1.0.2's complete outputs for the four fixtures
    // as v1 events and as v2 events in both forms; 1.0.2 accepted those v2
    // events only for the deployed recipient. 1.1.0 reads the same events with
    // any recipient, and with the provenance-v2 sender, to the same results.
    const results = frozen("1.0.2");
    expect(Object.keys(results).sort()).toEqual(
      NAMES.flatMap((name) => [name, `${name}/v2-direct`, `${name}/v2-forwarded`]),
    );
    for (const name of NAMES) {
      const base = fixture(name);
      expect(parse(base), name).toEqual(results[name]!);
      for (const [form, provenance] of [
        ["direct", direct],
        ["forwarded", forwarded],
      ] as const) {
        const expected = results[`${name}/v2-${form}`]!;
        expect(parse(v2(provenance, base)), `${name} ${form} v1`).toEqual(expected);
        expect(parse(v2(withMessageFrom(provenance), base)), `${name} ${form} v2`).toEqual(
          expected,
        );
      }
    }
  });

  test("negative non-declined notification amounts fail the whole artifact with a closed reason", () => {
    for (const name of ["usage", "charge", "balance-addition"]) {
      for (const amountYen of [-1, -1200, -1_000_000_000_000]) {
        const event: Record<string, unknown> = { ...fixture(name), amountYen };
        for (const input of [
          event,
          {
            ...event,
            schemaVersion: "vpoint-pay-email-event-v2",
            sourceProvenance: direct(event["id"] as string),
          },
        ]) {
          expect(() => parse(input)).toThrow(
            new Error("v_point_pay_negative_notification_amount_unsupported"),
          );
        }
      }
    }
  });

  test("run preconditions and envelope", () => {
    expect(() => parse(usage(), { runStatus: "partial" })).toThrow(/successful failure-free/u);
    expect(() => parse(usage(), { runFailureCount: 1 })).toThrow(/successful failure-free/u);
    expect(() => vPointPayNotificationEvent.parse(new TextEncoder().encode("{"), meta())).toThrow(
      "V Point Pay notification-event must be valid JSON",
    );
    expect(() => vPointPayNotificationEvent.parse(new Uint8Array([0xff]), meta())).toThrow(
      "not valid UTF-8",
    );
    expect(() => parse([usage()])).toThrow("notification-event must be an object");
    expect(() => parse(usage({ schemaVersion: "vpoint-pay-email-event-v3" }))).toThrow(
      "schemaVersion is unsupported",
    );
    expect(() => parse(usage({ extraField: null }))).toThrow("has schema drift");
    const { usedPoints: _dropped, ...missing } = usage();
    expect(() => parse(missing)).toThrow("has schema drift");
    // A v1 event never carries provenance; a v2 event always does.
    expect(() => parse({ ...usage(), sourceProvenance: null })).toThrow("has schema drift");
    expect(() => parse(usage({ schemaVersion: "vpoint-pay-email-event-v2" }))).toThrow(
      "has schema drift",
    );
  });

  test("identity, instants, enums and subject agreement", () => {
    expect(() => parse(usage({ id: "A".repeat(64) }))).toThrow("id is invalid");
    expect(() => parse(usage({ id: "" }))).toThrow("id must be a bounded string");
    expect(() => parse(usage({ sourceMessageId: 7 }))).toThrow(
      "sourceMessageId must be a bounded string",
    );
    for (const occurredAt of [
      "2026-08-01T01:02:03Z",
      "2026-08-01T10:02:03.000+09:00",
      "2026-02-30T00:00:00.000Z",
      "not a date",
      1_785_000_000_000,
      `2026-08-01T01:02:03.000Z${" ".repeat(20)}`,
    ]) {
      expect(() => parse(usage({ occurredAt }))).toThrow(
        "occurredAt must be a canonical UTC instant",
      );
    }
    expect(() => parse(usage({ eventType: "refund" }))).toThrow("eventType is unsupported");
    expect(() => parse(usage({ eventType: "charge" }))).toThrow("subject contradicts eventType");
    expect(() => parse(usage({ subject: "V Point Pay お知らせ" }))).toThrow(
      "subject contradicts eventType",
    );
    expect(() => parse(usage({ subject: "V Point Pay ご利用のお知らせ\u0007" }))).toThrow(
      "subject must be a bounded string",
    );
    expect(() => parse(usage({ merchant: "" }))).toThrow("merchant must be a bounded string");
    expect(() => parse(usage({ detail: "x".repeat(2_001) }))).toThrow(
      "detail must be a bounded string",
    );
  });

  test("amounts are bounded safe integers; balances and points are non-negative", () => {
    for (const amountYen of [12.5, "1200", 1_000_000_000_001, -1_000_000_000_001]) {
      expect(() => parse(usage({ amountYen }))).toThrow("amountYen must be a bounded safe integer");
    }
    for (const field of ["usedPoints", "balanceYen"]) {
      for (const value of [-1, 0.5, "1", 1_000_000_000_001]) {
        expect(() => parse(usage({ [field]: value }))).toThrow(
          `${field} must be a non-negative safe integer`,
        );
      }
    }
    expect(() => parse(usage({ amountYen: null }))).toThrow(
      "non-declined notification amountYen must not be null",
    );
    expect(() => parse({ ...fixture("charge"), amountYen: null })).toThrow(
      "non-declined notification amountYen must not be null",
    );
  });

  test("a declined event has no amount and a zero usage is never negative zero", () => {
    const declined = parse({ ...fixture("declined"), amountYen: null, balanceYen: null });
    expect(declined.observations).toHaveLength(1);
    expect(declined.observations[0]).toMatchObject({ kind: "transaction", status: "declined" });
    expect(declined.observations[0]).not.toHaveProperty("amountMinor");
    for (const amountYen of [-1200, 0, 1200, null]) {
      const transaction = parse({ ...fixture("declined"), amountYen }).observations[0];
      expect(transaction).toMatchObject({
        kind: "transaction",
        status: "declined",
        extra: { amountYen },
      });
      for (const field of ["amountMinor", "amountText", "amountScale", "currency"]) {
        expect(transaction).not.toHaveProperty(field);
      }
    }
    const zero = parse(usage({ amountYen: 0 })).observations[0];
    expect(zero?.kind === "transaction" && Object.is(zero.amountMinor, 0)).toBe(true);
    // The description falls back from merchant to detail to subject.
    const subjectOnly = parse(usage({ merchant: null, detail: null })).observations[0];
    expect(subjectOnly?.kind === "transaction" && subjectOnly.description).toBe(
      "V Point Pay ご利用のお知らせ",
    );
    expect(subjectOnly).not.toHaveProperty("counterparty");
  });

  test("schema-v2 records the recipient as a mailbox but does not compare it", () => {
    // The collector refuses mail sent to another mailbox before storing it
    // (services/collector-vpoint/worker-test/vpoint-pay-recipient.test.ts);
    // the parser takes no configuration to compare against (ADR 0115).
    for (const envelopeTo of [
      RECIPIENT,
      ` ${RECIPIENT.toUpperCase()} `,
      "other-mailbox@example.invalid",
      "synthetic-vpoint-pay@other.example.invalid",
    ]) {
      for (const form of [direct, forwarded, withMessageFrom(direct), withMessageFrom(forwarded)])
        expect(
          parse(v2((id) => ({ ...form(id), envelopeTo }))).observations,
          envelopeTo,
        ).toHaveLength(2);
    }
    // It must still be present and well formed, so the evidence records where the mail went.
    for (const form of [direct, withMessageFrom(forwarded)]) {
      expect(() => parse(v2((id) => ({ ...form(id), envelopeTo: "" })))).toThrow(
        "envelopeTo must be a bounded string",
      );
      expect(() => parse(v2((id) => ({ ...form(id), envelopeTo: "no-at-sign" })))).toThrow(
        "envelopeTo must be a mailbox",
      );
      expect(() => parse(v2((id) => ({ ...form(id), envelopeTo: "a@b@c" })))).toThrow(
        "envelopeTo must be a mailbox",
      );
      expect(() => parse(v2((id) => ({ ...form(id), envelopeTo: null })))).toThrow(
        "envelopeTo must be a bounded string",
      );
      expect(() =>
        parse(v2((id) => ({ ...form(id), envelopeTo: `${"x".repeat(310)}@example.invalid` }))),
      ).toThrow("envelopeTo must be a bounded string");
      expect(() =>
        parse(
          v2((id) => {
            const { envelopeTo: _dropped, ...missing } = form(id);
            return missing;
          }),
        ),
      ).toThrow("sourceProvenance has schema drift");
    }
  });

  test("provenance v2 requires the provider as the stored message's From in both forms", () => {
    expect(parse(v2(withMessageFrom(direct))).observations).toHaveLength(2);
    expect(parse(v2(withMessageFrom(forwarded))).observations).toHaveLength(2);
    // Compared case-insensitively after trimming, like every mailbox here.
    expect(
      parse(v2(withMessageFrom(forwarded, ` ${SENDER.toUpperCase()} `))).observations,
    ).toHaveLength(2);
    for (const form of [direct, forwarded]) {
      for (const messageFrom of [
        "attacker@example.invalid",
        `x${SENDER}`,
        SENDER.replace("smbc-card.com", "smbc-card.com.example.invalid"),
        // The forwarder is not the provider.
        "forwarder@example.invalid",
      ]) {
        expect(() => parse(v2(withMessageFrom(form, messageFrom))), messageFrom).toThrow(
          contradicts,
        );
      }
      expect(() => parse(v2(withMessageFrom(form, "no-at-sign")))).toThrow(
        "messageFrom must be a mailbox",
      );
      expect(() => parse(v2(withMessageFrom(form, "")))).toThrow(
        "messageFrom must be a bounded string",
      );
      // Provenance v2 without messageFrom, or v1 with it, is drift.
      expect(() =>
        parse(
          v2((id) => ({ ...form(id), schemaVersion: "vpoint-pay-email-source-provenance-v2" })),
        ),
      ).toThrow("sourceProvenance has schema drift");
      expect(() =>
        parse(
          v2((id) => ({
            ...withMessageFrom(form)(id),
            schemaVersion: "vpoint-pay-email-source-provenance-v1",
          })),
        ),
      ).toThrow("sourceProvenance has schema drift");
    }
    // Direct delivery still needs the provider on the SMTP envelope as well.
    expect(() =>
      parse(
        v2((id) => ({ ...withMessageFrom(direct)(id), envelopeFrom: "attacker@example.invalid" })),
      ),
    ).toThrow(contradicts);
  });

  test("schema-v2 provenance must match one of the two Layer A forms", () => {
    for (const version of [(form: Form): Form => form, withMessageFrom]) {
      const directForm = version(direct);
      const forwardedForm = version(forwarded);
      expect(parse(v2(directForm)).observations).toHaveLength(2);
      expect(parse(v2(forwardedForm)).observations).toHaveLength(2);
      // Mailboxes are compared case-insensitively after trimming.
      expect(
        parse(v2((id) => ({ ...directForm(id), envelopeFrom: ` ${SENDER.toUpperCase()} ` })))
          .observations,
      ).toHaveLength(2);

      expect(() => parse(v2((id) => ({ ...directForm(id), extra: true })))).toThrow(
        "sourceProvenance has schema drift",
      );
      expect(() => parse(v2((id) => ({ ...directForm(id), envelopeFrom: "no-at-sign" })))).toThrow(
        "envelopeFrom must be a mailbox",
      );
      expect(() =>
        parse(v2((id) => ({ ...directForm(id), outerMessageSha256: id.toUpperCase() }))),
      ).toThrow("outer hash is invalid");
      for (const contradiction of [
        (id: string) => ({ ...directForm(id), envelopeFrom: "other@example.invalid" }),
        (id: string) => ({ ...directForm(id), outerMessageSha256: "f".repeat(64) }),
        (id: string) => ({ ...directForm(id), storedMessageScope: "forwarded-rfc822-part" }),
        (id: string) => ({ ...forwardedForm(id), outerMessageSha256: id }),
        (id: string) => ({ ...forwardedForm(id), storedMessageScope: "smtp-message" }),
        (id: string) => ({ ...directForm(id), sourceVerification: "source_verified" }),
        (id: string) => ({ ...directForm(id), authenticationProvenance: "dkim-pass" }),
        (id: string) => ({ ...directForm(id), delivery: "unknown" }),
      ]) {
        expect(() => parse(v2(contradiction))).toThrow(contradicts);
      }
    }
    expect(() => parse(v2(() => "direct"))).toThrow("sourceProvenance must be an object");
    expect(() =>
      parse(
        v2((id) => ({ ...direct(id), schemaVersion: "vpoint-pay-email-source-provenance-v3" })),
      ),
    ).toThrow(contradicts);
  });
});
