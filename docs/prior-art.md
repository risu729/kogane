# Prior art: self-hosted personal finance software

`docs/design.md` lists the projects that were evaluated and not adopted, in a
paragraph each. This document is the long version: what each one actually
contains, what its data model does with the source material, and what — if
anything — Kogane can take from it.

It exists to answer one question honestly, because it is the cheapest possible
outcome if the answer is yes:

> Can Kogane just use one of these instead of being built?

The answer is no, and the reason is narrow and checkable rather than a matter
of taste. It is set out under "Why none of these is the store of record"
below. Several of them are nonetheless better than Kogane at things Kogane
will eventually need, and those are recorded here so the wheel is not
reinvented when the time comes.

Facts here were verified against repository files — manifests, schemas,
migrations, changelogs — or official documentation, on 2026-08-28. Star counts
and versions age quickly and are given to date the snapshot, not because they
matter. Anything that could not be confirmed from a primary source is marked
unverified.

## The short answer

Roughly thirty live projects were surveyed. **Exactly one keeps raw source
evidence in a separate layer and re-derives typed records from it as a routine
operation: rotki.** Two more get partway by other routes. Every other project,
including every popular budget and expense manager, stores finished records
only: the CSV, the API response, the statement PDF is read, converted, and
discarded.

That finding is worth more than any individual verdict below. Kogane's central
premise — that the evidence is the asset and everything above it is disposable
— is not a solved problem someone has already shipped. The closest working
implementation is in a crypto tax tool, not in personal finance.

## Why none of these is the store of record

Not because they are bad. Ghostfolio, Actual, and Wealthfolio are better
engineered than most commercial finance software. The disqualification is
structural, and it is the same one in each case.

A "finished ledger" application treats the import as a funnel. Bytes go in,
records come out, and the bytes are gone. That is the right design when the
records are the product. It is the wrong design when the provider will later
change an amount, restate a date, reuse an external id, or go out of business
— all of which `docs/design.md` treats as normal rather than exceptional.

Concretely, once the source material is discarded:

- A parser bug is permanent. The wrong number cannot be recomputed, because
  the input no longer exists. It can only be edited by hand, which replaces a
  provider's claim with a human's.
- A better parser is worthless retroactively. It improves only data collected
  after it ships.
- Reconciling a discrepancy means arguing from a derived figure, with nothing
  underneath it to appeal to.

Three projects resist this to some degree and are worth naming precisely.

### rotki — the closest architectural precedent that exists

AGPL-3.0. Python backend, Vue 3 + Vite + Electron frontend, local encrypted
SQLite. Actively developed by a company.

Its schema has a genuine two-layer split that maps closely onto Kogane's
layers A and B:

```text
rotki                                   Kogane analogue
--------------------------------------  ------------------------------------
evm_transactions (incl. input_data)     fetch_artifact + raw bytes
evmtx_receipts, evmtx_receipt_logs      raw evidence, byte-exact
history_events (typed, normalized)      observations
history_event_links (left/right/type)   observation_links (phase 6)
skipped_external_events (data TEXT)     quarantine for unparseable evidence
used_query_ranges                       fetch-run watermarking
```

Its "redecode" operation is Kogane's re-parse: on upgrade, rotki re-reads the
*stored* receipts and logs and regenerates events with newer decoder code. The
operation `docs/roadmap.md` calls first-class from day one runs in production
there, on real user data. That is genuine reassurance the design is viable.

Where it stops short, and these are the specific gaps Kogane is designed to
close:

1. **No decoder version on the event.** There is no `parser_name` or
   `parser_version` column on `history_events`. A wrong value cannot be
   attributed to a decoder generation after the fact.
2. **Redecode is destructive, not superseding.** Old events are deleted and
   replaced. There is no `superseded_by`, so the old parse and the new parse
   cannot be compared. rotki consequently has to ask the user whether to also
   reset their manual corrections, because it has no way to carry them across.
   Kogane's parse-run supersession and its layer-C split for corrections
   exist precisely to avoid that question.
