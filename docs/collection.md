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

Work item **U09** (chapter 03, decisions D7/D12/D13) switches the collectors
one source at a time from "stage into a per-source bucket, then ask
`kogane-collector-r2-importer` to upload it centrally" to "write the run into
the shared `DATA` bucket and finish it with a terminal". The contract is
`packages/collection` (`docs/collection-contract.md`); the consumer is the
Processor (U08).

Every collector gains the same two configuration items and the same switch:

| Item                       | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| var `COLLECTION_TARGET`    | `legacy` (default) or the exact string `shared`; anything else is `legacy` |
| R2 binding `DATA`          | `kogane-raw-evidence`, the existing central bucket                         |
| `src/collection-target.ts` | the only place that reads the var, with no `Env` dependency                |

Rules that hold for every source:

- **Legacy mode is byte-for-byte unchanged.** The staging write, the manifest,
  the central upload and every existing test are untouched.
- **Shared mode skips the central upload** (G1-15). The Processor reads the
  collector's own bytes; nothing copies or re-uploads an object.
- The per-source staging bucket **keeps** its write in shared mode. It is the
  collector's own outbox and the read source for anything that exists only
  there (plan 03 §7); U15 retires it once nothing does.
- **The Worker writes the run, never the container.** Container images and
  relay protocols are unchanged by this work item.
- Only _sanitized_ bytes reach `DATA` — the same artifacts the importer sends
  centrally today, produced by the same sanitization rules. Session cookies,
  credentials, container relay tokens and rotating CSRF tokens are removed
  before an object is planned, and a per-source test asserts the bucket
  contents contain none of them.
- `providerOutcome` comes from the run's own outcome: `partial` stays
  `partial`, and a failure with no artifacts is a `failed` terminal with a safe
  error code rather than a complete observation of nothing (G1-08, G1-09).
- A run stopped by something only a person can clear (a rejected credential, a
  revoked session, an unapproved MFA challenge) ends `failed` with a
  `human_required_*` code and a `waitingForHuman` signal. No collector retries
  a login, and none gained an unattended re-authentication (G3-10, G3-11).
- Crons, Durable Object classes and migration tags, containers, tunnels and
  Worker names are untouched, so no source can end up collecting twice.

**Deploy order** (11 §4, G5-14): the consumer first, then the producer.

1. Deploy the Processor (U08) with `SHARED_R2_INGEST_ENABLED` still off, then
   turn that flag on so terminals are read.
2. Deploy the collector with `COLLECTION_TARGET=legacy` (this change; merged is
   not enabled).
3. Set `COLLECTION_TARGET=shared` for **one** source and redeploy it.
4. Watch that source's next run, then move to the next source.

**Rollback**: set `COLLECTION_TARGET` back to `legacy` and redeploy that one
collector. Terminals already written stay valid and are picked up by the
Processor's bounded `runs/` scan; the staging bucket still has the same run, so
the legacy backfill route can import it if needed.

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
- Verified with synthetic fixtures only:
  `test/shared-collection.test.ts` (decisions, sanitization, outcomes,
  end-to-end target switch with a mocked container) and
  `worker-test/shared-data-bucket.test.ts` (a real Miniflare R2 `DATA` bucket).
  No provider was contacted and no production bucket was read or written.

### prestia-globalpass (`kogane-globalpass-collector-poc`)

Container + Durable Object + browser binding + `tamia`/`cf1` tunnels; one daily
cron (`17 18 * * *`), unchanged. Terminal source id `prestia-globalpass` (the
Processor maps it to the CORE source `global-pass`).

| Artifact                  | Role                         | Bytes                                                      |
| ------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `activity-<yyyy-mm>.html` | `sanitized_provider_capture` | the page `sanitizeGlobalPassActivityHtml` already produced |
| `manifest.json`           | `collector_manifest`         | the exact manifest bytes written to the staging bucket     |

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
  `collectionTarget`, `sharedOutcome`, `terminalKey` and `terminalDigest`.
- Verified with synthetic data only: `test/shared-collection.test.ts`
  (decisions, scope/ranges/units, outcomes, redaction),
  `test/shared-worker.test.ts` (end-to-end target switch with a mocked
  container) and `worker-test/shared-data-bucket.test.ts` (a real Miniflare R2
  `DATA` bucket).
