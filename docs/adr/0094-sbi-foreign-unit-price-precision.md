# ADR 0094: Keep observed SBI foreign unit-price precision as an exact decimal

- Status: proposed
- Date: 2026-11-10
- Issue: [#1220](https://github.com/risu729/kogane/issues/1220)

## Context

Read-only replay of one distinct rejected SBI foreign-trade object, with
SHA-256 and size verified, failed at the `price` minor-unit conversion. A unit
price with finer precision does not mean the settled amount is inexact. The
closed categories and the separate cash-metric limitation are recorded in
[the source notes](../sources/sbi-securities.md#2026-11-10-foreign-trade-price-precision-and-empty-cash-metrics).

## Options considered

1. Round the unit price to currency minor units. Rejected: this changes
   provider evidence and the canonical row fingerprint.
2. Keep refusing the whole trade. Rejected: the observed unit price is an
   exact decimal, and settlement amounts still have exact minor-unit checks.
3. Validate the unit price as an exact decimal and preserve its spelling.
   Chosen.

## Decision

Parser `sbi-foreign-trade-records` `1.0.2` uses `exactDecimal` for `price`.
The settlement `amount` remains `exactMoney`; no other admission check or
posted status changes. The provider row and occurrence-based `externalId`
calculation are unchanged. Empty cash metrics remain membership issues until
their semantics are observed and confirmed.

The read-only replay includes SBI Securities failures, with allowlisted paths
and fixed reasons only. The exact cash parser selection also takes published
membership issues, superseded by a later publication of that artifact. Cash
issue messages are never classification input because they contain values.

## Consequences

Sub-minor-unit exact unit prices can be retained without rounding or losing
otherwise valid trades. Stored evidence is unchanged. A versioned re-parse
and the next scheduled run must still establish publication and current
coverage; diagnostics alone do neither.

## Verification

Synthetic fixtures cover fractional prices, settlement precision refusal,
malformed price refusal and the frozen external identity of a trade accepted
by `1.0.1`. Processor tests cover closed labels and value exclusion, plus the
cash selection against the migrated CORE schema. Production diagnosis returns
only closed categories, schema keys and counts.
