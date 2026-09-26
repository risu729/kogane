// The Processor's shared-R2 consumption (unified plan 02 §2, 03 §4-§6, U08).
//
// Two ways in, one use case:
//
//   * the Queue consumer, woken by an R2 event notification on the DATA
//     bucket, filtered to `runs/<source>/<runId>/terminal.json`;
//   * the `collection_scan` cron lane, one bounded page of the whole `runs/`
//     prefix per tick, with the R2 cursor kept in CORE.
//
// Both call `registerTerminal`, so a lost notification costs nothing but time
// (G1-04) and a duplicate one costs nothing at all (G1-05). The scan is a
// full bounded walk rather than a recent-time window or a lexicographic
// watermark, because a run whose terminal is confirmed late sorts wherever
// its run id puts it and a watermark would step straight over it (G1-12).
//
// Everything here is behind `SHARED_R2_INGEST_ENABLED`, default off: the
// queue this consumer is declared on has to exist before the flag is turned
// on, and no collector writes the shared layout until U09.
//
// Every registration an invocation makes shares one operation budget
// (`RegistrationBudget`, issue #87): the consumer's whole batch, or the scan
// and the operations dispatch of one cron tick together. A registration that
// reaches the budget yields `pending` with its progress in CORE, and the scan
// continues pending runs first on every tick, before it lists new terminals.
//
// A terminal CORE has already judged — blocked, or refused `retryable` within
// the retry interval — is answered from its row and neither spends one of the
// tick's registrations nor holds the page, so a page of refused terminals no
// longer pins the cursor (ADR 0024).
import {
  REGISTRATION_CONTRACT_VERSION,
  RETRYABLE_RETRY_INTERVAL_MS,
  RegistrationBudget,
  registerTerminal,
  type RegisterTerminalOutcome,
} from "../../../../packages/application/src/collection/index.ts";
import type { IngestEnv } from "../../../../packages/application/src/ingest/contract.ts";
import type { R2BucketLike } from "../../../../packages/collection/src/bucket.ts";
import { listTerminals } from "../../../../packages/collection/src/reader.ts";
import {
  advanceCollectionScan,
  readCollectionScanState,
  readPendingRegistrations,
} from "../../../../packages/storage-d1/src/core/collection-runs.ts";
import {
  parseTerminalNotification,
  CollectionNotificationError,
  type TerminalNotification,
} from "./notifications.ts";

/** Terminals listed in one cron tick. */
export const DEFAULT_SCAN_PAGE = 25;
/** Runs registered in one cron tick; the rest wait for the next one. */
export const DEFAULT_SCAN_REGISTRATIONS = 5;
/** Staged registrations continued in one cron tick, before the page is listed. */
export const DEFAULT_SCAN_CONTINUATIONS = 5;

/**
 * What the collection lanes need from the Worker environment. Structural, so
 * a test builds one without the generated `Env`.
 */
export interface CollectionEnv {
  DB: IngestEnv["DB"];
  /** The shared DATA bucket. Physically the existing central bucket (03 §1). */
  EVIDENCE: IngestEnv["EVIDENCE"] & R2BucketLike;
  SHARED_R2_INGEST_ENABLED?: string | undefined;
  /** The ingest client the Processor registers as; its routes are CORE rows. */
  COLLECTION_INGEST_CLIENT?: string | undefined;
  COLLECTION_DATA_BUCKET?: string | undefined;
  COLLECTION_ACCOUNT_ID?: string | undefined;
}

/**
 * Off unless the flag says exactly "1" or "true". An absent, empty or
 * misspelled value leaves the Processor doing what it does today (D13).
 */
export function sharedR2IngestEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

const DEFAULT_INGEST_CLIENT = "processor-shared-r2";

function ingestClient(env: CollectionEnv): string {
  const configured = env.COLLECTION_INGEST_CLIENT;
  return configured && /^[a-z0-9-]{1,100}$/u.test(configured) ? configured : DEFAULT_INGEST_CLIENT;
}

export interface RegistrationOptions {
  artifactBudget?: number;
  inventoryChunk?: number;
  /** The invocation's shared budget; a registration without one gets its own. */
  budget?: RegistrationBudget;
  /** How long a `retryable` refusal stands before it is attempted again. */
  retryAfterMs?: number;
  /** The registration's clock; the scan passes its own. */
  now?: () => Date;
}

/**
 * One registration, through the in-process port: no HTTP hop, no Service
 * Binding call, no byte copied. The port is built by the use case over the
 * metered bindings, so everything it does counts against the budget.
 */
export function registerCollectionRun(
  env: CollectionEnv,
  run: { source: string; runId: string },
  options: RegistrationOptions = {},
): Promise<RegisterTerminalOutcome> {
  const ingestEnv: IngestEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE };
  return registerTerminal({
    env: ingestEnv,
    bucket: env.EVIDENCE,
    clientId: ingestClient(env),
    source: run.source,
    runId: run.runId,
    ...options,
  });
}

