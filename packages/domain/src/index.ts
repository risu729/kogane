// @kogane/domain: pure contracts for values, time, metrics, scope, coverage,
// context, decisions and results. No I/O, no clock, no runtime dependencies.
export * from "./values.ts";
export * from "./time.ts";
export * from "./metrics.ts";
export * from "./scope.ts";
export * from "./coverage.ts";
export * from "./context.ts";
export * from "./decisions.ts";
export * from "./events.ts";
export * from "./reconcile.ts";
export * from "./result.ts";
export * from "./paging.ts";
export {
  hasExactKeys,
  isRecord,
  isText,
  isOneOf,
  isArrayOf,
  isSafeInt,
  isRefList,
} from "./guards.ts";
export type { Guard, UnknownRecord } from "./guards.ts";
