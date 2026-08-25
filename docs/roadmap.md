# Roadmap

Phases are ordered so that evidence collection runs long before any schema
is committed to — including the raw layer's own schema. The single most
important sequencing rule: **collect and analyze real captures (phases 0–1)
before building any storage or freezing any schema (phase 2 onward).**

## Phase 0 — Collect (no code)

No server, no database, no custom code.

- Periodic (e.g. weekly) Kuebiko sessions across all accounts: banks,
  cards, brokers, crypto exchanges, aggregators, reward programs.
- CSV/OFX/PDF exports saved into a designated local folder.
- Capture root and exports folder backed up to private Google Drive
  storage.

This phase also surfaces the real-world cases the later layers must handle:
pending → posted, amount/date/description changes, unstable external IDs,
duplicates, refunds and partial refunds, card settlement debits,
inter-account and cross-currency transfers, FX and foreign transaction fees,
broker-reported valuations, reward expiry displays.

## Phase 1 — Capture Analysis

With a few weeks of real captures accumulated, characterize each source
from `metadata.ndjson` and the saved bodies: internal JSON APIs vs HTML,
payload shapes and sizes, noise ratio, how often data actually changes,
observed pending → posted behavior. From that evidence, design the raw
layer: which artifact metadata to keep, the source allowlist structure, and
the ingestion tables.

For SBI Securities, SMBC, Mobile Suica, and PayPay this analysis is largely
pre-done: `pnsk-lab/mnie` already identified the internal endpoints, request
shapes, and encodings (see `docs/tooling.md`). Those sources can skip
straight to endpoint replay; the capture-analysis effort concentrates on the
long tail.

## Phase 2 — Infrastructure + Raw Evidence Collector

Built only after phase 1, then backfilled with all accumulated captures.

- Cloudflare Worker, D1 database, private R2 bucket, CI.
- Bearer-token auth for the ingestion API.
- Importer CLI (`import-kuebiko`, `ingest-file`).
- Per-source collector coordinator and short-lived consumer only after its
  replay path is validated in phase 1. Treat password bootstrap as a separate
  gate: the existing Windows profile shows that a separate issuer may work but
  is not yet a stable repeated control. The deployed issuer remains gated on a
  repeatable Windows baseline and then a persistent Container-based coherent
  browser or real Android/macOS testing. The Linux/cloud consumer receives only
  an encrypted source-scoped session envelope. The vault, master password, and
  Vpass password never enter Cloudflare for the replay-only flow.

Expected shape of the tables (to be finalized in phase 1):

```sql
sources          -- registry: provider, ingestion type, domain allowlist
fetch_runs       -- when a collection happened, tool, status
raw_objects      -- sha256 (key), r2_key, content_type, size
fetch_artifacts  -- run, source, url, method, status, mime,
                 -- fetched_at, raw_object sha
```

Blobs are content-addressed in R2 (dedupe); fetch history is append-only.
`fetch_artifacts` keeps HTTP-level fields (URL, status) because they are the
most useful signal for later parser development.

## Phase 3 — Observation Layer

Deterministic, versioned parsers turn raw objects into typed observations
("the source says X") — no interpretation yet. Physically separate tables
per shape, not one generic EAV table:

```text
transaction_observations   balance_observations
position_observations      valuation_observations
reward_observations
```

Every observation records `parser_name` / `parser_version` and its raw
provenance (`raw_object`, locator within it). Re-parsing all historical
evidence with a newer parser, superseding prior observations, is a
first-class operation from day one.

The first parsers do not need to be written from scratch: `smcc-meisai-
scraper`'s `parser.ts` (Vpass card) and `pnsk-lab/mnie`'s provider parse
code already produce close-to-correct typed output. Both need the same two
changes — emit parser name/version and raw locators, and stop dropping
unrecognized fields — before adoption. See `docs/tooling.md`.

## Phase 4 — Identity

`source_accounts` (what a provider calls an account) vs `accounts`
(canonical), with corrigible mappings. The same real account may appear via
its own site, an aggregator, and CSV exports.

## Phase 5 — Instruments

`instruments` + `instrument_identifiers` + type-specific detail tables.
Positions become `(account, instrument, quantity)`.

## Phase 6 — Reconciliation

`observation_links` with relation / method / confidence
(provider-given links, exact matches, heuristics, AI, manual). Never
update-in-place.

## Phase 7 — Economic Events

`economic_events` + `event_legs`. Multi-asset, not forced to balance when
information is missing.

## Phase 8 — State Snapshots

`balance_snapshots`, `position_snapshots`, `valuation_snapshots` from
provider-reported state. Differences between provider-reported and
event-derived values become reconciliation signals, not bugs to overwrite.

## Phase 9 — Market / Reference Data

`price_observations` as its own domain; archive every price actually used
in a calculation, with provenance.

## Phase 10 — Rewards

Quantity / lots + expiry rules / conversion graph / valuations, per
`docs/design.md`. Expiry forecasting (including inactivity-based programs)
and expiring-value reports.

## Phase 11 — Derived Positions

Positions and balances computed from events + snapshots; unexplained
differences surfaced.

## Phase 12 — Lots / Cost Basis

Generated per methodology and jurisdiction from acquisition/disposal events.

## Phase 13 — Valuation Engine

`value(portfolio, as_of, base, price_policy, fx_policy)` — any base
instrument, explicit policies.

## Phase 14 — P&L

Decomposable P&L (market / FX / income / fees, realized / unrealized) under
an explicit calculation context, cached with `calculation_version`.

## Phase 15 — Tax

Jurisdiction-specific interpretation layers (JP / AU) over the same events.
Never bake tax semantics into lower layers.

## Phase 16 — AI / MCP

AI classifies, matches, and suggests — always as interpretations with
model/version/confidence recorded, always human-correctable, never touching
evidence or observations.

## MVP Cut

The first milestone is phases 0–3 only:

```text
several real sources captured (bank / card / broker / aggregator)
      ↓
raw schema designed from the actual captures
      ↓
everything backfilled into the raw store, re-parseable
      ↓
typed balance / transaction / position observations extracted
```

Explicitly out of scope for the MVP: ledger, categories, transfers, lots,
P&L, tax, reward valuation, AI classification, any UI.
