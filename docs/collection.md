# Evidence Collection

Current source timing and overlap/maintenance controls are in
[schedules](schedules.md). The source-by-source implementation notes below
include earlier Cron-based rollout descriptions; those trigger claims are
superseded by ADR 0039. Active Worker Cron arrays are empty. Daily collection
and SBI VC keepalive use Processor-owned alarm jobs.

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

## Shared DATA bucket per source (U09)

Unified plan U09 (chapters 03, 12, 13; decisions D12/D13). Every collector
holds one R2 binding, `DATA`, to the central bucket `kogane-raw-evidence` and
persists each run through `packages/collection`
([collection-contract.md](collection-contract.md)): content-addressed objects
under `objects/<2 hex>/<sha256>` and, written last, the run's `terminal-v1`
manifest at `runs/<source>/<runId>/terminal.json`. The Processor registers
that terminal in process, from the R2 notification or its bounded `runs/`
scan ([processor.md](processor.md)). The same bytes are never stored twice
(G1-15).

This is the only collection path. The per-source buckets, the importer that
copied a staged run into central storage, and the `COLLECTION_TARGET` switch
that chose between the two paths were retired on 2026-09-13
([legacy-retirement.md](legacy-retirement.md), [rollout.md](rollout.md)). No
collector reads a target variable or holds an importer binding. Where a
section below mentions the legacy path or the importer, it describes what the
shared bytes were checked against, not a path that still runs.

Rules that hold for every collector below:

