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
const TERMINALS = Object.entries(RECONCILER_SOURCES).flatMap(([source, spec]) => {
  const keys =
    source === "vpass"
      ? ["manifest.json", "error.json"].map(
          (name) => `vpass/2026/09/07/2026-09-07T12-34-56-789Z/card-001/${name}`,
        )
      : source === "v-point-pay-email"
        ? [`${spec.prefix}2026/09/07/${"a".repeat(64)}.json`]
        : [`${spec.prefix}2026/09/07/${RUN_ID}/manifest.json`];
  return keys.map((key) => ({ source, bucket: spec.bucket, key }));
});

describe("R2 outbox reconciler", () => {
  test("all 13 terminal rules accept every official create action and reject neighboring objects", () => {
    expect(TERMINALS).toHaveLength(13);
    expect(new Set(TERMINALS.map(({ source }) => source)).size).toBe(12);
    for (const { source, bucket, key } of TERMINALS) {
      for (const action of ["PutObject", "CopyObject", "CompleteMultipartUpload"]) {
        const notification = {
          ...r2Notification(bucket, key),
          action,
          ...(action === "CopyObject"
            ? { copySource: { bucket, object: "synthetic-original" } }
            : {}),
        };
        expect(parseMessage(notification, ACCOUNT)).toMatchObject({ source, terminalKey: key });
        for (const invalid of [
          { ...notification, bucket: "unknown-bucket" },
          {
            ...notification,
            bucket: TERMINALS.find((candidate) => candidate.bucket !== bucket)!.bucket,
          },
          { ...notification, object: { ...notification.object, key: `other/${key}` } },
          { ...notification, object: { ...notification.object, key: `${key}.extra` } },
          {
            ...notification,
            object: { ...notification.object, key: key.replace(/[^/]+$/u, "payload.bin") },
          },
          { ...notification, object: { ...notification.object, key: "x".repeat(501) } },
        ])
          expect(() => parseMessage(invalid, ACCOUNT)).toThrow();
      }
      for (const action of [["PutObject"], ["CopyObject"], {}, 1, null, "DeleteObject"]) {
        expect(() => parseMessage({ ...r2Notification(bucket, key), action }, ACCOUNT)).toThrow();
      }
    }
  });

  test("rejects oversized internal fields before performing any IO", async () => {
    const dependencies = fakeDependencies({});
    dependencies.importTerminal = async () => {
      throw new Error("unexpected_import");
    };
    dependencies.list = async () => {
      throw new Error("unexpected_list");
    };
    const repair = {
      schemaVersion: RECONCILER_SCHEMA,
      kind: "repair",
      source: "sbi-vc-trade",
      cursor: "c".repeat(12_001),
      page: 1,
    };
    const transfer = {
      schemaVersion: RECONCILER_SCHEMA,
      kind: "import",
      source: "sbi-vc-trade",
      terminalKey: MANIFEST,
      step: 1,
      progress: 8,
      resume: "r".repeat(16_001),
    };
    for (const body of [
      repair,
      transfer,
      { ...transfer, terminalKey: "k".repeat(501) },
      { ...transfer, extra: "x".repeat(128_000) },
    ]) {
      await expect(processReconcilerMessage(body, dependencies)).rejects.toThrow(
        "reconciler_message_invalid",
      );
    }
  });

  test("a full repair page stays within Queue count and serialized byte limits", async () => {
    for (const { source, key } of TERMINALS) {
      const sent: InternalMessage[][] = [];
      await processReconcilerMessage(
        { schemaVersion: RECONCILER_SCHEMA, kind: "repair", source, cursor: null, page: 0 },
        fakeDependencies({
          sent,
          listed: {
            keys: Array.from({ length: 50 }, () => key),
            truncated: true,
            cursor: "c".repeat(12_000),
          },
        }),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveLength(51);
      expect(sent[0]!.length).toBeLessThanOrEqual(100);
      const sizes = sent[0]!.map(
        (body) => new TextEncoder().encode(JSON.stringify(body)).byteLength + 100,
      );
      expect(Math.max(...sizes)).toBeLessThan(128_000);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(256_000);
      for (const body of sent[0]!) expect(() => parseMessage(body, ACCOUNT)).not.toThrow();
    }
  });

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
