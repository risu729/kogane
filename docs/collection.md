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
because the provider HTML was deliberately not kept. Before a byte is planned
it is re-checked (`assertCentralSafe`) against the invariants the importer
enforces on the way to central storage: a wallet page that still carries a
`;jsessionid=` or a hidden-input value, or a JSON payload with a credential
field (`loginPwd`, `password`, `csrf`, …), throws a stable code and the run
writes no terminal instead of publishing the value (G3-08).

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
G1-08, G1-09, G1-15, G3-07, G3-08) and, for parity with the importer, in
`services/collector-r2-importer/test/shared-target-parity.test.ts`: the same
synthetic legacy run validated by the importer and mapped by the shared plan
names the same digest for every artifact, and the shared `manifest.json` is
the legacy manifest byte for byte with each `raw/…` key replaced by the
content-addressed key. No provider was contacted and no production bucket was
read or written.

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
by its failure code; shared mode writes that normalized manifest. (The
importer also re-serializes its _parsed_ view of the manifest, so the central
bytes today additionally carry `filename`, `kind`, `accountOrdinal` and
`month` per artifact — values derived from the artifact key, not stated by the
collector. The shared manifest is the collector's own record and does not
carry them; the parity test pins exactly that difference.)

Terminal fields: one unit per account (`account-NN`, `unitKind: account`),
taken from the collector's own filename grammar — the run-wide
`accounts.html` index belongs to no unit; a `months-account-NN`
`declared_coverage` range per account covering the monthly fragments that were
actually captured; one `terminal` report carrying the outcome;
`requestedScope.scopeKind = full_snapshot` (the run asks for whatever the
aggregator currently shows) listing the accounts as `unitKeys`.

Verified with synthetic fixtures in
`services/collector-moneyforward/test/shared-collection.test.ts` (G1-01,
G1-02, G1-08, G1-09, G1-15, G3-07, G3-08) and, for parity with the importer,
in `services/collector-r2-importer/test/shared-target-parity.test.ts` (every
page digest identical; the manifest identical field by field with the keys
substituted). No provider was contacted and no production bucket was read or
written.

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
is what the legacy path already stores. Shared mode adds `assertRedactedHtml`
(`src/redaction.ts`), the invariants the central path enforces, checked again
on the bytes about to leave the Worker: a redaction regression throws
`artifact_html_redaction_invalid` and the run writes no terminal rather than
publishing the page. The importer runs its own sanitizer pass over the stored
page again on the way to central storage; the parity test proves that pass is
the identity on collector output, so the shared bytes are the central bytes.
Datasets the central path has never accepted (`debit-menu`, `debit-detail`,
`credit-csv`, `credit-pdf`, `credit-ofx` — the importer refuses a manifest
naming one with `manifest_dataset_unobserved`) are refused here the same way
(`artifact_dataset_unobserved`): shared mode does not store centrally what the
legacy path never let through. The collector manifest is written in its
central shape — a connection blocker and a failure message become coarse codes
(`human-required`, `collector-failure`, `r2-write-failure`), so upstream free
text never reaches the shared bucket either. (As for Money Forward, the
importer's central bytes today also carry its parsed `connectionId`,
`filename` and `ordinal` per artifact; the shared manifest keeps the
collector's own artifact shape.)

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
G1-08, G1-09, G1-15, G1-16, G3-08, G3-11) and, for parity with the importer,
in `services/collector-myjcb/test/shared-parity.test.ts` (the collector's
redacted pages validated by the importer's `validateMyJcbRun` and mapped by
the shared plan name the same digest for every artifact, and the importer's
central bytes equal the legacy bytes). No provider was contacted and no
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
G1-08, G1-09, G1-15, G1-16, G3-07, G3-08) and, for parity with the importer,
in `services/collector-r2-importer/test/shared-target-parity.test.ts`: the
importer's `validateVpassRun` over a synthetic legacy snapshot and the shared
plan over the same raw envelopes name the same digest for all six artifacts,
`manifest.json` included. No provider was contacted and no production bucket
was read or written.

### `v-point` (`services/collector-vpoint`)

| Artifact key                 | Role                | Bytes                                                   |
| ---------------------------- | ------------------- | ------------------------------------------------------- |
| `balance-info.json`          | `collector_derived` | the API response text, transport-decoded and re-encoded |
| `smfg-point.json`            | `collector_derived` | same                                                    |
| `history-page-NNNN.json`     | `collector_derived` | one history page each, in page order                    |
| `vmoney-history-page-*.json` | `collector_derived` | one V Money history page each                           |
| `collection-summary.json`    | `collector_summary` | the collector's own page/total counts                   |

Sanitizer: the collector never stores a request, a header or a cookie — it
stores the decoded JSON response text it already writes to the legacy bucket
today, and those are the bytes the importer forwards to the central store. The
session cookie lives in the `VPointSession` Durable Object and appears in no
artifact. The collector manifest itself is _not_ stored as an artifact in
shared mode: the terminal is the run record, so `manifest.json` (role
`collector_manifest` centrally) has no shared-mode equivalent.

Terminal: `source: v-point`, `producer: collector-vpoint`, `producerVersion:
COLLECTOR_SCHEMA_VERSION` (`vpoint-worker-poc-v2`), `runId` the collector's own
run UUID, `attemptId: attempt-<runId>`, `requestedScope: full_snapshot` over
unit `account`, one unit (`account`/`collection`) whose `artifactCount` is the
stored artifact count, `providerOutcome` from the run status, `coverageStatus`
`complete`/`partial`/`unknown` for `success`/`partial`/`failed`, and
`safeErrorCode` from the run's first safe failure code (`collector_failed` when
a failure carried none). `ranges`, `reports` and `transformations` are empty.

