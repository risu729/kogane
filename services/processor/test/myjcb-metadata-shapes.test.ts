// ADR 0025: the MyJCB metadata extractor reads both collector manifest shapes.
//
// The importer shape (entries carrying `connectionId` and `filename`) is
// compared with the extractor frozen before the change over generated
// manifests: every input it completed returns the same extraction, every
// error it raised is raised again, and the only inputs whose result changes
// are ones it refused `manifest_artifact_mismatch` and whose entries carry
// neither field - the shared shape. The shared shape is then checked case by
// case. Every value here is synthetic.
import { expect, test } from "bun:test";
import { objectKey } from "../../../packages/collection/src/keys.ts";
import { extractMyJcb } from "../src/metadata-extractors/myjcb.ts";
import type {
  ExtractorContext,
  MetadataArtifact,
  MetadataExtraction,
} from "../src/metadata-extractors/types.ts";
import { frozenExtractMyJcb } from "./myjcb-metadata-frozen.ts";

const MANIFEST_SHA = "f".repeat(64);
const SUBJECT_SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const SUBJECT_BYTES = 120;

/** A context whose CORE answers the two reads an extractor makes: the run's
 * manifest artifact and the subject's raw object size. */
function context(manifest: unknown, sizes: Record<string, number> = {}): ExtractorContext {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first(column?: string) {
              if (sql.includes("artifact_role='collector_manifest'"))
                return {
                  id: 9,
                  blob_key: "manifest",
                  byte_size: bytes.byteLength,
                  sha256: MANIFEST_SHA,
                };
              if (sql.includes("FROM raw_objects")) {
                const size = sizes[String(args[0])] ?? null;
                return column === undefined ? { byte_size: size } : size;
              }
              throw new Error(`unexpected query: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, read: async () => bytes };
}

function artifact(
  artifactKey: string,
  dataset: string | null,
  sha256 = SUBJECT_SHA,
): MetadataArtifact {
  return {
    id: 1,
    fetch_run_id: 1,
    source_id: "myjcb",
    dataset,
    artifact_key: artifactKey,
    mime: "application/json",
    sha256,
  };
}

type Outcome = { ok: MetadataExtraction } | { error: string };
async function outcome(run: () => Promise<MetadataExtraction>): Promise<Outcome> {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// The importer shape is unchanged
// ---------------------------------------------------------------------------

/** A small deterministic generator, so a failure names a reproducible case. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  return { next, pick };
}

const CONNECTIONS = ["conn-a", "conn-b", undefined, 7] as const;
const FILENAMES = ["credit-ledger-00.json", "credit-detail-01.html", undefined, null] as const;
const DATASETS = ["credit-ledger", "credit-detail", "discovery", undefined] as const;
const STATES = ["confirmed", "unconfirmed", "unknown", undefined, 3, null] as const;
const PERIODS = ["2026-10", "detailMonth-0", undefined, 202610, null] as const;

function generatedEntry(random: ReturnType<typeof generator>, row: MetadataArtifact): unknown {
  if (random.next() < 0.03) return random.pick([null, "entry", [1]]);
  const entry: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => {
    if (value !== undefined) entry[name] = value;
  };
  // Half the entries name the subject, so the completed class is common.
  const [connection, filename] = row.artifact_key.split("/");
  const names = random.next() < 0.5;
  set("connectionId", names ? connection : random.pick(CONNECTIONS));
  set("filename", names ? filename : random.pick(FILENAMES));
  set("dataset", random.next() < 0.6 ? (row.dataset ?? undefined) : random.pick(DATASETS));
  set("statementState", random.pick(STATES));
  set("period", random.pick(PERIODS));
  if (random.next() < 0.5) {
    set("sha256", random.pick([SUBJECT_SHA, OTHER_SHA]));
    set("bytes", random.pick([SUBJECT_BYTES, 1]));
    set("key", random.pick([objectKey(SUBJECT_SHA), "raw/myjcb/synthetic"]));
  }
  return entry;
}

test("the importer-shape branch returns what the frozen extractor returned, for every generated input", async () => {
  const random = generator(20260926);
  const tally = { completed: 0, sameError: 0, sharedOnly: 0 };
  for (let index = 0; index < 4000; index++) {
    const row = artifact(
      `${random.pick(["conn-a", "conn-b", "7", "undefined"])}/${random.pick(["credit-ledger-00.json", "credit-detail-01.html", "undefined"])}`,
      random.pick(["credit-ledger", "credit-detail", null]),
    );
    const entries = Array.from({ length: Math.floor(random.next() * 4) }, () =>
      generatedEntry(random, row),
    );
    const manifest = {
      artifacts: entries,
      connections: [{ connectionId: "conn-a" }, { connectionId: "conn-b" }],
    };
    const ctx = context(manifest, { [SUBJECT_SHA]: SUBJECT_BYTES });
    const before = await outcome(() => frozenExtractMyJcb(ctx, row));
    const after = await outcome(() => extractMyJcb(ctx, row));
    if ("ok" in before) {
      expect(after).toEqual(before);
      tally.completed++;
      continue;
    }
    const shared =
      before.error === "manifest_artifact_mismatch" &&
      entries.length > 0 &&
      entries.every(
        (entry) =>
          (entry as Record<string, unknown>).connectionId === undefined &&
          (entry as Record<string, unknown>).filename === undefined,
      );
    if (shared) {
      tally.sharedOnly++;
      continue;
    }
    expect(after).toEqual(before);
    tally.sameError++;
  }
  // Each class is exercised, not merely allowed.
  expect(tally.completed).toBeGreaterThan(100);
  expect(tally.sameError).toBeGreaterThan(100);
  expect(tally.sharedOnly).toBeGreaterThan(20);
});

test("an importer-era entry is found by its connection and file name, as before", async () => {
  const manifest = {
    artifacts: [
      {
        connectionId: "conn-a",
        filename: "credit-ledger-01.json",
        dataset: "credit-ledger",
        statementState: "confirmed",
        period: "2026-10",
      },
    ],
  };
  const extraction = await extractMyJcb(
    context(manifest),
    artifact("conn-a/credit-ledger-01.json", "credit-ledger"),
  );
  expect(extraction).toEqual({
    status: "ok",
    output: { mime: null, period: "2026-10", statementState: "confirmed" },
    inputs: [{ artifactId: 9, role: "collector_manifest", rawSha256: MANIFEST_SHA }],
    inputDigest: "",
    manifestArtifactId: 9,
  });
});

// ---------------------------------------------------------------------------
// The shared shape
// ---------------------------------------------------------------------------

/** One entry as `myJcbRunPlan` writes it: no connection, no file name. */
function sharedEntry(
  sha256: string,
  bytes: number,
  dataset: string,
  statement: { statementState?: string; period?: string } = {},
) {
  return {
    dataset,
    key: objectKey(sha256),
    mediaType: "application/json",
    sha256,
    bytes,
    ...statement,
  };
}
function sharedManifest(...artifacts: unknown[]) {
  return {
    schemaVersion: "synthetic",
    source: "myjcb",
    connections: [{ connectionId: "conn-a" }, { connectionId: "conn-b" }],
    artifacts,
    failures: [],
  };
}
const SIZES = { [SUBJECT_SHA]: SUBJECT_BYTES, [OTHER_SHA]: 2 };

test("a shared entry is found by the artifact's object and gives its state and period", async () => {
  const manifest = sharedManifest(
    sharedEntry(OTHER_SHA, 2, "credit-ledger", { statementState: "unconfirmed", period: "x" }),
    sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", {
      statementState: "confirmed",
      period: "2026-10",
    }),
  );
  const extraction = await extractMyJcb(
    context(manifest, SIZES),
    artifact("conn-b/credit-ledger-01.json", "credit-ledger"),
  );
  expect(extraction.status).toBe("ok");
  expect(extraction.output).toEqual({ mime: null, period: "2026-10", statementState: "confirmed" });
  expect(extraction.manifestArtifactId).toBe(9);
});

test("a shared entry without statement metadata is a completed, absent extraction", async () => {
  const manifest = sharedManifest(sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "discovery"));
  const extraction = await extractMyJcb(
    context(manifest, SIZES),
    artifact("conn-a/discovery.json", "discovery"),
  );
  expect(extraction.status).toBe("absent");
  expect(extraction.output).toEqual({ mime: null, period: null, statementState: null });
});

test("the same bytes stated twice are used only when both entries agree", async () => {
  const agreeing = sharedManifest(
    sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", {
      statementState: "unconfirmed",
      period: "detailMonth-0",
    }),
    sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", {
      statementState: "unconfirmed",
      period: "detailMonth-0",
    }),
  );
  expect(
    (
      await extractMyJcb(
        context(agreeing, SIZES),
        artifact("conn-a/credit-ledger-00.json", "credit-ledger"),
      )
    ).output,
  ).toEqual({ mime: null, period: "detailMonth-0", statementState: "unconfirmed" });
  const disagreeing = sharedManifest(
    sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", { statementState: "unconfirmed" }),
    sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", { statementState: "confirmed" }),
  );
  expect(
    await outcome(() =>
      extractMyJcb(
        context(disagreeing, SIZES),
        artifact("conn-a/credit-ledger-00.json", "credit-ledger"),
      ),
    ),
  ).toEqual({ error: "manifest_artifact_ambiguous" });
});

test("nothing is taken from an entry that does not name the artifact's object and connection", async () => {
  const ledger = { statementState: "confirmed", period: "2026-10" };
  const refused = async (manifest: unknown, row: MetadataArtifact) =>
    outcome(() => extractMyJcb(context(manifest, SIZES), row));
  const row = artifact("conn-a/credit-ledger-01.json", "credit-ledger");
  // Another object only.
  expect(
    await refused(sharedManifest(sharedEntry(OTHER_SHA, 2, "credit-ledger", ledger)), row),
  ).toEqual({ error: "manifest_artifact_mismatch" });
  // The digest, but another size.
  expect(
    await refused(sharedManifest(sharedEntry(SUBJECT_SHA, 1, "credit-ledger", ledger)), row),
  ).toEqual({ error: "manifest_artifact_mismatch" });
  // The digest, but not its content-addressed key.
  expect(
    await refused(
      sharedManifest({
        ...sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", ledger),
        key: "raw/x",
      }),
      row,
    ),
  ).toEqual({ error: "manifest_artifact_mismatch" });
  // A connection the manifest does not list.
  expect(
    await refused(
      sharedManifest(sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", ledger)),
      artifact("conn-z/credit-ledger-01.json", "credit-ledger"),
    ),
  ).toEqual({ error: "manifest_artifact_mismatch" });
  // The object under another dataset.
  expect(
    await refused(
      sharedManifest(sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-detail", ledger)),
      row,
    ),
  ).toEqual({ error: "manifest_dataset_mismatch" });
  // A value of the wrong type is refused as the importer branch refuses it.
  expect(
    await refused(
      sharedManifest(
        sharedEntry(SUBJECT_SHA, SUBJECT_BYTES, "credit-ledger", {
          period: 202610 as unknown as string,
        }),
      ),
      row,
    ),
  ).toEqual({ error: "manifest_period_invalid" });
});
