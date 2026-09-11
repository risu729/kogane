# Evidence Collection

Collection starts before modeling. The goal of the first working system is:

> Everything visible on a financial site or in an export is saved in a form
> that can be fully re-processed later.

No categorization, no transfer detection, no accounting happens at this
stage. Real data accumulates first; the observation schema is designed after
enough messy reality has been seen (pending → posted changes, amount/date/ID
changes, duplicates, refunds, card settlements, FX and fees, broker
valuations, reward expiry).

## No Infrastructure Yet

The "see real data before freezing a schema" principle applies to the raw
layer itself. Which artifact metadata is worth keeping, how the source
allowlist should be structured, and what the ingestion tables look like are
all modeling decisions — so they are made _after_ real captures have been
inspected, not before.

This is possible because a Kuebiko capture directory is already a complete
raw archive: content-addressed bodies plus append-only NDJSON metadata.
Collection therefore starts with no server, no database, and no custom code
at all. Captures live on local disk (backed up, see below) and lose no value
by waiting — importing them into cloud storage later is a retroactive,
idempotent batch operation.

## Capture with Kuebiko

[Kuebiko](https://github.com/risu729/kuebiko) is a passive Chrome CDP capture
tool: it launches a dedicated browser profile and saves every response body
(content-addressed by SHA-256) plus append-only NDJSON metadata while the
user browses manually.

This maps almost 1:1 onto Kogane's raw layer:

```text
kuebiko run directory      →  fetch_run
metadata.ndjson line       →  fetch_artifact (URL, method, status, timing)
bodies/<sha>.<ext>         →  raw_object (content-addressed blob)
```

The workflow: periodically (e.g. weekly) launch Kuebiko, log into each
financial site in the dedicated profile, browse balances and statements as
usual, close the browser, then run the importer. Ordinary manual account
checking doubles as data collection.

A key side benefit: `metadata.ndjson` records which internal JSON APIs each
site's own frontend calls, with real request/response pairs. When a source is
later automated, the scraper can usually replay those internal APIs instead
of parsing HTML, and the request shapes come from captured reality instead of
guesswork. The observation period is not throwaway work — the captures are
already evidence.

## Backup

Captures contain credentials and full financial pages, and they exist only
on one local disk. Until cloud ingestion exists, the capture root (and the
exports folder) is synced to private Google Drive storage as a whole
directory — a schema-free backup that commits to nothing about the data's
structure. R2 is not needed while nothing on Cloudflare reads the data.

## Importer (later)

Once the raw layer schema has been designed from real captures, a local CLI
imports a finished capture run:

```text
kogane import-kuebiko <run-dir>
```

- Reads `metadata.ndjson`, matches each entry's URL against the source
  registry (per-source domain/path allowlists).
- Uploads matched response bodies and trimmed metadata to the ingestion API.
  SHA-256 dedupe makes re-runs idempotent, so old capture directories can be
  imported (or re-imported) at any time.
- Unmatched hosts are reported for review; genuinely financial ones get
  added to the registry, the rest (ads, analytics, unrelated browsing) are
  dropped.

Batch import after the run is preferred over a real-time Kuebiko plugin: it
works on past captures, keeps network activity out of the capture loop, and
is trivially re-runnable. A plugin can be added later if live forwarding
becomes useful.

### Privacy rules for upload

Captures contain credentials. The importer enforces:

- Request headers are never uploaded (they contain `Cookie` /
  `Authorization`).
- Authentication request bodies are never uploaded or retained as evidence;
  they can contain IDs, passwords, OTPs, and anti-bot tokens. Only a keyed or
  access-controlled diagnostic hash may be recorded when operationally needed.
- Akamai/browser sensor telemetry is excluded from normal evidence ingestion.
  Its payload can fingerprint the browser and is not financial source data.
- Only allowlisted sources are uploaded at all.
- Uploaded metadata per artifact: URL, method, status, MIME type,
  timestamps, response body hash.

The R2 bucket is private; the ingestion API requires a bearer token stored as
a Worker secret.

## Other Ingestion Paths (later)

Not everything flows through the browser capture. Until the ingestion API
exists, exports are simply collected into the backed-up folder; afterwards:

```text
kogane ingest-file <path> --source <source-id>
```

for CSV/OFX/QIF exports, statement PDFs, and other downloads (browser
downloads are not reliably captured via CDP). Email statements and direct
API integrations are later additions; all paths converge on the same
ingestion API and the same raw layer.

Preferred order when adding a source, cheapest first:

1. Official CSV/OFX export
2. API (official or replayed internal API)
3. Email statements
4. Browser automation
5. Manual entry

These are direct-source paths: Kogane prefers the institution's own export,
API, website/app, or statement. An aggregator is optional reconciliation
evidence only, not the default collector and not the sole raw source. See
`docs/source-policy.md`.

For several sources this work is already done by existing tools:
`smcc-meisai-scraper` parses the Vpass card CSV, and `pnsk-lab/mnie` has
`fetch`-based internal-API clients for SBI Securities, SMBC, Mobile Suica,
and PayPay. See `docs/tooling.md` for the full catalog, the raw-evidence
adaptation each needs, and the local-auth / cloud-ingestion split.

## Ingestion API (later)

A sketch, to be finalized together with the raw schema:

```text
POST /ingest/artifact     one raw object + artifact metadata
POST /ingest/run          open/close a fetch run
```

The Worker stores the blob in R2 under its SHA-256 (skipping if present) and
records the fetch run, artifact, and raw object rows in D1. The API does no
parsing — ingestion must stay dumb so any future client (importer, scraper,
email handler, manual upload) can use it unchanged.

## Automation Phases

1. **Now — manual, no code.** Weekly Kuebiko session across all accounts;
   CSV/PDF exports saved into a designated folder; everything backed up to
   Google Drive. Data accumulates with zero maintenance.
2. **Next — analyze captures.** Aggregate the accumulated metadata per
   source to characterize each site (internal JSON APIs vs HTML, noise
   ratio, change frequency), design the raw layer schema and allowlist from
   that evidence, and identify stable endpoints worth replaying.
3. **Later — automate per source, selectively.** Replay internal APIs where
   possible, browser automation only where necessary, on Cron triggers where
   feasible. A source that needs a native impersonating client may run in a
   short-lived Container with only source-scoped credentials; see
   `docs/authenticated-collectors.md` and `docs/credentials.md`. Sources that
   rarely change can stay manual forever.

## Shared DATA target per collector (U09)

Unified plan U09 (chapters 03, 12, 13; decisions D12/D13). Each collector
gains a var `COLLECTION_TARGET` and an R2 binding `DATA` to the central
bucket `kogane-raw-evidence`:

- `COLLECTION_TARGET=legacy` (the deployed default) is the existing path,
  byte for byte: artifacts and the per-source manifest go to the collector's
  own bucket and the importer service binding copies them centrally.
- `COLLECTION_TARGET=shared` persists the run through
  `packages/collection` (`docs/collection-contract.md`): content-addressed
  objects under `objects/<2 hex>/<sha256>` and, written last, the run's
  `terminal-v1` manifest at `runs/<source>/<runId>/terminal.json`. The
  per-source bucket is not written and the importer is not called, so the
  same bytes are never stored twice (G1-15).

Only the exact string `shared` switches a collector; anything else — unset,
misspelled, a half-applied deploy — stays on the legacy path. The legacy
bucket binding stays in the config because it is the rollback target.

Rules that hold for every collector below:

- The stored bytes are the ones that already reach central storage: the
  collector's own sanitizer output. A provider response that carries
  credentials, cookies or session material is never stored as it is.
- `providerOutcome` is the run's own outcome (`success`/`partial`/`failed`)
  and is never widened; a `partial` run keeps its coverage gap (G1-08) and a
  `failed` run persists no artifact, so it cannot read downstream like an
  observation of zero (G1-09).
- A failed put returns `incomplete` with a checkpoint and no terminal: the
  run is not reported as complete, and only codes and counts are logged
  (G1-01, G3-08).
- `operationId`/`attemptId` are carried when an operation requested the run.
  U08 dispatches collection operations; today the cron and the admin trigger
  leave them unset.
- Deploy order, per source: the Processor (U08) with
  `SHARED_R2_INGEST_ENABLED` first, so a terminal is never written before
  something can read it; then `COLLECTION_TARGET=shared` on this collector.
  Rollback: set the var back to `legacy` and redeploy nothing else —
  terminals already written stay valid and are picked up by the Processor's
  bounded `runs/` scan. The collector keeps exactly one cron either way, so
  switching a source never doubles provider access (11 §4).

### Sony Bank (`services/collector-sony-bank`, `kogane-sony-bank-collector-poc`)

| Artifact key                                     | Role                         |
| ------------------------------------------------ | ---------------------------- |
| `gross-balance.json`, `*-history-page-NNNN.json` | `provider_response`          |
| `yen-history.csv`, `foreign-history-<ccy>.csv`   | `provider_export`            |
| `wallet-history-YYYY-MM.html`                    | `sanitized_provider_capture` |
| `collection-summary.json`                        | `collector_summary`          |
| `manifest.json`                                  | `collector_manifest`         |

Sanitizer: the collector's own `sanitizeWalletHtml` (Sony Bank Wallet
statements), which the legacy path already applies before the importer
forwards the object verbatim. Shared mode stores exactly those bytes and
records the step as a `redacted` transformation with no retained input,
because the provider HTML was deliberately not kept.

