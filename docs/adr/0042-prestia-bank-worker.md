# ADR 0042: PRESTIA bank snapshots and non-additive provider measures

- Status: proposed
- Date: 2026-10-05

## Context

GLOBAL PASS is a debit-card activity source, not the PRESTIA deposit surface.
A locally authenticated portable HTTP client has reached a structurally recognized
bank account-summary page. That is local evidence, not proof of a deployed Worker.
Observed bank labels distinguish native available amounts, term principal, bank
yen-equivalent group totals and three monthly-average qualification measures.
Production values are not copied into fixtures or documentation.

## Options considered

1. Reuse GLOBAL PASS identity or derive row-level FX values: rejected because
   neither identity equivalence nor per-row conversion was observed.
2. Treat every provider amount as current stock: rejected because availability,
   overlapping totals and monthly qualification have different meanings.
3. Register a separate bank collector and retain those distinctions: selected.

## Decision

- Terminal source `prestia-bank`, producer `collector-prestia-bank`, maps to existing
  CORE source `prestia`. The sanitized `balance.html` artifact has dataset
  `prestia-bank-balance-html`, unit `balance-summary`, parser
  `prestia-bank-balances@1.0.0`. No transaction-history completeness is asserted.
- Migration 0066 pins `coverage-v1` at run scope. Empty results cannot replace a
  previous snapshot. Partial or failure terminals are not upgraded by registration.
- Native account references retain account/currency and, for terms, deposit
  reference. Product labels are not durable identity. Group and relationship
  references remain aggregate identities; no GLOBAL PASS alias is adopted.
- `metric-registry-v2` adds available capacity, term principal stock, provider
  group valuations and monthly-average qualification metrics. All seven measures
  are non-additive and not automatically net-asset eligible. Bank TTB yen
  equivalents are section aggregates, not row-level FX. Qualification averages
  are neither income nor current stock; the provider period stays unspecified
  unless stated, rather than guessing a calendar month.
- Provider yen totals and monthly averages remain valuation observations, not
  synthetic positions or current/native stocks. The existing artifact parse-run
  references and `/api/observations/valuation/:id` detail reader expose exact
  amounts, notes and period metadata. They do not appear as extra native rows
  in the current balance screen.
- `source-authority-v3` reviews `prestia` as the institution's direct witness.
  Rank alone does not establish overlap or authorize adoption.
- Deploy `kogane-prestia-bank-collector` before its Processor RPC consumer through
  the prebuilt cf backend established by [ADR 0040](0040-compatible-cf-version-deployment.md).
  Native configuration mirrors canonical Wrangler bindings, required-secret names
  and variables; `RELEASE_SHA` comes from the stamped canonical config. Both
  credential-free cf build/version-upload dry runs and canonical Wrangler checks
  remain. No native routes, Worker Crons or trigger synchronization are added.
  Processor-managed scheduling uses `SCHEDULE_PRESTIA_BANK` and the shared
  execution lease. The daily 06:30 Asia/Tokyo job is seeded disabled; Worker
  Cron triggers stay empty. First production collection and downstream parse
  verification precede any separate schedule activation.

## Consequences and limits

Evidence and observations remain append-only, decimals exact, and operational
output limited to counts and closed codes. No bank values, credentials or
provider text belong in operational logs. OTP/challenges remain human-required.
A local accepted login is not production verification; PR merge, deployment,
first collection, parsing/publication and schedule activation are separate states.
No maintenance rule or empty-account meaning is guessed. Per-row yen conversion,
income inference and transaction history remain unsupported.

## Verification

Synthetic parser fixtures mirror only observed structures. Focused tests cover
closed artifact mappings, metric/legacy-classifier parity, non-additivity,
durable/aggregate identity, source authority, disabled migration seed and
deployment order. The owner records independent review, full checks and the
separate production readback before changing the pending production state.
