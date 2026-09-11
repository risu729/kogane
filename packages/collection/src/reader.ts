// The read half: find terminals, read one, and re-check the objects it names.
//
// The scan is a bounded walk of the whole `runs/` prefix with an R2 cursor,
// never a timestamp window and never a lexicographic watermark (plan 03 §6).
// A run whose terminal is confirmed late sorts wherever its run id puts it, so
// "everything after the newest key I saw" silently drops it.
//
// A terminal that cannot be read is reported as `blocked` for that run and
// does not end the page: one broken run must not stop every later run
// (acceptance G1-13).
import { type R2BucketLike, type R2ObjectLike } from "./bucket";
import { sha256Hex, terminalDigest } from "./digest";
import { parseTerminalKey, runPrefix, terminalKey } from "./keys";
import { tryParseTerminalManifest, type TerminalManifest } from "./manifest";
import { verifyStoredObject, type ObjectProblemCode } from "./verify";

export const DEFAULT_TERMINAL_PAGE_LIMIT = 100;
const MAX_TERMINAL_PAGE_LIMIT = 1_000;
const MAX_TERMINAL_BYTES = 8 * 1024 * 1024;

export interface TerminalRef {
  readonly source: string;
  readonly runId: string;
  readonly key: string;
  readonly byteSize: number;
  readonly uploadedAtMs: number | null;
}

export interface ListTerminalsOptions {
  readonly source?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListTerminalsResult {
  readonly terminals: readonly TerminalRef[];
  readonly truncated: boolean;
  readonly cursor: string | null;
  /** Objects under `runs/` that are not terminals; listed so a scan can account for them. */
  readonly skipped: number;
}

function terminalRef(object: R2ObjectLike): TerminalRef | null {
  const parts = parseTerminalKey(object.key);
  if (!parts) return null;
  return {
    source: parts.source,
    runId: parts.runId,
    key: object.key,
    byteSize: object.size,
    uploadedAtMs: object.uploaded ? object.uploaded.valueOf() : null,
  };
}

/**
 * One bounded page of the terminal scan. Pass the returned cursor back to
 * continue; a finished walk returns `truncated: false` and the next walk
 * starts from the beginning of the prefix again.
 */
export async function listTerminals(
  bucket: R2BucketLike,
  options: ListTerminalsOptions = {},
): Promise<ListTerminalsResult> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_TERMINAL_PAGE_LIMIT, 1),
    MAX_TERMINAL_PAGE_LIMIT,
  );
  const listed = await bucket.list({
    prefix: runPrefix(options.source),
    limit,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  const terminals: TerminalRef[] = [];
  let skipped = 0;
  for (const object of listed.objects) {
    const ref = terminalRef(object);
    if (ref) terminals.push(ref);
    else skipped += 1;
  }
  return {
    terminals,
    truncated: listed.truncated,
    cursor: listed.truncated ? (listed.cursor ?? null) : null,
    skipped,
  };
}

export type ReadTerminalResult =
  | {
      readonly outcome: "found";
      readonly key: string;
      readonly manifest: TerminalManifest;
      readonly terminalDigest: string;
      readonly byteSize: number;
    }
  | { readonly outcome: "missing"; readonly key: string }
  | { readonly outcome: "blocked"; readonly key: string; readonly reasonCode: string };

/** Read and validate the terminal at an exact key. */
export async function readTerminalAt(
  bucket: R2BucketLike,
  key: string,
): Promise<ReadTerminalResult> {
  const body = await bucket.get(key);
  if (!body) return { outcome: "missing", key };
  if (body.size > MAX_TERMINAL_BYTES) {
    return { outcome: "blocked", key, reasonCode: "terminal_too_large" };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await body.arrayBuffer());
  } catch {
    return { outcome: "blocked", key, reasonCode: "terminal_unreadable" };
  }
  const storedDigest = await sha256Hex(bytes);
  const declared = body.customMetadata?.terminalDigest;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { outcome: "blocked", key, reasonCode: "terminal_not_json" };
  }
  const parsed = tryParseTerminalManifest(value);
  if (!parsed.ok) return { outcome: "blocked", key, reasonCode: parsed.code };
  const parts = parseTerminalKey(key);
  if (
    !parts ||
    parts.source !== parsed.manifest.source ||
    parts.runId !== parsed.manifest.runId ||
    terminalKey(parsed.manifest.source, parsed.manifest.runId) !== key
  ) {
    return { outcome: "blocked", key, reasonCode: "terminal_identity_mismatch" };
  }
  const digest = await terminalDigest(parsed.manifest);
  // The stored bytes are the canonical encoding, so a mismatch means the
  // object was rewritten with something else under the same run identity.
  if (declared !== undefined && declared !== digest) {
    return { outcome: "blocked", key, reasonCode: "terminal_digest_metadata_mismatch" };
  }
  if (storedDigest !== digest) {
    return { outcome: "blocked", key, reasonCode: "terminal_not_canonical" };
  }
  return {
    outcome: "found",
    key,
    manifest: parsed.manifest,
    terminalDigest: digest,
    byteSize: body.size,
  };
}