- A failed provider logout or sign-off after all planned units were collected
  and stored never lowers the run outcome or its run/unit coverage. The
  immutable terminal records an auxiliary run report with `reportRef: logout`,
  `reportKind: logout`, `outcome: failed` and the closed code
  `safeErrorCode: logout_failed`; it does not put that code on the run or its
  units. Collection failures before completion and persistence failures retain
  their existing outcomes. No provider error text is kept. This policy follows
  the owner decision of 2026-11-08 13:26 UTC
  ([ADR 0044 amendment](adr/0044-smbc-resume-publication.md#amendment-2026-11-08-logout-after-complete-collection)).
  SMBC Direct and GLOBAL PASS also log a `logoutFailed` boolean; PRESTIA bank
  retains its `signoffFailed` boolean in its returned/scheduled run record.
  The flag remains readable from `readTerminal` after the run; the Processor
  currently derives only terminal run/unit reports for CORE, so collection
  quality screens do not yet display the auxiliary flag.
- The stored bytes are the collector's own sanitizer output, the same bytes
  the retired importer used to receive. A provider response that carries
  credentials, cookies or session material is never stored as it is.
- `providerOutcome` is the run's own outcome (`success`/`partial`/`failed`)
  and is never widened; a `partial` run keeps its coverage gap (G1-08) and a
  `failed` run persists no artifact, so it cannot read downstream like an
  observation of zero (G1-09).
- A failed put returns `incomplete` with a checkpoint and no terminal: the
  run is not reported as complete, and only codes and counts are logged
  (G1-01, G3-08).
- **The registration contract** ([ADR 0021](adr/0021-collector-registration-contract.md)).
  A terminal states what the Processor needs to register and seal it, and
  nothing more:
  - every `collector_derived` artifact has a transformation whose output it
    is: `extracted` or `reencoded` by the collector (named `collector-<id>`
    or by its own transformer id) at the producer version, whose
    `inputArtifactKeys` name the kept artifacts it was derived from, or are
    empty when the input was never stored — which registers as
    `source_bytes_not_available`, never as an invented parent;
  - bytes a sanitizer produced are a `sanitized_provider_capture` with a
    `redacted` step; a provider role (`provider_*`) carries the provider's
    bytes with no step at all (CORE seals a provider role only with
    `decrypted` or `extracted` steps);
  - the collector's own run manifest is `collector_manifest` and names no
    unit; a unit's `artifactCount` is exactly the number of artifacts whose
    `unitKey` is that unit;
  - a range at `month` precision states `YYYY-MM`.

  `services/processor/test/collector-plans.test.ts` runs every collector's
  real `*RunPlan` function through registration against the whole CORE schema
  and the operator bootstrap, and fails when any of these is broken.

- The terminal contract has optional `operationId`/`attemptId` fields. An
  operations-API collection reaches a collector through the same private named
  RPC the alarm uses (`ScheduledCollection.runOperation`, which runs the
  connection's own `runScheduled` job under the same lease) and is linked to
  its runs by the run ids the collector reports, stored on the operation
  ([ADR 0048](adr/0048-operation-collector-dispatch.md),
  [ops-api.md](ops-api.md#collector-execution-adr-0048)); no collector writes
  `operationId` into the terminal on that path. Acceptance is not execution:
  a request is started only for a connection the Processor's
  `OPS_COLLECTOR_DISPATCH_CONNECTIONS` names, and it collects the job's daily
  scope, not the requested window. See [current status](current-status.md) and
  [schedules](schedules.md).
- **One copy** (plan 00: the original is stored once; no standing
  collector-side → central double copy). A run is written only into `DATA`.
  sbi-shinsei, globalpass and sbi-vc-trade hold every artifact of a run in
  memory until the terminal is written, so nothing structural depends on a
  staging object and nothing is staged; their end-to-end tests assert zero
  staging puts. The one bounded exception is smbc-direct, whose chunks span
  Durable Object alarms and are staged under its run prefix inside `DATA`
  until the terminal is written (see its section).
- Current deployment order: collectors, then Processor, then App; health
  verification precedes future alarm bootstrap
  ([rollout.md §4](rollout.md#4-deployment-order)). There is no collector
  legacy mode to roll back to, and a release that needs the retired Workers
  or buckets is not a valid rollback target. Terminals already written stay
  valid and are picked up by the Processor's bounded `runs/` scan. Moving to
  the shared bucket added no cron or scheduler, so it never doubled provider
  access (11 §4).

### Logout audit (2026-11-08)

This audit covers every deployed collector's `src/` and `container/` paths.
Provider logout is distinct from closing a local browser, relay, HTTP reader or
container; this decision changes provider sign-off only. Session persistence,
refresh, approval, acquisition and publication failure handling stay as before.

| Collector      | Previous post-collection behavior                                                                                                                                  | Current behavior                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMBC Direct    | Logout failure appended `logout_failed` and made all completed chunks partial and ineligible for parsing.                                                          | Complete acquisition remains successful, retains `logoutSucceeded: false`, and publishes the auxiliary report. Failure cleanup before completion still appends its failure code.                                                                                                                      |
| PRESTIA bank   | Sign-off was caught; success and acquired balance survived, but `signoffFailed` was only in the run result/log.                                                    | The same result plus the durable auxiliary terminal report.                                                                                                                                                                                                                                           |
| GLOBAL PASS    | `signOut` swallowed count, visibility, click and load errors or a missing control. An unexpected escaping error could fail collection.                             | Sign-off detects those failures, emits a closed logout record, and the Worker records the flag without changing acquisition or rolling-window coverage. Its stream still validates month/page completeness, ordering and shape; browser/relay teardown failure remains a separate collection failure. |
| MyJCB          | No provider logout. The logout control is an authenticated-page check. `login.close()` in `collectConnection` closes the browser in `finally` and can still throw. | No provider logout to change; browser closure behavior retained.                                                                                                                                                                                                                                      |
| Vpass          | Shared session retained; per-card collection has no provider logout.                                                                                               | Unchanged.                                                                                                                                                                                                                                                                                            |
| SBI Securities | Domestic/foreign/main-site collection has no provider logout.                                                                                                      | Unchanged.                                                                                                                                                                                                                                                                                            |
| SBI VC Trade   | Encrypted gateway session retained and refreshed; no provider logout. Passkey bootstrap closes its browser before collection.                                      | Unchanged.                                                                                                                                                                                                                                                                                            |
| SBI Shinsei    | No provider logout. Container browser/relay cleanup uses `diagnostic.cleanup`, which logs and catches failures.                                                    | Unchanged.                                                                                                                                                                                                                                                                                            |
| Mizuho         | Per-run login and collection have no provider logout.                                                                                                              | Unchanged.                                                                                                                                                                                                                                                                                            |
| St George      | No provider logout. Browser/relay close failures are caught by the container cleanup.                                                                              | Unchanged.                                                                                                                                                                                                                                                                                            |
| Sony Bank      | Per-run authenticated request client has no provider logout.                                                                                                       | Unchanged.                                                                                                                                                                                                                                                                                            |
| Mobile Suica   | History session retained; no provider logout. Browser bootstrap closes before history collection.                                                                  | Unchanged.                                                                                                                                                                                                                                                                                            |
| Money Forward  | Session-based collection has no provider logout.                                                                                                                   | Unchanged.                                                                                                                                                                                                                                                                                            |
| V Point        | Email-code session retained; no provider logout. Email ingestion has no provider session.                                                                          | Unchanged.                                                                                                                                                                                                                                                                                            |
| V Point Pay    | App API collector is disabled (`email_only`); retained app client has no provider logout.                                                                          | Unchanged.                                                                                                                                                                                                                                                                                            |

### Terminal `source` ids and CORE source ids

A terminal names the collector's own source id. The Processor maps it to the
CORE source id through the closed table `COLLECTOR_SOURCE_IDS` in
`packages/application/src/collection/descriptors.ts`
([processor.md §3.1](processor.md#31-collector-ids-core-source-ids-and-producers));
no collector carries the CORE id.

Its `producer` is `collector-<collector id>`, the terminal's own `source`
with the prefix `collector-` (`collector-vpass`, `collector-prestia-globalpass`,
`collector-v-point-pay-email`), because that is the producer of the
Processor's route for the source; a terminal naming any other producer is
refused as `inactive_ingest_route`
([ADR 0014](adr/0014-collector-producer-ids.md)).
`tests/collector-producers.test.ts` checks every collector's terminal
constants against the routes in `config/ingest-clients.json`.

| Collector Worker                   | Terminal `source` (`runs/<source>/…`) | CORE source id     |
| ---------------------------------- | ------------------------------------- | ------------------ |
| `kogane-sbi-shinsei-collector-poc` | `sbi-shinsei`                         | `sbi-shinsei-bank` |
| `kogane-globalpass-collector-poc`  | `prestia-globalpass`                  | `global-pass`      |
| `kogane-sbi-vc-session-poc`        | `sbi-vc-trade`                        | `sbi-vc-trade`     |
| `kogane-smbc-direct-backfill-poc`  | `smbc-direct`                         | `smbc-bank`        |
| `kogane-mizuho-collector`          | `mizuho-bank`                         | `mizuho-bank`      |

### Failed terminal codes at registration

Migration 0086 adds nullable `collection_runs.provider_failure_code`. Registration
copies the validated run-level `safeErrorCode` only for `providerOutcome: failed`,
including both a refusal with `provider_run_failed` when no provider bytes exist
and a failed run whose captured bytes register. The code must match the manifest
vocabulary (`^[a-z0-9][a-z0-9_-]{0,99}$`); absent or invalid codes stay NULL.
Unvalidated terminals, success and partial outcomes never supply this column.
The value is immutable with the sighting; duplicate delivery cannot replace it.
Existing rows stay NULL and no historical R2 terminals are backfilled.

Collection quality exposes the reason as `failureCode` beside the registration
reason, through the existing closed-code normalization: hyphens become
underscores, and codes outside the display grammar become `unclassified`.
This read adds no provider call or automatic retry. See
[collection quality](read-model.md#collection-quality).

### Artifact datasets at registration (ADR 0022)

A terminal names no parser dataset, and no collector adds one: the Processor
derives it at registration from what the terminal already states — the
artifact key, its role and its media type — through the closed table
`ARTIFACT_DATASETS` in `packages/application/src/collection/descriptors.ts`
([processor.md §3.4](processor.md#34-artifact-datasets-adr-0022),
[ADR 0022](adr/0022-registration-artifact-datasets.md)). The artifact tables
below are its source: a collector that renames an artifact, changes its role
or declares another media type leaves that artifact without a dataset, and so
unparsed, until the table follows. Vpass statement pages were withheld until
the collector's card binding matched the importer's
([ADR 0023](adr/0023-vpass-collector-card-binding.md)) and carry
`statement-page` since registration contract `terminal-registration-v3`
([ADR 0083](adr/0083-release-vpass-collector-statement-pages.md)); only a
successful card run's pages are parsed. A run registered under an earlier
version whose artifacts gain a dataset registers again under the new version
(its earlier artifacts were never parsed), and every other registration is
carried over unchanged, so no capture is parsed twice.

### Sony Bank (`services/collector-sony-bank`, `kogane-sony-bank-collector-poc`)

| Artifact key                                     | Role                         |
| ------------------------------------------------ | ---------------------------- |
| `gross-balance.json`, `*-history-page-NNNN.json` | `provider_response`          |
| `yen-history.csv`, `foreign-history-<ccy>.csv`   | `provider_export`            |
| `wallet-history-YYYY-MM.html`                    | `sanitized_provider_capture` |
| `collection-summary.json`                        | `collector_summary`          |
| `manifest.json`                                  | `collector_manifest`         |

For each currency/window, the first JSON history page's `countCnt` is the
expected total, already checked against every walked JSON page. A zero total
skips CSV; a positive total requires a CSV whose logical data-row count,
excluding the header and blank lines, equals that total. The collector uses
the shared CSV reader so quoted multiline cells and quote recovery count as
in parsing. This check runs before collection returns artifacts, so failures
end the shared run as `failed`, with no JSON transaction fallback:
`history_csv_missing_with_transactions` (empty/missing body or failed CSV
HTTP request), `history_csv_count_mismatch` (short or long CSV), or
`history_csv_invalid` (invalid encoding/header). The allowlisted code is
stored at terminal, report and account-unit scope, without provider text or
amounts. Transport failures likewise fail the run. Existing failed-run
artifact retention is unchanged. See [ADR 0092](adr/0092-sony-history-csv-only.md).

Sanitizer: the collector's own `sanitizeWalletHtml` (Sony Bank Wallet
statements), the same pass the retired legacy path applied before the importer
forwarded the object verbatim. The collector stores exactly those bytes and
records the step as a `redacted` transformation with no retained input,
because the provider HTML was deliberately not kept. Before a byte is planned
it is re-checked (`assertCentralSafe`) against the invariants the importer
enforced on the way to central storage: a wallet page that still carries a
`;jsessionid=` or a hidden-input value, or a JSON payload with a credential
field (`loginPwd`, `password`, `csrf`, …), throws a stable code and the run
writes no terminal instead of publishing the value (G3-08).

Terminal fields: `producer: collector-sony-bank`; one unit `account`
(`unitKind: account`) whose `artifactCount` counts every artifact but
`manifest.json`, which belongs to the run and names no unit (ADR 0021; until
then the manifest named the unit and was counted in it); ranges
`request-window` (the requested `from`/`to`; every run, from the alarm or
from an operations-API `collect`, neither of which carries a window, requests
yesterday's JST date, the last finished JST day, from the first of its JST
month, `defaultWindow`, so a run on the 1st requests the whole previous month
and each day is requested after it ends; an open limit: the previous month's
last day is requested only by a run on the 1st, so if that run is missed or
fails, no later run requests that day, because a window that crosses a month
boundary is a request shape nobody has observed, ADR 0004) and, when wallet
statements were collected, `wallet-months`; one `terminal` report carrying the outcome;
`requestedScope.scopeKind = date_range` over the same window;
`coverageStatus` `complete` for a successful window, `partial` for a partial
run, `unknown` for a failure. `manifest.json` is the collector manifest with
the central-safe failure messages (`manifestFailure`) and each artifact's
`key` pointing at the content-addressed object that was actually written; the
terminal's `artifacts[]` stays authoritative.

Verified with synthetic fixtures in
`services/collector-sony-bank/test/shared-collection.test.ts` (G1-01, G1-02,
G1-08, G1-09, G1-15, G3-07, G3-08). The importer-side parity suite was removed
with the importer ([legacy-retirement.md](legacy-retirement.md)). No provider
was contacted and no production bucket was read or written.

### Money Forward ME (`services/collector-moneyforward`, `kogane-moneyforward-collector-poc`)

| Artifact key                    | Role                 |
| ------------------------------- | -------------------- |
| `accounts.html`                 | `provider_response`  |
| `account-detail-NN.html`        | `provider_response`  |
| `account-NN-month-YYYY-MM.html` | `provider_response`  |
| `manifest.json`                 | `collector_manifest` |

Sanitizer: none is applied to the pages — the retired legacy path stored
exactly these bytes and the importer forwarded them verbatim, because the
collector keeps only the rendered aggregator pages and never the request
headers, cookies or credential exchange that produced them. The one
normalization is to the manifest, whose failure message is replaced by its
failure code; the collector writes that normalized manifest. (The importer
also re-serialized its _parsed_ view of the manifest, adding `filename`,
`kind`, `accountOrdinal` and `month` per artifact — values derived from the
artifact key, not stated by the collector. The collector's manifest is its own
record and does not carry them.)

Terminal fields: `producer: collector-moneyforward-me`; one unit per account
(`unitKind: account`) holding its detail page and its monthly fragments — the
run-wide `accounts.html` index belongs to no unit; `declared_coverage` month
ranges cover only consecutive monthly fragments actually captured for each
account. One contiguous interval retains `months-<unit>`; gaps split it into
`months-<unit>-<start-month>` intervals. A missing month inside the outer
bounds is not declared captured. These manifest-based ranges do not prove the
aggregator's underlying provider data is fresh or its full history is retained;
one `terminal` report carries the outcome;
`requestedScope.scopeKind = full_snapshot` (the run asks for whatever the
aggregator currently shows) listing the accounts as `unitKeys`.

The unit key is the account identity the parser requires,
`moneyforward-account-v2-<64 hex>`
([ADR 0027](adr/0027-moneyforward-collector-account-identity.md),
[ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md)): the
unkeyed, domain-separated SHA-256 of `["moneyforward-account-v2",
account[id_hash], service[id]]`, read from each account-detail page with the
retired importer's checks (`src/account-identity.ts`). No secret is involved.
The artifact keys stay positional. When any account's tuple is absent or fails
a check, the whole run keeps positional units (`account-NN`, from the filename
grammar), which the parsers reject (`parser_rejected`); the persist diagnostic
carries `identity: derived` or one closed code (`identity_tuple_absent`,
`identity_tuple_invalid`, `identity_duplicate`, `identity_index_mismatch`,
`identity_incomplete`). No identifier is logged or written outside the pages
themselves. The parsers also accept the importer's `moneyforward-account-v1-`
identities, which are a different account from the v2 identity of the same
service ([identity operations](identity-operations.md#moneyforward-collector-runs-carry-the-account-identity)).

Verified with synthetic fixtures in
`services/collector-moneyforward/test/shared-collection.test.ts` (G1-01,
G1-02, G1-08, G1-09, G1-15, G3-07, G3-08) and
`services/collector-moneyforward/test/account-identity.test.ts` (ADR 0027);
end to end, registration and parsing in
`services/processor/test/moneyforward-shared-r2.test.ts`. The importer-side parity suite was
removed with the importer ([legacy-retirement.md](legacy-retirement.md)). No
provider was contacted and no production bucket was read or written.

### MyJCB (`services/collector-myjcb`, `kogane-myjcb-collector-poc`)

| Artifact key                                                                                                                                 | Role                         | Step (ADR 0021)                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| `<connectionId>/credit-menu.html`, `…/credit-detail-NN.html`, `…/credit-schedule-NN.html`, `…/credit-skip-payment-NN.html`, `…/debit-*.html` | `sanitized_provider_capture` | `redacted` by `myjcb-sanitizer`, no input  |
| `<connectionId>/credit-past-months.json`                                                                                                     | `provider_response`          | none                                       |
| `<connectionId>/credit-{csv,pdf,ofx}` exports                                                                                                | `provider_export`            | none                                       |
| `<connectionId>/credit-ledger-NN.json`                                                                                                       | `collector_derived`          | `extracted` by `collector-myjcb`, no input |
| `<connectionId>/discovery.json`                                                                                                              | `collector_derived`          | `extracted` by `collector-myjcb`, no input |
| `manifest.json`                                                                                                                              | `collector_manifest`         | none; names no unit                        |

A ledger is parsed from the statement page of the same `detailMonth` before
that page is redacted, and `discovery.json` from the login and mypage
responses; none of those bytes is kept, so both register as
`source_bytes_not_available`. The redacted `credit-detail-NN.html` kept in the
same run is not named as the ledger's input: the ledger was not derived from
it, and the sanitizer rewrites text (card-number-shaped digit runs) as well as
attributes, so the capture need not reproduce the ledger. Before ADR 0021
neither stated a step, and the Processor refused the run
(`artifact_lineage_unstated`).

Sanitizer: the collector's own `redactedStatementHtml` (parse5 tree: scripts,
styles, textareas, embedding elements and every URL-bearing attribute removed,
every `value=` replaced by `[redacted]`, card numbers in text replaced; body
text, the 口座名義 cell included, is kept as displayed). `myjcb-sanitizer` v3
is the same sanitizing as v1, which is what the retired legacy path stored;
v2 runs also replaced the 口座名義 cell with `[redacted:name]`, which
[ADR 0029's amendment 2](adr/0029-data-classification-and-unkeyed-identity.md#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence) withdrew. The collector adds
`assertRedactedHtml` (`src/redaction.ts`), the invariants the importer
enforced, checked on the bytes about to leave the Worker: a redaction
regression throws `artifact_html_redaction_invalid` and the run writes no
terminal rather than publishing the page. With the importer's second sanitizer
pass retired, this is the last check before `DATA`. Datasets the importer
never accepted (`debit-menu`, `debit-detail`, `credit-csv`, `credit-pdf`,
`credit-ofx` — it refused a manifest naming one with
`manifest_dataset_unobserved`) are refused here the same way
(`artifact_dataset_unobserved`): `DATA` holds nothing the legacy path never
let through. The collector manifest rebuilds each connection and each failure
from closed fields: a status, counts, and for a connection that stopped, a
stop code from `CONNECTION_STOP_CODES`, the month position it stopped at and
the number of months it kept (failure entries are
`{ connectionId, operation: "collect", code, position }`), plus the months it
kept unread (a position and a code from `UNREAD_MONTH_CODES`) and the export
kinds each month offered (`csv`, `pdf`, `ofx`). A code or kind outside its
list or a position that is not a `detailMonth` refuses the plan, so upstream
free text never reaches the shared bucket either. (As for Money Forward, the
importer's central bytes also carried its parsed `connectionId`, `filename`
and `ordinal` per artifact; the collector's manifest keeps its own artifact
shape.) The Processor's metadata extractor reads that shape. It finds an entry
by the artifact's digest, size and content-addressed key, and takes the
`statementState` and `period` the collector recorded. The connection and
position come from the artifact key, as before
([ADR 0025](adr/0025-myjcb-shared-manifest-metadata.md)).

Terminal fields: `producer: collector-myjcb`; one unit per connection
(`<connectionId>`, `unitKind: connection`), so several cards in one run stay distinguishable and
are never merged into one (G1-16); no ranges, because the statement periods are
provider labels rather than machine ranges and stay in the manifest artifact;
one `terminal` report carrying the outcome; `requestedScope.scopeKind =
full_snapshot` over the connections. The run's `coverageStatus` is `partial`
even for a successful run — a MyJCB card exposes a rolling set of statement
periods, so a finished run is not a claim about the card's whole history —
and registration only records it. Each unit states its own coverage
([ADR 0026](adr/0026-collector-unit-coverage.md)): `complete` for a
successful connection, which enumerated its credit months from the menu and
the past-months response and kept every month's page and the ledger of every
page that states its state. Export links a page offers for its own month are
recorded in the manifest (`exportOffers: [{ position, kinds }]`) and not
fetched: the datasets are refused here (above), so a fetched export would fail
the run's plan
([ADR 0005's amendment (b)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-b-export-links-the-third-ledger-header-and-the-stop-page)).
A menu link belongs to the last `h2` or `h3` before it. The months are the
credit menu's links under the `h2` headings 「最新のご利用明細」 and
「過去の明細」 and the past-months response's available positions; the links
under the `h3` 「ボーナス#回払い・ショッピングスキップ払い」 are payment
schedule pages
([ADR 0005's amendment (c)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months);
the heading levels are
[amendment (j)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-10-04-j-the-menus-schedule-heading-is-an-h3-and-the-bonus-page-is-known-by-its-h1)'s).
A link under any other `h2` or `h3`, or before any, stops the connection
before its first month (`credit_menu_group_unrecognized`). After the last
month each schedule page is fetched and stored whole, redacted (state
`unknown`, period `detailMonth-N`). The page whose one h1 is
「ショッピングスキップ払いご利用明細(未確定分)」 is stored as
`credit-skip-payment-NN.html`, which registration gives the dataset
`credit-schedule` and `myjcb-skip-payment-schedule` reads
([amendment (e)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-e-the-skip-payment-schedule-page-is-read-as-scheduled-payments));
every other schedule page, the ボーナス払い page (one h1
「ボーナス#回払いご利用代金明細(未確定分)」) included, is stored as
`credit-schedule-NN.html`, which no registration rule gives a parser
dataset, so it is catalogued and sealed but never parsed. The manifest records each one as
`schedulePages: [{ position, code }]` (`scheduled_payments_page` when stored,
`schedule_page_fetch` when its fetch failed, which is not a stop) and
`schedulePageCount`; schedule pages never count in `periodCount` or
`capturedMonthCount` and never change the unit's coverage. A month
position whose page has the skip-payment h1 (amendment (h)) or the
ボーナス払い h1 (amendment (j)) is stored and listed the same way, and is not
a month; a `credit-detail` page read as `unknown` carries no period
in the manifest, and one page's bytes at two positions must state one state
and period
([amendment (h)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-29-h-a-stored-page-states-only-what-the-page-states)).
A month can be kept unread: a page kept as `unknown` that shows ledger rows
(no heading, position 2 or later; `rows_unstated`), or a month page whose
ledger shows rows under the observed third header
`ご利用日 / ご利用先など お支払日 / 今後のお支払い金額`, seen so far only on
the ショッピングスキップ払い schedule page (`scheduled_payments_page`). Such a page gets no ledger, so
its rows reach no parser, and the connection goes on to the next month. The
manifest lists these months (`unreadMonths: [{ position, code }]`), the
connection is `partial`, its unit `partial` with `scheduled_payments_page`
when every unread month is under the third header and `collector_partial`
otherwise, and the run `partial` although no failure was recorded. The credit
menu (`detailMenu.html`) is read once, before any detail page, in the same
session. The credit months are read one at a time in ascending
`detailMonth` order, and a month is kept whole or not at all. When a month's
fetch, statement state, period, ledger parse or export fails, the connection
stops at that month ([ADR 0005's amendment](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)):
it keeps the credit menu, the past-months response, the months before it and
`discovery.json`, reads nothing further, and is `partial`. Its unit is
`partial` with the stage's stop code (`month_fetch`, `month_parse`,
`credit_statement_state`, `credit_statement_period`, `credit_page_repeated`
(the same page bytes as an earlier position's page read as another state or
period, [ADR 0005's amendment (h)](adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-29-h-a-stored-page-states-only-what-the-page-states)),
`ledger_parse`, and `export_fetch` only on the fetch path the Worker does not use), and its
manifest entry records the code, the position and the count of months kept.
On `credit_statement_state`, `credit_statement_period` and `ledger_parse` the
page it stopped on is also kept, redacted, as an `unknown` `credit-detail`
with no ledger, so the stop can be diagnosed; it is not counted as a kept
month. A connection that stops before its first month (`login`,
`human_required`, `discovery`, `credit_menu`,
`credit_menu_group_unrecognized`, `credit_first_detail`,
`credit_past_months`, `no_route`, or `unclassified` for an error that names no
stage) keeps nothing and has an `unknown` unit with that code, and so does a
failed debit read (`debit`; a debit capture is refused in shared mode in any
case, above). A run in which
every connection kept nothing is `failed` and stores only its terminal, whose
units still carry each connection's code; registration records such a run
as blocked (`provider_run_failed`) and seals nothing, as before. The run's own code is the stop code
when every connection that is not whole stopped at the same stage. A stopped
connection's unit registers as `failed`, so the run is `partial` and
`not_eligible`: its captured months are catalogued and sealed but not parsed.
The eligibility rule is not loosened; what is kept is the evidence and the
cause. `complete` assumes one detail page holds its whole month, which
has not been observed or confirmed (an open limit,
[ADR 0026](adr/0026-collector-unit-coverage.md#consequences)). A `complete` unit registers as the unit outcome
`success`, as the importer's did, so a successful run is `success` in
`observation_fetch_runs` and is parsed. Terminals written before ADR 0026
declared every unit `partial`; they stay `partial` and `not_eligible`, and the
next successful run captures their confirmed statements again. A connection that
needs a human is a `human-required` state on its own unit with
`safeErrorCode: human_required`, and the run-level code is `human_required`
when every blocked connection is waiting for a person: nothing here retries a
login (G3-10, G3-11).

Verified with synthetic fixtures in
`services/collector-myjcb/test/shared-collection.test.ts` (G1-01, G1-02,
G1-08, G1-09, G1-15, G1-16, G3-08, G3-11) and
`services/collector-myjcb/test/shared-parity.test.ts` (the shared plan stores
the collector's redacted pages unchanged and keeps the manifest facts). No
provider was contacted and no production bucket was read or written.

### Vpass (`services/collector-vpass`, `kogane-vpass-collector-poc`)

Daily reported credit snapshots (ADR 0105) are independent
`<session>-credit-card-NNN` runs. They reuse the existing authenticated
card selection and durable binding. Alongside sanitized card inventory,
selection and statement discovery, they store `credit/authori.json` and
`credit/revo.json` in the existing `card-NNN` unit, plus the existing
binding unit when derivable. The new credit sanitizer explicitly keeps
observed Authori financial keys while removing authentication/card references;
statement sanitizer v1 output remains unchanged. Registration v8 maps only
these two new JSON keys to `credit-snapshot`; versions v1-v7 keep their
old meaning.

The `vpass-credit-snapshot` parser publishes visible overall/card/revolving/
installment-twice-bonus reported limit, outstanding and availability at
1,000 JPY precision, cross-checked against the 万円 display, plus exact
reported revolving outstanding/repayment yen. The metric names and
`extra._kogane.reportedPrecisionJPY` state precision. Hidden zero rows are
unavailable. Metrics are non-additive shared-credit reports, outside assets
and canonical liabilities; availability is not recomputed. The selecting
`coverage-v1` policy keeps the newest complete card snapshot, while raw
history and prior publications remain append-only. Statement failures do
not discard a successful card snapshot. Exact installment precision remains
unobserved, so the existing `balance` catalogue entry stays partial under
[#1256](https://github.com/risu729/kogane/issues/1256).
See the [dated source observation](sources/vpass.md).
The table below describes statement runs.

| Artifact key                             | Role                         | Unit                  |
| ---------------------------------------- | ---------------------------- | --------------------- |
| `card-list.json`                         | `sanitized_provider_capture` | `card-NNN`            |
| `select-card.json`                       | `sanitized_provider_capture` | `card-NNN`            |
| `web-meisai-top.json`                    | `sanitized_provider_capture` | `card-NNN`            |
| `months/<yyyymm>/<top\|answer>-NNN.json` | `sanitized_provider_capture` | `card-NNN`            |
| `manifest.json`                          | `collector_manifest`         | none (the run's)      |
| `card-identity-binding.json`             | `collector_derived`          | `vpass-card-v2-<hex>` |

The binding artifact is written only when the card tuple passes its checks
(below).

The statement pages were `provider_response` until ADR 0021. They are the
sanitizer's output like the other three envelopes and carry the same
`redacted` step, and CORE seals a provider role only with `decrypted` or
`extracted` steps, so a card run with a page could never be sealed
(`run_inventory_incomplete`). `manifest.json` names no unit, so the card's
`artifactCount` counts its envelopes only.

Sanitizer: `vpass-json-sanitizer` v1 (`src/sanitize.ts`). Unlike the other
collectors, the retired legacy Vpass path stored the raw response envelopes in
its own bucket and the importer sanitized them on the way to central storage —
so the collector, which now writes the shared bucket itself, sanitizes first.
`src/sanitize.ts` is that transformation, with the same id, version and rules
the importer applied: every key naming authentication, a session, a device, a
CSRF token or a card identify key is replaced wholesale; the card inventory
keeps ordinal labels (`card-001`) and a placeholder reference instead of names
and keys; the result is canonically encoded (sorted keys, trailing newline) and
then re-checked, so output that still holds a sensitive value fails the run
instead of being stored. The artifact keys are the ones central storage already
uses, so the same run registers the same way.

Terminal fields: `producer: collector-vpass`; one run **per card**, `runId = <session run id>-card-NNN`,
all cards of one session carrying that session id as `acquisitionSessionRef`,
so several cards stay distinguishable instead of collapsing into one run
(G1-16). The alarm's answer lists each persisted card run once; a session with
more than 100 card runs persists every one and answers `failed` with
`run_ids_over_limit` and the first 100
([operations API](ops-api.md#collector-execution-adr-0048)). One unit per card (`unitKind: card`), plus the binding unit below
when there is a binding, a `statement-months` declared-coverage range over the
months that were captured, one `terminal` report,
`requestedScope.scopeKind = full_snapshot`. The run's `coverageStatus` is
`partial` even on success: a card exposes a rolling window of statement months,
so a finished run is not a claim about the card's whole history. The card unit
is `complete` only when every month's captured rows (the pages' `meisaiList`
entries) equal the total the provider states for it (`webMeisaiTopK3Vo.allCnt`
on a finalized statement page, a string on the live site, `total` on a
customized one, a number; both read by `providerCount` as a non-negative safe
integer or a string of ASCII digits only); otherwise it is
`partial`, which makes registration record the whole fetch run as `partial`,
which neither identity nor the trusted card binding reads
([ADR 0023](adr/0023-vpass-collector-card-binding.md#amendment-option-3-implemented),
[ADR 0026](adr/0026-collector-unit-coverage.md)). `manifest.json` records each month's `capturedRows`, `statedTotal`
and closed `coverage` code (`complete`, `stated_total_unverified`,
`stated_total_mismatch`) and the card's code, which the persist diagnostic
also logs (`statement_months_absent` when no month was walked). The month
walk (`src/statement-walk.ts`) stops a finalized month after a page whose
`allCnt` is below its `nextPageRow` or on an empty page after the first, and a
customized month once its rows reach `total` with `pageFlg` `1` or `3` or on
an empty answer page; it does not read `pageNo` or `lastPage`, whose meaning
is unobserved
([ADR 0023's note](adr/0023-vpass-collector-card-binding.md#note-2026-09-27-both-stated-total-fields-are-on-the-live-site)).
`producerVersion` is `vpass-worker-card-v1`, the schema version central
storage recorded for a card-scoped Vpass run, and `manifest.json` holds exactly
the summary central storage held for one.

A card (or a session that failed before a card was selected, as unit `run`)
that collected nothing persists a `failed` terminal with no artifact at all
(G1-09).

Card binding. Card purchase recognition needs a durable card identity, which
the card ordinal is not ([Vpass card binding](vpass-card-identity.md)). The
retired importer wrote it as a separate run; the collector writes it into the
card's own run (`src/card-binding.ts`). Before the responses are sanitized, the
Worker takes `externalId`, `globalid` and `cardCode` from the selection and
discovery `header.vpSessionBean`, applies the importer's checks (a
successful envelope, a unique card inventory, descriptors of 32, 32 and 13
characters, the same card code and card name in selection and discovery, and
that name at the card's ordinal in the inventory) and computes
`vpass-card-v2-` + SHA-256 of
`["vpass-card-binding-v2", externalId, globalid, cardCode]`, with no key
([ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md)). Only that
token is stored: as the key of a second `card` unit (`coverageStatus:
complete`, one artifact) and inside `card-identity-binding.json` (the token,
the derivation `schemaVersion: vpass-card-binding-v2`, the session, the
ordinal and the checks; never the tuple or a name). The artifact states one
`extracted` step (`vpass-card-binding` v2) with no input artifact, because the
responses it was read from are stored only redacted, so it registers as
`source_bytes_not_available`; registration gives it the dataset
`card-identity-binding` and format `vpass-card-identity-binding-json` version
`1`, which the trusted view requires.

No secret is needed. The retired importer's tokens are `vpass-card-v1-` HMACs
under a key that is lost, so a card's collector token is never equal to its
importer token: the two are different account entities unless the one-time
identity-value rewrite
([identity operations](identity-operations.md#one-time-identity-value-rewrite))
replaced the importer's token (migration 0063). Without the tuple or when a check fails, the card run is
stored exactly as before with no binding, and the persist diagnostic carries a
closed `binding` code (`bound`, `binding_tuple_absent`,
`binding_tuple_invalid`, `binding_selection_mismatch`,
`binding_inventory_invalid`, `binding_envelope_invalid`), never a value. Whether the current provider
responses still carry the session bean has not been observed; if they do not,
every run logs `binding_tuple_absent` and nothing binds
([identity operations](identity-operations.md#collector-vpass-runs-bind-in-their-own-run)).
`services/collector-vpass/test/shared-collection.test.ts` ("ADR 0023 and ADR 0029") pins
the derivation, the fail-closed codes and that no tuple value and no token
outside the binding unit and artifact reaches a stored byte.

Registration of a card run: one unit (two with a binding), one range and one
artifact per page plus the four fixed artifacts (five with a binding), registered by the Processor in process with no
Service Binding call. Each page costs about 20 operations (D1 statements and
R2 calls) against a per-invocation budget of 500, so a card of about twenty
pages registers in one invocation and a longer card is continued on the next
cron tick with its progress in CORE (issue #87,
[processor.md §3.3](processor.md#33-operation-budget-and-staged-registration-issue-87)).

Every stored object except the binding carries a `redacted` transformation
with no retained input, because the provider envelope that held the session was
deliberately not kept; note that this differs from the legacy central
descriptors, which recorded a statement page as `extracted` from the stored
snapshot — the collector keeps no snapshot to extract from.

Verified with synthetic fixtures in
`services/collector-vpass/test/shared-collection.test.ts` (G1-01, G1-02,
G1-08, G1-09, G1-15, G1-16, G3-07, G3-08). The importer-side parity suite was
removed with the importer ([legacy-retirement.md](legacy-retirement.md)). No
provider was contacted and no production bucket was read or written.

### `v-point` (`services/collector-vpoint`)

| Artifact key                 | Role                | Bytes                                                   |
| ---------------------------- | ------------------- | ------------------------------------------------------- |
| `balance-info.json`          | `collector_derived` | the API response text, transport-decoded and re-encoded |
| `smfg-point.json`            | `collector_derived` | same                                                    |
| `history-page-NNNN.json`     | `collector_derived` | one history page each, in page order                    |
| `vmoney-history-page-*.json` | `collector_derived` | one V Money history page each                           |
| `collection-summary.json`    | `collector_summary` | the collector's own page/total counts                   |

Both history walks stop at the page whose rows reach `results.total`. Before
the total is reached, a page with no rows or with fewer rows than the first
page stops the collection (`premature-end`) instead of ending the walk: an
early end of history has not been observed. Only the first V Money page may
answer with an empty `results`, read as an empty history.

Each `collector_derived` artifact states one `reencoded` step by
`collector-v-point` at the producer version with no input (ADR 0021): the
bytes are `Response.text()` encoded again as UTF-8, the same content but not
provably the provider's bytes, and the response is not stored, so it
registers as `source_bytes_not_available`. Before ADR 0021 the terminal stated
no step and the Processor refused the run (`artifact_lineage_unstated`).

Sanitizer: the collector never stores a request, a header or a cookie — it
stores the decoded JSON response text, the same bytes the retired legacy path
wrote to its bucket and the importer forwarded to the central store. The
session cookie lives in the `VPointSession` Durable Object and appears in no
artifact. The collector manifest itself is _not_ stored as an artifact: the
terminal is the run record, so `manifest.json` (role `collector_manifest` for
legacy runs) has no equivalent.

Terminal: `source: v-point`, `producer: collector-v-point`, `producerVersion:
COLLECTOR_SCHEMA_VERSION` (`vpoint-worker-poc-v2`), `runId` the collector's own
run UUID, `attemptId: attempt-<runId>`, `requestedScope: full_snapshot` over
unit `account`, one unit (`account`/`collection`) whose `artifactCount` is the
stored artifact count, `providerOutcome` from the run status, `coverageStatus`
`complete`/`partial`/`unknown` for `success`/`partial`/`failed`, and
`safeErrorCode` from the run's first safe failure code (`collector_failed` when
a failure carried none). `ranges` and `reports` are empty; `transformations`
holds the `reencoded` steps above.

Not carried over: the V Point Pay email reconciliation report. It was built by
listing the legacy `raw/v-point-pay-email/` prefix, and those notifications
are now content-addressed runs that no prefix enumerates, so the collector no
longer produces it. Cross-source reconciliation belongs to the Processor,
which reads terminals (03 §4).

### `v-point-pay-email` (Email route of `services/collector-vpoint`)

| Artifact key            | Role                | Bytes                                          |
| ----------------------- | ------------------- | ---------------------------------------------- |
| `notification.eml`      | `user_capture`      | the notification message exactly as it arrived |
| `normalized-event.json` | `collector_derived` | the parsed event with its source provenance    |

Sanitizer: the existing email handling is unchanged — the envelope recipient
must match `VPOINT_PAY_EMAIL_RECIPIENT`, a directly delivered message must come
from the V Point Pay sender, and the stored event records
`sourceVerification: source_unverified` because the Email event exposes no
trusted SPF/DKIM result. The V Point _login code_ mail is never stored: it is
parsed for the code and dropped.

Terminal: `source: v-point-pay-email`, `producer: collector-v-point-pay-email`
(one Worker, but a producer per source), `runId` the SHA-256 of the stored
message, `attemptId: message-<that digest>`, run window the message's own date,
`providerOutcome: success`, `coverageStatus: complete`, one unit
(`notification`/`message`), and one transformation (`extracted`,
`vpoint-pay-email-parser`) from `notification.eml` to `normalized-event.json`.
Every field is derived from the message, so a redelivery produces the same
terminal digest and is answered `already_persisted`, which replaces the
retired legacy duplicate check. `producerVersion` is part of that
digest: a mail redelivered after a `COLLECTOR_SCHEMA_VERSION` bump is a
`conflict`, and the handler then fails the delivery rather than overwrite the
terminal already written for that message.

`acquisitionSessionRef` is `email-<sha256 of the message as it arrived>` on the
notification run, and the same value on the V Point run that the same delivered
mail triggers through the email-code path. One session, two sources, two runs,
neither merged into the other (G1-16, 03 §3).

### `v-point-pay` (`services/collector-vpoint-pay`)

| Artifact key               | Role                | Bytes                                            |
| -------------------------- | ------------------- | ------------------------------------------------ |
| `balance.json`             | `collector_derived` | the prepaid balance response text                |
| `transactions-yyyyMM.json` | `collector_derived` | one statement month each, in month order         |
| `collection-summary.json`  | `collector_summary` | the collector's own month and transaction counts |

As for `v-point`, each `collector_derived` artifact states one `reencoded`
step by `collector-v-point-pay` with no input (ADR 0021).

Sanitizer: the refresh token, the device UUID and the access token live in the
Durable Object and in the request headers `collectVPointPay` builds. None of
them is an artifact, and a failure becomes a machine code
(`credential_configuration_required`, `authentication_required`,
`provider_protocol_failed`, `provider_http_failed`, `operation_failed`) rather
than the redacted provider message the legacy manifest kept — a terminal
states codes only (12 §6).

Terminal: `source: v-point-pay`, `producer: collector-v-point-pay`,
`producerVersion: COLLECTOR_SCHEMA_VERSION` (`vpoint-pay-worker-poc-v1`),
`requestedScope: month_range` from the provider's own `inquiry_period` to the
current JST month, one matching `requested-months` range with basis `source`,
both stated as `YYYY-MM` (the collector's `yyyyMM` was refused by the ingest
range contract, `invalid_start_value`, until ADR 0021),
one unit (`account`/`collection`), and `providerOutcome` from the run status.
When the month window is unknown — a run that failed before the balance
response — the scope is `unspecified` and no range is stated rather than a
guessed one.

This collector is **stopped**: `/trigger`, `/probe` and `/reset-credentials`
answer 410, there is no cron, and the notification mail this source is actually
observed through is collected by `services/collector-vpoint` as
`v-point-pay-email`. A future re-enable writes to `DATA` like every other
collector; the Durable Object's single-collection-in-flight exclusion is
unchanged (G3-14), and nothing here adds a scheduler.

### `mobile-suica` (`services/collector-mobile-suica`)

| Artifact key                | Role                         | Bytes                                           |
| --------------------------- | ---------------------------- | ----------------------------------------------- |
| `sf-history-page-0001.html` | `sanitized_provider_capture` | the CP932 history page, `baseVariable` redacted |
| `sf-history.json`           | `collector_derived`          | the rows parsed from that page                  |
| `collection-summary.json`   | `collector_summary`          | the collector's own counts and cookie names     |

Sanitizer: `src/sanitize.ts` (`sanitizeHistoryHtml`) replaces the hidden
`baseVariable` session field with the redaction sentinel and proves the CP932
round trip before anything is stored — the same bytes the retired importer
verified and forwarded centrally. The session envelope, the cookie header and the
browser bootstrap never become artifacts.

Terminal: `source: mobile-suica`, `producer: collector-mobile-suica`,
`producerVersion: COLLECTOR_SCHEMA_VERSION` (`mobile-suica-worker-poc-v2`),
`requestedScope: full_snapshot` over unit `account` with the requested day as
an `as-of-selector` range (`selector`/`date`/`request`) — the date selects the
page, it is not the extent of what came back. Two transformations are stated:
`redacted` by `mobile-suica-history-sanitizer` producing the HTML (with no
input artifact, because the unredacted page is deliberately not retained) and
`extracted` by `mobile-suica-history-normalizer` from the HTML to
`sf-history.json`.

`coverageStatus` is `complete` only when the run succeeded **and** the
collector proved it reached the end of the history; an unproven boundary is
`partial` with `history_boundary_unproven`, however clean the transport was.
The media type in the terminal is `text/html`: `terminal-v1` media types carry
no parameters, and `text/html` is what the central descriptor already declares
for this artifact, with the CP932 charset a constant of the source.

### `sbi-securities` (`services/collector-sbi-securities`)

| Artifact key                                 | Role                | Unit       |
| -------------------------------------------- | ------------------- | ---------- |
| `domestic-cash-positions.json`               | `collector_derived` | `domestic` |
| `account-assets-current.json`                | `collector_derived` | `domestic` |
| `account-assets-history-source.json`         | `provider_response` | `domestic` |
| `account-assets-history-inventory.json`      | `collector_derived` | `domestic` |
| `account-assets-history-<year>.json`         | `collector_derived` | `domestic` |
| `income-payments-summary-source.json`        | `provider_response` | `domestic` |
| `income-payments-rows-source.json`           | `provider_response` | `domestic` |
| `income-payments.json`                       | `collector_derived` | `domestic` |
| `realised-gains-all-summary-source.json`     | `provider_response` | `domestic` |
| `realised-gains-summary-source.json`         | `provider_response` | `domestic` |
| `realised-gains-rows-source.json`            | `provider_response` | `domestic` |
| `realised-gains.json`                        | `collector_derived` | `domestic` |
| `yen-detail-history.json`                    | `collector_derived` | `domestic` |
| `yen-detail-history-page-NNNN-source.json`   | `provider_response` | `domestic` |
| `foreign-cash-history.json`                  | `collector_derived` | `domestic` |
| `foreign-cash-history-page-NNNN-source.json` | `provider_response` | `domestic` |
| `domestic-trade-records.json`                | `collector_derived` | `domestic` |
| `foreign-cash-positions.json`                | `collector_derived` | `foreign`  |
| `foreign-cash-balances.json`                 | `collector_derived` | `foreign`  |
| `foreign-trade-records.json`                 | `collector_derived` | `foreign`  |
| `domestic-trade-records-<from>-<to>.json`    | `collector_derived` | `domestic` |
| `foreign-trade-records-<from>-<to>.json`     | `collector_derived` | `foreign`  |

Weekly asset history comes from the observed no-query/no-body GET
`/account/api/assets/valuations` in the existing main-site session. The
collector audits its closed shape and preserves the exact full response bytes.
A derived inventory records every expected calendar-year shard
(`account-assets-history-<year>.json`), hash and point count, and the source
hash/request/capture time. Yearly shards retain all profiles, native tuples
and residual rows while keeping at most 53 weeks under the unchanged parser
output budget. Their transformation inputs name both the source and inventory.
Missing or changed shards make the domestic unit/run partial. Registration v5
names only yearly derivatives as the history dataset; source/inventory are unparsed;
v1–v4 stay frozen. The parser separates available window coverage from
unavailable null profiles and emits no extra points for native ALL tuples.
The production observation reader chooses one latest witnessed revision per
point before filtering/paging; old raw and superseded observations remain
archived. No new read route is added. The catalogue is partial pending
scheduled publication and account-specific retained-period verification
([ADR 0098](adr/0098-sbi-weekly-asset-history.md)).

Retained cash statements use the observed two-year yen / five-year foreign
presets through JST today, without an operation window or cursor. The yen
query walks its declared pages at size 10; unobserved foreign continuation
fails closed. Original JSON grammar, duplicate keys, exact numeric tokens and
closed fields are audited before raw page storage. Derived bundles name every
source page, preserve the full requested range and check contiguous metadata,
totals, dates, known codes, exact amounts and unique yen ids. Yen direction
counts and exact sums match their controls; positive transfer controls stay
unsupported until observed. USD duplicates retain occurrence identities, and
the production reader chooses one revision per logical id across overlapping
runs. Both statements use the domestic main-site session/unit. Registration
v7 adds only the new USD derivative; raw pages stay unmapped and earlier
mappings stay frozen. Catalogue status remains partial under #1226 pending
unobserved semantics and scheduled proof
([ADR 0102](adr/0102-sbi-retained-cash-history.md)).

Except for the exact weekly/cash-history source bytes above, the bytes are
`JSON.stringify(artifact.body)` — the collector's re-encoded view
of each response, exactly what the retired legacy path wrote to the per-source
bucket and the importer forwarded centrally. A dataset is attributed to a unit
by the same rule the importer used (`foreign-` prefix → `foreign`), except the
new main-site foreign cash statement and its raw inputs, which are domestic.

Each normal collection walks the historically exercised execution-history
interval in at most thirteen non-overlapping windows per scope, each at most 90 days,
newest first. The
newest window retains its original key; older windows use the dated keys.
Domestic history begins January 1 of year minus two, matching the historical
successful requests. Returned date controls must retain that requested
window; a cleared or clamped date is incomplete. Foreign history
uses the historically observed mobile BFF `GetSearchingDuration` query with
`pastYears=2` and begins January 1 of year minus two, through today. This
reproduces the successful historical eleven-window scan and can need thirteen
windows at year end. Web retention is a different surface and is not used as
the mobile boundary. The mobile execution query fields stay unchanged. No progress cursor or operations window
parameter is added ([ADR 0096](adr/0096-sbi-scheduled-execution-history.md)).

Other datasets state one `extracted` step by `collector-sbi-securities` at the
producer version with no input (ADR 0021): each is the collector's own
envelope around what it read from provider responses (the MTS payload with its
result codes, the GraphQL and main-site JSON, the foreign trade history pages
bundled into one object), and none of those responses is stored, so it
registers as `source_bytes_not_available`. Before ADR 0021 the terminal stated
no step and the Processor refused every run (`artifact_lineage_unstated`).

Sanitizer: the passkey credential, the handshake key and the MTS/GraphQL
session ids stay in the secrets and in `src/sbi.ts`; none of them is an
artifact. A failure reaches the terminal only as a machine code
(`provider_http_failed`, `provider_timeout`, `provider_network_failed`,
`credential_configuration_required`, `authentication_required`,
`provider_response_invalid`, `operation_failed`) derived through
`safeErrorDetails`, never as the redacted provider message the legacy manifest
kept (12 §6).

Terminal: `source: sbi-securities`, `producer: collector-sbi-securities`,
`producerVersion: COLLECTOR_SCHEMA_VERSION` (`sbi-worker-poc-v1`), one unit per
requested scope (`domestic`, `foreign`, kind `scope`) carrying that scope's own
artifact count, coverage and error code — a scope that failed does not make the
other scope's data look incomplete, and a scope that produced nothing is
`unknown` rather than an observation of zero. `requestedScope` is a
`date_range` with a matching `requested-window` range when an internal caller
named a window, and otherwise `full_snapshot`. Every artifact with a window
also states `<artifactKey>:requested`, attributed to its scope. Registration
v4 maps dated execution keys and copies each matching requested range into
that artifact's descriptor; earlier registration versions retain their prior
meaning. Empty windows keep separate captures even when their bytes share an
object. Per-window failures retain other windows but mark their scope
incomplete using fixed `sbi_*_history_*` codes. If foreign retention cannot be
read, the old 90-day request remains partial evidence, with
`sbi_foreign_history_retention_unavailable` rather than a completeness claim.

### `mizuho-bank` (`services/collector-mizuho`, `kogane-mizuho-collector`)

| Artifact key                                           | Role                         | Unit                                           |
| ------------------------------------------------------ | ---------------------------- | ---------------------------------------------- |
| `account-list.html`                                    | `sanitized_provider_capture` | `account-list`                                 |
| `ordinary/<branch>-<account>/history/<from>-<to>.html` | `sanitized_provider_capture` | `ordinary:<branch>:<account>:page:<from>:<to>` |
| `ordinary/<branch>-<account>/history/empty.html`       | `sanitized_provider_capture` | `ordinary:<branch>:<account>:page:empty`       |
| `ordinary/<branch>-<account>/history/unparsed.html`    | `sanitized_provider_capture` | `ordinary:<branch>:<account>:page:unparsed`    |

One daily cron (`25 21 * * *` UTC, 06:25 JST) signs in once with the Worker
secrets and reads the account list, then the first displayed history page of
each ordinary JPY account, at most ten accounts: a run holds up to 11
artifacts. The client verifies the bank query day's full current-and-two-prior-
month period, both directions and an empty keyword; a narrower initial page
is replaced by the observed period-selection read. Invalid or clipped echoed
controls fail the account as `invalid-history-period`. Page traversal remains
unobserved, so this does not assert complete all-page coverage. Accounts past the limit, and accounts whose read failed, are
units with no artifact, `coverageStatus: unknown` and the closed code that
stopped them as `safeErrorCode` (`account-limit`, a client code such as
`read-http-error`, or the HTML parser's check as `parse-<code>`; anything else
stays `collection-unit-failed`), which make the run `partial`. A history page
with no transaction block at all (the observed empty state,
[docs/sources/mizuho-bank.md](sources/mizuho-bank.md#empty-history-page-2026-11-09))
is one complete page with no rows, stored under the `empty` key above and
parsed into no transaction and a complete empty page claim; it does not make
the run `partial`. A history page the parser refuses is still stored, sanitized
and `partial`, under the `unparsed` key above; no parser accepts that key, so
it is evidence only. `kogane.collection-quality.read` does not list it either:
Mizuho artifacts carry no dataset, and the cell read lists only artifacts with
a dataset or a parse job.
Additional authentication stops the run, and scheduled retries are disabled.

The `mizuho-collection-result` record distinguishes six closed login-page
checks under the existing `login-unrecognized-page` code: `form-count`,
`field-value`, `missing-token`, `credential-controls`, `entry-base`, and
`post-login-form`. A refused shape also carries `httpStatusClass` and the
expected form's allow-listed name, never the observed form name or page text.
`phaseDurationsMs` counts elapsed milliseconds in `login`, `account-list`,
`history`, and `persistence`, accumulating repeated phases; unvisited phases
are zero. Unknown exceptions and unlisted error codes use `internal-error`,
including on failed units, instead of masquerading as `read-parse-error`.
Known client and parser errors keep their closed codes. These diagnostics
change no login retry, publication or evidence-retention rule.

The `mizuho-weekly` maintenance rule defers the Sunday run until 08:15 JST
(Saturday 22:00 to Sunday 08:15). The official window ends at 08:00
(`config/maintenance-research.json`); revision 2 of the rule (2026-11-08,
owner-instructed) adds 15 minutes because the run deferred to 08:00:01 JST that
morning failed at login with `login-unrecognized-page`. A re-survey proposal
that reads 08:00 as the official end is no reason to move it back.

Sanitizer: `sanitizeMizuhoPage` (`packages/parsers/src/parsers/mizuho-html.ts`)
reduces each page to its account/history DOM before anything is planned, and
`mizuhoRunPlan` refuses an artifact that is not already its own sanitizer's
output (`unsafe-collection-artifact`). The password, cookies and form tokens
stay in Worker secrets or invocation memory; none of them is an artifact.
Each artifact is recorded as a `redacted` transformation by
`collector-mizuho-bank` with no retained input.

Terminal: `source: mizuho-bank`, `producer: collector-mizuho-bank`,
`producerVersion: COLLECTOR_SCHEMA_VERSION` (`mizuho-collector-v1`),
`requestedScope: unspecified` over every unit key and no range; units are
`container`s. `providerOutcome` is `failed` (with no artifact and the
closed code that failed the run, e.g. `login-unrecognized-page`, as
`safeErrorCode`, else `collection-failed`), `partial` when any unit failed
(with `safeErrorCode: collection-unit-failed` on the run and each unit's own
code), else `success`. `coverageStatus` is
`partial` when the collector recorded any issue (for example a first history
page that is not the whole history, which leaves the outcome `success`) and
otherwise `unknown`: no date-range coverage is claimed. The run is written
through `persistRun`, all artifacts held in memory until the terminal is
written, so nothing is staged.

### sbi-shinsei (`kogane-sbi-shinsei-collector-poc`)

Container + Durable Object + `tamia` tunnel; one daily cron (`0 21 * * *`),
unchanged. Terminal source id `sbi-shinsei` (the Processor maps it to the CORE
source `sbi-shinsei-bank`).

| Artifact                                  | Role                         | Bytes                                                             |
| ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `raw-<dataset>.json` (four CORE datasets) | `sanitized_provider_capture` | the provider response with `header.newToken` removed              |
| `normalized.json`                         | `collector_derived`          | the collector's own normalized snapshot                           |
| `manifest.json`                           | `collector_manifest`         | the collector manifest with failures reduced to allowlisted codes |

`manifest.json` was declared `collector_derived` with no step until ADR 0021,
and the Processor refused every run on it (`artifact_lineage_unstated`); it is
the collector's own record, so it is `collector_manifest` now.

- **What the manifest's `artifacts` entries describe.** One entry per stored
  artifact, in collection order, written by `buildSharedRunPlan` from the bytes
  it plans for `DATA`: `sha256` and `bytes` are the digest and size of the
  token-stripped capture (or of `normalized.json` as derived), and `key` is the
  content-addressed object (`objects/<2 hex>/<sha256>`) those bytes are
  written at, the same object the terminal's `storageRef` names. This matches
  Sony Bank's manifest. The terminal's `artifacts[]` stays authoritative.
  Until 2026-11-08 the entries were the Worker's admission records
  (`describeArtifact`): the digest and size of each capture _before_ the token
  was stripped, under a staging-prefix key (`raw/sbi-shinsei/<date>/<runId>/…`)
  that shared mode never writes, so for `raw-top-accounts-balance-and-activity.json`
  (the capture that carries `header.newToken`) the entry described bytes that
  were never stored. Manifests written before then keep those entries
  (append-only; corrections are new runs). No reader depends on them: the
  Processor's collector-manifest metadata extractors exist only for Sony Bank
  and MyJCB (Sony Bank matches an entry by dataset, digest and size; MyJCB's
  shared-bucket manifests by digest, size and content-addressed key), and
  neither the App nor the web evidence browser reads a collector manifest's
  entries. `test/shared-collection.test.ts` ("the collector
  manifest describes the bytes DATA holds") checks every entry against the
  object at its digest in a fake `DATA` bucket.

- `requestedScope`: `full_snapshot` — this source is a current snapshot and the
  trigger accepts no date range. No units, ranges or reports.
- `transformations`: one `redacted` step per provider capture
  (`sbi-shinsei-token-sanitizer` v3: the rotating CSRF token stripped, the
  balance summary's name fields kept as sent; v2 runs replaced those with
  `[redacted:name]`, which
  [ADR 0029's amendment 2](adr/0029-data-classification-and-unkeyed-identity.md#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence) withdrew),
  one `extracted` step for `normalized.json`
  (`sbi-shinsei-normalizer`), matching the central descriptors.
- `acquisitionSessionRef`: none. The container authenticates once per run and no
  session survives it, so there is no generation to reference (12 §4).
- Human-required: a rejected credential or refused login (`credential-shape`,
  `credential-validation`, `login-rejected`, `login-failed`) ends the run
  `failed` with `human_required_credentials`.
- Staging: **none**. The four provider responses and the normalized snapshot
  are held in memory until the terminal is written; the `r2:<dataset>` failure
  operation means "not admitted to the run" (validation), not a staging put.
  The Worker admits each artifact with `describeArtifact` (dataset, filename and
  media-type checks); `test/storage.test.ts` proves that record equals the one
  the legacy staging put returns. The stored manifest does not copy it (above).
- Sanitization: `test/shared-collection.test.ts` asserts the rotating token
  never reaches a stored artifact and the stored manifest keeps only
  allowlisted failure codes. The importer-side digest comparison was removed
  with the importer ([legacy-retirement.md](legacy-retirement.md)).
- Verified with synthetic fixtures only:
  `test/shared-collection.test.ts` (decisions, sanitization, outcomes, an
  end-to-end DATA-only run with a mocked container) and
  `worker-test/shared-data-bucket.test.ts` (a real Miniflare R2 `DATA` bucket).
  No provider was contacted and no production bucket was read or written.

### prestia-globalpass (`kogane-globalpass-collector-poc`)

Container + Durable Object + browser binding + `tamia`/`cf1` tunnels; one daily
cron (`17 18 * * *`), unchanged. Terminal source id `prestia-globalpass` (the
Processor maps it to the CORE source `global-pass`), producer
`collector-prestia-globalpass`.

| Artifact                       | Role                         | Bytes                                                                              |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| `activity-<yyyy-mm>.html`      | `sanitized_provider_capture` | page 1 of the month, as `sanitizeGlobalPassActivityHtml` produced it               |
| `activity-<yyyy-mm>-p<n>.html` | `sanitized_provider_capture` | page `n` (2..5) of a walked month, as `sanitizeGlobalPassActivityHtml` produced it |
| `manifest.json`                | `collector_manifest`         | the collector manifest; each `artifacts` entry names its page's stored object      |

- `requestedScope`: `month_range` over the selected months (oldest to newest),
  `unitKeys: ["account"]`. A run whose container never reported its month list
  states `unspecified` rather than inventing a range.
- `units`: one `account` unit of kind `collection`, the same unit the central
  descriptors use, counting the stored pages; `manifest.json` names no unit
  (ADR 0021 — it named the unit without being counted, which CORE refuses at
  the seal with `run_inventory_incomplete`). `ranges`: one `requested` range
  plus one `declared_coverage` month range per month with a stored page.
- **The page walk** (`paginationStatus: pages_walked`). After selecting a
  month, the container reads the top pager (`div.nablarch_paging`) and, while
  its Next is an enabled `a.nablarch_nextSubmit`, clicks it, waits for the
  POST to `/p/statementInquiry/RW1313010201`, and checks that the new page
  states the next index, the same page count and the same total and shows a
  statement block; a click that produced no POST is retried once, and a
  failed check throws, which ends the run as a container error. It sends one
  `{type: "artifact", month, page, pageCount, html}` line per page, page 1
  first, at most five pages a month (`ACTIVITY_PAGE_CAP`); a month without a
  pager is one page with `pageCount: 1`. The Worker accepts the pages of a
  month only as 1..min(`pageCount`, 5) in order, with one `pageCount`, before
  the next month starts; anything else is `container_contract_invalid`.
- **Coverage.** The `account` unit is `complete` when the run is `success`,
  and the run is `success` only when every selected month is proven whole
  (`monthCoverageCode` in `src/pagination.ts`): either a page with no Found
  line, no pager and no statement block (an empty month), or pages 1..P all
  captured, every page stating the same `N` and `P` and its own index, and
  the statement blocks (two `table.tableStyle4` each) adding up to `N`. A
  month that is not gets one failure `pagination` / `PaginationError` on its
  page-1 key: `activity_pages_unwalked` (pages missing, or the five-page cap),
  `activity_pager_unreadable` (totals, page counts or indexes disagree, or a
  page shows statements or a Found line without a pager) or
  `activity_total_mismatch` (blocks do not add up to `N`). The pager is read
  in English (`Found N Result`, `[p/Ppage]`) and Japanese (「検索結果 N件」,
  「[p/Pページ]」). The run's own coverage stays `partial`: the provider
  exposes a rolling window of statement months. A `success` run registers as
  `success` and its pages are eligible for `global-pass-activity`; any other
  run is `partial` and `not_eligible`
  ([ADR 0026 amendment](adr/0026-collector-unit-coverage.md#amendment-2026-10-04-global-pass-walks-every-page-of-a-month)).
- Logs: before sanitizing, the Worker logs `globalpass-activity-pages` per
  page (the month's position in the run, the walk's `page` and
  `walkPageCount`, and the page's `statedTotal`, `pageIndex`, `pageCount`,
  `statementBlocks`), and `globalpass-activity-coverage` per month
  (`pagesCaptured`, `walkPageCount`, and `errorCode` when not whole); never
  the month or any text. A page the sanitizer refuses still counts in its
  month's decision.
- Failure entries have the keys `operation`, `errorType`, `errorCode`,
  `artifactKey`, and on a sanitizer refusal also `expectationCode`. A page
  the sanitizer refuses is `sanitization` / `GlobalPassSanitizerError` with
  the check's closed code: `globalpass_html_contract_invalid`,
  `globalpass_html_redaction_failed`, `globalpass_html_shape_unreviewed` or
  `globalpass_html_utf8_invalid`, and `expectationCode` names which
  expectation failed (one of `GLOBALPASS_SANITIZER_EXPECTATIONS` in
  `src/sanitize.ts`). The same code is the `artifact-write` diagnostic line's
  `code`, and the first failure's code is the terminal's and the unit's
  `safeErrorCode`. That line also carries a `shape` object: the expectation,
  phase, element and attribute class as closed codes, and counts and
  booleans describing the refused page's markup, never its text
  ([ADR 0026 amendment](adr/0026-collector-unit-coverage.md#amendment-2026-09-28-global-pass-sanitizer-refusals-log-a-counts-only-shape)).
- `transformations`: one `redacted` step per page
  (`globalpass-activity-sanitizer`); the unredacted page is never retained, so
  it has no artifact key.
- `acquisitionSessionRef`: none. The container logs in once per run and keeps no
  session across runs (12 §4).
- Container failures carry a closed code (`container/failure.mjs`; the Worker
  admits only `GLOBALPASS_CONTAINER_FAILURE_CODES` in `src/model.ts`), so a
  failed run's `safeErrorCode` names the step: `globalpass_relay_start_failed`,
  `globalpass_browser_launch_failed`, `globalpass_login_page_failed`,
  `globalpass_challenge_timeout` (no attempt got a Turnstile token),
  `globalpass_challenge_denied` (Access Denied on the login page),
  `globalpass_challenge_failed` (the wait ended other than by a timeout),
  `globalpass_login_submit_failed`, `globalpass_login_denied` (Access Denied
  on the credential POST), `globalpass_login_rejected` (the POST returned to
  the credential form), `globalpass_activity_open_failed`,
  `globalpass_month_discovery_failed`, `globalpass_statement_read_failed`,
  `globalpass_browser_close_failed`, and `browser_collection_failed` for a
  failure in no known step (and from images before `timezone-collector-v8`).
  The failure entry also carries `stage`, `challengeAttempts` and
  `lastHttpStatus` (400-599) when the container sent them; any other value
  is `container_contract_invalid`. Being in the manifest, they outlive the
  seven days Workers Logs keep.
- **The challenge.** The container waits up to 45 s for the Turnstile token
  and, when none comes, loads the login page afresh, at most three attempts
  (`CHALLENGE_ATTEMPTS`). No credential is sent before a token exists, so a
  retried challenge is not a retried login. An edge refusal or a closed page
  ends the wait at once. Each attempt logs `attempt`, `elapsedMs`, a closed
  `code` (`token`, `token-timeout`, `widget-missing`, `edge-denied`,
  `page-unreadable`), the number of Turnstile frames and the last HTTP error
  status of that attempt with its host class (`globalpass`, `turnstile`,
  `turnstile-helper`, `other`). The error record's `challengeAttempts` counts
  every attempt started, and a teardown failure after another failure is
  logged but never replaces that failure's code or stage. Observed 2026-11-05..07: one token after 25 s, two
  waits that ran out at 45 s.
- **Observed after `timezone-collector-v8` (#1121, Deploy #802 2026-11-08
  05:38 UTC), #1134.** The first three scheduled runs (2026-11-08, 11-09 and
  11-10 at 18:17 UTC) all completed with no failure code, against 2 of 4
  runs failing (`collection_failed`) from 11-04 to 11-07. Each needed one
  challenge attempt: `code: token` after 13 993 / 18 347 / 15 209 ms, with
  one Turnstile frame and `lastHttpStatus: 401` (the Turnstile challenge
  fetch, which the token still follows). `globalpass-container-relay-summary`:
  25 / 26 / 26 CONNECT requests, 9 denied each run (browser traffic outside the
  allowlist, the case that crashed the 11-07 run), 16 / 17 / 17 established,
  no upstream failure or timeout; the Worker's `globalpass-relay-closed`
  count matched `established` every run. No `globalpass-container-crash`,
  `/collect` answered 200, and `logout` failed every run (`logoutFailed:
  true`, see the logout audit). Container `console.log` lines are in the
  Workers Observability `containers` dataset of the container application,
  not in the Worker's own dataset; `runtimeRevision` is in the manifest
  only, never in a log line.
- Human-required: **not claimed.** `globalpass_login_rejected` may mean the
  credentials need a person, but it has not been observed, so the terminal
  does not yet say a person must act. The collector still makes exactly one
  credential POST per run; the cron is the only re-attempt.
- The shared persist is reported under the existing `central-import`
  diagnostics stage; the `globalpass-collection-stored` log line carries
  `collectionTarget` (always `shared`), `sharedOutcome`, `terminalKey` and
  `terminalDigest`.
- Staging: **none**. Every sanitized page is held in memory until the terminal
  is written.
- **What the manifest's `artifacts` entries describe.** One entry per stored
  page: `sha256` and `bytes` are the digest and size of the sanitized page,
  and `key` is the content-addressed object (`objects/<2 hex>/<sha256>`) the
  terminal's `storageRef` names for those bytes. Until 2026-11-08 `key` was a
  staging-prefix key (`raw/prestia-globalpass/<date>/<runId>/…`) that shared
  mode never writes; the digest and size were already those of the stored
  bytes. Manifests written before then keep that key (append-only). No reader
  depends on it (the Processor's collector-manifest metadata extractors exist
  only for Sony Bank and MyJCB). `test/shared-worker.test.ts` ("the collector
  manifest names the objects DATA holds") checks every entry against the
  terminal and the object in a fake `DATA` bucket.
- Sanitization: `test/shared-worker.test.ts` asserts nothing in `DATA` carries
  the session state, the password or the relay token. The importer-side
  sanitizer comparison was removed with the importer
  ([legacy-retirement.md](legacy-retirement.md)).
- Verified with synthetic data only: `test/shared-collection.test.ts`
  (decisions, scope/ranges/units, outcomes, redaction),
  `test/shared-worker.test.ts` (an end-to-end DATA-only run with a mocked
  container) and `worker-test/shared-data-bucket.test.ts` (a real Miniflare R2
  `DATA` bucket).

### sbi-vc-trade (`kogane-sbi-vc-session-poc`)

A session Durable Object (`SbiVcSessionState`) with two crons — the 15-minute
keep-alive and the daily collection — both unchanged. Terminal source id
`sbi-vc-trade`, the same id CORE uses.

| Artifact         | Role                 | Bytes                                                       |
| ---------------- | -------------------- | ----------------------------------------------------------- |
| `<dataset>.json` | `collector_derived`  | the gateway envelope with `meta.secureKey` already stripped |
| `manifest.json`  | `collector_manifest` | the collector manifest; each entry names a stored object    |

- `requestedScope`: `full_snapshot`; `account` holds the classic datasets,
  and `full-cashflows` holds the additional all-type lists after the classic
  reads finish. Both are kind `collection`; each counts only its own datasets.
  `manifest.json` names no unit (ADR 0021 — it named the unit
  without being counted, so every run failed its seal with
  `run_inventory_incomplete` and was retried each tick until the ADR 0024
  amendment of 2026-09-26 made that refusal a block). No ranges.
- A successful run declares `coverageStatus: complete`: the collector walks
  every historical execution and cash-flow page to exhaustion and verifies the
  provider's own pagination totals before finishing.
- The existing JPY cash-flow dataset remains the sole publishing dataset for
  remittances. Additional `cashflows-all-recent-page-NNNN` and
  `cashflows-all-historical-page-NNNN` capture unfiltered lists with page size
  20 and the same total/cardinality checks; no parser publishes these evidence
  datasets. Crypto transfer and reward observations remain unsupported, and the
  trader-mode observation has not yet been validated through a scheduled HTTP
  run ([source observation](sources/sbi-vc-trade.md#17-unfiltered-cash-flow-observation-2026-11-10)).
- A failed full-list request makes its own unit and the overall run partial.
  A completed classic `account` unit stays complete and is admitted by the
  explicit classic-dataset `unit-independent-v1` policies. A classic failure
  still excludes that whole account unit. Neither another run's successful
  unit nor the raw lists can rescue it
  ([ADR 0026 amendment](adr/0026-collector-unit-coverage.md#amendment-sbi-vcs-unfiltered-evidence-is-independent-of-its-classic-account-unit-2026-11-10)).
- `transformations`: one `redacted` step per dataset (`sbi-vc-trade-worker`);
  the unredacted envelope carried the session key and is not retained.
- `acquisitionSessionRef`: **yes.** The Durable Object now keeps a session
  generation id under the storage key `sessionRef`, minted when a session is
  seeded and rotated when re-authentication replaces it, in the same storage
  batch as the session itself — so a failed re-authentication cannot lose the
  previous generation (12 §4, G3-09). Cookie rotation inside a live session
  keeps the generation. Only the opaque id reaches the terminal; the cookies,
  the encryption key and the passkey credential never do.
- Human-required: a collection that cannot start because re-authentication
  failed, or because the session was refused (401/403) and has never
  re-authenticated, is recorded as a **`failed` run with its own terminal**
  carrying `human_required_reauth` (`manual_agreement_required` while the
  provider's terms wait for the owner), and `waitingForHuman` is reported in
  the summary and the keepalive alarm history (the `/health` and `/collect`
  routes were removed on 2026-11-08, ADR 0069). A recoverable
  session error uses `session_unhealthy` instead. The blocked collection
  retries no login; the keepalive's re-authentication keeps its cooldown,
  6 hours, or 1 hour for up to 72 hours while a terms agreement is pending
  ([source note §16](sources/sbi-vc-trade.md#16-resuming-after-a-terms-agreement-2026-11-07);
  G3-10, G3-11).
- No deferral: with no service binding in the chain, a run with more than
  eleven artifacts finishes in place. The retired importer path deferred such
  a run to a backfill route, which no longer exists.
- Staging: **none**. Every sanitized envelope is held in memory until the
  terminal is written; the create-only terminal put in `DATA` is the duplicate
  guard the staging `onlyIf` put used to be.
- **What the manifest's `artifacts` entries describe.** One entry per stored
  dataset: `sha256` and `bytes` are the digest and size of the sanitized
  envelope, and `key` is the content-addressed object
  (`objects/<2 hex>/<sha256>`) the terminal's `storageRef` names for those
  bytes. The Worker takes the entry from `describeArtifact` and replaces its
  run-prefix key, which nothing writes: the staging put (`storeArtifact`) that
  wrote it is called by no Worker path and is kept only for the parity tests.
  Until 2026-11-08 `key` was that run-prefix key
  (`raw/sbi-vc-trade/<date>/<runId>/<dataset>.json`), which shared mode never
  writes; the digest and size were already those of the stored bytes.
  Manifests written before then keep that key (append-only). No reader
  depends on it (the Processor's collector-manifest metadata extractors exist
  only for Sony Bank and MyJCB). `test/worker-manifest.test.ts` runs the
  Durable Object's collection against a synthetic gateway and checks every
  entry against the terminal and the object in a fake `DATA` bucket.
- Parity: `test/shared-collection.test.ts` asserts the `DATA` bytes are the
  staged encoding of the same sanitized body (the encoding the retired
  importer forwarded verbatim after checking `meta.secureKey` was absent), and
  that an envelope still carrying `meta.secureKey` is refused with
  `shared_secure_key_present` rather than planned.
- Duplicate dispatch is still one run: the Durable Object's existing
  single-flight `runCollection` returns the in-flight summary (G3-14).
- Verified with synthetic data only: `test/shared-collection.test.ts` and
  `worker-test/shared-data-bucket.test.ts`, which drives the real Durable
  Object and a real Miniflare R2 `DATA` bucket. The Worker does not read a
  collection-target var, and neither the Miniflare config nor the deployed
  config declares one.

### smbc-direct (`kogane-smbc-direct-backfill-poc`)

The only human-triggered source: a person signs in behind Cloudflare Access,
approves a QR challenge, and the backfill then runs across many Durable Object
alarms, one month chunk at a time. **No cron**, before or after this change.
Terminal source id `smbc-direct` (the Processor maps it to the CORE source
`smbc-bank`).

| Artifact                                                    | Role                 | Bytes                                       |
| ----------------------------------------------------------- | -------------------- | ------------------------------------------- |
| `balance.raw.json.sjis`, `transactions/*.raw.json.sjis`     | `provider_response`  | the provider's own response bytes, verbatim |
| `balance.normalized.json`, `transactions/*.normalized.json` | `collector_derived`  | the collector's normalized counterparts     |
| `manifest.json`                                             | `collector_manifest` | the exact manifest bytes written to staging |

One `account` unit counts the stored responses and their normalized
counterparts; `manifest.json` names no unit (ADR 0021). Until then it named
the unit without being counted, so a finished backfill would have failed its
seal with `run_inventory_incomplete`; the run-plan registration test found it.

**Bounded exception to one-copy.** This is the only source that still stages a
run before its terminal, and the reason is structural, not convenience: the
chunks are collected across many Durable Object alarms and the Durable Object
keeps only their manifest entries, so the bytes of a finished run exist nowhere
else until the terminal is written. Each chunk is staged in `DATA` under the
run prefix `raw/smbc-direct/<yyyy>/<mm>/<dd>/<runId>/`, the key layout the
retired per-source bucket used, and the run is re-read from there at the end.
The retirement preserved the staged objects at those keys so that existing
Durable Object progress resumes through `DATA`
([legacy-retirement.md](legacy-retirement.md)). What bounds the exception:

- the staging keys are the ones the per-source bucket used (no new keys);
- the terminal is written by `persistRun`, last, after every content-addressed
  object in `DATA` has been put and verified, exactly like the other sources;
- every re-read byte is verified against the manifest (size and digest) before
  it is planned, and a run larger than `MAX_SHARED_RUN_BYTES` is refused.

**Removal path** (not done; U15 retired the per-source bucket but kept this
staging step): write each chunk's bytes content-addressed into `DATA` from the
alarm that collected it (`persistRun` verifies and reuses an object that is
already there), keep only the manifest entries in Durable Object state as
today, and delete `readStagedArtifacts` and the staging round trip. No terminal
format change is needed for that step.

- **Immutable terminals per published segment** ([ADR 0044](adr/0044-smbc-resume-publication.md)).
  The initial stopped session keeps the backfill ID. Resumed sessions publish
  additional partial evidence or a full success snapshot in digest-addressed
  continuation terminals. Partial SMBC account units are not parseable, so
  final success includes their earlier chunks; only artifacts from clean
  successful complete terminals are excluded. Previously catalogued normalized
  bytes must remain unchanged. Each continuation attaches its segment manifest plus the
  exact cumulative staging manifest as a non-unit collector artifact.
  A changed failure with no new provider bytes publishes only manifests and
  reports failed; an exact snapshot retry is a no-op.
- The run's bytes are re-read from the staging prefix at that point (the
  bounded exception above) and **verified against the manifest** (size and
  digest) before anything is planned; a byte that changed or vanished stops the
  run with no terminal. A run larger than `MAX_SHARED_RUN_BYTES` (48 MiB) is
  refused for the same reason rather than read into memory.
- Parity: `test/shared-collection.test.ts` stores a Shift_JIS provider body
  through the staging re-read and asserts `DATA` holds the identical bytes
  (the retired importer forwarded this source's provider bytes verbatim after
  a Shift_JIS round-trip check), and that the `manifest.json` object equals the
  bytes `storeManifest` stages.
- `requestedScope`: `date_range` over `DEFAULT_BACKFILL_FROM` through the last
  finished JST day at approval (inclusive),
  `unitKeys: ["account"]`; one `account` unit of kind `collection`. `ranges`:
  the requested range plus one `declared_coverage` range per collected month
  (the raw and normalized artifacts of a month share it).
- **Closed days and resumable windows** (owner decision, 2026-11-08 13:26 UTC;
  [issue 1178](https://github.com/risu729/kogane/issues/1178)). Fresh runs exclude
  the current JST day entirely. A stopped run retains its stored `from`, `to`,
  run identity, completed chunks and artifacts across later approvals, including
  a changed `DEFAULT_BACKFILL_FROM`; it finishes that frozen window. The next
  fresh backfill advances the end to the last finished JST day at its approval.
  Legacy runs whose stored end was their approval day also resume. An alarm
  defers an unfinished last chunk to the next JST midnight while its end day is
  still open, rather than replacing the run or shrinking its recorded range.
  The session can expire while waiting; recovery still needs a fresh approval.
  Transaction artifacts record their request-start `collectedAt`. Publication
  declares complete coverage only when every artifact's end day had already
  finished at acquisition and the requested end had finished at completion.
  Legacy artifacts without that timestamp use the run start as a conservative
  lower bound. An old saved success that captured an open day keeps its bytes
  and provider outcome but publishes `coverageStatus: partial` with
  `coverage_day_not_finished` on its account unit (the run itself carries no
  code: the terminal contract refuses one on a `success`; registration records
  that unit `failed`), even if publication is retried after midnight;
  stored progress and `/api/status` retain this coverage reason and report
  `waitingForHuman: true`. The UI explains that a fresh QR approval and backfill
  are needed, and that retrying shared publication cannot repair coverage. A
  new run clears this recovery reason. Existing immutable terminals
  are never rewritten. See [ADR 0044](adr/0044-smbc-resume-publication.md).
- Media types lose their `charset` parameter in the terminal (`application/json`);
  the Shift_JIS bytes themselves are stored unchanged.
- `transformations`: one `extracted` step per normalized artifact
  (`smbc-direct-normalizer`) naming its raw parent when that parent is in the run.
- `acquisitionSessionRef`: **yes.** The Durable Object keeps `sessionRef` (the
  live generation, rotated on every approved sign-in) and `runSessionRef` (the
  generation that opened the current run, kept across a resume). The terminal
  carries `runSessionRef` for the initial publication and the current
  `sessionRef` for partial continuation segments. The full successful snapshot
  retains `runSessionRef` and its prior-terminal lineage because it spans
  approved sessions. The credential, the encrypted session envelope, the
  challenge state and the page cookies stay in Durable Object state (12 §4).
- Human-required: this source has **no unattended re-authentication at all**,
  and none was added. Any run that does not reach `success` needs a person to
  approve a new challenge before it can continue, so its terminal reports
  `waitingForHuman`, and a run that lost its session carries
  `human_required_approval` (G3-10, G3-11). `/api/status` reports
  `waitingForHuman` while the person still has to act.

- Verified with synthetic data only: `test/shared-collection.test.ts` and
  `worker-test/shared-data-bucket.test.ts` and `worker-test/continuation.test.ts`,
  which stage initial and resumed runs into a real
  Miniflare R2 `DATA` bucket, re-reads it and writes the objects and the
  terminal into the same bucket.
- A bare `bun test` also discovers `worker-test/shared-data-bucket.test.ts`,
  whose `cloudflare:test` import resolves only under Vitest. The test task runs
  `vitest run` and `bun test ./test` separately, and both pass under bun 1.4.0.