3. **Raw evidence only for on-chain data.** Exchange API responses go straight
   to typed events. So the evidence-first property covers the easy half —
   blockchains are already an immutable public archive — and not the hard
   half, which is a Japanese bank's HTML that will not exist tomorrow. That
   hard half is the whole of Kogane's collection problem.

`rotkehlchen/db/schema.py` and the EVM decoder directory are the best
available reading on what a re-parse pipeline looks like at scale.

### tackler — proof by checksum

Rust, small, actively maintained. Reads journals directly from a git
repository, including bare repos.

Every report carries a triplet: the git commit id, a **transaction-set
checksum** (SHA-256 over the set of transactions used), and an account-selector
checksum. The project describes this as cryptographic proof of which
transactions produced a report.

This is the same insight as Kogane's parse-run chain in a different substrate:
a figure is not trustworthy unless it names the exact input set that produced
it. Kogane already content-addresses raw objects; **a stable digest over the
set of observations a view was computed from is the missing half**, and would
answer `docs/evidence-browser.md`'s open question about comparing two parse
runs mechanically. Worth adopting when derived views arrive in phases 11–14.

It proves what you computed from. It does not prove where the journal came
from — the institution's bytes are still outside the system.

### beancount-import — the interaction, already invented

GPL-2.0-only. Python, with a web UI for interactive reconciliation.

It deliberately does not own the download step, and it links every generated
transaction to its source through metadata: `source_desc` preserves the
institution's own description verbatim, alongside source-specific identifiers.
For some sources it displays the source document — an Amazon order invoice, for
instance — beside the candidate transaction. Re-import is idempotent because it
checks that metadata.

Showing the parsed row next to the raw fragment it came from is exactly what
Kogane's observation detail page does. This is prior art that the interaction
is worth building, and that separating fetch from parse is workable.

## The six commonly cited projects

### Ghostfolio

AGPL-3.0. v3.62.0 (2026-08-27), ~9.2k stars, releasing every day or two.

**Stack.** TypeScript monorepo on Nx. NestJS 11 on Express 5, Prisma 7 with
PostgreSQL, Redis, Bull queues. **Angular 22** front end with Angular Material,
Chart.js 4 for charts. `big.js` for decimal math. An experimental MCP server
was added in 3.59.

**Includes.** Multi-account holdings and activities (buy/sell/dividend/fee/
interest/liability), watchlist, account balances over time, ROAI performance
across standard periods, allocations, an "X-ray" risk-rule screen, FIRE
calculator, CSV/JSON import with a dry run, tagging, multi-currency against a
user base currency, REST API with API keys, JWT/Google/OIDC/passkey auth,
sharing links, PWA. Ingestion is CSV/JSON/API/manual — there is no bank
aggregation dependency.

**Data model.** Finished records only. No raw payload table, no fetch-run
table, no content-addressed store. `Order` — the activity record — carries
account, currency, date, fee, quantity, symbol, type, unit price, comment and
tags; provenance for a transaction is the free-text `comment`. `MarketData` is
keyed on `(dataSource, date, symbol)` and stores the price, so a price carries
a provider *enum* but not the response it came from. FX is not a separate
concept: currency pairs live in the same `MarketData` table and cross-rates are
derived through the base currency. `AccountBalance` is one mutable row per
account per day, not an append-only measurement stream.

**Worth taking.** Three modelling ideas, no code. `AssetProfileSplit` stores a
stock split as two integers (numerator and denominator) with a schema comment
explaining that this keeps 1:3 exact — the same instinct as Kogane's refusal to
use floats. `AssetProfileResolution` maps a source symbol to a target symbol,
which is Kogane's layer-C identity mapping in miniature. The X-ray rule
catalogue (account/asset-class/currency/regional cluster risk, emergency fund,
fees, liquidity) is a good template for Kogane data-health rules — stale
source, unreconciled pending, missing FX rate — rendered as the same card list.

**Verdict.** Design reference only. AGPL plus Angular/NestJS/Prisma/Postgres/
Redis; nothing survives contact with Workers, D1, and R2, and there is no
separately licensed sub-package.

### Maybe Finance

