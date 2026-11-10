# ADR 0103: MoneyForward detail-page reported measures

- Status: proposed
- Date: 2026-11-10

## Context

Issue #1240 asks for balances and holdings from already stored MoneyForward
detail HTML. A read-only observation of every accessible linked detail found
bank aggregate yen values, unavailable card amounts and one point quantity/value
table. Securities holdings were unavailable to observe. The source notes record
only structural evidence. No new collection request is necessary.

Bank product rows have no observed stable identity. Some rows are missing, and
foreign product labels accompany explicit yen amounts. A second deposit table
duplicates the main table. An input named `user_asset_act[updated_at]` belongs
to manual transaction entry; it is not the provider's retrieval timestamp.

## Options considered

1. Publish product rows under positional identities or infer native currencies.
   This would invent account continuity and currency semantics.
2. Publish only the observed, explicitly reported aggregate and point measures,
   retaining their MoneyForward account identity and excluding them from sums.
3. Leave every detail page evidence-only until securities are observable.

## Decision

Choose option 2. Add `moneyforward-detail-balances@1.0.1` alongside the frozen
evidence boundary. The existing `account-detail` descriptor already routes the
same stored bytes; neither registration contracts nor collection routes change.

- Validate the existing run/account/document boundary first. Match exact
  observed headers, direct table structure and bounded row shapes; reject
  unknown structures with closed errors. Require explicit closing tags for
  HTML, body and every selected account/portfolio section; a repaired DOM
  cannot prove complete membership after a truncated capture.
- Emit one `reported_account_value_jpy` balance for the bank's root aggregate.
  Verify it equals the exact sum of the available numeric main-table rows.
  Missing rows remain unavailable; this check does not assign them zero.
  Neither product rows nor the duplicate deposit table are published.
- Match the complete points/debt headers, because both sections share an ID.
  The observed single point row emits `reported_point_quantity` in `POINT`
  and `reported_point_value_jpy` in JPY. `POINT` is a provider-local reported
  unit, without a cross-provider reward-program identity. The conversion rate
  is retained with the source cells. Its observed exact product must agree
  with the displayed JPY value; no alternative value is calculated.
- An undetermined card payment, premium-gated debt, missing product amount and
  unobserved securities holdings remain closed diagnostics. No debt zero or
  securities position is invented, and no premium gate is bypassed.
- Keep all observations on the existing digest/HMAC MoneyForward source account.
  All three metrics are explicitly non-additive and retain the unknown legacy
  fallback. They are visible financial evidence without becoming direct bank
  deposits or known-assets subtotal members. ADR 0093's direct-source allow list
  and containment/overlap rules are unchanged.
- Store capture time only as `observedAt`; omit `asOf`. The underlying
  provider's freshness remains unknown. Manual-entry and debt acquisition dates
  never become a balance timestamp.
- Migration 0091 registers the observed-measure snapshot contract under
  `coverage-v1`. Complete membership describes only the explicitly supported
  aggregate/point measures, not every product or holding the provider offers.
  A parse with no available measure is partial and cannot erase an older
  snapshot. A valid newer observed-measure container replaces the older one.
  The local observation store mirrors this policy idempotently and preserves
  an existing operator policy choice.

## Consequences

The data-type catalogue marks balances, positions and reward balances partial,
with #1240 tracking native product identity/currency, gated card balances,
securities schema and other unobserved account kinds. The position entry names
the parser that records the unavailable holdings diagnostic; it emits no
positions today. Stored historical HTML with another shape is rejected.

Raw provider cells remain financial observation evidence. Operational diagnostics
contain closed codes and locators only. No provider labels, identifiers or
amounts belong in logs, repository fixtures or review text; fixtures are synthetic.

## Verification

Synthetic parser tests exercise observed bank/card/point shapes, duplicate
deposit suppression, missing values, unknown headers/currencies, mismatched
totals and truncated tables. Contract fixtures pin the new output separately
from historical parser expectations.

A synthetic collector-plan-to-reader test uses actual registration, publication,
identity resolution, observation reader and READ projection/subtotal reader.
It verifies the MoneyForward account, reported JPY unit, absent provider as-of
and exclusion from known-assets subtotals. Snapshot tests verify replacement
and retention across unavailable captures.

Production replay, production publication and a live financial-reader check are
not performed by this change. Those remain rollout validation, not evidence
that code or CI alone can provide.
