// The importer's reconcile logic, now owned by the Processor (U08).
//
// Two things are proved here.
//
//   * The moved modules are the ones the importer runs: the message schema,
//     the source table and the bounded repair walk behave as before, and the
//     importer's own tests still exercise them through its re-export shims.
//   * The legacy layouts the collection adapters describe agree with the
//     reconciler's source table, and the sources that have no adapter are
//     named rather than guessed.
//
// This is the path a late notification takes after the old Workers stop
// (G5-18): the Processor can still recognise a legacy terminal key and say
// which bucket it belongs to, so unprocessed work is recoverable instead of
// dropped. Synthetic keys only.
import { expect, test } from "bun:test";
import {
  COVERED_LEGACY_SOURCES,
  matchLegacyTerminalKey,
  parseMessage,
  processReconcilerMessage,
  RECONCILER_SCHEMA,
  RECONCILER_SOURCES,
  uncoveredLegacySources,
  weeklyRepairSeeds,
  type ImportOutcome,
  type InternalMessage,
} from "../src/legacy-import/index.ts";
import { LEGACY_ADAPTERS } from "../../../packages/collection/src/adapters.ts";

const ACCOUNT = "59ea63cc00914b30ca410b062ae2bb7f";
const VPASS_RUN = "2026-09-01T00-00-00-000Z";
const VPASS_TERMINAL = `vpass/2026/09/01/${VPASS_RUN}/card-001/manifest.json`;

test("the moved reconciler still parses the schema the importer sends", () => {
  expect(
    parseMessage(
      {
        schemaVersion: RECONCILER_SCHEMA,
        kind: "import",
        source: "vpass",
        terminalKey: VPASS_TERMINAL,
        step: 0,
        progress: 0,
        resume: null,
      },
      ACCOUNT,
    ),
  ).toMatchObject({ kind: "import", source: "vpass", terminalKey: VPASS_TERMINAL });

  // An R2 notification for a legacy bucket is still recognised by bucket name.
  expect(
    parseMessage(
      {
        account: ACCOUNT,
        action: "PutObject",
        bucket: "kogane-vpass-collector-poc",
        object: { key: VPASS_TERMINAL, size: 10, eTag: "e" },
        eventTime: "2026-09-01T00:00:00.000Z",
      },
      ACCOUNT,
    ),
  ).toEqual({ kind: "r2-notification", source: "vpass", terminalKey: VPASS_TERMINAL });

  // Another account's message is refused exactly as before.
  expect(() =>
    parseMessage(
      {
        account: "f".repeat(32),
        action: "PutObject",
        bucket: "kogane-vpass-collector-poc",
        object: { key: VPASS_TERMINAL, size: 10, eTag: "e" },
        eventTime: "2026-09-01T00:00:00.000Z",
      },
      ACCOUNT,
    ),
  ).toThrow("reconciler_notification_invalid");
});

test("the bounded repair walk pages the whole prefix and seeds every source", async () => {
  const sent: InternalMessage[][] = [];
  const listed = [
    { keys: [VPASS_TERMINAL, "vpass/2026/09/01/not-a-run/x.json"], truncated: true, cursor: "c1" },
    { keys: [], truncated: false, cursor: null },
  ];
  let page = 0;
  const dependencies = {
    accountId: ACCOUNT,
    importTerminal: (): Promise<ImportOutcome> => Promise.resolve({ status: "sealed" as const }),
    list: () => Promise.resolve(listed[page++]!),
    send: (messages: InternalMessage[]) => {
      sent.push(messages);
      return Promise.resolve();
    },
  };
  const first = await processReconcilerMessage(
    { schemaVersion: RECONCILER_SCHEMA, kind: "repair", source: "vpass", cursor: null, page: 0 },
    dependencies,
  );
  expect(first).toEqual({ kind: "repair", source: "vpass", outcome: "continued" });
  // One import per terminal key, plus the next page of the walk. The key that
  // is not a terminal of this layout is skipped, not imported.
  expect(sent[0]?.map((message) => message.kind)).toEqual(["import", "repair"]);

  const second = await processReconcilerMessage(
    { schemaVersion: RECONCILER_SCHEMA, kind: "repair", source: "vpass", cursor: "c1", page: 1 },
    dependencies,
  );
  expect(second).toEqual({ kind: "repair", source: "vpass", outcome: "complete" });

  // The weekly seed covers every source the reconciler knows, so no bucket is
  // left out of the repair walk.
  expect(
    weeklyRepairSeeds()
      .map((seed) => String(seed.source))
      .sort(),
  ).toEqual(Object.keys(RECONCILER_SOURCES).sort());
});

test("a legacy terminal key is recognised by both descriptions of its bucket", () => {
  const matched = matchLegacyTerminalKey(VPASS_TERMINAL);
  expect(matched).toMatchObject({
    bucket: RECONCILER_SOURCES.vpass.bucket,
    identity: { source: "vpass", runId: `${VPASS_RUN}-card-001`, unitKey: "card-001" },
  });
  // The adapter names the bucket it was written for, and it is the bucket the
  // reconciler lists: one layout, described once.
  expect(matched?.adapter.legacyBucketName).toBe(RECONCILER_SOURCES.vpass.bucket);
  // A key that does not belong to any legacy layout matches nothing.
  expect(matchLegacyTerminalKey("vpass/2026/09/01/not-a-run/manifest.json")).toBeNull();
  expect(matchLegacyTerminalKey("runs/kogane-synthetic/run-001/terminal.json")).toBeNull();
});

test("the collection adapters cover vpass, and the rest are named rather than guessed", () => {
  expect(COVERED_LEGACY_SOURCES).toEqual(["vpass"]);
  expect(LEGACY_ADAPTERS.map((adapter) => adapter.sourceId)).toEqual(["vpass"]);
  // Every source the importer reconciles is either covered or listed as not
  // covered; nothing falls between the two.
  expect([...COVERED_LEGACY_SOURCES, ...uncoveredLegacySources()].map(String).sort()).toEqual(
    Object.keys(RECONCILER_SOURCES).sort(),
  );
  expect(uncoveredLegacySources()).toContain("moneyforward");
  // Each adapter's terminal suffixes are the ones the reconciler's pattern
  // accepts, so a re-persist reads the same objects the importer imports.
  for (const adapter of LEGACY_ADAPTERS) {
    const spec = RECONCILER_SOURCES[adapter.sourceId as keyof typeof RECONCILER_SOURCES];
    expect(spec).toBeDefined();
    for (const suffix of adapter.terminalSuffixes) {
      expect(spec.terminal.test(`${spec.prefix}2026/09/01/${VPASS_RUN}/card-001/${suffix}`)).toBe(
        true,
      );
    }
  }
});