AGPL-3.0 with a trademark restriction. **Archived 2025-07-24**; final release
v0.6.0. 54.3k stars, issues disabled. The company pivoted to B2B forecasting
and left the code as-is, inviting forks that do not use the name.

**Stack.** Ruby on Rails 7.2, PostgreSQL, Redis, Hotwire (Turbo + Stimulus),
ViewComponent, Tailwind, Sidekiq, Doorkeeper OAuth2, Plaid, `ruby-openai`. No
React; importmap rather than a bundler.

**Includes.** Typed accounts (depository, credit card, investment, crypto,
loan, property, vehicle, other asset/liability), transactions/trades/
valuations, holdings and securities, budgets, categories/tags/merchants, a
rules engine, transfers, multi-currency with an exchange-rate table, CSV import
with mappings, Plaid sync, multi-user families, API, AI chat with recorded tool
calls.

**Data model — the strongest provenance story of the six.** Worth reading
before Kogane finalizes layers A to C:

- `plaid_items.raw_payload`, `plaid_accounts.raw_payload`,
  `raw_transactions_payload`, `raw_investments_payload`,
  `raw_liabilities_payload` — real raw retention, but as *current-state*
  columns overwritten on each sync rather than an append-only artifact log.
- `imports.raw_file_str` **and** `normalized_csv_str`, plus `column_mappings`,
  separator, date format, number format, signage convention, and per-field
  column labels; `import_rows` holds parsed-but-unapplied values as strings.
  Original bytes, the parse configuration, and the typed rows, all retained —
  close to Kogane's A→B split.
- `data_enrichments(enrichable_type, enrichable_id, source, attribute_name,
  value, metadata)`, unique per (record, source, attribute). Literally "source
  S claims attribute A of record R is V" — Kogane's layer-C origin tracking,
  implemented.
- `entries.locked_attributes` records which fields a human overrode, so a later
  sync does not clobber them.
- `syncs` is a first-class run table with status, error, windows, and
  parent/child nesting.

Still a finished ledger: balances and holdings are materialized, no parser
version is stamped anywhere, and re-deriving from `raw_*_payload` is not a
supported operation.

**Verdict.** No code — Rails, AGPL, archived. But the highest-value *schema*
reference in this survey, and because it is archived it is a stable citation
that will not move under a footnote.

### Actual Budget

**MIT.** v26.8.1 (2026-08-07), 28.4k stars, monthly calendar releases,
community-governed.

**Stack.** TypeScript monorepo on Yarn workspaces. **React 19 + Vite 8**,
`react-aria-components` as the accessibility primitive layer, its own
`@actual-app/components`, Redux Toolkit, TanStack Query, react-router 8,
Recharts 3, `hyperformula`, CodeMirror. Core logic (`loot-core`, ISC) runs
SQLite everywhere — `absurd-sql` over IndexedDB in the browser,
`better-sqlite3` on Node — with a CRDT sync layer. Sync server on Express 5.

**Includes.** Envelope budgeting (this is the product), accounts, transactions
with splits, transfers, schedules with recurrence, a rules engine with
Handlebars action templating, payees with learning, reports and a draggable
dashboard, CSV/QIF/OFX import with a mapping UI, bank sync via GoCardless /
SimpleFIN / Pluggy / Akahu / Enable Banking (manual trigger only), end-to-end
encryption, OpenID auth, a headless npm API, CLI, Electron and mobile clients.

**No multi-currency.** The documentation states it is currency agnostic and
does not support multi-currency, and the roadmap does not include it. That
alone disqualifies it for a JPY/AUD ledger, as `docs/design.md` already
concluded.

**Data model.** `transactions.raw_synced_data` stores the entire provider
transaction object as delivered, and is preserved rather than replaced on
re-sync — a real, if minimal, evidence field. It exists **only for bank-synced
transactions**; file imports do not populate it, and the source file is never
stored. `imported_id` and `imported_payee` (the original description before
rules renamed it) are the other provenance fields. Everything is soft-deleted
and every mutation is a CRDT message, but that log is a sync mechanism, not a
queryable evidence layer.

