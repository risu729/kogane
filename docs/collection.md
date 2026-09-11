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

## Shared DATA R2 switchover, per source (U09)

Unified plan work item **U09** (chapter 03, decisions D7/D12/D13). Each
collector gains one var and one binding:

| Name                | Value                                                  |
| ------------------- | ------------------------------------------------------ |
| `COLLECTION_TARGET` | `legacy` (default) or `shared`                         |
| `DATA`              | R2 binding to the central bucket `kogane-raw-evidence` |

`legacy` is the deployed path, byte for byte: sanitized artifacts and the
collector manifest into the per-source bucket, then the central importer over
the Service Binding. Only the exact string `shared` switches a collector to
`packages/collection`: the same sanitized bytes, content-addressed under
`objects/<2 hex>/<sha256>`, and the run's `terminal-v1` manifest written last
to `runs/<source>/<runId>/terminal.json`. In `shared` mode the collector makes
no importer call and writes nothing to its per-source bucket, so an object is
never copied between buckets (G1-15). The legacy buckets stay readable; nothing
is deleted or migrated by this change (03 §7).

What the switch never touches: the Worker name, its cron, its Email route, its
Durable Object classes and migration tags, its per-source secrets and its
per-source bucket bindings (G5-15). A source keeps exactly one scheduler, so
there is no second cron and no double provider access during the switch
(G3-14).

**Deploy order** (11 §4, G5-14) — the consumer before the producer:

1. Deploy the Processor's terminal consumer (U08) with
   `SHARED_R2_INGEST_ENABLED` on, so a terminal can be read before one exists.
2. Then set `COLLECTION_TARGET=shared` on one collector and watch that source's
   runs.
3. Repeat per source. A source whose Processor path is not yet enabled stays on
   `legacy`.

**Rollback**: set `COLLECTION_TARGET` back to `legacy` (or unset it) and
redeploy that collector. Terminals already written stay valid and are still
picked up by the Processor's bounded `runs/` scan; the legacy path resumes
writing to the per-source bucket and the importer. No schema or data migration
is involved either way.

**What a terminal does not claim**: `providerOutcome` stays `partial` when the
acquisition was partial, and a `failed` run with zero artifacts stays a failure
rather than an observation of zero (G1-08, G1-09). A run whose objects could
not all be written produces no terminal at all and is not reported as stored
(G1-01, G1-03); the failure is a machine code in the log, never provider text
(12 §6).

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
equivalent of the legacy duplicate check.

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
