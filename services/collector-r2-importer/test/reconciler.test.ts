import { describe, expect, test } from "bun:test";
import {
  RECONCILER_SCHEMA,
  RECONCILER_SOURCES,
  parseMessage,
  processReconcilerMessage,
  weeklyRepairSeeds,
  type InternalMessage,
  type ReconcilerDependencies,
} from "../src/reconciler";

const ACCOUNT = "59ea63cc00914b30ca410b062ae2bb7f";
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const MANIFEST = `raw/sbi-vc-trade/2026/09/07/${RUN_ID}/manifest.json`;

describe("R2 outbox reconciler", () => {
  test("accepts only an exact R2 object-create notification for an allowlisted terminal", () => {
    const notification = r2Notification("kogane-sbi-vc-trade-poc", MANIFEST);
    expect(parseMessage(notification, ACCOUNT)).toEqual({
      kind: "r2-notification",
      source: "sbi-vc-trade",
      terminalKey: MANIFEST,
    });
    for (const invalid of [
      { ...notification, account: "0".repeat(32) },
      { ...notification, action: "DeleteObject" },
      { ...notification, bucket: "untrusted-bucket" },
      { ...notification, eventTime: "2026-99-99T12:34:56.789Z" },
      { ...notification, unexpected: true },
      {
        ...notification,
        object: { ...notification.object, key: MANIFEST.replace("manifest.json", "data.json") },
      },
    ]) {
      expect(() => parseMessage(invalid, ACCOUNT)).toThrow();
    }
  });

  test("accepts both non-overlapping Vpass terminal records", () => {
    for (const filename of ["manifest.json", "error.json"]) {
      const key = `vpass/2026/09/07/2026-09-07T12-34-56-789Z/card-001/${filename}`;
      expect(
        parseMessage(r2Notification("kogane-vpass-collector-poc", key), ACCOUNT),
      ).toMatchObject({ source: "vpass", terminalKey: key });
    }
  });

  test("queues an opaque continuation and rejects non-advancing progress", async () => {
    const sent: InternalMessage[][] = [];
    const dependencies = fakeDependencies({
      sent,
      outcome: { status: "deferred", resume: "opaque-token", progress: 8 },
    });
    await expect(
      processReconcilerMessage(r2Notification("kogane-sbi-vc-trade-poc", MANIFEST), dependencies),
    ).resolves.toEqual({ kind: "import", source: "sbi-vc-trade", outcome: "deferred" });
    expect(sent).toEqual([
      [
        {
          schemaVersion: RECONCILER_SCHEMA,
          kind: "import",
          source: "sbi-vc-trade",
          terminalKey: MANIFEST,
          step: 1,
          progress: 8,
          resume: "opaque-token",
        },
      ],
    ]);

    await expect(
      processReconcilerMessage(sent[0]![0], {
        ...dependencies,
        importTerminal: async () => ({
          status: "deferred",
          resume: "another-token",
          progress: 8,
        }),
      }),
    ).rejects.toThrow("reconciler_import_stalled");
  });

  test("repair sends terminal imports and scan continuation as independent messages", async () => {
    const sent: InternalMessage[][] = [];
    const dependencies = fakeDependencies({
      sent,
      listed: {
        keys: [MANIFEST, MANIFEST.replace("manifest.json", "cash-balances.json")],
        truncated: true,
        cursor: "next-page",
      },
    });
    await expect(
      processReconcilerMessage(
        {
          schemaVersion: RECONCILER_SCHEMA,
          kind: "repair",
          source: "sbi-vc-trade",
          cursor: null,
          page: 0,
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: "repair", source: "sbi-vc-trade", outcome: "continued" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(sent[0]![0]).toMatchObject({ kind: "import", terminalKey: MANIFEST });
    expect(sent[0]![1]).toEqual({
      schemaVersion: RECONCILER_SCHEMA,
      kind: "repair",
      source: "sbi-vc-trade",
      cursor: "next-page",
      page: 1,
    });
  });

  test("V Point Pay repair treats normalized JSON, not EML, as the terminal pair trigger", async () => {
    const sent: InternalMessage[][] = [];
    const id = "a".repeat(64);
    await processReconcilerMessage(
      {
        schemaVersion: RECONCILER_SCHEMA,
        kind: "repair",
        source: "v-point-pay-email",
        cursor: null,
        page: 0,
      },
      fakeDependencies({
        sent,
        listed: {
          keys: [
            `raw/v-point-pay-email/2026/09/07/${id}.eml`,
            `raw/v-point-pay-email/2026/09/07/${id}.json`,
          ],
          truncated: false,
          cursor: null,
        },
      }),
    );
    expect(sent.flat()).toEqual([
      expect.objectContaining({
        kind: "import",
        source: "v-point-pay-email",
        terminalKey: `raw/v-point-pay-email/2026/09/07/${id}.json`,
      }),
    ]);
  });

  test("rejects stalled repair cursors and malformed internal resume kinds", async () => {
    const dependencies = fakeDependencies({
      listed: { keys: [], truncated: true, cursor: "same" },
    });
    await expect(
      processReconcilerMessage(
        {
          schemaVersion: RECONCILER_SCHEMA,
          kind: "repair",
          source: "sony-bank",
          cursor: "same",
          page: 1,
        },
        dependencies,
      ),
    ).rejects.toThrow("reconciler_repair_cursor_stalled");
    expect(() =>
      parseMessage(
        {
          schemaVersion: RECONCILER_SCHEMA,
          kind: "import",
          source: "sony-bank",
          terminalKey: `raw/sony-bank/2026/09/07/${RUN_ID}/manifest.json`,
          step: 1,
          progress: 8,
          resume: "not-an-offset",
        },
        ACCOUNT,
      ),
    ).toThrow("reconciler_message_invalid");
  });

  test("weekly repair seeds cover every configured source exactly once", () => {
    const seeds = weeklyRepairSeeds();
    expect(seeds).toHaveLength(Object.keys(RECONCILER_SOURCES).length);
    expect(new Set(seeds.map((seed) => seed.source)).size).toBe(seeds.length);
    expect(seeds.every((seed) => seed.cursor === null && seed.page === 0)).toBeTrue();
  });
});

function r2Notification(bucket: string, key: string) {
  return {
    account: ACCOUNT,
    action: "PutObject",
    bucket,
    object: { key, size: 123, eTag: "abc123" },
    eventTime: "2026-09-07T12:34:56.789Z",
  };
}

function fakeDependencies(options: {
  sent?: InternalMessage[][];
  outcome?: Awaited<ReturnType<ReconcilerDependencies["importTerminal"]>>;
  listed?: Awaited<ReturnType<ReconcilerDependencies["list"]>>;
}): ReconcilerDependencies {
  return {
    accountId: ACCOUNT,
    importTerminal: async () => options.outcome ?? { status: "sealed" },
    list: async () => options.listed ?? { keys: [], truncated: false, cursor: null },
    send: async (messages) => {
      options.sent?.push(messages);
    },
  };
}