Import matching is explicitly destructive of history: reconciliation matches on
`imported_id` then fuzzy passes, and the documentation says it will always
favour the imported transaction, updating the date of a manually entered one to
match. This is the "reconcile-by-update semantics that destroy observation
history" line in `docs/design.md`, now with a citation.

**Genuinely liftable.** The most legally permissive codebase here.
`@actual-app/crdt` (MIT, on npm, three small dependencies) is a hybrid logical
clock plus merkle trie, not tied to SQLite or the browser — a real candidate if
Kogane ever needs multi-writer merge on its corrigible layer-C records, which a
single-writer Workers backend probably does not. `@actual-app/components` is
MIT but workspace-only and not published; depending on `react-aria-components`
directly is strictly better. `@actual-app/api` is **Node-only** — it pulls
`better-sqlite3` and cannot run on Workers.

**Worth taking — the reconciliation flow, which is the best interaction in this
survey.** Enter the balance your bank states; the tool shows the remaining
difference and counts it to zero as you clear each transaction; at zero it
declares you reconciled and locks what cleared. For off-budget asset accounts
you enter a new market value, it reports the gain, and offers to **create a
reconciliation transaction** materializing the delta as an explicit event. That
is a clean answer to "a source asserted a balance; record the difference as
something that happened", which is exactly Kogane's phase-8 problem. Its CSV
import screen — live preview, the interpreted date turning green as you change
the format, flip-amount and split-amount toggles — makes every parser
ambiguity a visible control with immediate feedback.

### Firefly III

AGPL-3.0-or-later. v6.6.6 (2026-07-01) plus daily development builds. 24.4k
stars, oldest project here, one dominant maintainer.

**Stack.** PHP 8.5 on Laravel 13, Passport OAuth2, Twig templates, `bcmath` for
arbitrary-precision money. Current front end is Alpine.js 3 + Bootstrap 5 +
AdminLTE 4 built with Vite 8; a legacy Vue 2 + jQuery layout remains. Chart.js 4
including a Sankey plugin, Leaflet for transaction geolocation. Importing lives
in a separate repository (`firefly-iii/data-importer`) handling CSV, CAMT.053,
GoCardless, Spectre and SimpleFIN.

**Includes.** True double-entry bookkeeping, asset/expense/revenue/liability
accounts, transaction groups with splits, budgets, bills, categories, tags,
piggy banks, a rules engine, recurring transactions, reports, attachments,
webhooks, an audit log, a near-complete REST API, 2FA, multi-user, and native
multi-currency where every leg can carry a foreign amount and currency.

**Data model.** Classic double entry: `transaction_journals` own two or more
`transactions` rows, both soft-deleted, with several distinct dates per journal
(`date`, `interest_date`, `book_date`, `process_date`) — a good idea Kogane
already shares. Provenance is `journal_meta`, an open key/value store per
journal holding `import_hash_v2`, `external_id`, `original_source`. That is **a
hash of the source record, not the record.** The documentation is candid about
the consequences: editing a transaction after import does not update the hash;
duplicate detection runs on the pre-rules form; and changing the mapping
changes the hash. So the hash identifies a form of the record that is never
itself persisted and cannot be re-derived.

**Verdict.** Design reference. PHP and AGPL are unliftable here. The API shape
— transaction groups with per-split foreign amounts, Fractal transformers — is
the most mature open double-entry API in existence and a good model if Kogane
ever exports a read model. The Sankey flow report is the standout chart choice,
and the "test this rule against existing transactions before applying" pattern
is the right shape for Kogane's future classification rules.

### Wealthfolio

**AGPL-3.0** for the application; **MIT** for two published npm packages. Note
the repository moved from `afadil/wealthfolio` to `wealthfolio/wealthfolio`.
v3.7.0 (2026-08-19), 8.7k stars. Recent releases added MCP agents, OIDC SSO,
and Japanese and Korean locales. Broker syncing is a paid hosted service and is
not self-hostable; manual tracking and CSV import are free.

**Stack.** Rust workspace — Tauri 2 desktop, Axum 0.8 server with OpenAPI,
Diesel 2.2 on SQLite, `rust_decimal`, an MCP crate, encrypted device sync.
Front end is **React 19 + Vite + Tailwind 4 + Radix/shadcn**, TanStack Query/
Table/Virtual, Recharts 3.

