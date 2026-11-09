# ADR 0093: Treat listed direct deposit readings at different banks as disjoint

- Status: accepted (merged 2026-11-08 in [#1195](https://github.com/risu729/kogane/pull/1195))
- Date: 2026-11-08
- Decision basis: the owner's allow-list variant of option 2, recorded at
  2026-11-08 06:59 UTC in [issue 1150](https://github.com/risu729/kogane/issues/1150).

## Context

The cross-source balance policy previously required two identified accounts.
Account identity rules do not currently assign that status, so direct deposits
at different banks remained an unknown overlap. An overall known-assets
subtotal could not include these deposits even though each bank reports its
own account. An identity re-run could change mapping references cited by
ownership evidence, and is unnecessary for this limited disjointness rule.

## Options considered

1. Identify accounts from provider identifiers: broader work with privacy and
   mapping-reference consequences.
2. Declare direct deposits at different institutions disjoint, initially with
   exclusions: rejected in favor of an explicit allow-list that fails closed
   for a new source.
3. Adopt a manual relation for each pair: safe but requires repeated owner work.

## Decision

Use `distinct-identified-accounts-v2`. Preserve the existing within-source and
identified-account rules. Add cross-institution disjointness only when every
witness of both scopes has direct authority rank zero, neither scope is
aggregate or unresolved, and the metric registry resolves it to `deposit.balance`.
The source-to-institution allow-list contains SBI Shinsei, SMBC and Mizuho.
Unknown sources do not qualify even if a later registry entry describes them.

The registry currently names SBI Shinsei's yen-deposit account and top-page
account balance, SMBC Direct balance and Mizuho account-list balance. The list
uses this registry definition, never the legacy balance classification. Its
condition is that each listed screen reports that institution's own deposits.
SBI Securities buying power, Sony's balance after a transaction and Prestia's
term-deposit principal are different metrics and gain no disjointness here.

MoneyForward, lower-authority restatements, unknown metrics and unresolved or
aggregate scopes gain no new relation. Existing `connection_contains` handling
is unchanged. Multiple witnesses of one scope must all qualify at the same
institution, independently of input order.

## Consequences

The projection feeds both the latest-balances read and financial-query
holdings, so both use the same adopted set. Amounts still use exact domain
arithmetic, and different units are never added. Identity mappings, evidence,
grants and storage schemas are unchanged. The policy release participates in
the projection build digest: a later Processor tick builds a new snapshot
instead of rewriting an old one.

Production verification remains pending merge, deployment and a completed
projection tick. A read-only check must confirm a whole-store JPY subtotal
with `reasonCode: null`; no production amount or account label is recorded here.

## Verification

Synthetic projection tests cover all current listed readings, both excluded
scope statuses, lower-authority and unknown routes, unknown parsers and metrics,
and mixed witnesses in both input orders. Existing SC01 and SC06 fixtures still
retain possible duplicates. Workspace and root checks are recorded in the PR.