Terminal fields: one unit `account` (`unitKind: account`); ranges
`request-window` (the requested `from`/`to`) and, when wallet statements were
collected, `wallet-months`; one `terminal` report carrying the outcome;
`requestedScope.scopeKind = date_range` over the same window;
`coverageStatus` `complete` for a successful window, `partial` for a partial
run, `unknown` for a failure. `manifest.json` is the collector manifest with
the central-safe failure messages (`manifestFailure`) and each artifact's
`key` pointing at the content-addressed object that was actually written; the
terminal's `artifacts[]` stays authoritative.

Verified with synthetic fixtures in
`services/collector-sony-bank/test/shared-collection.test.ts` (G1-01, G1-02,
G1-08, G1-09, G1-15, G3-07, G3-08). No provider was contacted and no
production bucket was read or written.

### Money Forward ME (`services/collector-moneyforward`, `kogane-moneyforward-collector-poc`)

| Artifact key                    | Role                 |
| ------------------------------- | -------------------- |
| `accounts.html`                 | `provider_response`  |
| `account-detail-NN.html`        | `provider_response`  |
| `account-NN-month-YYYY-MM.html` | `provider_response`  |
| `manifest.json`                 | `collector_manifest` |

Sanitizer: none is applied to the pages — the legacy path stores exactly
these bytes and the importer forwards them verbatim, because the collector
keeps only the rendered aggregator pages and never the request headers,
cookies or credential exchange that produced them. The one normalization the
central path does apply is to the manifest, whose failure message is replaced
by its failure code; shared mode writes that normalized manifest.