/** Read the terminal of one run. */
export function readTerminal(
  bucket: R2BucketLike,
  source: string,
  runId: string,
): Promise<ReadTerminalResult> {
  return readTerminalAt(bucket, terminalKey(source, runId));
}

export interface TerminalPageEntry {
  readonly ref: TerminalRef;
  readonly result: ReadTerminalResult;
}

export interface ReadTerminalPageResult extends ListTerminalsResult {
  readonly entries: readonly TerminalPageEntry[];
  readonly blocked: readonly TerminalRef[];
}

/**
 * List a page and read each terminal on it. A blocked terminal is reported and
 * the rest of the page is still returned, so one corrupt run cannot stop the
 * reconciliation scan.
 */
export async function readTerminalPage(
  bucket: R2BucketLike,
  options: ListTerminalsOptions = {},
): Promise<ReadTerminalPageResult> {
  const page = await listTerminals(bucket, options);
  const entries: TerminalPageEntry[] = [];
  const blocked: TerminalRef[] = [];
  for (const ref of page.terminals) {
    const result = await readTerminalAt(bucket, ref.key);
    entries.push({ ref, result });
    if (result.outcome === "blocked") blocked.push(ref);
  }
  return { ...page, entries, blocked };
}

export interface ObjectProblem {
  readonly artifactKey: string;
  readonly key: string;
  readonly reasonCode: ObjectProblemCode;
  readonly expectedSha256: string;
  readonly expectedByteSize: number;
  readonly observedByteSize: number | null;
}

export interface VerifyReferencedObjectsResult {
  readonly outcome: "ok" | "blocked";
  readonly checked: number;
  readonly problems: readonly ObjectProblem[];
}

export interface VerifyReferencedObjectsOptions {
  /**
   * Read and hash the body when R2 metadata cannot prove the digest (for
   * example a multipart object written without custom metadata). Off by
   * default because it costs a full read of every artifact.
   */
  readonly streamHash?: boolean;
  /** Stop after this many problems; the scan still reports `blocked`. */
  readonly maxProblems?: number;
}

/**
 * Re-check every object a terminal names: it exists, its size matches, and its
 * digest matches. This is what lets the Processor register the same bytes the
 * collector stored without copying them (plan 03 §4).
 */
export async function verifyReferencedObjects(
  bucket: R2BucketLike,
  manifest: TerminalManifest,
  options: VerifyReferencedObjectsOptions = {},
): Promise<VerifyReferencedObjectsResult> {
  const maxProblems = options.maxProblems ?? 100;
  const problems: ObjectProblem[] = [];
  let checked = 0;
  for (const artifact of manifest.artifacts) {
    if (problems.length >= maxProblems) break;
    const key = artifact.storageRef.key;
    const expected = { sha256: artifact.sha256, byteSize: artifact.byteSize };
    const head = await bucket.head(key);
    let problem = verifyStoredObject(head, expected);
    if (problem === "object_digest_unverifiable" && options.streamHash) {
      const body = await bucket.get(key);
      if (!body) problem = "object_missing";
      else {
        const bytes = new Uint8Array(await body.arrayBuffer());
        problem =
          bytes.byteLength !== artifact.byteSize
            ? "object_size_mismatch"
            : (await sha256Hex(bytes)) === artifact.sha256
              ? null
              : "object_hash_mismatch";
      }
    }
    checked += 1;
    if (problem !== null) {
      problems.push({
        artifactKey: artifact.artifactKey,
        key,
        reasonCode: problem,
        expectedSha256: artifact.sha256,
        expectedByteSize: artifact.byteSize,
        observedByteSize: head ? head.size : null,
      });
    }
  }
  return { outcome: problems.length === 0 ? "ok" : "blocked", checked, problems };
}
