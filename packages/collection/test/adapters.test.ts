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
// What the caller hands over is the sanitizer's output, never the raw
// snapshot; the raw one would carry the session envelope the importer strips.
const SANITIZED_SNAPSHOT = JSON.stringify({
  format: "kogane-vpass-r2-snapshot/v1",
  runId: RUN,
  sanitized: true,
});
const SANITIZER = {
  transformerId: "vpass-importer-sanitizer",
  transformerVersion: "vpass-central-sanitized-v1",
};

async function legacyInput() {
  const identity = VPASS_LEGACY_ADAPTER.matchTerminalKey(CARD_KEY)!;
  const snapshot = bytesOf(SANITIZED_SNAPSHOT);
  return {
    identity,
    terminalKey: CARD_KEY,
    terminalBytes: bytesOf(LEGACY_MANIFEST),
    objects: [
      {
        legacyKey: `${identity.legacyPrefix}snapshot.json`,
        bytes: snapshot,
        sha256: await fakeSha256Hex(snapshot),
        role: "provider_response",
        sanitizer: SANITIZER,
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
    expect(manifest.artifacts.map((entry) => entry.artifactKey)).toEqual(["snapshot.json"]);
    expect(manifest.units).toEqual([
      { unitKey: "card-001", unitKind: "card", artifactCount: 1, coverageStatus: "partial" },
    ]);
    // The stored artifact is the sanitizer's output over the legacy object.
    expect(manifest.transformations).toEqual([
      {
        transformationId: "redacted:snapshot.json",
        stepKind: "redacted",
        transformerId: SANITIZER.transformerId,
        transformerVersion: SANITIZER.transformerVersion,
        inputArtifactKeys: [`vpass/2026/09/01/${RUN}/card-001/snapshot.json`],
        outputArtifactKey: "snapshot.json",
      },
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
      objects: [],
    });
    const manifest = planManifest(plan);
    expect(manifest.providerOutcome).toBe("failed");
    expect(manifest.coverageStatus).toBe("unknown");
    expect(manifest.safeErrorCode).toBe("collector_failed");
    // The error record's free-text `message` is provider text; it is read
    // for the outcome and not stored.
    expect(manifest.artifacts).toEqual([]);
    expect(manifest.units[0]?.artifactCount).toBe(0);
    expect(manifest.ranges).toEqual([]);
  });

  test("no legacy byte is stored verbatim; every artifact is a named sanitizer's output", async () => {
    const bucket = new FakeR2Bucket();
    const input = await legacyInput();
    const plan = VPASS_LEGACY_ADAPTER.toPersistPlan(input);
    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("persisted");
    const legacyDigest = await fakeSha256Hex(input.terminalBytes);
    const storedDigests = await Promise.all(
      [...bucket.entries.values()].map((entry) => fakeSha256Hex(entry.bytes)),
    );
    expect(storedDigests).not.toContain(legacyDigest);
    const manifest = planManifest(plan);
    const outputs = new Set(manifest.transformations.map((step) => step.outputArtifactKey));
    for (const artifact of manifest.artifacts) {
      expect(outputs.has(artifact.artifactKey)).toBe(true);
      const step = manifest.transformations.find(
        (entry) => entry.outputArtifactKey === artifact.artifactKey,
      );
      expect(step?.stepKind).toBe("redacted");
      expect(step?.inputArtifactKeys[0]?.startsWith(input.identity.legacyPrefix)).toBe(true);
    }
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
            role: "provider_response",
            sanitizer: SANITIZER,
          },
        ],
      }),
    ).toThrow(new LegacyAdapterError("vpass_object_outside_run"));
    expect(() =>
      VPASS_LEGACY_ADAPTER.toPersistPlan({ ...input, terminalBytes: bytesOf("{not json") }),
    ).toThrow(new LegacyAdapterError("vpass_terminal_json_invalid"));
  });
});