Terminal fields: one unit per account (`account-NN`, `unitKind: account`),
taken from the collector's own filename grammar — the run-wide
`accounts.html` index belongs to no unit; a `months-account-NN`
`declared_coverage` range per account covering the monthly fragments that were
actually captured; one `terminal` report carrying the outcome;
`requestedScope.scopeKind = full_snapshot` (the run asks for whatever the
aggregator currently shows) listing the accounts as `unitKeys`.

Verified with synthetic fixtures in
`services/collector-moneyforward/test/shared-collection.test.ts` (G1-01,
G1-02, G1-08, G1-09, G1-15, G3-07, G3-08). No provider was contacted and no
production bucket was read or written.

### MyJCB (`services/collector-myjcb`, `kogane-myjcb-collector-poc`)

| Artifact key                                                                   | Role                         |
| ------------------------------------------------------------------------------ | ---------------------------- |
| `<connectionId>/credit-menu.html`, `…/credit-detail-NN.html`, `…/debit-*.html` | `sanitized_provider_capture` |
| `<connectionId>/credit-past-months.json`                                       | `provider_response`          |
| `<connectionId>/credit-csv                                                     | pdf                          | ofx` | `provider_export` |
| `<connectionId>/credit-ledger-*.json`, `…/discovery.json`                      | `collector_derived`          |
| `manifest.json`                                                                | `collector_manifest`         |

