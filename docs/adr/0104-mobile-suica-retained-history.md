# ADR 0104: Walk retained Mobile Suica history with inclusive date overlap

- Status: proposed
- Date: 2026-11-10

## Context

The observed PC history search returns at most 100 rows on or before the selected
JST date, within 26 weeks. Its oldest displayed row omits the amount; an overlapping
search can reveal it. The site has no observed transaction identifier. Equal rows
can be legitimate separate occurrences. Issue #1255 requires complete daily acquisition.

## Options considered

1. Keep the single-page partial boundary.
2. Move to the previous day, potentially dropping unseen boundary-day rows.
3. Search inclusively and replace the verified boundary-day suffix.

## Decision

Use option 3. A capped page requests its oldest date again. Every previously seen
boundary-day row must match the next page's prefix in provider order; only an
unavailable amount may become available. Replace that whole day's suffix with the
next response. Never set-deduplicate rows. A capped single day or non-progressing,
missing or changed overlap refuses completeness. A final sub-100 page proves the end.

Each run acquires the whole retained history without a checkpoint or API window.
Bound work to 183 pages, 2 MiB per response and normalized bundle, 32 MiB total
responses, and ten minutes of HTTP acquisition. The holder's existing 13-minute
boundary remains unchanged. Time/size limits refuse a run; no partial transaction
bundle is published. Successfully sanitized pages remain private append-only evidence
when a later acquisition/proof fails.

Keep every sanitized CP932 page, including the observed dedicated empty-message
response. Redact its session and navigation hidden values; reject unknown hidden
fields and unknown message/login responses. Multi-page normalized bundles retain
all page rows, cursor dates, and the merged rows. The parser reproduces the overlap
proof, validates every row, and records each merged row's page/row provenance.
Terminal transformations reference every input page. Legacy sub-100 bundles remain
accepted and unchanged. A row older than the documented 26 weeks keeps the parser's
existing preserved warning; only a year-wrapped month/day inference (365 days or
older) refuses the run. Missing amounts remain null and emit no transaction.

Keep existing canonical-row-plus-occurrence transaction IDs. The boundary row with
an unavailable amount emitted no transaction before enrichment. Production
`transactionsSql` already ranks Mobile Suica observations by source, account, parser
and external ID across runs, so no reader change or registration-version bump is
needed. `sf-history.json` keeps its existing descriptor and HTML stays evidence only.
The catalogue now records collected cash movement; it describes implemented retained
coverage, not a claim of a new production run or observed real capped page.

## Consequences

Repeated daily captures retain all evidence while exposing each witnessed transaction
once. Identical occurrences survive. Live multi-page behavior, high-volume runtime
and long-term scheduled results remain unverified; real capped pages were unavailable
in the observed account and are represented only by synthetic fixtures.

## Verification

Synthetic tests exercise inclusive overlap, boundary amount enrichment, identical
occurrences, exact amounts, year rollover, known-empty responses, malformed pages,
changed/repeated/missing overlaps and single-day saturation. A real collector to
shared R2, registration, parser publication and production-reader regression captures
two runs: 200 archived transaction observations expose 100 logical transactions.
