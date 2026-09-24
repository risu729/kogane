// How much one Worker invocation may spend registering terminals (issue #87).
//
// Registration used to be bounded by a count of artifacts (500 per call), and
// the work around the artifacts was not bounded at all: every call added
// every unit and every range of the manifest, re-verified every referenced
// object and re-staged every inventory item before cataloguing anything, and
// the manifest schema allows 1,000 units, 1,000 ranges and 10,000 artifacts.
// Each of those is several CORE statements or an R2 call. One registration of
// a 34-artifact Vpass card run measured 669 D1 statements and 69 R2 calls, so
// the old budget of 500 artifacts allowed roughly 8,000 D1 statements in one
// invocation against a documented limit of 1,000.
//
// The budget below is therefore counted in the unit the provider limits are
// written in: operations against Cloudflare services, measured rather than
// estimated. Every D1 statement (each statement of a batch counts) and every
// R2 call a registration makes goes through a meter, and registration only
// starts a step while the step's reserve still fits under the budget. What
// does not fit yields with its progress recorded and continues on a later
// invocation — the staged continuation — instead of failing at a limit.
//
// Nothing here guesses a lower provider limit. The documented numbers are
// recorded as they are published, and the budget is a fraction of the
// strictest of them, leaving the rest of the invocation to the lanes that
// share it.

/**
 * The per-invocation limits the registration path is reconciled against, as
 * Cloudflare documents them for Workers Paid. They are recorded here so the
 * probe can report measured counts next to them; nothing enforces them but
 * the platform.
 */
export const DOCUMENTED_LIMITS = {
  /**
   * "A single request has a maximum of 32 Worker invocations, and each call to
   * a Service binding counts towards this limit."
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
   * Registration runs in process in the Processor, which declares no service
   * binding, so it makes no such call (`scripts/service-binding-chain.test.ts`).
   */
  workerInvocationsPerRequest: 32,
  /** D1 "Queries per Worker invocation": 1000 (Workers Paid). https://developers.cloudflare.com/d1/platform/limits/ */
  d1QueriesPerInvocation: 1_000,
  /** Workers "Subrequests per invocation", D1 and R2 included: 10,000 by default (Workers Paid). https://developers.cloudflare.com/workers/platform/limits/#subrequests */
  subrequestsPerInvocation: 10_000,
} as const;

/**
 * Operations (D1 statements plus R2 calls) that registration may spend in one
 * Worker invocation, all registrations of that invocation together. Half the
 * documented D1 limit: the queue consumer spends nothing else, and the cron
 * invocation shares the other half with its other lanes.
 */
export const REGISTRATION_OPERATION_BUDGET = 500;

// Step reserves. A step only starts while its reserve still fits, so a step
// can never carry the invocation over the budget as long as each reserve is
// an upper bound of what its step costs. Every reserve below is the cost
// measured against the real CORE schema plus a margin, and
// `services/processor/test/registration-budget.test.ts` measures each step
// kind at its largest and fails when one outgrows its reserve.

/** The per-run preamble: the terminal read, the run row, the conflict and refusal checks (measured 8). */
export const PREAMBLE_RESERVE = 16;

/** A structure step: the run, a unit, a range, the inventory declaration or a unit report (measured 5-6). */
export const STRUCTURE_STEP_RESERVE = 16;

/**
 * An inventory chunk: a fixed part and a part per item (measured 7 plus 3 per
 * item, 97 for a full chunk of `MAX_INVENTORY_CHUNK_ITEMS`).
 */
export const INVENTORY_CHUNK_BASE = 16;
export const INVENTORY_ITEM_RESERVE = 4;

/**
 * The final step: the run report, the seal — direct, of at most
 * `DIRECT_SEAL_ARTIFACTS` items, or staged — and the link and completion that
 * record it (measured 32 at the direct-seal maximum, 16 staged). They are one
 * step so that none of them is ever made twice.
 */
export const FINAL_STEP_RESERVE = 64;

/**
 * An artifact step: the object's R2 head, its adoption and its catalogue row
 * cost a fixed part (measured 19), plus one statement per transformation step
 * and two per relation (a parent read and the relation row). Its reserve is
 * computed from its descriptor so a derived artifact with many parents is not
 * squeezed under a fixed number.
 */
export const ARTIFACT_STEP_BASE = 32;

/**
 * Operations always kept back for the audit of how the step ended: a pending
 * stage for a yield, or a stage row and the block itself for a failure. A step
 * that fails at the edge of the budget can therefore still record why.
 */
export const AUDIT_RESERVE = 4;