**Includes.** Multi-account portfolios, **lot-level cost basis** with
configurable methods, realized and unrealized P&L, time- and money-weighted
returns, holdings including closed positions and cash, multi-currency with FX
rates stored per lot and per valuation, goals and allocation targets, asset
taxonomies, contribution limits, CSV import with saved per-account templates,
market data with pluggable providers, a spending and budgeting module, an addon
system with a TypeScript SDK and permission prompts, AI agents over MCP with an
audit log, and personal access tokens.

**Data model — the best typed model here, and no raw archive.** `activities`
carries a striking provenance cluster: `source_system`, `source_record_id`,
`source_group_id`, `idempotency_key`, `import_run_id`, `is_user_modified`,
`needs_review`, and `activity_type_override` — the interpretation stored
separately from the observed type. `import_runs` makes an import a first-class,
checkpointed, reviewable operation with `review_mode` and `applied_at`.
`import_templates` version the column mapping. Lot accounting is done properly:
`lots` and `lot_disposals` carry every monetary figure in both native and base
currency together with the FX rate that produced it — the closest thing in open
source to what Kogane needs for JP and AU tax. Derived data is explicitly
derived: `daily_account_valuation` carries `calculated_at`, `value_status` and
`basis_status`, which is Kogane's layer D with provenance of computation.

Searching the schema for raw payloads finds only the encrypted device-sync
outbox. There is no stored source document, no content-addressed artifact, and
no parser version.

**Genuinely liftable.** `@wealthfolio/ui` is **MIT and published on npm**,
separate from the AGPL application: a shadcn/Radix/Tailwind component set for
React 19 with a Recharts chart export, TanStack Table and Virtual, money
formatting and animated numerals. If Kogane builds a React *product* UI this is
a real candidate, and it is finance-shaped in a way generic shadcn is not. Two
caveats: it version-locks to an AGPL application at 3.x and could relicense or
disappear, and its i18next peer dependency drags in a translation stack.
Vendoring the few components needed is the lower-risk option, which MIT permits.

**Worth taking.** The staged import — rows land inside an import run with
`needs_review`, and the run is only `applied_at` on confirmation — is a write
you approve rather than a write you undo, and Kogane should copy that shape for
parser runs. `is_user_modified` is the same idea as Maybe's `locked_attributes`.
And `mcp_audit_log`, recording every AI tool call, is the concrete mechanism for
`docs/design.md`'s requirement that AI mistakes never destroy source data.

### Fava

**MIT.** v1.30.16 (2026-08-18), 2.6k stars, steadily maintained.

**Stack.** Python 3.10+ on Flask with Jinja2, `msgspec`, and beancount 3.2
alongside `beangulp` (importers) and `beanquery` (BQL). Front end is **Svelte 5**
built with esbuild, CodeMirror 6 for editing, `web-tree-sitter` parsing
Beancount in the browser, and **hand-rolled d3** — there is no charting library.
There is no database: the store of record is the user's plain-text file, watched
for changes. There is no authentication; it ships `--read-only` and
`--incognito` flags and expects a reverse proxy.

**Includes.** Accounts, commodities, documents, an editor, errors, events,
holdings, an import screen, journal, options, a query console, statistics, and
tree reports (income statement, balance sheet, trial balance). Plus a global
filter bar whose state is URL-encoded, multi-file switching, export of the
current filtered view, BQL downloads to CSV/XLSX/ODS, and an extension system.

**Data model — provenance is the architecture.** Every directive carries its
`filename` and `lineno`. Fava exposes a source slice for any entry as
`{sha256sum, slice}`, and writes verify that hash, raising
`ExternallyChangedError` if the text moved underneath. Entry context is a typed
structure of the entry plus balances immediately before and after it. Documents
are linked to accounts and dates by directive and tagged `#linked` or
`#discovered`.

