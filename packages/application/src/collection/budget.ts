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
 * step so that no yield separates them; an invocation that ends inside it is
 * finished by the next, which finds the report and the seal already recorded.
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

/** Numeric provider subtotal with coverage; absence is unknown, never zero. */
class ReportedMetric {
  private sum = 0;
  statements = 0;

  add(value: unknown, integer = true): void {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isSafeInteger(value))
    )
      return;
    this.sum += value;
    this.statements += 1;
  }

  summary(attempted: number) {
    return {
      reported: this.statements === 0 ? null : this.sum,
      statements: this.statements,
      missing: attempted - this.statements,
    };
  }
}

/** Metadata is observational: a malformed accessor is unavailable, never a source failure. */
function observedProperty(value: unknown, property: PropertyKey): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

/** Observe completion, preserving the original return value, Promise and errors. */
function observeOperation(
  call: () => unknown,
  settled: (result: unknown, durationMs: number, rejected: boolean) => void,
): unknown {
  let started: number;
  try {
    started = performance.now();
  } catch {
    return call();
  }
  let completed = false;
  const done = (result: unknown, rejected: boolean) => {
    if (completed) return;
    completed = true;
    try {
      settled(result, Math.max(0, performance.now() - started), rejected);
    } catch {
      // Observer failures must neither replace the source return/error nor
      // reject the detached Promise reaction. Keep no exception text.
    }
  };
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    done(undefined, true);
    throw error;
  }
  const then = observedProperty(result, "then");
  if (typeof then === "function") {
    try {
      // Read then once: re-assimilating a thenable may invoke its accessor
      // again and manufacture a rejection that the source never returned.
      Reflect.apply(then, result, [
        (value: unknown) => done(value, false),
        () => done(undefined, true),
      ]);
    } catch {
      // Unexpected observer setup is unavailable, without changing the call.
    }
  } else done(result, false);
  return result;
}

/** Counts and numeric metadata only; no SQL, rows or error text is retained. */
export class OperationMeter {
  d1Statements = 0;
  d1Batches = 0;
  r2Operations = 0;
  #d1FailedStatements = 0;
  #d1SettledStatements = 0;
  #r2FailedOperations = 0;
  #r2SettledOperations = 0;
  #d1ElapsedMs = 0;
  #r2ElapsedMs = 0;
  readonly #rowsRead = new ReportedMetric();
  readonly #rowsWritten = new ReportedMetric();
  readonly #sqlDuration = new ReportedMetric();
  readonly #retries = new ReportedMetric();

  /** Every D1 statement plus every R2 call. */
  get total(): number {
    return this.d1Statements + this.r2Operations;
  }

  executeD1(call: () => unknown, count: number, metadata: "result" | "batch" | "none"): unknown {
    this.d1Statements += count;
    return observeOperation(call, (result, durationMs, rejected) => {
      this.#d1ElapsedMs += durationMs;
      this.#d1SettledStatements += count;
      for (let index = 0; index < count; index += 1) {
        const entry =
          metadata === "batch"
            ? Array.isArray(result)
              ? observedProperty(result, index)
              : undefined
            : metadata === "result"
              ? result
              : undefined;
        if (rejected || observedProperty(entry, "success") === false) this.#d1FailedStatements += 1;
        const meta = observedProperty(entry, "meta");
        this.#rowsRead.add(observedProperty(meta, "rows_read"));
        this.#rowsWritten.add(observedProperty(meta, "rows_written"));
        this.#sqlDuration.add(observedProperty(meta, "duration"), false);
        const attempts = observedProperty(meta, "total_attempts");
        if (typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts >= 1)
          this.#retries.add(attempts - 1);
      }
    });
  }

  executeR2(call: () => unknown): unknown {
    this.r2Operations += 1;
    return observeOperation(call, (_result, durationMs, rejected) => {
      this.#r2ElapsedMs += durationMs;
      this.#r2SettledOperations += 1;
      if (rejected) this.#r2FailedOperations += 1;
    });
  }

  summary() {
    return {
      operations: this.total,
      d1Statements: this.d1Statements,
      d1Batches: this.d1Batches,
      r2Operations: this.r2Operations,
      d1SettledStatements: this.#d1SettledStatements,
      d1FailedStatements: this.#d1FailedStatements,
      r2SettledOperations: this.#r2SettledOperations,
      r2FailedOperations: this.#r2FailedOperations,
      d1ElapsedMs: this.#d1ElapsedMs,
      r2ElapsedMs: this.#r2ElapsedMs,
      d1RowsRead: this.#rowsRead.summary(this.d1Statements),
      d1RowsWritten: this.#rowsWritten.summary(this.d1Statements),
      d1SqlDurationMs: this.#sqlDuration.summary(this.d1Statements),
      d1Retries: this.#retries.summary(this.d1Statements),
    };
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
            return meter.executeD1(
              () => method.apply(inner, args),
              1,
              property === "all" || property === "run" ? "result" : "none",
            );
          };
        return method.bind(inner);
      },
    });
    originals.set(proxy, target);
    return proxy;
  };
  const binding = (target: object): object =>
    new Proxy(target, {
      get(inner, property) {
        const value: unknown = Reflect.get(inner, property, inner);
        if (typeof value !== "function") return value;
        const method = value as AnyFunction;
        if (property === "withSession")
          return (...args: unknown[]) => binding(method.apply(inner, args) as object);
        if (property === "prepare")
          return (...args: unknown[]) => statement(method.apply(inner, args) as object);
        if (property === "batch")
          return (statements: readonly object[]) => {
            meter.d1Batches += 1;
            return meter.executeD1(
              () =>
                method.call(
                  inner,
                  statements.map((entry) => originals.get(entry) ?? entry),
                ),
              statements.length,
              "batch",
            );
          };
        return method.bind(inner);
      },
    });
  return binding(database) as T;
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
          return meter.executeR2(() => method.apply(inner, args));
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
