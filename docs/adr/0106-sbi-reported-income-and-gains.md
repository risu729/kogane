# ADR 0106: Preserve reported SBI payments and sales as complete retained containers

- Status: proposed
- Date: 2026-11-10
- Issue: [#1236](https://github.com/risu729/kogane/issues/1236)

## Context

The observed My Assets income and realised-gain pages state retention since
August 2021. Income returned 14 rows, matching both its independent summary
and the visible total. A domestic sale returned one row, matching the
all-product and domestic summaries. Detail labels establish domestic JPY
fields and US-stock original-currency USD `Lc` fields. Continuation beyond
the first 30 rows, other products and foreign realised gains remain unobserved
([source notes](../sources/sbi-securities.md#2026-11-10-my-assets-income-and-realised-gains)).

No provider row identifier was observed. A union of amount-based fingerprints
across runs would retain a corrected payment/sale alongside the original.
The observed complete full-retention container provides a stronger membership
boundary than an invented cross-capture correction match.

## Options considered

1. Derive income or realised gains from cash movements or trades. Rejected:
   those are different provider statements and cannot replace reported gains.
2. Append fingerprints and union their latest revisions. Rejected: a corrected
   identifying amount, date or quantity could become a second current payment.
3. Preserve all evidence and select the latest complete full-retention
   container separately for payments and sales. Chosen.

## Decision

- Every normal domestic main-site run requests `2021/08/01` through the current
  JST date, independently of legacy execution-window arguments. Use the observed
  empty income filters, contract-date gains filters and `offset=1&limit=30`.
  Read income summary and rows; read all-product and domestic gain summaries
  plus domestic gain rows. There is no new collection parameter, continuation
  cursor, login or manual collection.
- Reuse the bounded response reader: count actual stream bytes before assembling
  a body, under its unchanged 256 KiB ceiling. The existing bounded structural
  JSON reader validates the original grammar and decoded-key uniqueness before
  any numeric-token representation changes. Original financial numbers are
  preserved as token strings, then parsed with exact decimal arithmetic.
  Numeric strings supplied by the provider cannot impersonate numeric fields.
- Only the closed observed field/type schemas enter private raw storage.
  Keep exact summary and row bytes as unmapped `provider_response` sources.
  Unknown keys, duplicate aliases, malformed JSON and unexpected authentication
  payloads fail before raw storage. Financial-shaped precision, code, count or
  continuation refusals retain the eligible original bytes, produce no canonical
  artifact and make the domestic unit/run partial with closed codes only.
- A derived `income-payments.json` or `realised-gains.json` carries the exact
  source texts and fixed requested range. The parser rereads the original tokens
  and revalidates every code, date and control count. Ordered input edges name
  every source; persistence checks source hashes and the exhaustive inventory.
  `terminal-registration-v9` maps only these derivatives and their requested
  ranges. Versions 1–8 retain their meanings.
- Publish the observed domestic/US-stock payment rows only. One logical payment
  has reported gross, total tax, income tax, resident tax and after-tax net
  metrics. Domestic values are JPY; USD uses `Lc` fields. The corresponding yen
  equivalent stays metadata, not another income payment. Null metrics create an
  unavailable-field issue and no zero. Unused domestic `Lc` fields remain exact
  metadata without inferring their currency or publishing another payment.
  Interest/fund/bond/other products remain
  unsupported; public menu codes alone do not prove their response semantics.
- Publish domestic `SELL` rows as provider-reported sale proceeds, realised gain
  before tax, unit price and average acquisition unit cost. Use contract date
  while retaining settlement date. Never calculate gains from quantity/price
  or trades. Currency amounts must be exactly representable in minor units;
  per-unit values retain exact decimal text without invented minor units.
- Use valuation observations with separate payment/sale subjects and source
  accounts, not new cash transactions, trades or adopted economic events.
  Explicit domain metric definitions are provider-reported event flows/prices,
  non-additive and in overlap groups with cash/trades. They never enter automatic
  totals or net assets, and observed metrics do not fall back to unknown types.
- Within a response, normalized quantity, original-currency net/proceeds and
  product/account/date fields plus occurrence identify repeated rows. Labels,
  numeric spelling and USD yen equivalents do not change that identity.
  No cross-capture correction match is inferred from these fields.
- Migration 0093 selects each dataset's latest published **complete container**
  through existing `coverage-v1` snapshot policy, on run eligibility. Its range
  always starts at August 2021; the newer complete response replaces all prior
  membership, including corrected or removed identities. An explicitly counted
  complete-empty response replaces old rows. Failed/partial captures preserve
  the last complete current snapshot; raw objects and observations stay append-only.
- `ObservationReader.listSbiIncomeHistory` is an internal typed production read
  over that existing snapshot selection. It returns per-payment/sale facts with
  provenance and exact amounts, filtering/paging after membership selection.
  Income/gains, currency, account, metric and date filters never union cash or
  trade rows. No public route, UI or MCP operation is added.

## Consequences

At most five observed requests cover the supported retained routes each day,
with no state. The summary's independent count and category counts must equal
the rows. More than 30 rows, an unknown product, inconsistent summaries or
missing evidence makes the run partial; no unobserved offset is requested.

The catalogue's existing `income` and `valuation_history` types remain partial.
This does not establish scheduled production publication, continuation beyond
30, foreign gains, interest/fund/bond income or universal monetary precision.
The issue stays open until a normal scheduled run proves actual retained
coverage, counts and publication. No production collection is part of this PR.

## Verification

Synthetic parser/collector cases check exact decimal tokens, native type guards,
decoded duplicate-key secrets, malformed fragments, nulls, unsupported codes,
control counts, continuation refusal, exact raw bytes and missing/altered inputs.
Historical coverage fixtures remain unchanged; new expectations live separately.

The production-path integration test uses shared R2, actual registration,
`parseJob`/publication and the production reader. Repeated captures remain unique;
a changed net/date/quantity and a removed row replace old current membership;
a corrected sale stays one sale. An inexact partial capture keeps eligible raw
evidence and the preceding current snapshot. A complete-empty payment response
retires payments without removing gains. The cash transaction reader remains
empty. Metric tests prove typed non-additivity; frozen registration checks keep
versions 1–8 unchanged.