Not carried over to shared mode: the V Point Pay email reconciliation report.
It is built by listing the legacy `raw/v-point-pay-email/` prefix, and in
shared mode those notifications are content-addressed runs that no prefix
enumerates — a report built from the legacy bucket alone would silently
under-count them. Cross-source reconciliation belongs to the Processor, which
reads terminals (03 §4). In `legacy` mode it is produced exactly as before.

### `v-point-pay-email` (Email route of `services/collector-vpoint`)

| Artifact key            | Role                | Bytes                                          |
| ----------------------- | ------------------- | ---------------------------------------------- |
| `notification.eml`      | `user_capture`      | the notification message exactly as it arrived |
| `normalized-event.json` | `collector_derived` | the parsed event with its source provenance    |

Sanitizer: the existing email handling is unchanged — the envelope recipient
must match `VPOINT_PAY_EMAIL_RECIPIENT`, a directly delivered message must come
from the V Point Pay sender, and the stored event records
`sourceVerification: source_unverified` because the Email event exposes no
trusted SPF/DKIM result. The V Point _login code_ mail is never stored in
either mode: it is parsed for the code and dropped.

Terminal: `source: v-point-pay-email`, `runId` the SHA-256 of the stored
message, `attemptId: message-<that digest>`, run window the message's own date,
`providerOutcome: success`, `coverageStatus: complete`, one unit
(`notification`/`message`), and one transformation (`extracted`,
`vpoint-pay-email-parser`) from `notification.eml` to `normalized-event.json`.
Every field is derived from the message, so a redelivery produces the same
terminal digest and is answered `already_persisted` — the shared-target
equivalent of the legacy duplicate check. `producerVersion` is part of that
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

Sanitizer: the refresh token, the device UUID and the access token live in the
Durable Object and in the request headers `collectVPointPay` builds. None of
them is an artifact, and a failure becomes a machine code
(`credential_configuration_required`, `authentication_required`,
`provider_protocol_failed`, `provider_http_failed`, `operation_failed`) rather
than the redacted provider message the legacy manifest keeps — a terminal
states codes only (12 §6).

Terminal: `source: v-point-pay`, `producer: collector-vpoint-pay`,
`producerVersion: COLLECTOR_SCHEMA_VERSION` (`vpoint-pay-worker-poc-v1`),
`requestedScope: month_range` from the provider's own `inquiry_period` to the
current JST month, one matching `requested-months` range with basis `source`,
one unit (`account`/`collection`), and `providerOutcome` from the run status.
When the month window is unknown — a run that failed before the balance
response — the scope is `unspecified` and no range is stated rather than a
guessed one.

This collector is **stopped**: `/trigger`, `/probe` and `/reset-credentials`
answer 410, there is no cron, and the notification mail this source is actually
observed through is collected by `services/collector-vpoint` as
`v-point-pay-email`. The shared target is therefore the path a future
re-enable writes to; the Durable Object's single-collection-in-flight exclusion
is unchanged by it (G3-14), and switching the target adds no scheduler.

### `mobile-suica` (`services/collector-mobile-suica`)

| Artifact key                | Role                         | Bytes                                           |
| --------------------------- | ---------------------------- | ----------------------------------------------- |
| `sf-history-page-0001.html` | `sanitized_provider_capture` | the CP932 history page, `baseVariable` redacted |
| `sf-history.json`           | `collector_derived`          | the rows parsed from that page                  |
| `collection-summary.json`   | `collector_summary`          | the collector's own counts and cookie names     |

Sanitizer: `src/sanitize.ts` (`sanitizeHistoryHtml`) replaces the hidden
`baseVariable` session field with the redaction sentinel and proves the CP932
round trip before anything is stored — the same bytes the importer verifies and
forwards centrally today. The session envelope, the cookie header and the
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

| Artifact key                   | Role                | Unit       |
| ------------------------------ | ------------------- | ---------- |
| `domestic-cash-positions.json` | `collector_derived` | `domestic` |
| `account-assets-current.json`  | `collector_derived` | `domestic` |
| `yen-detail-history.json`      | `collector_derived` | `domestic` |
| `domestic-trade-records.json`  | `collector_derived` | `domestic` |
| `foreign-cash-positions.json`  | `collector_derived` | `foreign`  |
| `foreign-cash-balances.json`   | `collector_derived` | `foreign`  |
| `foreign-trade-records.json`   | `collector_derived` | `foreign`  |

The bytes are `JSON.stringify(artifact.body)` — the collector's re-encoded view
of each response, exactly what it writes to the per-source bucket today and
what the importer forwards centrally. A dataset is attributed to a unit by the
same rule the importer uses (`foreign-` prefix → `foreign`).

Sanitizer: the passkey credential, the handshake key and the MTS/GraphQL
session ids stay in the secrets and in `src/sbi.ts`; none of them is an
artifact. A failure reaches the terminal only as a machine code
(`provider_http_failed`, `provider_timeout`, `provider_network_failed`,
`credential_configuration_required`, `authentication_required`,
`provider_response_invalid`, `operation_failed`) derived through
`safeErrorDetails`, never as the redacted provider message the legacy manifest
keeps (12 §6).

Terminal: `source: sbi-securities`, `producer: collector-sbi-securities`,
`producerVersion: COLLECTOR_SCHEMA_VERSION` (`sbi-worker-poc-v1`), one unit per
requested scope (`domestic`, `foreign`, kind `scope`) carrying that scope's own
artifact count, coverage and error code — a scope that failed does not make the
other scope's data look incomplete, and a scope that produced nothing is
`unknown` rather than an observation of zero. `requestedScope` is a
`date_range` with a matching `requested-window` range when the trigger named a
window, and `full_snapshot` with no range when it did not.
