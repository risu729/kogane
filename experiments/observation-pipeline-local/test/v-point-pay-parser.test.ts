import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { vPointPayNotificationEvent } from "../../../packages/parsers/src/parsers/v-point-pay.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "observation-pipeline", "v-point-pay-parser-boundaries");

function artifact(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
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

function fixture(name: string): Uint8Array {
  return readFileSync(join(FIXTURE_DIR, `${name}.json`));
}

function value(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, unknown>;
}

function encode(input: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

describe("V Point Pay normalized notification-event Layer B", () => {
  test("routes only the exact normalized artifact and never routes notification-mail", () => {
    expect(PARSERS.filter((parser) => parser.accepts(artifact()))).toEqual([
      vPointPayNotificationEvent,
    ]);
    for (const overrides of [
      { sourceId: "v-point-pay-email" },
      { dataset: "notification-mail", mime: "message/rfc822", artifactKey: "notification.eml" },
      { artifactKey: null },
      { artifactKey: "notification.json" },
      { mime: "application/json; charset=utf-8" },
    ]) {
      expect(PARSERS.filter((parser) => parser.accepts(artifact(overrides)))).toEqual([]);
    }
  });

  test("signs notification amounts without claiming settlement or splitting funding legs", () => {
    const expected = [
      ["usage", -1200, "outflow-notified"],
      ["charge", 5000, "inflow-notified"],
      ["balance-addition", 700, "inflow-notified"],
    ] as const;
    for (const [name, amount, direction] of expected) {
      const result = vPointPayNotificationEvent.parse(fixture(name), artifact());
      expect(result.observations).toHaveLength(2);
      expect(result.observations[0]).toMatchObject({
        kind: "transaction",
        sourceAccount: "v-point-pay:notification-events",
        status: "notified",
        amountMinor: amount,
        amountText: String(amount),
        amountScale: 0,
        currency: "JPY",
        extra: {
          _kogane: {
            direction,
            amountDisposition: "notification-amount-not-settled",
            settlementDisposition: "not-established-by-notification",
            fundingSplitDisposition: "not-inferred-from-total-and-used-points",
            usedPointsDisposition: "extra-only",
          },
        },
      });
      expect(result.observations.filter((row) => row.kind === "transaction")).toHaveLength(1);
      expect(result.observations.filter((row) => row.kind === "balance")).toHaveLength(1);
    }
  });

  test("preserves a declined attempt without inventing a posted cashflow amount", () => {
    const result = vPointPayNotificationEvent.parse(fixture("declined"), artifact());
    const transaction = result.observations[0]!;
    expect(transaction).toMatchObject({
      kind: "transaction",
      sourceAccount: "v-point-pay:notification-events",
      status: "declined",
      externalId: "d".repeat(64),
      extra: {
        amountYen: 3000,
        _kogane: { direction: "no-posted-cashflow", amountDisposition: "attempted-not-posted" },
      },
    });
    expect(transaction).not.toHaveProperty("amountMinor");
    expect(transaction).not.toHaveProperty("amountText");
    expect(transaction).not.toHaveProperty("currency");
  });

  test("derives usage direction from eventType even when Layer A retains a signed display", () => {
    const input = value("usage");
    input["amountYen"] = -1200;
    expect(
      vPointPayNotificationEvent.parse(encode(input), artifact()).observations[0],
    ).toMatchObject({
      kind: "transaction",
      amountMinor: -1200,
      amountText: "-1200",
      extra: { amountYen: -1200, _kogane: { amountSignSource: "eventType" } },
    });
  });

  test("emits balance only when the source event carries balanceYen", () => {
    const input = value("usage");
    input["balanceYen"] = null;
    const result = vPointPayNotificationEvent.parse(encode(input), artifact());
    expect(result.observations).toHaveLength(1);
    const balance = vPointPayNotificationEvent.parse(fixture("usage"), artifact()).observations[1];
    expect(balance).toMatchObject({
      kind: "balance",
      sourceAccount: "v-point-pay:prepaid-yen",
      metric: "prepaid_balance_after_event",
      instrument: "JPY",
      asOf: "2026-08-01T01:02:03.000Z",
      rawLocator: "json:$.balanceYen",
    });
  });

  test("rejects unsuccessful runs, missing notification amounts, and schema or semantic drift", () => {
    for (const overrides of [
      { runStatus: "partial" as const, runFailureCount: 1 },
      { runStatus: "success" as const, runFailureCount: 1 },
    ]) {
      expect(() => vPointPayNotificationEvent.parse(fixture("usage"), artifact(overrides))).toThrow(
        /failure-free/u,
      );
    }
    const mutations: ((input: Record<string, unknown>) => void)[] = [
      (input) => {
        input["newField"] = true;
      },
      (input) => {
        input["schemaVersion"] = "future";
      },
      (input) => {
        input["id"] = "not-an-id";
      },
      (input) => {
        input["occurredAt"] = "2026-08-01T01:02:03Z";
      },
      (input) => {
        input["eventType"] = "charge";
      },
      (input) => {
        input["amountYen"] = null;
      },
      (input) => {
        input["usedPoints"] = -1;
      },
      (input) => {
        input["balanceYen"] = 1.5;
      },
    ];
    for (const mutate of mutations) {
      const input = value("usage");
      mutate(input);
      expect(() => vPointPayNotificationEvent.parse(encode(input), artifact())).toThrow();
    }
  });

  test("enforces the exact Layer A v2 provenance envelope without propagating it", () => {
    const input = value("usage");
    input["schemaVersion"] = "vpoint-pay-email-event-v2";
    input["sourceProvenance"] = {
      schemaVersion: "vpoint-pay-email-source-provenance-v1",
      delivery: "direct",
      storedMessageScope: "smtp-message",
      sourceVerification: "source_unverified",
      envelopeFrom: "info@prepaid.smbc-card.com",
      envelopeTo: "vpointpay@takuk.me",
      outerMessageSha256: input["id"],
      authenticationProvenance: "not-exposed-by-cloudflare-email-event",
    };
    const result = vPointPayNotificationEvent.parse(encode(input), artifact());
    expect(result.observations[0]?.extra).not.toHaveProperty("sourceProvenance");
    (input["sourceProvenance"] as Record<string, unknown>)["outerMessageSha256"] = "f".repeat(64);
    expect(() => vPointPayNotificationEvent.parse(encode(input), artifact())).toThrow(
      /provenance/iu,
    );
  });
});
