import { describe, expect, test } from "bun:test";
import { LegacyAdapterError, matchLegacyTerminal, VPASS_LEGACY_ADAPTER } from "../src/adapters";
import { terminalKey } from "../src/keys";
import { readTerminal } from "../src/reader";
import { persistRun, planManifest } from "../src/writer";
import { bytesOf, FakeR2Bucket, fakeSha256Hex } from "./fake-bucket";

const RUN = "2026-09-01T00-00-00-000Z";
const CARD_KEY = `vpass/2026/09/01/${RUN}/card-001/manifest.json`;

// Synthetic bytes in the legacy shape; no real card, month or amount.
const LEGACY_MANIFEST = JSON.stringify({
  runId: RUN,
  startedAt: "2026-09-01T00:00:00.000Z",
  completedAt: "2026-09-01T00:02:00.000Z",
  cardCount: 2,
  selectedCardIndex: 1,
  monthCount: 2,
  pageCount: 2,
  transactionCount: 0,
  objectCount: 2,
  status: "success",
  months: { "202608": { pages: 1, transactions: 0 }, "202607": { pages: 1, transactions: 0 } },
});
const LEGACY_SNAPSHOT = JSON.stringify({ format: "kogane-vpass-r2-snapshot/v1", runId: RUN });

async function legacyInput(): ReturnType<typeof buildInput> {
  return buildInput();
}

async function buildInput() {
  const identity = VPASS_LEGACY_ADAPTER.matchTerminalKey(CARD_KEY)!;
  const terminalBytes = bytesOf(LEGACY_MANIFEST);
  const snapshot = bytesOf(LEGACY_SNAPSHOT);
  return {
    identity,
    terminalKey: CARD_KEY,
    terminalBytes,
    terminalSha256: await fakeSha256Hex(terminalBytes),
    objects: [
      {
        legacyKey: `${identity.legacyPrefix}snapshot.json`,
        bytes: snapshot,
        sha256: await fakeSha256Hex(snapshot),
      },
    ],
  };
}

describe("legacy layout adapters", () => {
  test("the Vpass key grammar identifies a run and rejects everything else", () => {
    expect(VPASS_LEGACY_ADAPTER.matchTerminalKey(CARD_KEY)).toEqual({
      source: "vpass",
      runId: `${RUN}-card-001`,
      legacyPrefix: `vpass/2026/09/01/${RUN}/card-001/`,
      acquisitionSessionRef: RUN,
      unitKey: "card-001",
    });
    expect(VPASS_LEGACY_ADAPTER.matchTerminalKey(`vpass/2026/09/01/${RUN}/error.json`)).toEqual({
      source: "vpass",
      runId: `${RUN}-run`,
      legacyPrefix: `vpass/2026/09/01/${RUN}/`,
      acquisitionSessionRef: RUN,
      unitKey: "run",
    });
    for (const key of [
      `vpass/2026/09/02/${RUN}/card-001/manifest.json`,
      `vpass/2026/09/01/${RUN}/card-001/snapshot.json`,
      `vpass/2026/09/01/${RUN}/card-1/manifest.json`,
      "../../manifest.json",
    ]) {
      expect(VPASS_LEGACY_ADAPTER.matchTerminalKey(key)).toBeNull();
    }
    expect(matchLegacyTerminal(CARD_KEY)?.adapter.sourceId).toBe("vpass");
    expect(matchLegacyTerminal("raw/sony-bank/2026/09/01/run/manifest.json")).toBeNull();
  });

  test("a legacy success run maps to a valid terminal-v1 plan", async () => {
    const input = await legacyInput();
    expect(VPASS_LEGACY_ADAPTER.requiredObjectKeys(input)).toEqual([
      `vpass/2026/09/01/${RUN}/card-001/snapshot.json`,
    ]);
    const plan = VPASS_LEGACY_ADAPTER.toPersistPlan(input);
    const manifest = planManifest(plan);

    expect(manifest.source).toBe("vpass");
    expect(manifest.runId).toBe(`${RUN}-card-001`);
    // The card is a run of its own; the session ref keeps the card runs of one
    // login linked without merging them.
    expect(manifest.acquisitionSessionRef).toBe(RUN);
    expect(manifest.providerOutcome).toBe("success");
    // A card exposes a rolling window of statement months, so a successful run
    // is not a claim about the whole history.
    expect(manifest.coverageStatus).toBe("partial");
    expect(manifest.artifacts.map((entry) => entry.artifactKey)).toEqual([
      "manifest.json",
      "snapshot.json",
    ]);
    expect(manifest.units).toEqual([
      { unitKey: "card-001", unitKind: "card", artifactCount: 2, coverageStatus: "partial" },
    ]);
    expect(manifest.ranges[0]).toEqual({
      rangeKey: "statement-months",
      rangeKind: "declared_coverage",
      precision: "month",
      basis: "manifest",
      startValue: "2026-07",
      endValue: "2026-08",
      unitKey: "card-001",
    });
  });

  test("a legacy error record becomes a failed run that stores what it had", async () => {
    const key = `vpass/2026/09/01/${RUN}/card-002/error.json`;
    const identity = VPASS_LEGACY_ADAPTER.matchTerminalKey(key)!;
    const bytes = bytesOf(
      JSON.stringify({
        runId: RUN,
        startedAt: "2026-09-01T00:00:00.000Z",
        failedAt: "2026-09-01T00:00:30.000Z",
        status: "error",
        message: "synthetic failure",
        selectedCardIndex: 2,
        objectCount: 1,
      }),
    );
    const plan = VPASS_LEGACY_ADAPTER.toPersistPlan({
      identity,
      terminalKey: key,
      terminalBytes: bytes,
      terminalSha256: await fakeSha256Hex(bytes),
      objects: [],
    });
    const manifest = planManifest(plan);
    expect(manifest.providerOutcome).toBe("failed");
    expect(manifest.coverageStatus).toBe("unknown");
    expect(manifest.safeErrorCode).toBe("collector_failed");
    expect(manifest.artifacts.map((entry) => entry.role)).toEqual(["collector_error"]);
    expect(manifest.ranges).toEqual([]);
  });

  test("the mapped plan persists through the shared writer", async () => {
    const bucket = new FakeR2Bucket();
    const plan = VPASS_LEGACY_ADAPTER.toPersistPlan(await legacyInput());
    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") throw new Error("unreachable");
    expect(result.terminalKey).toBe(terminalKey("vpass", `${RUN}-card-001`));
    expect(bucket.putKeys.at(-1)).toBe(result.terminalKey);
    const read = await readTerminal(bucket, "vpass", `${RUN}-card-001`);
    expect(read.outcome).toBe("found");
    // Re-running the mapping on the same legacy bytes is a resend, not a
    // second run: the derived identity and digest are deterministic.
    expect((await persistRun(bucket, plan)).outcome).toBe("already_persisted");
  });

  test("the mapping refuses bytes that do not belong to the run it names", async () => {
    const input = await legacyInput();
    expect(() =>
      VPASS_LEGACY_ADAPTER.toPersistPlan({
        ...input,
        objects: [
          {
            legacyKey: "vpass/elsewhere/snapshot.json",
            bytes: bytesOf("{}"),
            sha256: "0".repeat(64),
          },
        ],
      }),
    ).toThrow(new LegacyAdapterError("vpass_object_outside_run"));
    expect(() =>
      VPASS_LEGACY_ADAPTER.toPersistPlan({ ...input, terminalBytes: bytesOf("{not json") }),
    ).toThrow(new LegacyAdapterError("vpass_terminal_json_invalid"));
  });
});