/** What one artifact step is expected to cost, used only to size the verify-ahead window. */
export const ARTIFACT_STEP_TYPICAL = 20;

/** The reserve of one inventory chunk of `items` items. */
export function inventoryChunkReserve(items: number): number {
  return INVENTORY_CHUNK_BASE + INVENTORY_ITEM_RESERVE * items;
}

/** Counts of operations against Cloudflare services, never their content. */
export class OperationMeter {
  d1Statements = 0;
  d1Batches = 0;
  r2Operations = 0;

  /** Everything counted: every D1 statement plus every R2 call. */
  get total(): number {
    return this.d1Statements + this.r2Operations;
  }
}

/** The statement methods that execute SQL. `bind` returns a new statement. */
const D1_EXECUTING = new Set<PropertyKey>(["first", "all", "run", "raw"]);

/** R2 calls that reach the service. Everything else is passed through untouched. */
const R2_OPERATIONS = new Set<PropertyKey>([
  "head",
  "get",
  "put",
  "list",
  "delete",
  "createMultipartUpload",
  "resumeMultipartUpload",
]);

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * The same D1 binding, counting every statement it executes into `meter`.
 *
 * A proxy rather than a re-implementation: every property of the binding and
 * of its statements is the original's, called with the original as `this`,
 * and a batch is handed the original statements. Only the counting is added,
 * so a lane that runs through the meter behaves exactly as it does without it.
 */
export function meterD1<T extends object>(database: T, meter: OperationMeter): T {
  const originals = new WeakMap<object, object>();
  const statement = (target: object): object => {
    const proxy = new Proxy(target, {
      get(inner, property) {
        const value: unknown = Reflect.get(inner, property, inner);
        if (typeof value !== "function") return value;
        const method = value as AnyFunction;
        if (property === "bind")
          return (...args: unknown[]) => statement(method.apply(inner, args) as object);
        if (D1_EXECUTING.has(property))
          return (...args: unknown[]) => {
            meter.d1Statements += 1;
            return method.apply(inner, args);
          };
        return method.bind(inner);
      },
    });
    originals.set(proxy, target);
    return proxy;
  };
  return new Proxy(database, {
    get(inner, property) {
      const value: unknown = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      const method = value as AnyFunction;
      if (property === "prepare")
        return (...args: unknown[]) => statement(method.apply(inner, args) as object);
      if (property === "batch")
        return (statements: readonly object[]) => {
          meter.d1Batches += 1;
          meter.d1Statements += statements.length;
          return method.call(
            inner,
            statements.map((entry) => originals.get(entry) ?? entry),
          );
        };
      return method.bind(inner);
    },
  });
}

/** The same R2 binding, counting every call that reaches the service into `meter`. */
export function meterBucket<T extends object>(bucket: T, meter: OperationMeter): T {
  return new Proxy(bucket, {
    get(inner, property) {
      const value: unknown = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      const method = value as AnyFunction;
      if (R2_OPERATIONS.has(property))
        return (...args: unknown[]) => {
          meter.r2Operations += 1;
          return method.apply(inner, args);
        };
      return method.bind(inner);
    },
  });
}

/**
 * The registration budget of one Worker invocation, shared by every
 * registration that invocation makes: the queue consumer's whole batch, or the
 * cron's scan and operations-dispatch lanes together.
 */
export class RegistrationBudget {
  readonly meter = new OperationMeter();
  /** Registrations that did any work in this invocation. */
  started = 0;
  /** Registrations that stopped at the budget with their progress recorded. */
  yielded = 0;
  /** Registrations not started at all because the budget was already spent. */
  deferred = 0;

  constructor(readonly limit: number = REGISTRATION_OPERATION_BUDGET) {}

  /** Operations spent so far in this invocation. */
  get used(): number {
    return this.meter.total;
  }

  /** True when a step that may cost `reserve` still fits, with the audit reserve kept back. */
  fits(reserve: number): boolean {
    return this.used + reserve + AUDIT_RESERVE <= this.limit;
  }

  /** What is left for work once the audit reserve is kept back. */
  get available(): number {
    return Math.max(0, this.limit - AUDIT_RESERVE - this.used);
  }

  /** Aggregate counts for the invocation probe: numbers only. */
  summary(): Record<string, number> {
    return {
      budget: this.limit,
      operations: this.used,
      d1Statements: this.meter.d1Statements,
      r2Operations: this.meter.r2Operations,
      started: this.started,
      yielded: this.yielded,
      deferred: this.deferred,
    };
  }
}