export interface ScanSummary {
  enabled: boolean;
  status: "skipped" | "scanned";
  listed: number;
  registered: number;
  alreadyRegistered: number;
  pending: number;
  blocked: number;
  retryable: number;
  /**
   * Of `blocked` and `retryable`, the terminals answered from CORE: judged on
   * an earlier tick under this contract and digest, and not attempted again.
   * They spend none of the tick's registrations (ADR 0024).
   */
  alreadyJudged: number;
  missing: number;
  /**
   * Registrations that threw — a CORE or R2 failure rather than a verdict
   * about the terminal. Nothing is recorded for them; the page still
   * advances and the next cycle tries again (G1-13).
   */
  failed: number;
  /** Staged registrations continued before the page was listed. */
  continued: number;
  /** Registrations not started because the invocation's budget was spent. */
  deferred: number;
  /** True when this tick finished the walk and the next one starts over. */
  cycleComplete: boolean;
  /** True when the tick stopped on its own budget and left the cursor put. */
  budgetExhausted: boolean;
}

export interface ScanOptions {
  pageLimit?: number;
  maxRegistrations?: number;
  /** Staged registrations continued per tick before the page is listed. */
  maxContinuations?: number;
  artifactBudget?: number;
  /** The invocation's shared registration budget; the scan gets its own when absent. */
  budget?: RegistrationBudget;
  /**
   * How long a `retryable` refusal stands before the scan attempts that run
   * again; `RETRYABLE_RETRY_INTERVAL_MS` (24 hours) when absent.
   */
  retryAfterMs?: number;
  now?: () => Date;
  /** Told the safe code of each registration that threw. */
  onFailure?: (code: string) => void;
}

/** A class or error name only: never the message, which may quote a key. */
function safeFailureCode(error: unknown): string {
  return error instanceof Error ? error.name || error.constructor.name : "unknown";
}

/** Adds one registration's outcome to the tick's counts. */
function count(summary: ScanSummary, result: RegisterTerminalOutcome): void {
  const outcome = result.outcome;
  if ((outcome === "blocked" || outcome === "retryable") && result.recorded) {
    summary.alreadyJudged += 1;
  }
  if (outcome === "registered") summary.registered += 1;
  else if (outcome === "already_registered") summary.alreadyRegistered += 1;
  else if (outcome === "pending") summary.pending += 1;
  else if (outcome === "blocked") summary.blocked += 1;
  else if (outcome === "retryable") summary.retryable += 1;
  else if (outcome === "deferred") summary.deferred += 1;
  else summary.missing += 1;
}

/**
 * One bounded page of the terminal scan.
 *
 * Staged registrations come first. A run that yielded at an earlier
 * invocation's budget has its progress in CORE and a `pending` stage naming
 * its fetch run; up to `maxContinuations` of them, oldest first, are
 * continued before anything is listed, so a large run finishes over
 * consecutive ticks instead of waiting for the walk to come round to it.
 *
 * The cursor only advances when the whole page was dealt with. A tick that
 * runs out of its registration budget leaves the cursor where it was, so the
 * next tick lists the same page again; the runs it already registered answer
 * `already_registered` in one query each, and the rest make progress. That is
 * cheaper than remembering a position inside a page, and it cannot skip one.
 *
 * Only new work spends one of the tick's `maxRegistrations`: a registration,
 * a continuation, a first verdict, a retry that was due, a missing terminal
 * or a failure. A terminal already registered, already blocked, or refused
 * `retryable` less than `retryAfterMs` ago is answered from its CORE row and
 * spends none, so a page whose terminals are all judged is finished in one
 * tick and the cursor moves on even when nothing registered (ADR 0024). A
 * terminal with no row yet is always attempted.
 */
