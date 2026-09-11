// R2 event notifications for the shared DATA bucket, narrowed to terminals.
//
// The queue is how the Processor learns quickly that a run finished; it is
// not the record that the run exists — the terminal in R2 is (unified plan
// 03 §2). So this parser is deliberately strict and deliberately lossy: a
// message it cannot vouch for is refused, and a message about an object that
// is not `runs/<source>/<runId>/terminal.json` is skipped, because the bucket
// also holds every content-addressed object and every report.
//
// Nothing downstream trusts the message's contents. Only the run identity is
// taken from it, and the terminal is then read and validated from the bucket;
// the notification's size and etag are never used as evidence about the
// object. Queues can deliver the same message more than once, so the
// notification id is never an idempotency key either (03 §6).
import { parseTerminalKey } from "../../../../packages/collection/src/keys.ts";

export class CollectionNotificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CollectionNotificationError";
  }
}

/** The object actions that can create a terminal. */
const CREATE_ACTIONS = ["PutObject", "CopyObject", "CompleteMultipartUpload"];
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface TerminalNotificationContext {
  /** The Cloudflare account the bucket belongs to. */
  accountId: string;
  /** The shared DATA bucket's name. */
  bucket: string;
}

export interface TerminalNotification {
  source: string;
  runId: string;
  key: string;
}

export type ParsedNotification =
  | { outcome: "terminal"; notification: TerminalNotification }
  /** A real notification about something that is not a terminal. */
  | { outcome: "ignored"; reason: "not_a_terminal" | "not_a_create" };

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new CollectionNotificationError(code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new CollectionNotificationError("notification_invalid");
  }
}

function isoInstant(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_MS.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/**
 * Validates one R2 event notification and returns the run it names.
 *
 * The account and the bucket must be the ones this Worker is configured for:
 * a queue is a shared pipe, and a message about another bucket is not a fact
 * about the shared DATA bucket.
 */
export function parseTerminalNotification(
  body: unknown,
  context: TerminalNotificationContext,
): ParsedNotification {
  const input = record(body, "notification_invalid");
  exactKeys(input, ["account", "action", "bucket", "object", "eventTime", "copySource"]);
  if (!ACCOUNT_ID.test(context.accountId)) {
    throw new CollectionNotificationError("notification_account_unconfigured");
  }
  if (input.account !== context.accountId) {
    throw new CollectionNotificationError("notification_account_mismatch");
  }
  if (input.bucket !== context.bucket) {
    throw new CollectionNotificationError("notification_bucket_mismatch");
  }
  if (!isoInstant(input.eventTime)) throw new CollectionNotificationError("notification_invalid");
  if (typeof input.action !== "string")
    throw new CollectionNotificationError("notification_invalid");
  if (!CREATE_ACTIONS.includes(input.action)) {
    // A delete or lifecycle event says nothing about a run finishing.
    return { outcome: "ignored", reason: "not_a_create" };
  }
  const object = record(input.object, "notification_invalid");
  exactKeys(object, ["key", "size", "eTag"]);
  if (typeof object.key !== "string" || object.key.length > 1024) {
    throw new CollectionNotificationError("notification_invalid");
  }
  const parts = parseTerminalKey(object.key);
  // Every object of the bucket is notified; only terminals mean anything here.
  if (!parts) return { outcome: "ignored", reason: "not_a_terminal" };
  return {
    outcome: "terminal",
    notification: { source: parts.source, runId: parts.runId, key: object.key },
  };
}
