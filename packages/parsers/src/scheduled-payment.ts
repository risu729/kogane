// The fifth observation kind: a payment the provider says is still to come
// (ADR 0005 amendment e). It is stored in `scheduled_payment_observations`
// (migration 0061), append-only like every observation table, and no read
// path, purchase recognition, settlement matching or identity run reads it.
//
// It is declared here, not in `types.ts`, on purpose: every parser's code
// digest covers `types.ts`, so widening the `Observation` union there would
// re-identify every deployed parser (migration 0028 refuses the same name and
// version with another digest). Only `myjcb-skip-payment-schedule` imports
// this module, and the processor, which persists the kind.
import type { Observation } from "./types.ts";

/** "The source says: this amount is still to be paid on this date." */
export interface ScheduledPaymentObservation {
  kind: "scheduled_payment";
  sourceAccount: string;
  externalId: string;
  /** Closed: what kind of schedule the row is on. */
  scheduleKind: "card-skip-payment";
  /** The usage date the row names, `YYYY-MM-DD`. */
  usageDate: string;
  /** The payment date the row names, `YYYY-MM-DD`. */
  dueDate: string;
  /** Exact decimal text; never a float. */
  amountText: string;
  amountScale: number;
  currency: string;
  counterparty: string;
  /** The date the page says the schedule is as of, `YYYY-MM-DD`. */
  asOf: string;
  observedAt: string;
  rawLocator: string;
  extra: Record<string, unknown>;
}

/** Every kind the processor persists: the parser contract's four and this one. */
export type PersistedObservation = Observation | ScheduledPaymentObservation;

/**
 * The parser contract's `observations` array carrying scheduled payments. The
 * processor persists them by `kind` (`services/processor/src/worker.ts`
 * `fields`); nothing else reads a parse result.
 */
export function scheduledPaymentsAsObservations(
  rows: readonly ScheduledPaymentObservation[],
): Observation[] {
  return [...rows] as unknown as Observation[];
}
