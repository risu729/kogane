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
}

export function invocationContext(): InvocationContext {
  return { registration: new RegistrationBudget(), limitErrors: 0 };
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
    d1Statements: meter.d1Statements,
    d1Batches: meter.d1Batches,
    r2Operations: meter.r2Operations,
    registration: context.registration.summary(),
    limitErrors: context.limitErrors,
    documented: DOCUMENTED_LIMITS,
    // Each statement of a batch counts here, which is the conservative
    // reading of D1's "queries per Worker invocation".
    overDocumentedD1Queries: meter.d1Statements > DOCUMENTED_LIMITS.d1QueriesPerInvocation,
    overDocumentedSubrequests: meter.total > DOCUMENTED_LIMITS.subrequestsPerInvocation,
  };
}