The caveat `docs/design.md` already notes: the immutable evidence here is *the
user's own text file*, not the provider's payload. Beancount has no concept of
what the bank's API returned — that lives outside, in whatever importer wrote
the file. And a plain-text canonical file is hostile to concurrent writes from
Workers.

**Worth taking — the richest set for Kogane specifically.** Three mechanisms,
each roughly fifty lines to reimplement in TypeScript, and all three map onto
`docs/evidence-browser.md`:

1. Hash-locked source slices: `(slice, sha256sum)` as the unit of display and
   edit, with optimistic concurrency against the source text.
2. `Context = entry + balances_before + balances_after` — for any record, what
   was true immediately either side of it.
3. The `__source__` import convention: each proposed entry is shown **next to
   the raw CSV row or XML fragment it was parsed from**, display-only, and the
   metadata is stripped before saving. That is Kogane's A↔B pairing as a user
   interface, already invented and shipping.

Two more interactions worth copying. **Up-to-date indicators**: a coloured dot
per account — green when the last entry is a passing balance assertion, red when
failing, yellow when the last entry is not a balance check, grey when stale —
which adapts directly to "is this source fresh, and does its last snapshot
reconcile?" And **drag a PDF onto a journal row** to file it and attach a
`document:` reference to that transaction, which beats any upload dialog.

Finally, Fava is the one project here that could be *used* rather than copied:
if Kogane ever exports a Beancount read model, as `docs/design.md` suggests,
pointing Fava at it yields a full reporting UI for free under a compatible
licence.

## Everything else, briefly

Alive, modern, and surveyed; none keeps raw evidence.

| Project | License | Stack | Note |
| --- | --- | --- | --- |
| ezbookkeeping | MIT | Go 1.26 + Vue 3 + Vuetify/Framework7 | Best-engineered conventional self-hosted manager found. Uses `decimal.js` and character-set detection for arbitrary statement encodings — Kogane's Shift-JIS problem, solved pragmatically. |
| Kresus | AGPL-3.0 | Node + Express 5 + TypeORM + React 19 | Delegates scraping to **woob**, an external Python suite. Instructive: delegation buys scraper maintenance and **costs the evidence**, because the scraper returns records, not bytes. A concrete argument for Kogane's direct-source policy. |
| Portfolio Performance | EPL-1.0 | Java, Eclipse RCP desktop | Deepest performance analytics in open source. Its **importer test methodology is the takeaway**: ~90 bank and broker PDF importers, each with anonymized extracted-text fixtures, plus a built-in anonymizer that replaces your name with random characters. That is a working answer to "build a regression corpus of real financial documents you cannot commit" — precisely Kogane's fixture problem. |
| Paisa | AGPL-3.0 | Go + SvelteKit | A read/analyze layer over a ledger-cli or beancount journal. Its importer converts CSV/PDF into transactions via Handlebars templates and applies a learned account classifier **at import time** — an interpretation baked irreversibly into the record. For Kogane that is the anti-pattern: layers B and C collapsed into the import step. |
| hledger / hledger-web | GPL-3.0 | Haskell | Journal is the record; CSV import does not retain the CSV. Worth noting that hledger-web has **no access control and binds loopback by default**, telling you to use a proxy — the identical posture `docs/evidence-browser.md` arrived at independently, in a fifteen-year-old project. |
| Wallos, Cashew, GnuCash, MoneyManagerEX, bigcapital, whisper-money, budget-board, BeeCount, sossoldi, openmonetis | various | PHP / Flutter / C++ / TypeScript / Laravel | Conventional managers. None retains source evidence. |
| OpenBB | NOASSERTION | Python | An integration layer over ~100 data vendors that **explicitly does not persist anything** — no ledger, no accounts, no provenance. Not relevant to layers A–B; possibly relevant much later as a price-source abstraction, and even then a direct vendor call is simpler. Note it moved off plain AGPL. |

Names checked and not found as personal-finance projects: `sunrise`, `nolus`
(a DeFi protocol, unrelated), and "Wallet by Zellyn". Kubera and Finary have no
open-source equivalent; the nearest self-hosted answers are Ghostfolio and
Wealthfolio.

## Provenance scorecard

