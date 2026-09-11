// Moved here from `services/collector-r2-importer/src/reconciler.ts` by U08.
// The Queue message schema, the source table and the bounded repair walk are
// byte-for-byte what the importer ran; only the file's home changed, and the
// importer imports it back through a re-export shim while it keeps running.
//
// It is pure: no Worker environment, no binding, no HTTP. The Processor and
// the importer therefore share one implementation of "what a reconciler
// message means" instead of two that can drift (plan 02 §2).
import {
  resumeFromWire,
  type ImportCommand,
  type ResumeKind,
  type ResumeState,
} from "./adapters/contract.ts";
import { ImportError } from "./error.ts";

export const RECONCILER_SCHEMA = "kogane-r2-outbox-reconciler-v1" as const;
export const REPAIR_LIST_LIMIT = 50;
const MAX_IMPORT_STEPS = 1_024;
const MAX_REPAIR_PAGES = 100_000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const DATE_RUN = `\\d{4}/\\d{2}/\\d{2}/${UUID}`;

export const RECONCILER_SOURCES = {
  "global-pass": {
    bucket: "kogane-globalpass-collector-poc",
    prefix: "raw/prestia-globalpass/",
    terminal: new RegExp(`^raw/prestia-globalpass/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "offset",
  },
  "mobile-suica": {
    bucket: "kogane-mobile-suica-collector-poc",
    prefix: "raw/mobile-suica/",
    terminal: new RegExp(`^raw/mobile-suica/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "none",
  },
  moneyforward: {
    bucket: "kogane-moneyforward-collector-poc",
    prefix: "raw/moneyforward/",
    terminal: new RegExp(`^raw/moneyforward/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "token",
  },
  myjcb: {
    bucket: "kogane-myjcb-collector-poc",
    prefix: "raw/myjcb/",
    terminal: new RegExp(`^raw/myjcb/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "token",
  },
  "sbi-securities": {
    bucket: "kogane-sbi-collector-poc",
    prefix: "raw/sbi-securities/",
    terminal: new RegExp(`^raw/sbi-securities/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "none",
  },
  "sbi-shinsei": {
    bucket: "kogane-sbi-shinsei-collector-poc",
    prefix: "raw/sbi-shinsei/",
    terminal: new RegExp(`^raw/sbi-shinsei/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "none",
  },
  "sbi-vc-trade": {
    bucket: "kogane-sbi-vc-trade-poc",
    prefix: "raw/sbi-vc-trade/",
    terminal: new RegExp(`^raw/sbi-vc-trade/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "token",
  },
  "smbc-direct": {
    bucket: "kogane-smbc-direct-backfill-poc",
    prefix: "raw/smbc-direct/",
    terminal: new RegExp(`^raw/smbc-direct/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "offset",
  },
  "sony-bank": {
    bucket: "kogane-sony-bank-collector-poc",
    prefix: "raw/sony-bank/",
    terminal: new RegExp(`^raw/sony-bank/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "offset",
  },
  vpass: {
    bucket: "kogane-vpass-collector-poc",
    prefix: "vpass/",
    terminal:
      /^vpass\/\d{4}\/\d{2}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:\/card-\d{3})?\/(?:manifest|error)\.json$/u,
    resume: "token",
  },
  "v-point": {
    bucket: "kogane-vpoint-collector-poc",
    prefix: "raw/v-point/",
    terminal: new RegExp(`^raw/v-point/${DATE_RUN}/manifest\\.json$`, "u"),
    resume: "offset",
  },
  "v-point-pay-email": {
    bucket: "kogane-vpoint-pay-collector-poc",
    prefix: "raw/v-point-pay-email/",
    terminal:
      /^raw\/v-point-pay-email\/20\d{2}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/[0-9a-f]{64}\.json$/u,
    resume: "none",
  },
} as const satisfies Record<string, ReconcilerSourceSpec>;

export interface ReconcilerSourceSpec {
  readonly bucket: string;
  readonly prefix: string;
  readonly terminal: RegExp;
  readonly resume: ResumeKind;
}

export type ReconcilerSource = keyof typeof RECONCILER_SOURCES;

export interface ImportMessage {
  schemaVersion: typeof RECONCILER_SCHEMA;
  kind: "import";
  source: ReconcilerSource;
  terminalKey: string;
  step: number;
  progress: number;
  resume: string | number | null;
}

export interface RepairMessage {
  schemaVersion: typeof RECONCILER_SCHEMA;
  kind: "repair";
  source: ReconcilerSource;
  cursor: string | null;
  page: number;
}

export type InternalMessage = ImportMessage | RepairMessage;

interface R2CreateNotification {
  kind: "r2-notification";
  source: ReconcilerSource;
  terminalKey: string;
}

export type ParsedMessage = InternalMessage | R2CreateNotification;

export type ImportOutcome =
  | { status: "sealed" }
  | { status: "deferred"; resume: string | number; progress: number };

export interface ReconcilerDependencies {
  accountId: string;
  importTerminal(command: ImportCommand, resume: ResumeState): Promise<ImportOutcome>;
  list(
    source: ReconcilerSource,
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ keys: string[]; truncated: boolean; cursor: string | null }>;
  send(messages: InternalMessage[]): Promise<void>;
}

export async function processReconcilerMessage(
  body: unknown,
  dependencies: ReconcilerDependencies,
): Promise<{ kind: "import" | "repair"; source: ReconcilerSource; outcome: string }> {
  const parsed = parseMessage(body, dependencies.accountId);
  if (parsed.kind === "repair") return processRepair(parsed, dependencies);
  const current: ImportMessage =
    parsed.kind === "r2-notification"
      ? importMessage(parsed.source, parsed.terminalKey, 0, 0, null)
      : parsed;
  const outcome = await dependencies.importTerminal(
    { source: current.source, terminalKey: current.terminalKey, mode: "staged" },
    resumeFromWire(RECONCILER_SOURCES[current.source].resume, current.resume),
  );
  if (outcome.status === "sealed") {
    return { kind: "import", source: current.source, outcome: "sealed" };
  }
  if (current.step >= MAX_IMPORT_STEPS || outcome.progress <= current.progress) {
    throw new ImportError(409, "reconciler_import_stalled");
  }
  assertResume(RECONCILER_SOURCES[current.source].resume, outcome.resume);
  await dependencies.send([
    importMessage(
      current.source,
      current.terminalKey,
      current.step + 1,
      outcome.progress,
      outcome.resume,
    ),
  ]);
  return { kind: "import", source: current.source, outcome: "deferred" };
}

export function weeklyRepairSeeds(): RepairMessage[] {
  return (Object.keys(RECONCILER_SOURCES) as ReconcilerSource[]).map((source) => ({
    schemaVersion: RECONCILER_SCHEMA,
    kind: "repair",
    source,
    cursor: null,
    page: 0,
  }));
}

export function parseMessage(body: unknown, accountId: string): ParsedMessage {
  const input = record(body, "reconciler_message_invalid");
  if (input.schemaVersion === RECONCILER_SCHEMA) return parseInternal(input);
  return parseR2Notification(input, accountId);
}

async function processRepair(
  message: RepairMessage,
  dependencies: ReconcilerDependencies,
): Promise<{ kind: "repair"; source: ReconcilerSource; outcome: string }> {
  if (message.page >= MAX_REPAIR_PAGES) {
    throw new ImportError(409, "reconciler_repair_page_limit");
  }
  const spec = RECONCILER_SOURCES[message.source];
  const listed = await dependencies.list(
    message.source,
    spec.prefix,
    message.cursor,
    REPAIR_LIST_LIMIT,
  );
  if (listed.keys.length > REPAIR_LIST_LIMIT) {
    throw new ImportError(409, "reconciler_repair_page_too_large");
  }
  if (listed.truncated && (!listed.cursor || listed.cursor === message.cursor)) {
    throw new ImportError(409, "reconciler_repair_cursor_stalled");
  }
  if (!listed.truncated && listed.cursor !== null) {
    throw new ImportError(409, "reconciler_repair_cursor_invalid");
  }
  const next: InternalMessage[] = listed.keys
    .filter((key) => spec.terminal.test(key))
    .map((key) => importMessage(message.source, key, 0, 0, null));
  if (listed.truncated) {
    next.push({
      schemaVersion: RECONCILER_SCHEMA,
      kind: "repair",
      source: message.source,
      cursor: listed.cursor,
      page: message.page + 1,
    });
  }
  if (next.length > 0) await dependencies.send(next);
  return {
    kind: "repair",
    source: message.source,
    outcome: listed.truncated ? "continued" : "complete",
  };
}

function parseInternal(input: Record<string, unknown>): InternalMessage {
  if (input.kind === "import") {
    exactKeys(input, [
      "schemaVersion",
      "kind",
      "source",
      "terminalKey",
      "step",
      "progress",
      "resume",
    ]);
    const source = sourceId(input.source);
    if (
      typeof input.terminalKey !== "string" ||
      input.terminalKey.length > 500 ||
      !RECONCILER_SOURCES[source].terminal.test(input.terminalKey) ||
      !boundedInteger(input.step, 0, MAX_IMPORT_STEPS) ||
      !boundedInteger(input.progress, 0, 100_000)
    ) {
      throw new ImportError(400, "reconciler_message_invalid");
    }
    assertResume(RECONCILER_SOURCES[source].resume, input.resume);
    const step = input.step as number;
    if (step === 0 && (input.progress !== 0 || input.resume !== null)) {
      throw new ImportError(400, "reconciler_message_invalid");
    }
    if (step > 0 && (input.progress === 0 || input.resume === null)) {
      throw new ImportError(400, "reconciler_message_invalid");
    }
    return input as unknown as ImportMessage;
  }
  if (input.kind === "repair") {
    exactKeys(input, ["schemaVersion", "kind", "source", "cursor", "page"]);
    const source = sourceId(input.source);
    if (
      !(input.cursor === null || safeString(input.cursor, 12_000)) ||
      !boundedInteger(input.page, 0, MAX_REPAIR_PAGES)
    ) {
      throw new ImportError(400, "reconciler_message_invalid");
    }
    if (input.page === 0 ? input.cursor !== null : input.cursor === null) {
      throw new ImportError(400, "reconciler_message_invalid");
    }
    return { ...input, source } as unknown as RepairMessage;
  }
  throw new ImportError(400, "reconciler_message_invalid");
}

function parseR2Notification(
  input: Record<string, unknown>,
  accountId: string,
): R2CreateNotification {
  exactKeys(input, ["account", "action", "bucket", "object", "eventTime", "copySource"], true);
  if (
    typeof input.account !== "string" ||
    !/^[0-9a-f]{32}$/u.test(accountId) ||
    input.account !== accountId ||
    typeof input.action !== "string" ||
    !["PutObject", "CopyObject", "CompleteMultipartUpload"].includes(input.action) ||
    typeof input.bucket !== "string" ||
    !exactIsoTime(input.eventTime)
  ) {
    throw new ImportError(400, "reconciler_notification_invalid");
  }
  const source = sourceForBucket(input.bucket);
  const object = record(input.object, "reconciler_notification_invalid");
  exactKeys(object, ["key", "size", "eTag"]);
  if (
    typeof object.key !== "string" ||
    object.key.length > 500 ||
    !RECONCILER_SOURCES[source].terminal.test(object.key) ||
    !boundedInteger(object.size, 0, Number.MAX_SAFE_INTEGER) ||
    !safeString(object.eTag, 256)
  ) {
    throw new ImportError(400, "reconciler_notification_invalid");
  }
  if (input.action === "CopyObject") {
    const copy = record(input.copySource, "reconciler_notification_invalid");
    exactKeys(copy, ["bucket", "object"]);
    if (!safeString(copy.bucket, 63) || !safeString(copy.object, 1_024)) {
      throw new ImportError(400, "reconciler_notification_invalid");
    }
  } else if (input.copySource !== undefined) {
    throw new ImportError(400, "reconciler_notification_invalid");
  }
  return { kind: "r2-notification", source, terminalKey: object.key };
}

function importMessage(
  source: ReconcilerSource,
  terminalKey: string,
  step: number,
  progress: number,
  resume: string | number | null,
): ImportMessage {
  return {
    schemaVersion: RECONCILER_SCHEMA,
    kind: "import",
    source,
    terminalKey,
    step,
    progress,
    resume,
  };
}

function assertResume(kind: ResumeKind, value: unknown): void {
  const valid =
    kind === "none"
      ? value === null
      : kind === "offset"
        ? value === null || boundedInteger(value, 1, 100_000)
        : value === null || safeString(value, 16_000);
  if (!valid) throw new ImportError(400, "reconciler_message_invalid");
}

function sourceId(value: unknown): ReconcilerSource {
  if (typeof value !== "string" || !Object.hasOwn(RECONCILER_SOURCES, value)) {
    throw new ImportError(400, "reconciler_message_invalid");
  }
  return value as ReconcilerSource;
}

function sourceForBucket(bucket: string): ReconcilerSource {
  const source = (Object.keys(RECONCILER_SOURCES) as ReconcilerSource[]).find(
    (candidate) => RECONCILER_SOURCES[candidate].bucket === bucket,
  );
  if (!source) throw new ImportError(400, "reconciler_notification_invalid");
  return source;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ImportError(400, code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  allowMissingCopySource = false,
): void {
  const actual = Object.keys(value).sort();
  const expected = allowed
    .filter((key) => !(allowMissingCopySource && key === "copySource"))
    .sort();
  if (allowMissingCopySource && Object.hasOwn(value, "copySource")) expected.push("copySource");
  expected.sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ImportError(400, "reconciler_message_invalid");
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function safeString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function exactIsoTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
