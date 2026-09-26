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
- `operationId`/`attemptId` are carried when an operation requested the run.
  U08 dispatches collection operations; today the cron and the admin trigger
  leave them unset.
- **One copy** (plan 00: the original is stored once; no standing
  collector-side → central double copy). A run is written only into `DATA`.
  sbi-shinsei, globalpass and sbi-vc-trade hold every artifact of a run in
  memory until the terminal is written, so nothing structural depends on a
  staging object and nothing is staged; their end-to-end tests assert zero
  staging puts. The one bounded exception is smbc-direct, whose chunks span
  Durable Object alarms and are staged under its run prefix inside `DATA`
  until the terminal is written (see its section).
- Deploy order: the Processor before the collectors, so a terminal is never
  written before something can read it
  ([rollout.md §4](rollout.md#4-deployment-order)). There is no collector
  legacy mode to roll back to, and a release that needs the retired Workers
  or buckets is not a valid rollback target. Terminals already written stay
  valid and are picked up by the Processor's bounded `runs/` scan. Moving to
  the shared bucket added no cron or scheduler, so it never doubled provider
  access (11 §4).

### Terminal `source` ids and CORE source ids

A terminal names the collector's own source id. The Processor maps it to the
CORE source id through the closed table `COLLECTOR_SOURCE_IDS` in
`packages/application/src/collection/descriptors.ts`
([processor.md §3.1](processor.md#31-collector-ids-core-source-ids-and-producers));
no collector carries the CORE id.

| Collector Worker                   | Terminal `source` (`runs/<source>/…`) | CORE source id     |
| ---------------------------------- | ------------------------------------- | ------------------ |
| `kogane-sbi-shinsei-collector-poc` | `sbi-shinsei`                         | `sbi-shinsei-bank` |
| `kogane-globalpass-collector-poc`  | `prestia-globalpass`                  | `global-pass`      |
| `kogane-sbi-vc-session-poc`        | `sbi-vc-trade`                        | `sbi-vc-trade`     |
| `kogane-smbc-direct-backfill-poc`  | `smbc-direct`                         | `smbc-bank`        |
| `kogane-mizuho-collector`          | `mizuho-bank`                         | `mizuho-bank`      |

### Artifact datasets at registration (ADR 0022)

A terminal names no parser dataset, and no collector adds one: the Processor
derives it at registration from what the terminal already states — the
artifact key, its role and its media type — through the closed table
`ARTIFACT_DATASETS` in `packages/application/src/collection/descriptors.ts`
([processor.md §3.4](processor.md#34-artifact-datasets-adr-0022),
[ADR 0022](adr/0022-registration-artifact-datasets.md)). The artifact tables
below are its source: a collector that renames an artifact, changes its role
or declares another media type leaves that artifact without a dataset, and so
unparsed, until the table follows. Vpass statement pages are withheld and
registered without a dataset until the collector derives the trusted card
binding ([ADR 0023](adr/0023-vpass-collector-card-binding.md)). The table is
registration contract `terminal-registration-v2`: a run registered under v1
whose artifacts gain a dataset registers again under v2 (its v1 artifacts were
never parsed), and every other v1 registration is carried over unchanged, so
no capture is parsed twice.

### Sony Bank (`services/collector-sony-bank`, `kogane-sony-bank-collector-poc`)

| Artifact key                                     | Role                         |
| ------------------------------------------------ | ---------------------------- |
| `gross-balance.json`, `*-history-page-NNNN.json` | `provider_response`          |
| `yen-history.csv`, `foreign-history-<ccy>.csv`   | `provider_export`            |
| `wallet-history-YYYY-MM.html`                    | `sanitized_provider_capture` |
| `collection-summary.json`                        | `collector_summary`          |
| `manifest.json`                                  | `collector_manifest`         |

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

Terminal fields: one unit per account (`account-NN`, `unitKind: account`),
taken from the collector's own filename grammar — the run-wide
`accounts.html` index belongs to no unit; a `months-account-NN`
`declared_coverage` range per account covering the monthly fragments that were
actually captured; one `terminal` report carrying the outcome;
`requestedScope.scopeKind = full_snapshot` (the run asks for whatever the
aggregator currently shows) listing the accounts as `unitKeys`.

Verified with synthetic fixtures in
`services/collector-moneyforward/test/shared-collection.test.ts` (G1-01,
G1-02, G1-08, G1-09, G1-15, G3-07, G3-08). The importer-side parity suite was
removed with the importer ([legacy-retirement.md](legacy-retirement.md)). No
provider was contacted and no production bucket was read or written.

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
is what the retired legacy path stored. The collector adds
`assertRedactedHtml` (`src/redaction.ts`), the invariants the importer
enforced, checked on the bytes about to leave the Worker: a redaction
regression throws `artifact_html_redaction_invalid` and the run writes no
terminal rather than publishing the page. With the importer's second sanitizer
pass retired, this is the last check before `DATA`. Datasets the importer
never accepted (`debit-menu`, `debit-detail`, `credit-csv`, `credit-pdf`,
`credit-ofx` — it refused a manifest naming one with
`manifest_dataset_unobserved`) are refused here the same way
(`artifact_dataset_unobserved`): `DATA` holds nothing the legacy path never
let through. The collector manifest is written in its central shape — a
connection blocker and a failure message become coarse codes
(`human-required`, `collector-failure`, `r2-write-failure`), so upstream free
text never reaches the shared bucket either. (As for Money Forward, the
importer's central bytes also carried its parsed `connectionId`, `filename`
and `ordinal` per artifact; the collector's manifest keeps its own artifact
shape.)

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
G1-08, G1-09, G1-15, G1-16, G3-08, G3-11) and
`services/collector-myjcb/test/shared-parity.test.ts` (the shared plan stores
the collector's redacted pages unchanged and keeps the manifest facts). No
provider was contacted and no production bucket was read or written.

### Vpass (`services/collector-vpass`, `kogane-vpass-collector-poc`)

| Artifact key                             | Role                         |
| ---------------------------------------- | ---------------------------- |
| `card-list.json`                         | `sanitized_provider_capture` |
| `select-card.json`                       | `sanitized_provider_capture` |
| `web-meisai-top.json`                    | `sanitized_provider_capture` |
| `months/<yyyymm>/<top\|answer>-NNN.json` | `provider_response`          |
| `manifest.json`                          | `collector_manifest`         |

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

Terminal fields: one run **per card**, `runId = <session run id>-card-NNN`,
all cards of one session carrying that session id as `acquisitionSessionRef`,
so several cards stay distinguishable instead of collapsing into one run
(G1-16). One unit per card (`unitKind: card`), a `statement-months`
declared-coverage range over the months that were captured, one `terminal`
report, `requestedScope.scopeKind = full_snapshot`. `coverageStatus` is
`partial` even on success: a card exposes a rolling window of statement months,
so a finished run is not a claim about the card's whole history.
`producerVersion` is `vpass-worker-card-v1`, the schema version central
storage recorded for a card-scoped Vpass run, and `manifest.json` holds exactly
the summary central storage held for one.

A card (or a session that failed before a card was selected, as unit `run`)
that collected nothing persists a `failed` terminal with no artifact at all
(G1-09).

No card binding. The retired importer also wrote, per card run, a separate
`card-identity-binding` run holding an HMAC token of the card's session
identifiers ([Vpass card binding](vpass-card-identity.md)); card purchase
recognition needs that binding. The collector writes no such artifact, the
sanitizer redacts the session bean the token was derived from, and the Worker
holds no fingerprint secret, so its runs have no trusted binding and their rows
would resolve to unresolved accounts if parsed; its artifacts are registered
without a parser dataset — [ADR 0022](adr/0022-registration-artifact-datasets.md)
withholds it — so they are not
([ADR 0023](adr/0023-vpass-collector-card-binding.md),
[identity operations](identity-operations.md#collector-vpass-runs-have-no-trusted-binding)).
`services/collector-vpass/test/shared-collection.test.ts` pins this ("ADR 0023").

Registration of a card run: one unit, one range and one artifact per page plus
the four fixed artifacts, registered by the Processor in process with no
Service Binding call. Each page costs about 20 operations (D1 statements and
R2 calls) against a per-invocation budget of 500, so a card of about twenty
pages registers in one invocation and a longer card is continued on the next
cron tick with its progress in CORE (issue #87,
[processor.md §3.3](processor.md#33-operation-budget-and-staged-registration-issue-87)).

Every stored object carries a `redacted` transformation with no
retained input, because the provider envelope that held the session was
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

Sanitizer: the collector never stores a request, a header or a cookie — it
stores the decoded JSON response text, the same bytes the retired legacy path
wrote to its bucket and the importer forwarded to the central store. The
session cookie lives in the `VPointSession` Durable Object and appears in no
artifact. The collector manifest itself is _not_ stored as an artifact: the
terminal is the run record, so `manifest.json` (role `collector_manifest` for
legacy runs) has no equivalent.

Terminal: `source: v-point`, `producer: collector-vpoint`, `producerVersion:
COLLECTOR_SCHEMA_VERSION` (`vpoint-worker-poc-v2`), `runId` the collector's own
run UUID, `attemptId: attempt-<runId>`, `requestedScope: full_snapshot` over
unit `account`, one unit (`account`/`collection`) whose `artifactCount` is the
stored artifact count, `providerOutcome` from the run status, `coverageStatus`
`complete`/`partial`/`unknown` for `success`/`partial`/`failed`, and
`safeErrorCode` from the run's first safe failure code (`collector_failed` when
a failure carried none). `ranges`, `reports` and `transformations` are empty.

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

Terminal: `source: v-point-pay-email`, `runId` the SHA-256 of the stored
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

Sanitizer: the refresh token, the device UUID and the access token live in the
Durable Object and in the request headers `collectVPointPay` builds. None of
them is an artifact, and a failure becomes a machine code
(`credential_configuration_required`, `authentication_required`,
`provider_protocol_failed`, `provider_http_failed`, `operation_failed`) rather
than the redacted provider message the legacy manifest kept — a terminal
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
of each response, exactly what the retired legacy path wrote to the per-source
bucket and the importer forwarded centrally. A dataset is attributed to a unit
by the same rule the importer used (`foreign-` prefix → `foreign`).

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
`date_range` with a matching `requested-window` range when the trigger named a
window, and `full_snapshot` with no range when it did not.

### `mizuho-bank` (`services/collector-mizuho`, `kogane-mizuho-collector`)

| Artifact key                                           | Role                         | Unit                                           |
| ------------------------------------------------------ | ---------------------------- | ---------------------------------------------- |
| `account-list.html`                                    | `sanitized_provider_capture` | `account-list`                                 |
| `ordinary/<branch>-<account>/history/<from>-<to>.html` | `sanitized_provider_capture` | `ordinary:<branch>:<account>:page:<from>:<to>` |

One daily cron (`25 21 * * *` UTC, 06:25 JST) signs in once with the Worker
secrets and reads the account list, then the first displayed history page of
each ordinary JPY account, at most ten accounts: a run holds up to 11
artifacts. Accounts past the limit, and accounts whose read failed, are
units with no artifact, `coverageStatus: unknown` and
`safeErrorCode: collection-unit-failed`, which make the run `partial`.
Additional authentication stops the run, and scheduled retries are disabled.

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
`container`s. `providerOutcome` is `failed` (with no artifact and
`safeErrorCode: collection-failed`), `partial` when any unit failed (with
`safeErrorCode: collection-unit-failed`), else `success`. `coverageStatus` is
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
| `manifest.json`                           | `collector_derived`          | the collector manifest with failures reduced to allowlisted codes |

- `requestedScope`: `full_snapshot` — this source is a current snapshot and the
  trigger accepts no date range. No units, ranges or reports.
- `transformations`: one `redacted` step per provider capture
  (`sbi-shinsei-token-sanitizer`), one `extracted` step for `normalized.json`
  (`sbi-shinsei-normalizer`), matching the central descriptors.
- `acquisitionSessionRef`: none. The container authenticates once per run and no
  session survives it, so there is no generation to reference (12 §4).
- Human-required: a rejected credential or refused login (`credential-shape`,
  `credential-validation`, `login-rejected`, `login-failed`) ends the run
  `failed` with `human_required_credentials`.
- Staging: **none**. The four provider responses and the normalized snapshot
  are held in memory until the terminal is written; the `r2:<dataset>` failure
  operation means "not admitted to the run" (validation), not a staging put.
  `test/storage.test.ts` proves the described manifest entry equals the one the
  legacy put returns.
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
Processor maps it to the CORE source `global-pass`).

| Artifact                  | Role                         | Bytes                                                      |
| ------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `activity-<yyyy-mm>.html` | `sanitized_provider_capture` | the page `sanitizeGlobalPassActivityHtml` already produced |
| `manifest.json`           | `collector_manifest`         | the collector manifest, the bytes legacy mode staged       |

- `requestedScope`: `month_range` over the selected months (oldest to newest),
  `unitKeys: ["account"]`. A run whose container never reported its month list
  states `unspecified` rather than inventing a range.
- `units`: one `account` unit of kind `collection`, the same unit the central
  descriptors use. `ranges`: one `requested` range plus one `declared_coverage`
  month range per stored page.
- **Coverage is `partial` even on success.** The provider exposes a rolling
  window of statement months and `paginationStatus` is `unproven`, so a
  finished run is a claim about persistence, never about the account's history.
- `transformations`: one `redacted` step per page
  (`globalpass-activity-sanitizer`); the unredacted page is never retained, so
  it has no artifact key.
- `acquisitionSessionRef`: none. The container logs in once per run and keeps no
  session across runs (12 §4).
- Human-required: **not distinguishable today.** The container reports every
  login failure as the generic `browser_collection_failed`, so the terminal does
  not claim a person must act. The collector still makes exactly one login
  attempt per run — the cron is the only re-attempt — and nothing was added to
  retry one. Classifying a Turnstile or credential rejection would need a
  container change, which U09 does not make.
- The shared persist is reported under the existing `central-import`
  diagnostics stage; the `globalpass-collection-stored` log line carries
  `collectionTarget` (always `shared`), `sharedOutcome`, `terminalKey` and
  `terminalDigest`.
- Staging: **none**. Every sanitized page is held in memory until the terminal
  is written.
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
| `manifest.json`  | `collector_manifest` | the collector manifest, the bytes legacy mode staged        |

- `requestedScope`: `full_snapshot`, `unitKeys: ["account"]`; one `account` unit
  of kind `collection`, the same unit the central descriptors use. No ranges.
- A successful run declares `coverageStatus: complete`: the collector walks
  every historical execution and cash-flow page to exhaustion and verifies the
  provider's own pagination totals before finishing.
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
  carrying `human_required_reauth`, and `waitingForHuman` is reported on
  `/health`, on the `/collect` 502 body and in the summary. A recoverable
  session error uses `session_unhealthy` instead. Nothing retries a login: the
  existing single, 6-hour-cooled-down re-authentication attempt is unchanged
  (G3-10, G3-11).
- No deferral: with no service binding in the chain, a run with more than
  eleven artifacts finishes in place. The retired importer path deferred such
  a run to a backfill route, which no longer exists.
- Staging: **none**. Every sanitized envelope is held in memory until the
  terminal is written; the create-only terminal put in `DATA` is the duplicate
  guard the staging `onlyIf` put used to be.
- Parity: `test/shared-collection.test.ts` asserts the `DATA` bytes are the
  staged encoding of the same sanitized body (the encoding the retired
  importer forwarded verbatim after checking `meta.secureKey` was absent), and
  that an envelope still carrying `meta.secureKey` is refused with
  `shared_secure_key_present` rather than planned.
- Duplicate dispatch is still one run: the Durable Object's existing
  single-flight `runCollection` returns the in-flight summary (G3-14).
- Verified with synthetic data only: `test/shared-collection.test.ts` and
  `worker-test/shared-data-bucket.test.ts`, which drives the real Durable
  Object and a real Miniflare R2 `DATA` bucket. (Its Miniflare config still
  binds a `COLLECTION_TARGET` value that the Worker no longer reads; the
  deployed config carries none.)

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

- **One terminal per backfill run.** The run is finished exactly once — when the
  last chunk lands, when it ends partial, or when it fails — and that is the only
  place the terminal is written, whatever the outcome.
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
- `requestedScope`: `date_range` over `DEFAULT_BACKFILL_FROM`…today,
  `unitKeys: ["account"]`; one `account` unit of kind `collection`. `ranges`:
  the requested range plus one `declared_coverage` range per collected month
  (the raw and normalized artifacts of a month share it).
- Media types lose their `charset` parameter in the terminal (`application/json`);
  the Shift_JIS bytes themselves are stored unchanged.
- `transformations`: one `extracted` step per normalized artifact
  (`smbc-direct-normalizer`) naming its raw parent when that parent is in the run.
- `acquisitionSessionRef`: **yes.** The Durable Object keeps `sessionRef` (the
  live generation, rotated on every approved sign-in) and `runSessionRef` (the
  generation that opened the current run, kept across a resume). The terminal
  carries `runSessionRef`; the credential, the encrypted session envelope, the
  challenge state and the page cookies stay in Durable Object state (12 §4).
- Human-required: this source has **no unattended re-authentication at all**,
  and none was added. Any run that does not reach `success` needs a person to
  approve a new challenge before it can continue, so its terminal reports
  `waitingForHuman`, and a run that lost its session carries
  `human_required_approval` (G3-10, G3-11). `/api/status` reports
  `waitingForHuman` while the person still has to act.
- Verified with synthetic data only: `test/shared-collection.test.ts` and
  `worker-test/shared-data-bucket.test.ts`, which stages a run into a real
  Miniflare R2 `DATA` bucket, re-reads it and writes the objects and the
  terminal into the same bucket.
- A bare `bun test` also discovers `worker-test/shared-data-bucket.test.ts`,
  whose `cloudflare:test` import resolves only under Vitest. The test task runs
  `vitest run` and `bun test ./test` separately, and both pass under bun 1.4.0.
