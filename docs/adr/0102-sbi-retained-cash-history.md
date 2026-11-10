# ADR 0102: Preserve retained SBI cash history with checked page coverage

- Status: proposed
- Date: 2026-11-10
- Issue: [#1226](https://github.com/risu729/kogane/issues/1226)

## Context

The yen collector fetched only statement initialization and refused multiple
pages. USD cash balances did not establish movements. The
[dated browser observation](../sources/sbi-securities.md#2026-11-10-retained-cash-statements)
established the yen query/paging request and a five-year foreign-cash read.
The latter returned no stable row identifier and only one page; a second-page
request remains unobserved. These statements describe settlement cash, including
dividend-labelled receipts, without authorizing a second income publication.

## Options considered

1. Add a requested collection window or progress cursor. Rejected: the normal
   run can request the observed full-retention presets directly; the observed
   response needs only two yen requests and one foreign request.
2. Derive one transaction id from each foreign row's fields. Rejected: two
   identical provider rows can be distinct receipts.
3. Retain checked pages with a complete derived bundle, preserving foreign-row
   multiplicity through an occurrence ordinal. Chosen.

## Decision

- Every normal main-site run requests the two-year yen and five-year foreign
  presets through JST today. The start is the day after the corresponding
  anniversary. Execution-only legacy window arguments never shorten cash
  retention, and no operation parameter or cursor is added.
- Use only observed GET paths, filters, sort and page size 10. Yen page 2
  changes only `pageNumber`; walk the declared contiguous chain, bounded by
  2,000 pages / 20,000 rows. Foreign continuation remains unsupported: a
  multi-page response stops with `sbi_foreign_cash_pagination_unobserved`.
- The exact original JSON grammar, duplicate keys (including escaped aliases),
  numeric integer tokens and the closed response/row fields are audited before
  retaining raw page bytes. Unknown/private envelopes are refused. Known
  financial response bytes remain evidence when later coverage checks fail.
- Keep each page as `<dataset>-page-NNNN-source.json`, `provider_response`.
  The derived `<dataset>.json` uses `sbi-retained-cash-history-v1`, carrying
  the requested full-retention range and every page. Its transformation names
  every source page. Shared persistence rechecks that exhaustive inventory
  and original parsed content; missing or altered inputs make the unit partial.
- Validate page cardinality, consecutive yen page numbers, unchanged controls,
  provider totals, expected row counts, duplicate yen `did`, known direction,
  detail/currency/cash-type labels, unsigned exact amounts, descending calendar
  dates and requested-range membership before publishing any observations.
  Yen deposit/payment counts and exact domain sums must match their controls.
  Positive transfer controls remain unsupported because their relationship to
  the other controls was not observable when both transfer counts were zero.
- Preserve existing yen `sbi-yen-detail:<did>` ids and legacy parser input
  compatibility. USD ids use normalized row fields plus a whole-bundle
  occurrence ordinal. Identical rows retain separate ids; repeated full-range
  captures retain the same ids. The production transaction reader includes
  the new parser in its existing external-id revision selection.
- Register `foreign-cash-history.json` only from registration v7; v1–v6 stay
  reproducible. Raw pages stay unmapped. Requested cash ranges are attached
  to v7 descriptors when present. Both cash datasets belong to the domestic
  main-site unit, including USD, because that session acquires them.
- `sbi-yen-detail-history@1.1.0` and `sbi-foreign-cash-history@0.1.0` publish
  transaction observations with complete-container claims only after these
  checks. Transaction-family registry v5 records the latter as securities
  settlement cash with fingerprint identity; it enables no economic-event writer.
  The provider-data-type catalogue stays partial under #1226 pending the
  unobserved continuation/transfer semantics and scheduled publication proof.

## Consequences

Raw financial evidence and superseded parse rows remain append-only. Invalid
coverage never becomes zero or complete. Known receipts are settlement cash
only; separate income semantics and other foreign currencies are unobserved.
The scheduled run's full retained coverage, freshness and 13-minute execution
budget still need authorized production verification.

## Verification

Synthetic tests cover multi-page yen totals, every retained row and stable
provider ids; duplicate USD receipts, withdrawals, exact cents and overlapping
capture identity; missing/reordered/changed pages, unknown codes, impossible or
out-of-range dates, raw-number rounding, duplicate keys and malformed JSON;
source inventory and terminal lineage; and real shared-R2 registration,
parse/publication and the production reader across two overlapping captures.
