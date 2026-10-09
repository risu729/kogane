// The deployed invocation probe (issue #87): counts only.
//
// Cloudflare documents three per-invocation limits a collection path could
// meet — 32 Worker invocations per request through Service Bindings, 1,000 D1
// queries per Worker invocation and 10,000 subrequests per invocation on
// Workers Paid. The first no longer applies to registration: it runs in
// process here, and this Worker declares no Service Binding
// (`scripts/service-binding-chain.test.ts`). The other two do, and production
// has registered every observed run although the arithmetic said a large one
// could pass the D1 limit. This probe is what reconciles the two: every cron
// and queue invocation counts what it actually did through its bindings and
// logs one line with the counts next to the documented numbers, so an
// invocation that went past a documented limit and still succeeded is
// visible as exactly that.
//
// The line carries counts, booleans and the documented constants. Never a
// key, a statement, a value, an identifier or an exception message: a failure
// that names a platform limit is counted by recognising the text, and the
// text itself is dropped.
import {
  DOCUMENTED_LIMITS,
  meterBucket,
  meterD1,
  OperationMeter,
  RegistrationBudget,
} from "../../../packages/application/src/collection/index.ts";

/** What every lane of one invocation shares. */
export interface InvocationContext {
  /** The registration budget every registration of this invocation spends from. */
  registration: RegistrationBudget;
  /** Failures whose text names a platform invocation limit. Counted, never quoted. */
  limitErrors: number;
  /** Fixed-name stage aggregates for this invocation only; never persisted per query. */
  lanes: Partial<Record<ObservedLane, LaneCost>>;
}

const OBSERVED_LANES = [
  "observation_sweep",
  "collection_scan",
  "identity_sweep",
  "balance_projection",
  "reconciliation_sweep",
  "card_debit_account_sweep",
  "card_settlement_sweep",
  "purchase_recognition",
  "reward_claims_sweep",
  "reward_read_projection",
  "price_promotion",
  "report_job",
  "maintenance_survey",
  "operation_dispatch",
  "decision_outbox",
  "collection_notification",
] as const;
type ObservedLane = (typeof OBSERVED_LANES)[number];

const RETURNED_OUTCOMES = [
  "skipped",
  "unchanged",
  "building",
  "complete",
  "refused",
  "retryable",
  "pending",
  "dispatched",
  "registered",
  "already_registered",
  "blocked",
  "deferred",
  "ignored",
  "invalid",
  "flag_off",
] as const;
type ReturnedOutcome = (typeof RETURNED_OUTCOMES)[number];

interface LaneCost {
  meter: OperationMeter;
  runs: number;
  failed: number;
  skipped: number;
  limitErrors: number;
  durationMs: number;
  /** Only known returned count fields; absent means unavailable. */
  resultCounts: Partial<Record<"failed" | "error" | "retried" | "deferred", number>>;
  /** Closed returned status/outcome codes; refused/blocked are not thrown failures. */
  resultOutcomes: Partial<Record<ReturnedOutcome, number>>;
  /** A boolean deferred flag describes a tick, not a number of deferred jobs. */
  deferredFlags: { yes: number; no: number };
  /** Successfully returned queue action calls, not an assertion of eventual delivery. */
  acknowledgements: number;
  retries: number;
}

export interface LaneObservation {
  env: Env;
  finish(outcome: "ran" | "failed" | "skipped", result?: object, limit?: boolean): void;
  queueAction(action: "ack" | "retry"): void;
}

