// Key layout of the shared DATA bucket (unified plan 03 §1).
//
//   objects/<first two hex>/<sha256>     content-addressed bytes that are safe to keep
//   runs/<source>/<runId>/terminal.json  the record that a run finished persisting
//   reports/<reportRef>/<path>           persisted outputs
//   projection-inputs/<digest>/<path>    frozen inputs for a repeatable projection
//
// Every builder validates its inputs: a key is derived, never interpolated
// from caller text. Traversal (`.`, `..`, `//`), backslashes, control
// characters, upper-case hex and out-of-charset source or run identifiers are
// rejected rather than normalized, because a normalized key would silently
// address a different object than the caller named.

export class CollectionKeyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CollectionKeyError";
  }
}

export const OBJECT_PREFIX = "objects/";
export const RUN_PREFIX = "runs/";
export const REPORT_PREFIX = "reports/";
export const PROJECTION_INPUT_PREFIX = "projection-inputs/";
export const TERMINAL_OBJECT_NAME = "terminal.json";

/** Lower-case hex only: R2 keys are case sensitive, so `AB…` is a second object. */
export const SHA256_HEX = /^[0-9a-f]{64}$/u;
/** Same charset as the ingest contract's source ids (`packages/evidence-contract`). */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/u;
/** Collector run ids are timestamps or opaque ids; case is preserved, separators are not free text. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
/** Digest-like refs used as a directory: hex or a lower-case opaque id. */
export const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function assertSha256Hex(value: unknown): string {
  if (!isSha256Hex(value)) throw new CollectionKeyError("invalid_sha256");
  return value;
}

export function assertSource(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    throw new CollectionKeyError("invalid_source");
  }
  return value;
}

export function assertRunId(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID.test(value) || value === "." || value === "..") {
    throw new CollectionKeyError("invalid_run_id");
  }
  return value;
}

export function assertRef(value: unknown, code: string): string {
  if (typeof value !== "string" || !REF_ID.test(value) || value === "." || value === "..") {
    throw new CollectionKeyError(code);
  }
  return value;
}

/**
 * A relative path below a prefix: one or more safe segments, no traversal, no
 * absolute form, no empty segment, at most 512 characters.
 */
export function assertRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new CollectionKeyError("invalid_path");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !PATH_SEGMENT.test(segment)) {
      throw new CollectionKeyError("invalid_path");
    }
  }
  return value;
}

/** `objects/<first two hex>/<sha256>` — the only place object keys are formed. */
export function objectKey(sha256: string): string {
  const digest = assertSha256Hex(sha256);
  return `${OBJECT_PREFIX}${digest.slice(0, 2)}/${digest}`;
}

/** `runs/<source>/<runId>/terminal.json`. */
export function terminalKey(source: string, runId: string): string {
  return `${runPrefix(source, runId)}${TERMINAL_OBJECT_NAME}`;
}

/** `runs/`, `runs/<source>/` or `runs/<source>/<runId>/`, for bounded scans. */
export function runPrefix(source?: string, runId?: string): string {
  if (source === undefined) return RUN_PREFIX;
  const prefix = `${RUN_PREFIX}${assertSource(source)}/`;
  return runId === undefined ? prefix : `${prefix}${assertRunId(runId)}/`;
}

/** `reports/<reportRef>/<path>`. */
export function reportKey(reportRef: string, path: string): string {
  return `${REPORT_PREFIX}${assertRef(reportRef, "invalid_report_ref")}/${assertRelativePath(path)}`;
}

/** `projection-inputs/<digest>/<path>`. */
export function projectionInputKey(digest: string, path: string): string {
  return `${PROJECTION_INPUT_PREFIX}${assertSha256Hex(digest)}/${assertRelativePath(path)}`;
}

export interface TerminalKeyParts {
  readonly source: string;
  readonly runId: string;
}

/**
 * Inverse of {@link terminalKey}. Returns null for anything that is not a
 * terminal key in the exact layout above, so a listing can skip unrelated
 * objects without throwing.
 */
export function parseTerminalKey(key: string): TerminalKeyParts | null {
  if (!key.startsWith(RUN_PREFIX) || !key.endsWith(`/${TERMINAL_OBJECT_NAME}`)) return null;
  const middle = key.slice(RUN_PREFIX.length, key.length - TERMINAL_OBJECT_NAME.length - 1);
  const parts = middle.split("/");
  if (parts.length !== 2) return null;
  const [source, runId] = parts as [string, string];
  if (!SOURCE_ID.test(source) || !RUN_ID.test(runId)) return null;
  if (terminalKey(source, runId) !== key) return null;
  return { source, runId };
}

/** True when the key addresses the content-addressed object of that digest. */
export function isObjectKeyFor(key: string, sha256: string): boolean {
  return isSha256Hex(sha256) && key === objectKey(sha256);
}
