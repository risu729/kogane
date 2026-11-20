// Which published tools follow the one paging contract (ADR 0128), and where
// each is walked by following only `next.arguments`; and which still page
// their own way, with the slice of docs/plans/2026-11-mcp-consistency.md that
// converts them. `ui-mcp-parity.test.ts` checks that every published tool
// taking a continuation argument is in exactly one of the two lists, so a new
// paged tool cannot ship outside the contract unnoticed. The waiting list is
// empty once slice S9 lands.

/** Converted tools, each with the test file whose walk follows only `next.arguments`. */
export const PAGING_WALKED = {
  "kogane.identity.read": "paging-conformance.test.ts",
  "kogane.events.read": "paging-conformance.test.ts",
  "kogane.reports.read": "paging-conformance.test.ts",
  "kogane.evidence.read": "paging-conformance.test.ts",
  "kogane.audit.search": "paging-conformance.test.ts",
  "kogane.ops.operation.list": "paging-conformance.test.ts",
  "kogane.card-settlements.read": "paging-conformance-cards.test.ts",
  "kogane.card-settlements.statements": "paging-conformance-cards.test.ts",
  "kogane.card-settlements.unmatched": "paging-conformance-cards.test.ts",
  "kogane.reported-holdings-change.read": "page-read-holdings-change.test.ts",
  "kogane.purchases.explain": "purchases-explain.test.ts",
  // Walked over the pure summary (`packages/collection/test/maintenance-summary.test.ts`):
  // the tool answers that function's page as it is.
  "kogane.schedules.maintenance.read": "packages/collection/test/maintenance-summary.test.ts",
} as const;

/** Tools that still page their own way, and the slice that converts each. */
export const PAGING_WAITING = {
  "kogane.financial.query": "S7",
  "kogane.instruments.candidates": "S6",
  "kogane.accounts.candidates": "S6",
  "kogane.observations.list": "S3",
  "kogane.balances.read": "S3",
  "kogane.collection-quality.read": "S4",
  "kogane.changes.since": "S5",
  "kogane.rewards.read": "S1b",
} as const;

/** The arguments that continue a read, under any of their current names. */
export const CONTINUATION_INPUTS = ["cursor", "offset", "latestOffset", "after"] as const;
