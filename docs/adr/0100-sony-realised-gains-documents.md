# ADR 0100: Sony annual realised gains and delivered PDF evidence

- Status: proposed
- Date: 2026-11-10

## Context

Issue #1250 needs the bank's two years of realised FX results and delivered documents. Read-only owner-machine observation proves annual currency summaries and a complete 15-column detail CSV, a five-year foreign-document query with one page, and PDF bytes. Fund access is unavailable for the observed account. Nonempty valuation-portfolio and document pagination schemas have not been observed.

## Options considered

1. Recompute gains from ordinary history or publish detail rows as cash income. This would invent semantics and duplicate movements.
2. Parse an unbounded full-history detail CSV into observations. This could exceed the fixed two-MiB parser output cap.
3. Publish the bounded provider-stated annual summaries, retain detail CSV/PDF evidence privately, and isolate independent collection results.

## Decision

Choose option 3. Each year has a stable `realised-year-YYYY` fetch unit and an artifact referencing unchanged provider response bytes. The parser scopes its complete-container claim to that year/unit and emits at most 26 valuation observations. The existing production snapshot selector partitions by fetch-unit key: repeated runs replace only the same year, and rollover retains older collected years. FX gains and after-tax interest use distinct annual metrics, never cash movement or adopted income. No amounts are recomputed.

The collector validates the complete detail CSV count/header but publishes no detail movements. PDFs use the shared private DATA content-addressed writer; the raw document list preserves identity/date evidence, ordinal artifact references avoid provider labels in metadata, identical bytes are stored once, and changed bytes are append-only revisions. The observed document page must match its total and unique IDs. A larger total fails closed because the next-page contract is unobserved. Full retention is unproved; the document run remains partial even after a successful five-year query. Each validated PDF has an independent successful document unit and an eligibility-only policy so the metadata parser can record evidence-only coverage without interpreting PDF finances. Fund documents stay unsupported.

Persist the core, realised and document results as separate terminal runs sharing one acquisition session. Return all persisted run IDs, including partial/failed supplemental terminals, rather than hiding any result. Each run records its own scope: annual query bounds are null because the provider states year labels; document bounds name the observed five-year query.

## Consequences

The existing parser output cap stays unchanged and long detail history cannot enlarge annual output. Annual summaries remain revisioned evidence without inventing a transaction ID or cash income. Optional document limitations cannot block independent core publication. Generic standalone valuation-history API exposure is a separate integration boundary; these observations are published and inspectable through artifact evidence.

## Verification

Synthetic fixtures check exact annual values, year/unit identity, schema/count refusal, bounded parse output, scheduled multi-run results, PDF magic and document completeness limits. Shared DATA persistence and publication tests exercise production code and the actual snapshot selector, including repeated runs and rollover. No production collection, login, deployment or private-data query is part of this change.