/** A bounded scope: unknown names cannot allocate map entries or copy private fields. */
export function observeLane(env: Env, context: InvocationContext, name: string): LaneObservation {
  if (!(OBSERVED_LANES as readonly string[]).includes(name))
    throw new Error("unknown_observation_lane");
  const lane = name as ObservedLane;
  const cost = (context.lanes[lane] ??= {
    meter: new OperationMeter(),
    runs: 0,
    failed: 0,
    skipped: 0,
    limitErrors: 0,
    durationMs: 0,
    resultCounts: {},
    resultOutcomes: {},
    deferredFlags: { yes: 0, no: 0 },
    acknowledgements: 0,
    retries: 0,
  });
  const started = performance.now();
  let finished = false;
  return {
    env: meteredEnv(env, cost.meter),
    finish(outcome, result, limit = false) {
      if (finished) return;
      finished = true;
      cost.durationMs += Math.max(0, performance.now() - started);
      const source = result as Record<string, unknown> | undefined;
      if (
        outcome === "ran" &&
        (source?.["enabled"] === false ||
          source?.["status"] === "skipped" ||
          source?.["outcome"] === "flag_off")
      )
        outcome = "skipped";
      if (outcome === "ran") cost.runs += 1;
      else if (outcome === "failed") cost.failed += 1;
      else cost.skipped += 1;
      if (limit) cost.limitErrors += 1;
      if (result) {
        const counts = result as Record<string, unknown>;
        if (typeof counts["deferred"] === "boolean")
          cost.deferredFlags[counts["deferred"] ? "yes" : "no"] += 1;
        for (const code of RETURNED_OUTCOMES) {
          if (counts["status"] === code || counts["outcome"] === code)
            cost.resultOutcomes[code] = (cost.resultOutcomes[code] ?? 0) + 1;
        }
        for (const field of ["failed", "error", "retried", "deferred"] as const) {
          const value = counts[field];
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
            cost.resultCounts[field] = (cost.resultCounts[field] ?? 0) + value;
        }
      }
    },
    queueAction(action) {
      if (action === "ack") cost.acknowledgements += 1;
      else cost.retries += 1;
    },
  };
}

export function invocationContext(): InvocationContext {
  return { registration: new RegistrationBudget(), limitErrors: 0, lanes: {} };
}

/**
 * The messages the platform throws when an invocation passes one of the
 * documented limits: D1's per-invocation query limit, the subrequest limit,
 * and the Service Binding chain limit.
 */
const PLATFORM_LIMIT =
  /too many api requests by single worker invocation|too many subrequests|subrequest depth limit|worker invocation limit/iu;

/** True when the error names a platform invocation limit; the text is not kept. */
export function platformLimitError(error: unknown): boolean {
  return error instanceof Error && PLATFORM_LIMIT.test(error.message);
}

/**
 * The same bindings, counted. Every other property of the environment — the
 * lane flags, the vars — is the original's; only CORE, READ and the two R2
 * bindings are wrapped, and the wrappers pass every call through unchanged.
 * A binding a deployment lacks stays absent, so the health route still sees
 * that it is missing.
 */
export function meteredEnv(env: Env, meter: OperationMeter): Env {
  const bound = (value: unknown): value is object =>
    (typeof value === "object" || typeof value === "function") && value !== null;
  return {
    ...env,
    ...(bound(env.DB) ? { DB: meterD1(env.DB, meter) } : {}),
    ...(bound(env.READ) ? { READ: meterD1(env.READ, meter) } : {}),
    ...(bound(env.EVIDENCE) ? { EVIDENCE: meterBucket(env.EVIDENCE, meter) } : {}),
    ...(bound(env.DATA) ? { DATA: meterBucket(env.DATA, meter) } : {}),
  };
}

/** The one log line of an invocation. Counts and booleans only. */
export function invocationProbe(
  trigger: "scheduled" | "queue",
  meter: OperationMeter,
  context: InvocationContext,
): Record<string, unknown> {
  return {
    event: "invocation_budget",
    trigger,
    ...meter.summary(),
    lanes: Object.fromEntries(
      Object.entries(context.lanes).map(([lane, cost]) => [
        lane,
        {
          ...cost.meter.summary(),
          runs: cost.runs,
          failed: cost.failed,
          skipped: cost.skipped,
          limitErrors: cost.limitErrors,
          durationMs: cost.durationMs,
          resultCounts: cost.resultCounts,
          resultOutcomes: cost.resultOutcomes,
          deferredFlags: cost.deferredFlags,
          acknowledgements: cost.acknowledgements,
          retries: cost.retries,
        },
      ]),
    ),
    registration: context.registration.summary(),
    limitErrors: context.limitErrors,
    documented: DOCUMENTED_LIMITS,
    // Each statement of a batch counts here, which is the conservative
    // reading of D1's "queries per Worker invocation".
    overDocumentedD1Queries: meter.d1Statements > DOCUMENTED_LIMITS.d1QueriesPerInvocation,
    overDocumentedSubrequests: meter.total > DOCUMENTED_LIMITS.subrequestsPerInvocation,
  };
}