The four columns are the properties `docs/design.md` treats as load-bearing.

| Project | Raw evidence kept | Re-derive from raw | Parser version recorded | Prior output preserved |
| --- | --- | --- | --- | --- |
| **rotki** | yes, on-chain only | yes, "redecode" | no | no, destructive |
| **tackler** | yes, journal in git | yes, any git ref | n/a | yes, via git and checksums |
| **beancount-import** | links to it, does not own it | idempotent re-import | no | no |
| **Maybe** (archived) | partial, overwritten per sync | not supported | no | no |
| **Actual** | bank sync only, not file imports | no | no | no |
| Wealthfolio | no | no | no | no |
| Ghostfolio, Firefly III, Fava, Paisa, hledger, ezbookkeeping, Kresus, and the rest | no | no | no | no |

No project surveyed satisfies all four. Kogane's design is not redundant.

## What Kogane should actually take

### Code, in order of realism

1. **Nothing, for the evidence browser.** It is a five-page read-only operator
   tool with no dependencies beyond React and TanStack. Adding a component
   library to it would be weight without benefit.
2. **`@wealthfolio/ui`** (MIT, npm) *if and when* a product UI is built in
   React — finance-shaped components rather than generic ones. Vendor the few
   needed rather than depending on a package that version-locks to an AGPL
   application.
3. **`@actual-app/crdt`** (MIT, npm) only if multi-writer merge is ever needed
   on corrigible layer-C records. A single-writer Workers backend probably
   never needs it.

Everything else is either AGPL (Ghostfolio, Maybe, Firefly III, Wealthfolio's
core, rotki, Kresus) or a non-portable runtime (Fava and Paisa in Python and
Go; Actual's headless API pulls a native SQLite binding and will not run on
Workers).

### Schema references, ranked

1. **Wealthfolio** — lots and lot disposals with dual-currency amounts and the
   FX rate that produced each; import runs as staged, checkpointed, reviewable
   operations; the `source_system` / `source_record_id` / `idempotency_key` /
   `is_user_modified` / `needs_review` cluster.
2. **Maybe** — `data_enrichments` per-field source attribution;
   `locked_attributes`; `imports.raw_file_str` with `normalized_csv_str` and
   `import_rows`; `syncs` with windows and parents. Archived, so a stable
   citation.
3. **rotki** — the two-layer split itself, and `skipped_external_events` as a
   quarantine for evidence no decoder understood, which Kogane currently lacks.
4. **Ghostfolio** — rational-number splits, symbol resolution, FX as price
   pairs.
5. **Firefly III** — multi-date journals and the double-entry API shape, as a
   possible future export target.

### Interactions to copy, ranked

1. **Fava's context view and `__source__` pairing** — the parsed record beside
   the raw fragment, with balances either side. This is the evidence browser,
   already designed by someone else.
2. **Actual's reconciliation** — enter the source's stated balance, watch the
   difference count to zero, lock what reconciled; and materialize a valuation
   delta as an explicit event rather than an edit.
3. **Wealthfolio's staged import** — `needs_review` rows inside a run that is
   only applied on confirmation. The right shape for a parser run over new
   evidence.
4. **Fava's up-to-date dots** — per-source freshness and reconciliation status
   at a glance.
5. **Portfolio Performance's anonymized fixtures** — the answer to building a
   parser regression corpus from documents that cannot be committed.
6. **Ghostfolio's X-ray** — named, thresholded rules as pass/warn cards, for
   data-health checks.
7. **tackler's transaction-set checksum** — a digest over the observation set a
   derived figure was computed from, so the figure names its own inputs.

## A note on the stack

No open-source finance project uses TypeScript with React, Vite, and Hono.
The nearest match found has one star. The stack is well-trodden for Cloudflare
Workers applications generally — Cloudflare ships a Hono-plus-React-SPA
scaffold, and several large starters use it — but nobody in this domain has
walked it.

Read that as a mild warning rather than a reason to change course: the
financial-domain problems, money formatting and large tables and Shift-JIS
among them, have no community answers waiting. Several of them are already
recorded in `poc/observation-pipeline/RESULTS.md`.
