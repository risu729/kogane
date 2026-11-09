# ADR 0098: Preserve SBI weekly asset history and select one revision per point

- Status: proposed
- Date: 2026-11-09
- Issue: [#1238](https://github.com/risu729/kogane/issues/1238)

## Context

The collector saves current My Assets valuations but not the weekly chart's
history. The [2026-11-09 observation](../sources/sbi-securities.md#2026-11-09-weekly-asset-history)
found one request with 44 weekly points. Choosing all periods only filters the
response in the browser; no extra request or historical-window parameter was
observed. These points do not establish account history back to August 2021.

The four response profiles overlap. `holdCategories`, rather than every row
under `valuationsTransitions`, determines which categories contribute to that
profile's `ALL`. In particular, WithoutDeposit retains nonzero deposit rows
outside its two listed stock categories. Native balance/acquisition tuples
repeat `ALL`, and two iDeCo-related profiles are explicitly unavailable.

Observations and raw evidence are append-only. The existing publication
pointer chooses one parse per artifact, not one weekly point across artifacts.
There was no production reader selecting portfolio valuation history.

## Options considered

1. Replace the whole latest response through a complete-container snapshot
   policy. Rejected: unavailable profiles cannot prove a complete container,
   and a later response with fewer weeks would hide earlier witnessed points.
2. Append points with stable subjects alone. Rejected: this archives evidence
   but does not implement deduplication in a production reader.
3. Append evidence and select the newest witnessed revision per point in the
   existing observation reader. Chosen.

## Decision

- Normal scheduled main-site collection makes the observed read-only
  `GET /account/api/assets/valuations`, using its existing cookies and referer.
  It adds no query, body, CSRF header, login or collection operation parameter.
  A closed shape audit precedes storage; unknown fields/categories, unsupported
  positive iDeCo shapes or excessive point counts fail closed with static codes.
- Preserve the audited full response's exact bytes as unmapped
  `account-assets-history-source.json` (`provider_response`). The Processor's
  existing 2 MiB observation-output limit can reject a multi-year response,
  so derive fixed calendar-year shards, each containing at most 53 weeks.
  This is a local partition, not a provider query parameter. Keep all profiles
  and residual rows for each year. `account-assets-history-<year>.json`
  carries its year, the original history fields and source key/hash, fixed GET
  path and capture time. An unmapped derived inventory records every expected
  year key/hash/count. Its input is the exact source; each year's inputs are
  source and inventory. Registration therefore records linked lineage.
- Before partitioning, the collector applies the same semantic validator as
  the parser to the **whole** original response. A cross-year gap, missing
  year, mismatched profile calendar or extra native tuple cannot disappear
  during filtering. It creates no derivatives from an invalid source.
- Financial and native numeric tokens are checked with exact decimal arithmetic
  before conversion to Number. Their mathematical values must be safe integers;
  decimal/scientific spellings do not waive exactness. Rates remain finite
  metadata and are never emitted as monetary metrics. A shape-only audit uses
  numeric stand-ins solely to check the closed secret-field contract, without
  changing any key or string. This allows financial-shaped but semantically
  invalid original bytes to be retained privately; strict derivation reads
  those bytes again and refuses them with a closed code. Unknown fields and
  unexpected authentication payloads still fail before raw storage.
- `sbiRunPlan` recomputes the exhaustive inventory from retained source bytes.
  A missing, duplicate, altered or extra history derivative makes the run and
  existing domestic unit partial with `sbi_asset_history_shard_inventory`.
  Keep available evidence; never invent a missing parent edge. Year keys and
  the domestic unit are stable across overlapping runs. Size limits stay fixed.
- `terminal-registration-v5` maps only the yearly derived history keys to the
  new dataset; raw source and inventory remain unparsed. Versions 1–4 retain
  their exact mappings and v4's dated execution-range semantics.
- Parse each listed category plus `ALL` for each available profile/week. Use
  integer JPY valuation, acquisition cost and non-null unrealized profit/loss;
  retain rates as provider metadata. Validate Saturday midnight JST anchors,
  weekly cadence, native tuple equality and exact listed-category sums for
  valuation/acquisition cost. Native tuples corroborate `ALL`; they emit no
  additional financial facts. Unlisted rows remain in raw bytes and aggregate
  metadata, without becoming included-category facts.
- Keep `sbi-securities:account-assets` as the portfolio source account. A
  subject is `portfolio:weekly:<profile>:<category>`; date, currency and metric
  complete the logical key. No instrument/account mapping is inferred from
  a category. Current summaries keep their separate subjects.
- A null metric creates an unavailable-field issue and no numeric fact. Null
  profiles create unavailable-container issues and no observations. Available
  profiles have separate window claims about their listed points; the whole
  response is partial. Neither a null view nor an absent earlier week is zero.
- `ObservationReader.listPortfolioValuationHistory` is an internal production
  read, with no new UI, HTTP route or MCP operation. It uses published parses
  over sealed eligible evidence, first choosing the latest capture/parse for
  `(source, parser name, source account, subject, currency, point date)`, then
  one metric row. Capture time leads artifact and parse ids as deterministic
  tie-breakers. Parser **name** denotes one logical transformation; **version**
  identifies a build and is not part of a financial point's identity.
  Re-parsing an old capture does not outrank a newer capture.
- Null metrics in a newer point do not resurrect from an old revision. Weeks
  absent from a shorter later response keep their last witnessed revision.
  Selection precedes metric/date filters and bounded pagination. The caller
  selects one profile and one category (default `ALL`); aggregate and breakdown
  are alternatives, never an automatically combined total.
- Successfully captured main-site artifacts reach the existing worker sink
  immediately. A later sibling failure retains these bytes while the run and
  domestic unit stay partial under the existing eligibility policy.

## Consequences

The existing reader now serves one latest revision of each witnessed point
while every raw capture and superseded parse remains available as evidence.
No snapshot policy, migration, infrastructure or public operation is added.

The catalogue stays `partial`, linked to the issue. This change does not prove
August 2021 coverage, positive iDeCo shapes or scheduled production collection.
A normal scheduled run must establish its complete returned inventory,
registration/publication, earliest/latest keys, count, freshness and execution
budget. Any additional historical route needs observation before implementation.
The issue remains open for that production and retention proof.

## Verification

The long synthetic integration fixture contains 312 consecutive weeks. Its
unpartitioned observation output exceeds 2 MiB, while every calendar-year
shard stays below the unchanged cap. All year shards register, publish and
read back through the production path; an overlapping short run still yields
312 unique valuation points, and paged metric reads have no duplicate rows.
Raw source bytes, source hashes and both input edges are checked. Regression
cases require identical direct-source and collector refusals for cross-year
and missing-year gaps, extra native tuples, fractional tokens that round to
integers, unsafe integer edges and exponent underflow. Local Worker R2 tests
retain inexact financial-shaped raw bytes with a closed partial outcome and
no derivatives while still refusing unknown secret fields.

Synthetic parser tests cover conditional category membership, native tuple
agreement, nulls, exact money, calendar/schema drift and stable logical keys.
An end-to-end test uses the collector plan, actual registration, Processor
`parseJob`/publication and D1 observation reader: overlapping captures return
one corrected revision, a shorter response retains the older week, a new null
does not revive old profit/loss, and a newer parser publication stays unique.
Superseded observations remain archived; a newer failed parse cannot replace
the selected evidence. Registration tests freeze v1–v4 behavior. Collector
tests assert the exact request and retain already fetched evidence on a later
failure. No production collector run is part of this change.