Sanitizer: the collector's own `redactedStatementHtml` (parse5 tree: scripts,
styles, textareas, embedding elements and every URL-bearing attribute removed,
every `value=` replaced by `[redacted]`, card numbers in text replaced), which
is what the legacy path already stores. Shared mode adds `assertRedactedHtml`,
the invariants the central path enforces, checked again on the bytes about to
leave the Worker: a redaction regression throws
`artifact_html_redaction_invalid` and the run writes no terminal rather than
publishing the page. The collector manifest is written in its central shape —
a connection blocker and a failure message become coarse codes
(`human-required`, `collector-failure`, `r2-write-failure`), so upstream free
text never reaches the shared bucket either.

Terminal fields: one unit per connection (`<connectionId>`,
`unitKind: connection`), so several cards in one run stay distinguishable and
are never merged into one (G1-16); no ranges, because the statement periods are
provider labels rather than machine ranges and stay in the manifest artifact;
one `terminal` report carrying the outcome; `requestedScope.scopeKind =
full_snapshot` over the connections. `coverageStatus` is `partial` even for a
successful run — a MyJCB card exposes a rolling set of statement periods, so a
finished run is not a claim about the card's whole history. A connection that
needs a human is a `human-required` state on its own unit with
`safeErrorCode: human_required`, and the run-level code is `human_required`
when every blocked connection is waiting for a person: nothing here retries a
login (G3-10, G3-11).

Verified with synthetic fixtures in
`services/collector-myjcb/test/shared-collection.test.ts` (G1-01, G1-02,
G1-08, G1-09, G1-15, G1-16, G3-08, G3-11). No provider was contacted and no
production bucket was read or written.

### Vpass (`services/collector-vpass`, `kogane-vpass-collector-poc`)

| Artifact key                             | Role                         |
| ---------------------------------------- | ---------------------------- |
| `card-list.json`                         | `sanitized_provider_capture` |
| `select-card.json`                       | `sanitized_provider_capture` |
| `web-meisai-top.json`                    | `sanitized_provider_capture` |
| `months/<yyyymm>/<top\|answer>-NNN.json` | `provider_response`          |
| `manifest.json`                          | `collector_manifest`         |

Sanitizer: `vpass-json-sanitizer` v1 (`src/sanitize.ts`). Unlike the other
collectors, the legacy Vpass path stores the raw response envelopes in its own
bucket and the importer sanitizes them on the way to central storage — so a
collector writing the shared bucket has to sanitize first. `src/sanitize.ts` is
that transformation, with the same id, version and rules the importer applies
today: every key naming authentication, a session, a device, a CSRF token or a
card identify key is replaced wholesale; the card inventory keeps ordinal
labels (`card-001`) and a placeholder reference instead of names and keys; the
result is canonically encoded (sorted keys, trailing newline) and then
re-checked, so output that still holds a sensitive value fails the run instead
of being stored. The artifact keys are the ones central storage already uses,
so the same run registers the same way.

Terminal fields: one run **per card**, `runId = <session run id>-card-NNN`,
all cards of one session carrying that session id as `acquisitionSessionRef`,
so several cards stay distinguishable instead of collapsing into one run
(G1-16) — the same mapping `VPASS_LEGACY_ADAPTER` uses when a legacy run is
re-persisted. One unit per card (`unitKind: card`), a `statement-months`
declared-coverage range over the months that were captured, one `terminal`
report, `requestedScope.scopeKind = full_snapshot`. `coverageStatus` is
`partial` even on success: a card exposes a rolling window of statement months,
so a finished run is not a claim about the card's whole history.
`producerVersion` is `vpass-worker-card-v1`, the schema version central
storage records for a card-scoped Vpass run, and `manifest.json` holds exactly
the summary central storage holds today.

A card (or a session that failed before a card was selected, as unit `run`)
that collected nothing persists a `failed` terminal with no artifact at all
(G1-09). Every stored object carries a `redacted` transformation with no
retained input, because the provider envelope that held the session was
deliberately not kept; note that this differs from the legacy central
descriptors, which record a statement page as `extracted` from the stored
snapshot — in shared mode there is no snapshot to extract from.

Verified with synthetic fixtures in
`services/collector-vpass/test/shared-collection.test.ts` (G1-01, G1-02,
G1-08, G1-09, G1-15, G1-16, G3-07, G3-08). No provider was contacted and no
production bucket was read or written.
