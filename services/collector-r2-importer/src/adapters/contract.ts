import { ImportError } from "../error";
import type { ReconcilerSource } from "../reconciler";

/**
 * Application-level import contract shared by the HTTP entry points and the
 * Queue reconciler. Wire formats (HTTP bodies, Queue message schema) are
 * unchanged; this module only names the validated internal shapes.
 */
export type ImportSource = ReconcilerSource;

/**
 * `immediate`: a synchronous caller that cannot resume by offset, so an
 * offset-resumed source may answer `deferred` before creating central state.
 * `staged`: the Queue reconciler or a backfill cursor will resume the run.
 */
export type ImportMode = "immediate" | "staged";

export interface ImportCommand {
  readonly source: ImportSource;
  /** The collector's terminal object key: manifest, Vpass record, or normalized pair. */
  readonly terminalKey: string;
  readonly mode: ImportMode;
}

export type ResumeState =
  | { readonly kind: "none" }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "offset"; readonly offset: number };

export type ResumeKind = ResumeState["kind"];

/** The common subset of every source module's import result. */
export interface ImportStepResult {
  /** Absent on the SBI Securities and SBI Shinsei results, which always seal. */
  readonly status?: "sealed" | "deferred";
  readonly sealed?: boolean;
  readonly nextOffset?: number;
  readonly continuation?: string;
}

export interface ImportHttpRoutes {
  readonly importRun: string;
  readonly backfillPage: { readonly path: string; readonly cursorBudget: number };
}

export interface RepairPolicy {
  /** The read-only collector outbox the repair scan lists and imports read from. */
  outbox(env: Env): R2Bucket;
}

export interface ImportAdapter<TResult extends ImportStepResult = ImportStepResult> {
  readonly id: ImportSource;
  /** The source ingest contract recorded as the terminal report `producerVersion`. */
  readonly contractVersion: string;
  readonly resumeKind: ResumeKind;
  readonly http: ImportHttpRoutes | null;
  /** HTTP request body to command: allowed keys and key budget stay source-specific. */
  validateCommand(input: unknown): ImportCommand;
  /** HTTP request body to resume state: continuation budget stays source-specific. */
  validateResume(input: unknown, command: ImportCommand): ResumeState;
  step(env: Env, command: ImportCommand, resume: ResumeState): Promise<TResult>;
  readonly repairPolicy: RepairPolicy;
}

export interface ImportExecution<TResult extends ImportStepResult = ImportStepResult> {
  readonly result: TResult;
  readonly status: "sealed" | "deferred";
}

type JsonObject = Record<string, unknown>;

export type TerminalKeyField = "manifestKey" | "recordKey" | "normalizedKey";

const TERMINAL_KEY_CODES: Record<TerminalKeyField, string> = {
  manifestKey: "manifest_key_invalid",
  recordKey: "record_key_invalid",
  normalizedKey: "normalized_key_invalid",
};

/**
 * Builds the HTTP command validator: exact allowed keys, then the terminal key
 * budget, in the same order the previous per-source route branches used.
 */
export function httpCommand(
  source: ImportSource,
  options: { key: TerminalKeyField; max: number; continuation: boolean },
): (input: unknown) => ImportCommand {
  const allowed = [options.key, ...(options.continuation ? ["continuation"] : [])];
  return (input) => {
    const body = jsonObject(input);
    exactKeys(body, allowed);
    return {
      source,
      terminalKey: requiredString(body[options.key], TERMINAL_KEY_CODES[options.key], options.max),
      mode: "immediate",
    };
  };
}

export function httpTokenResume(max: number): (input: unknown) => ResumeState {
  return (input) => {
    const body = jsonObject(input);
    if (body.continuation === undefined) return { kind: "none" };
    return { kind: "token", token: requiredString(body.continuation, "continuation_invalid", max) };
  };
}

export function httpNoResume(): ResumeState {
  return { kind: "none" };
}

/** Queue wire value to resume state; mirrors the reconciler's resume-kind rules. */
export function resumeFromWire(kind: ResumeKind, value: string | number | null): ResumeState {
  if (value === null) return { kind: "none" };
  if (kind === "offset" && Number.isSafeInteger(value) && (value as number) > 0) {
    return { kind: "offset", offset: value as number };
  }
  if (kind === "token" && typeof value === "string") return { kind: "token", token: value };
  throw new ImportError(400, "reconciler_message_invalid");
}

export function resumeOffset(resume: ResumeState): number {
  if (resume.kind === "none") return 0;
  if (resume.kind === "offset") return resume.offset;
  throw new ImportError(500, "import_resume_kind_mismatch");
}

export function resumeToken(resume: ResumeState): string | undefined {
  if (resume.kind === "none") return undefined;
  if (resume.kind === "token") return resume.token;
  throw new ImportError(500, "import_resume_kind_mismatch");
}

export function assertNoResume(resume: ResumeState): void {
  if (resume.kind !== "none") throw new ImportError(500, "import_resume_kind_mismatch");
}

function jsonObject(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ImportError(400, "json_shape_invalid");
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new ImportError(400, "unknown_field");
  }
}

function requiredString(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ImportError(400, code);
  }
  return value;
}