export async function collectionScan(
  env: CollectionEnv,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const enabled = sharedR2IngestEnabled(env.SHARED_R2_INGEST_ENABLED);
  const empty: ScanSummary = {
    enabled,
    status: "skipped",
    listed: 0,
    registered: 0,
    alreadyRegistered: 0,
    pending: 0,
    blocked: 0,
    retryable: 0,
    alreadyJudged: 0,
    missing: 0,
    failed: 0,
    continued: 0,
    deferred: 0,
    cycleComplete: false,
    budgetExhausted: false,
  };
  // A flag that is off is not a completed scan. Nothing is recorded and the
  // cursor does not move (contracts/stages.json `neverCompleteOn: flag_off`).
  if (!enabled) return empty;

  const now = options.now ?? (() => new Date());
  const pageLimit = Math.max(1, options.pageLimit ?? DEFAULT_SCAN_PAGE);
  const maxRegistrations = Math.max(1, options.maxRegistrations ?? DEFAULT_SCAN_REGISTRATIONS);
  const maxContinuations = Math.max(0, options.maxContinuations ?? DEFAULT_SCAN_CONTINUATIONS);
  const budget = options.budget ?? new RegistrationBudget();
  const registration: RegistrationOptions = {
    budget,
    retryAfterMs: Math.max(0, options.retryAfterMs ?? RETRYABLE_RETRY_INTERVAL_MS),
    now,
    ...(options.artifactBudget === undefined ? {} : { artifactBudget: options.artifactBudget }),
  };
  const summary: ScanSummary = { ...empty, status: "scanned" };

  /** One registration; false when the invocation's budget is spent. */
  const attempt = async (run: { source: string; runId: string }): Promise<boolean> => {
    let outcome: RegisterTerminalOutcome;
    try {
      outcome = await registerCollectionRun(env, run, registration);
    } catch (error) {
      // A failure that is not a verdict — R2 or CORE unavailable, or a
      // refusal CORE made that the derivation did not foresee. Counted, not
      // recorded, and never allowed to stop the page or pin the cursor on
      // this run forever (G1-13). The code is logged, never the message.
      options.onFailure?.(safeFailureCode(error));
      summary.failed += 1;
      return true;
    }
    // One poisonous terminal is its own blocked run and does not end the page
    // (15 §2, G1-13); this simply counts what happened.
    count(summary, outcome);
    return outcome.outcome !== "deferred";
  };

  const continuations =
    maxContinuations === 0
      ? []
      : await readPendingRegistrations(env.DB, REGISTRATION_CONTRACT_VERSION, maxContinuations);
  let budgetExhausted = false;
  for (const run of continuations) {
    summary.continued += 1;
    if (!(await attempt({ source: run.source, runId: run.run_id }))) {
      budgetExhausted = true;
      break;
    }
  }

  const state = await readCollectionScanState(env.DB);
  let cursor = state?.cursor ?? null;
  let truncated = true;
  if (!budgetExhausted) {
    const page = await listTerminals(env.EVIDENCE, {
      limit: pageLimit,
      ...(state?.cursor ? { cursor: state.cursor } : {}),
    });
    summary.listed = page.terminals.length;
    let worked = 0;
    for (const terminal of page.terminals) {
      if (worked >= maxRegistrations) {
        budgetExhausted = true;
        break;
      }
      const before = summary.alreadyRegistered + summary.alreadyJudged;
      if (!(await attempt(terminal))) {
        budgetExhausted = true;
        break;
      }
      // A run that was already registered or already judged cost a few
      // queries, not a registration, so it does not consume the tick's count
      // (ADR 0024).
      if (summary.alreadyRegistered + summary.alreadyJudged === before) worked += 1;
    }
    if (!budgetExhausted) {
      cursor = page.cursor;
      truncated = page.truncated;
    }
  }

  await advanceCollectionScan(env.DB, {
    cursor,
    pageFinished: !budgetExhausted,
    nowMs: now().valueOf(),
    seen: summary.listed,
    registered: summary.registered,
    blocked: summary.blocked,
  });
  return {
    ...summary,
    cycleComplete: !budgetExhausted && !truncated,
    budgetExhausted,
  };
}

export interface QueueDelivery {
  body: unknown;
}

export type QueueOutcome =
  | {
      outcome:
        | "registered"
        | "already_registered"
        | "pending"
        | "blocked"
        | "retryable"
        | "missing"
        | "deferred";
    }
  | { outcome: "ignored"; reason: string }
  | { outcome: "invalid"; code: string }
  | { outcome: "flag_off" };

/**
 * One R2 event notification. Returns what happened rather than throwing, so
 * the consumer can decide between acknowledging and retrying with the same
 * vocabulary the stage records use. `deferred` means the batch's shared
 * budget was spent before this run started; the consumer retries the message.
 */
export async function handleTerminalNotification(
  env: CollectionEnv,
  delivery: QueueDelivery,
  options: { budget?: RegistrationBudget } = {},
): Promise<QueueOutcome> {
  if (!sharedR2IngestEnabled(env.SHARED_R2_INGEST_ENABLED)) return { outcome: "flag_off" };
  let parsed;
  try {
    parsed = parseTerminalNotification(delivery.body, {
      accountId: env.COLLECTION_ACCOUNT_ID ?? "",
      bucket: env.COLLECTION_DATA_BUCKET ?? "",
    });
  } catch (error) {
    if (error instanceof CollectionNotificationError) {
      return { outcome: "invalid", code: error.code };
    }
    throw error;
  }
  if (parsed.outcome === "ignored") return { outcome: "ignored", reason: parsed.reason };
  const notification: TerminalNotification = parsed.notification;
  const result = await registerCollectionRun(
    env,
    notification,
    options.budget === undefined ? {} : { budget: options.budget },
  );
  return { outcome: result.outcome };
}
