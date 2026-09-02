# Roadmap

Phases are ordered so that evidence collection runs long before any schema
is committed to — including the raw layer's own schema. The single most
important sequencing rule: **collect and analyze real captures (phases 0–1)
before building any storage or freezing any schema (phase 2 onward).**

## Phase 0 — Collect (no code)

No server, no database, no custom code.

- Periodic (e.g. weekly) Kuebiko sessions across direct account surfaces:
  banks, cards, brokers, crypto exchanges, stored-value services, and reward
  programs. Aggregators are optional reconciliation inputs, not required
  collection targets.
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
The detailed plan — full DDL, the ingestion API, the importer CLI,
idempotency and backfill rules — is in `docs/raw-store.md`.

**Implementation status (2026-09-02):** the cross-source D1 schema and Worker
foundation passed independent architecture, use-case, and adversarial
SQLite/D1 review with no P0/P1 findings. Migrations through `0004` and Worker
schema version `0004` are deployed. The production synthetic round trip proves
run-scoped streaming R2 writes, immutable catalogue ingestion, R2 integrity
verification, and complete sealing; production reconciliation reports no
unsealed run and no synthetic run in the financial projection. The sanitized
acceptance suite covers 12 documented source shapes, including a 1,001-item
resumable inventory. Collector-R2/Kuebiko importers and staging-bucket backfill
remain the next implementation unit. See `docs/raw-store.md`.

- Cloudflare Worker, D1 database, private R2 bucket, CI.
- Bearer-token auth for the ingestion API.
- Importer CLI (`import-kuebiko`, `ingest-file`).
- Per-source collector coordinator and short-lived consumer only after its
  replay path is validated in phase 1. Treat password bootstrap as a separate
  gate: visible Windows Chrome has produced both successes and failures, so it
  is not yet a stable repeated control. The deployed issuer remains gated on a
  repeatable Windows baseline and then a persistent Container-based coherent
  browser or real Android/macOS testing. The Linux/cloud consumer receives only
  an encrypted source-scoped session envelope. The vault, master password, and
  Vpass password never enter Cloudflare for the replay-only flow.

The original four-table sketch below remains useful as the layer summary; the
candidate schema expands it with acquisition method, scoped authorization,
progress/terminal reports, units/pages/ranges, typed privacy-safe origins,
lineage, transforms, inventory seals, and integrity events:

```sql
sources                 -- reviewed provider/data-surface registry
fetch_runs              -- source-specific acquisition identity
raw_objects             -- sha256, exact byte size, private R2 key
fetch_artifacts         -- run, role/fidelity/container, safe media essence,
                        -- timestamp basis, raw-object digest
artifact_http_metadata  -- method/status/scheme/host, sanitized path template,
                        -- reviewed query names and optional HMAC only
```

Blobs are content-addressed in R2 (dedupe); fetch history is append-only.
Raw URLs, query values, userinfo, fragments, cookies, tokens, and unreviewed
path/query shapes are never catalogue fields. HTTP provenance is useful for
later parser development only after this enforced sanitization boundary.

## Phase 3 — Observation Layer

Deterministic, versioned parsers turn raw objects into typed observations
("the source says X") — no interpretation yet. The detailed plan — the
parser contract, versioning and supersession, the tables, and the first
parsers — is in `docs/observations.md`. Physically separate tables per
shape, not one generic EAV table:

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

## Operator tooling — Evidence Browser

Not a numbered phase, because it is not a data layer: it is a read-only
operator tool that spans phases 2 and 3 and would be deleted without data
loss. It exists so that a human can see, for any observation, the exact
bytes it came from and the parser version that produced it. Re-parsing is
a first-class operation, and an operation nobody can verify is an
operation nobody trusts.

It reads layers A and B only, computes every current-state view on
request, and stores nothing. It is not the product UI, which stays out of
scope — see the MVP cut below and `docs/evidence-browser.md`.

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
several direct real sources captured (bank / card / broker / stored value or rewards)
      ↓
raw schema designed from the actual captures
      ↓
everything backfilled into the raw store, re-parseable
      ↓
typed balance / transaction / position observations extracted
```

Explicitly out of scope for the MVP: ledger, categories, transfers, lots,
P&L, tax, reward valuation, AI classification, and the product UI.

This last exclusion was originally written as "any UI", and is narrowed
here deliberately rather than quietly. The read-only evidence browser
described above is admitted to the MVP; every user-facing view — balances
as a dashboard, net worth, categories, charts — remains excluded. The
distinction being drawn is that the browser renders observations and their
provenance and nothing else: it interprets nothing, stores nothing, and
computes no derived value. Admitting it costs the MVP a surface that
renders real financial data and must never be publicly reachable, which is
a real cost and the reason the boundary is stated as rules in
`docs/evidence-browser.md` rather than left to judgement.

A worked implementation of phases 2 and 3 and the browser, against the
payload shapes the live collectors already emit, is in
`poc/observation-pipeline`.
