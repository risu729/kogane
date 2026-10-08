// @kogane/domain: pure contracts for values, time, metrics, scope, coverage,
// rewards, context, decisions, results, the transaction-family registry, lots
// and as-of market-data selection. No I/O, no clock, no runtime dependencies.
export * from "./values.ts";
export * from "./time.ts";
export * from "./civil-date.ts";
export * from "./metrics.ts";
export * from "./scope.ts";
export * from "./coverage.ts";
export * from "./rewards.ts";
export * from "./context.ts";
export * from "./decisions.ts";
export * from "./events.ts";
export * from "./reconcile.ts";
export * from "./result.ts";
export * from "./paging.ts";
export * from "./calculation.ts";
export * from "./lots.ts";
export * from "./reports.ts";
export * from "./event-families.ts";
export * from "./reconstruction.ts";
export * from "./market-data.ts";
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
