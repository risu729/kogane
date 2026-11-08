# ADR 0087: A checked-in catalogue of the data types each provider offers makes uncollected data visible

Status: proposed
Date: 2026-11-08
Issue: [#542](https://github.com/risu729/kogane/issues/542) (Phase 3, layers 0–5:
"Missing data types remain visible"); per-source issues #441–#454 under #440

## Context

The roadmap's layers 0–5 done-when requires that missing data types remain
visible. Collection quality (ADR 0045) lists cells only for what was captured:
a dataset no collector requests, a provider page nobody parses or an account
kind no collector reaches has no cell, so it is invisible. The research for
each source (`docs/sources/*.md`) and its issue already say what the provider
offers and what is not collected (SBI証券's dividends and delivered documents,
SBI VC's crypto transfers and staking rewards, みずほ's points, ...), but in
prose nobody reads beside the collection page.

The owner decided on 2026-11-08 at 03:16 UTC (Phase 3 plan, question 4) that
this list describes what each provider offers, built from the source research,
not a personal list of the owner's holdings to review.

## Options considered

1. **The owner's own list of expected data per account.** Needs the owner to
   write and keep it; declined by the owner.
2. **Infer missing types from the stored observations.** Nothing stored says
   what a provider offers but was never requested; it would only restate what
   was captured.
3. **A versioned catalogue in code, per source, checked against the parser
   registry (chosen).** Each entry names a data type and whether it is
   collected, with the parsers that publish it or the issue that tracks the
   rest.

## Decision

`provider-data-types-v1`
(`packages/application/src/collection/provider-data-types.ts`). For each CORE
source with a collector, the data types its provider offers for the account
kinds the source collects, in one closed vocabulary
(`PROVIDER_DATA_TYPES` in the collection-quality contract): `balance`,
`cash_movement`, `card_usage`, `card_statement`, `position`, `execution`,
`settlement_cash`, `asset_transfer`, `income`, `valuation_history`,
`term_deposit`, `document`, `fx_rate`, `reward_balance`, `reward_activity`,
`reward_expiry`. Each entry is one of:

- `collected` with the registered parsers that publish it;
- `partial` with those parsers and the issue that tracks the rest;
- `not_collected` with the issue that tracks it.

Example (SBI証券): `position` partial (domestic and US positions; funds and
bonds #446), `execution` collected, `settlement_cash` collected, `income`
not collected (#446), `valuation_history` partial (the current My資産
valuation only; #446), `document` not collected (#446).

Only what the research or the issue documents is listed: a provider semantic
nobody has observed is not added (ADR 0004). A source with no collector is not
catalogued (`dataTypes: null`); its absence is already the `no_collector`
reason. SBI Shinsei's issue #447 was closed on 2026-10-10 with no comment while
its dated history, monthly reports and product details are still not
collected (docs/collection.md), so its entries point to the backlog #440.

The collection-quality summary carries `dataTypesVersion` and, per source,
`dataTypes` (`apiVersion` 4); `kogane.collection-quality.read` answers the same
and its description names the catalogue. The page lists the entries per
source under 取得元が提供するデータ種別, with each issue linked, and the
source list counts the types not wholly collected. The account view of
ADR 0088 can show its source's entries once it is merged.

A test checks the catalogue against the parser registry: every name is a
registered parser, each parser belongs to one source, and every registered
parser is named unless it publishes no observation (the two evidence-boundary
parsers) or no collector feeds it (`paypay-csv`). A collector that gains a
parser therefore fails the test until the catalogue says what the parser
publishes.

## Consequences

- A data type is visible as not collected before anyone builds it, with the
  issue to follow.
- The catalogue is maintained by hand: a provider adding a service, or a
  collector extending its scope without a new parser, needs a pull request
  that changes the entry. Changing the vocabulary or a status's meaning is a
  new version.
- `collected` says a parser publishes the type, not that production is
  current or complete for every account or period: the cells, their reasons
  and their freshness (ADR 0045) say that.
- The catalogue is not per account: whether a given account holds a product
  (a term deposit, a fund) is not known from it.
- No migration, table, writer, grant or tool is added.

## Verification

Synthetic and static only. `packages/application/test/provider-data-types.test.ts`
(the sources described, parser names against the registry, one owner per
parser, entry order and fields per status, copies);
`packages/application/test/collection-quality-query.test.ts` (the summary
carries the entries, a source with no collector carries none, the contract
refuses an entry whose fields its status does not allow and a repeated type);
`apps/web/test/collection-quality.browser.test.ts` (the page lists them).
The entries were not compared with production holdings, by design.
