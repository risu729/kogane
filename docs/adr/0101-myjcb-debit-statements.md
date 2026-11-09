# ADR 0101: Read observed MyJCB debit statement rows separately from credit payments

- Status: proposed
- Date: 2026-11-10
- Issue: [#1239](https://github.com/risu729/kogane/issues/1239)

## Context

The owner's authenticated, read-only observation confirmed MyJCB debit
statement pages, fifteen offered month positions, desktop/mobile copies of
the same rows, and two different desktop schemas. An ordinary transfer and
a negative difference can share their merchant and approval number.
The separate `od_details` route is a different statement surface: all fourteen
offered past months explicitly reported no charges in the observation.

## Options considered

1. Reuse the credit ledger/payment model. Rejected: debit transfer dates,
   difference dates and provider statuses carry different evidence.
2. Deduplicate by approval number. Rejected: that drops the observed difference.
3. Parse the sanitized desktop tables, retaining each section and its provider
   columns separately. Chosen.

## Decision

`myjcb-debit-ledger@1.0.0` reads dataset `debit-detail` as sanitized HTML.
The collector and parser share the same structural reader. It admits only the
observed six-column ordinary and seven-column difference schemas inside
`.pc-disp`, skipping `.sp-disp` duplicates. The only supported difference
status is `銀行振替済`; changed status, columns or row shape fails closed.

Each observation retains the original columns and section. Provider debit
amounts become outflow-negative transaction observations; a signed difference
retains its sign before that explicit conversion. Nothing creates a cash
reconciliation, a credit payment, an adopted purchase or a cross-account match.
Difference status `銀行振替済` is recorded verbatim in provider metadata and
maps to the closed observation status `bank-transferred`; ordinary rows use
`transferred`. Transaction-family registry v4 records fingerprint identity
and an unsupported purchase writer for these rows. Debit transfer rows are
not classified as credit-card settlements.

Registration v6 adds only `debit-detail` and `debit-other-detail` sanitized
HTML datasets. Versions v1 through v5 retain their earlier mappings, and debit
menus stay evidence-only. Parser releases are self-registered as usual.

External IDs fingerprint the section and complete row contents, with an
occurrence suffix for identical rows within one page. Month position and
capture time do not participate, so a row moving through the rolling selector
keeps its ID. Approval number alone never identifies a row.

Zero rows require exactly one observed `p.comment` no-details marker naming
the exact period selected in `select[name=seq]`. Missing tables or unfamiliar
empty wording remains unread/partial. Each daily run enumerates the currently
offered month positions and reads all of them without a cursor or request
window. Unknown months are retained as evidence and reported unread.

The separate difference/other menu is read after ordinary statement capture.
Every offered sequence in `1..14` is read with the official Shift_JIS-encoded
`inquiry` parameter. `myjcb-debit-other-statement@1.0.0` admits only the
observed explicit no-charges heading. A separate `:debit-other` terminal unit
is complete only when every offered period states that absence; unfamiliar
content is retained as sanitized evidence and the unit is partial. The parser
refuses nonempty/unrecognized pages and publishes no invented amount.

Migration `0090` adds eligibility-only policies (`unit_scope=unit`,
`snapshot_selection=0`) for the two new datasets. A successful connection or
other-statement unit can be parsed when a different connection failed in the
same run. It does not select one rolling month as a replacement for all the
other months, and changes no existing dataset policy.

The observation does not establish a safe display-switch implementation:
the relay response bodies and a stable per-card identity remain unproved.
Switching stays deferred. Each independently configured credential connection
can collect the observed debit routes. Adding credentials remains the owner's
action; no secret is read or changed. This PR is related to the issue and does
not close its all-confirmed-cards acceptance criterion.

## Consequences

The catalogue names the debit parser under both card usage and statements,
while retaining `partial`: unsupported difference statuses, document formats,
and unobserved routes are not complete collection. The separate nonempty
`od_details` schema remains unsupported. PDF/CSV bytes were not observed in
this work and are outside this parser contract.

Deploying code proves neither successful owner authentication nor a production
scheduled capture. Existing evidence is unchanged; future captures append new
objects and observations.

## Verification

Synthetic tests exercise offered-month enumeration, collection, sanitization,
shared evidence planning, parsing of persisted bytes, duplicate mobile markup,
signed differences sharing an approval, stable identity across month positions,
explicit empty periods, and refusal of unknown statuses and invalid dates.
Separate-route tests cover all fourteen offered periods, exact query encoding,
known-empty terminal coverage, and preservation/refusal of unknown content.
No provider values are used in fixtures.
