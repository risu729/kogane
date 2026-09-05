# Raw evidence store

Status: phase 2 schema and Worker candidate under final review. D1, R2, Worker,
and a synthetic sealed run were verified in production on 2026-09-02; the
additive `0003` contract and run-scoped API are verified locally and are
deployed only through the migration-first runbook below.

This is the canonical design for layer A of Kogane. It was derived from the
current collector manifests **and** the source and architecture notes under
`docs/`. The store records what bytes were acquired, how they were acquired,
and whether the central copy is complete. It deliberately does not interpret
transactions, accounts, instruments, balances, rewards, or economic events.

## Boundary

The service has two stores and one authenticated Worker:

```text
collector / capture / file
          |
          | source-scoped ingest credential
          v
  kogane-ingest Worker
       |           |
       | bytes     | immutable metadata
       v           v
private R2       D1 catalogue
```

- R2 stores content-addressed bytes at `objects/<first-two-hex>/<sha256>`.
- D1 stores origin, acquisition, integrity, and completeness claims.
- Parsing begins in phase 3 and writes observations elsewhere.
- Credentials, cookies, session tokens, passkey material, account numbers,
  raw URLs, URL query values, and unredacted secret-bearing login pages are not
  catalogue metadata.
- An artifact may intentionally be a sanitized provider capture when retaining
  its source bytes would retain credentials. That decision and every transform
  step remain explicit.

The named production resources are:

```text
Worker      kogane-ingest
R2 bucket   kogane-raw-evidence
D1 database kogane-raw-evidence
```

The bucket has no public route. Existing collector buckets remain acquisition
staging areas until their runs have been reconciled and sealed centrally.

The deployed D1 database is in APAC. Production verification streamed one
synthetic object, reused it by content hash, created a run and terminal report,
verified its R2 checksum/metadata, and produced a complete seal. A first
post-deployment attempt created its run but the immediately following request
returned 404; the row was present on direct D1 inspection and the same
idempotent request succeeded shortly afterwards, which is consistent with a
cross-request visibility delay. The verifier now performs bounded retries for
idempotent 404/500/503 responses and can take an explicit safe session ID to
resume that exact run. The interrupted run was resumed and sealed rather than
deleted, exercising the intended append-only recovery path. No financial
values or provider credentials were used.

Early verification runs used `external_id_namespace='synthetic'` under the real
`sbi-securities` source. Migration `0003` preserves those immutable rows but
adds an explicit `exclude_from_financial_views` annotation and the
`financial_fetch_runs` view; future verification uses `kogane-synthetic`.
Migration `0004` also excludes that dedicated synthetic source from the view,
so neither legacy nor current operational checks appear as financial runs.

## Why the schema is larger than the roadmap sketch

The four-table sketch in `docs/roadmap.md` was enough to describe the storage
idea, but not enough to preserve the cases already documented in this repo:

- a Kuebiko directory can contain several financial sources;
- one source may be acquired through Kuebiko, an official export, email, or a
  scheduled collector without those being the same identity;
- Vpass stores a self-contained multi-card bundle, while other collectors store
  one object per endpoint or page;
- SMBC backfill can stop for renewed QR approval and resume from a later chunk;
- SBI VC Trade, SBI Securities, V Point, and other sources have pagination,
  separate ledgers, or requested/declared date windows;
- MyJCB and Sony Bank can require redaction before an artifact is safe to retain;
- V Point Pay can arrive as a direct or forwarded `message/rfc822` attachment;
- CSV, CP932/Shift-JIS HTML, JSON, PDF, ZIP, XLSX, OFX, QIF, MT940, CAMT, and
  unknown legacy bytes must remain representable without parsing;
- a producer reporting `success` is different from the central importer proving
  that it received every declared artifact.

The schema in `services/raw-evidence/migrations/0001_initial.sql` encodes these
differences rather than hiding them in JSON blobs.

## Entity model

### Mutable reviewed configuration

| Entity                     | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `sources`                  | Financial or official data surface, independent of acquisition method        |
| `producers`                | Collector, capture importer, file importer, or other byte producer           |
| `producer_sources`         | Sources a producer is allowed to claim                                       |
| `ingest_clients`           | Identity selected by a Worker secret                                         |
| `ingest_client_producers`  | Producers a client may speak for                                             |
| `ingest_client_routes`     | Exact client + producer + source authorization                               |
| `http_scope_rules`         | Sanitized host/path allow and deny rules; deny wins                          |
| `origin_template_policies` | Exact reviewed templates and redaction/HMAC-key versions accepted per source |
| `source_external_ids`      | Reviewed manifest/capture name to canonical source mapping                   |

Deactivating any component prevents new history without invalidating old
foreign keys. `0002_registry.sql` seeds every source currently represented by
`docs/sources`, plus the existing `vpass` and `global-pass` collectors.
`0003_runtime_contract.sql` adds MoneyForward and a dedicated synthetic
verification source. The registry also
seeds separate Kuebiko, collector-R2, and local-file import mechanisms. “Active”
means evidence may be catalogued; it does not claim unattended collection is
already implemented.

### Immutable acquisition history

| Entity                           | Meaning                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `acquisition_sessions`           | One producer invocation or capture directory; may contain multiple sources               |
| `fetch_runs`                     | One source-specific ledger within a session                                              |
| `fetch_units`                    | Optional account/card/connection/chunk hierarchy                                         |
| `fetch_unit_reports`             | Append-only progress and terminal claims for a unit                                      |
| `fetch_page_groups`              | Page sets, including a declared zero-page set                                            |
| `fetch_run_reports`              | Append-only producer progress and one terminal outcome                                   |
| `fetch_run_ranges`               | Requested, selector, or declared coverage at instant/date/month precision                |
| `raw_objects`                    | SHA-256, byte size, and content-addressed R2 key only                                    |
| `fetch_artifacts`                | One appearance of bytes in a source run                                                  |
| typed metadata tables            | Sanitized HTTP, storage, file, email, and artifact range facts                           |
| `artifact_relations`             | Input and manifest/description edges between artifacts                                   |
| `artifact_transform_steps`       | Ordered decoding, decryption, redaction, re-encoding, bundling, rendering, or extraction |
| `run_inventories` / items        | Sender-declared complete artifact set                                                    |
| `fetch_run_seals`                | Server-validated proof that the full run is centrally present                            |
| `ingestion_attempts`             | Central transfer outcome, separate from provider outcome                                 |
| `raw_object_verification_events` | Append-only later R2 integrity checks                                                    |

All acquisition-history tables reject updates and deletes. Duplicate-insert
guards also reject SQLite `INSERT OR REPLACE` on every uniqueness path,
including artifact sequence and page position. Exact retries use
`INSERT ... SELECT ... WHERE NOT EXISTS`, followed by a read and immutable
field comparison. Artifact scalar and child rows are validated and written in
one D1 batch; seal, inventory items, and its complete ingestion attempt are
also atomic. Set-like descriptor arrays are normalized and duplicates rejected
before hashing.

## Artifact semantics

`artifact_role` answers what the object represents:

- exact provider responses, exports, documents, or messages;
- collector manifests, errors, and summaries;
- collector-derived objects;
- sanitized provider or user captures.

`payload_fidelity` answers what happened to the bytes: exact,
transport-decoded, transformed, generated, or unknown. `container_kind`
separately records single object, bundle, archive, multipart, or unknown.
`lineage_disposition` distinguishes linked source bytes, embedded source bytes,
intentional non-retention for security, unavailable source bytes, and cases
where lineage does not apply.

Compound transformations are ordered rows. For example, a safe MyJCB HTML
artifact can be `redacted` then `reencoded`; a Vpass snapshot can be `bundled`
then `reencoded` while declaring that the source bytes are embedded. A
transformed artifact that claims linked input must actually have an input edge
before the run can be sealed, and relation cycles are rejected.

## Privacy-preserving origin metadata

Raw origin strings often contain bearer tokens, customer identifiers, email
addresses, card fragments, or private filenames. Therefore:

- HTTP stores scheme, lower-case host, optional port, a redacted path template,
  query **names only**, and optional versioned HMAC fingerprint. It never stores
  a raw URL or query value. Query names use a strict token grammar, are sorted,
  and the complete name set must exactly match a reviewed template-policy row;
  a policy for no query names does not authorize additional names.
- Storage stores a redacted object-key template and versioned HMAC fingerprint,
  not the original source bucket key when that key is sensitive.
- File and email attachment names use a redacted basename template and
  versioned HMAC fingerprint.
- Email distinguishes direct, forwarded RFC822, and unknown transport, and can
  identify a nested MIME part without storing recipient or subject text.
- Source-specific HTTP allow rules and an exact active origin-template policy
  are required before HTTP metadata is accepted. Storage/file/attachment
  templates likewise require a reviewed exact policy. Global deny rules
  override allows.
- A declared media type is stored only as a lower-case `type/subtype` essence.
  Parameters such as multipart boundaries and filenames are rejected rather
  than copied into catalogue metadata.

The local file importer computes fingerprints with a separate HMAC-SHA-256 key,
not the ingest bearer and not unsalted SHA-256. The API can validate digest
shape, key version, and template policy, but cannot cryptographically prove how
an external importer produced a submitted fingerprint; importer tests and key
provisioning remain part of that trust boundary. Only digest and version enter
D1.

Its run identity is deterministic from safe file metadata and keyed path/hash
fingerprints, so the same evidence is not duplicated. Each invocation receives
a distinct immutable ingestion-attempt ID and start time; rerunning after a
committed seal whose response was lost therefore records reuse instead of
conflicting with the prior attempt.

## Lifecycle and completeness

1. The client creates/reuses its acquisition session and source run. This
   proves an exact active client + producer + source route before any bytes are
   accepted.
2. The client streams the original/safe-to-retain bytes through that run to R2 with its expected
   SHA-256 and exact byte size.
3. R2 validates the checksum. A conditional write prevents a racing writer from
   replacing the same content-addressed key.
4. Only after R2 succeeds does the Worker register `raw_objects` in D1. An R2
   object left by a D1 failure is a safe orphan and may be reconciled later.
5. It appends reports and artifacts. Progress states such as `running`,
   `human_required`, and `partial` never overwrite prior claims.
6. For at most 1,000 artifacts the client may submit one complete sorted
   inventory. Larger/interrupted runs begin a staged inventory, append
   idempotent chunks, inspect received count, and finalize it. The staged path
   is capped at 10,000 artifacts so final digest verification stays below D1
   response and Worker memory limits.
7. The Worker compares the inventory in
   both directions against the D1 artifact catalogue and recomputes the digest.
8. D1 triggers additionally verify the terminal report, declared all/provider
   count, required unit reports/counts, page completeness, lineage, and
   contiguous transform steps. Only then can the run be sealed.
9. A sealed run rejects any later run-scoped child mutation. A correction is a
   new acquisition/run, preserving the old provider claim.

Provider `failed` or `partial` is still valid evidence. A terminal failed run
with no artifacts may be sealed with an explicit zero-item inventory; an
unfinished or accidentally truncated run may not.

## Worker API v1

Authentication is `Authorization: Bearer <client-id>.<secret>`. The JSON map of
client IDs to high-entropy secrets is the Worker secret
`INGEST_CLIENT_KEYS`; secrets are never stored in D1 or Git.

For the current local bootstrap, `scripts/sync-ingest-key.sh --rotate` creates a
random key, encrypts it with the WSL systemd host credential key at
`~/.config/kogane/ingest-client-keys.cred`, and publishes the complete local
authoritative client-key map to the Worker secret. Rotation merges only the
selected client into that map, verifies the new remote credential before the
encrypted local blob is atomically replaced, and rolls the remote map back on
failure. `origin-fingerprint.cred` is separate. Import and verification scripts
pass credentials through inherited file descriptors/config streams, not
arguments or environment variables.
The encrypted local file is a bootstrap, not a replacement for the repository's
Bitwarden sync model: when the credential sync command is unified, the same
secret payload can come from a dedicated Bitwarden item without changing the
Worker or D1 schema. Do not place it in `.dev.vars`, shell history, or Git.
On the current WSL host, `systemd-creds` reports that its host key is not itself
on encrypted media. The credential blob therefore prevents casual/non-root
file reads but is not a security boundary against WSL root or offline access to
the host-key storage. This is acceptable only for the local bootstrap assumed
here; a future Bitwarden-backed sync should remain the authoritative copy.

| Request                                          | Purpose                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                    | Non-sensitive liveness and schema version                                                                             |
| `PUT /v1/runs/:id/objects/:sha256`               | Stream bytes to R2 after run-scoped authorization; requires exact byte size                                           |
| `POST /v1/runs/:id/objects/:sha256/verify`       | Append a route-scoped R2 integrity check after the object is catalogued in the run; reuse a recent same-client result |
| `POST /v1/runs`                                  | Idempotently create an acquisition session and source run                                                             |
| `POST /v1/runs/:id/reports`                      | Append progress or terminal producer report                                                                           |
| `POST /v1/runs/:id/ranges`                       | Append a validated instant/date/month run range                                                                       |
| `POST /v1/runs/:id/page-groups`                  | Declare a known or unknown-size page set                                                                              |
| `POST /v1/runs/:id/units`                        | Append a root or child account/card/chunk unit                                                                        |
| `POST /v1/units/:id/reports`                     | Append progress or terminal unit report                                                                               |
| `POST /v1/runs/:id/artifacts`                    | Catalogue an R2 object, ranges, origins, transforms, and relations                                                    |
| `POST /v1/runs/:id/attempts`                     | Idempotently record an incomplete/failed central transfer                                                             |
| `POST /v1/runs/:id/seal`                         | Verify exact inventory, create seal and complete ingest attempt                                                       |
| `POST /v1/runs/:id/inventories`                  | Begin/reuse a resumable inventory with expected count and digest                                                      |
| `POST /v1/runs/:id/inventories/:inventory/items` | Append an idempotent chunk of at most 30 exact items                                                                  |
| `GET /v1/runs/:id/inventories/:inventory`        | Read expected/received counts and seal state                                                                          |
| `POST /v1/runs/:id/inventories/:inventory/seal`  | Recompute a staged inventory digest and atomically seal it with a complete attempt                                    |

JSON request bodies are bounded. Raw bodies are streamed directly to R2 and are
never read with `arrayBuffer()`, `text()`, or `formData()`. The default direct
upload limit is 50 MiB; larger objects require a future authenticated multipart
protocol rather than raising the limit blindly.

### Canonical digests

Artifact descriptor version `v1` is SHA-256 over UTF-8 JSON after:

1. rejecting unknown fields;
2. validating and normalizing values (for example, lower-case domains and
   sorted unique query names);
3. sorting every object key recursively while preserving array order;
4. rejecting non-safe-integer JSON numbers.

Inventory digest version `v1` is stored explicitly and is SHA-256 over the same canonical JSON encoding of items
sorted by `artifactKey`, each containing `artifactKey`, `sha256`, and
`descriptorSha256`. The Worker recomputes both digests; callers do not choose
stored descriptor digests.

## Use-case coverage review

The candidate schema was independently reviewed against every `docs/*.md`,
every `docs/sources/*.md`, current collector manifest shapes, and adversarial
D1/API behavior. A schema is not called frozen until the final fixed-hash
review reports no P0/P1 issue. Covered cases include:

| Case                                | Representation                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Kuebiko with multiple sites         | one acquisition session, multiple source runs                                |
| Multiple cards/connections/accounts | hierarchical units and source-scoped runs                                    |
| Paginated history                   | page group plus page-indexed artifacts; zero/known/unknown counts            |
| Backfill and resume                 | run/unit progress reports, requested/coverage ranges, immutable retries      |
| Pending then posted/corrected data  | separate evidence runs; interpretation deferred                              |
| Composite Vpass snapshot            | bundle with embedded-source lineage and ordered transforms                   |
| Sanitized MyJCB/Sony HTML           | transformed capture, redaction step, explicit source non-retention           |
| API JSON and browser HTML           | provider-response role with HTTP origin metadata                             |
| CSV/PDF/OFX/XLSX/manual files       | provider export/document or user capture with file origin                    |
| Direct/forwarded V Point Pay mail   | provider message with email transport and MIME path                          |
| Collector manifest/error/summary    | generated roles, counted in all-catalogued inventory                         |
| Legacy evidence with weak metadata  | unknown fidelity/container and explicit time basis                           |
| Same bytes fetched repeatedly       | one R2 object, separate artifact appearances                                 |
| Parser re-run                       | raw object and descriptor remain stable; phase 3 adds versioned observations |

Account identity, family-card ownership, canonical instruments, transaction
state changes, matching, OCR meaning, reward expiry, prices, FX, P&L, and tax
remain later-layer concerns. Putting them in layer A would make evidence
ingestion depend on interpretations that need to be corrigible.

## Verification

Local tests use the current Cloudflare Vitest integration with real
workerd/Miniflare D1 and R2 bindings. They cover:

- append-only update/delete and `INSERT OR REPLACE` attacks;
- inactive route attribution;
- incomplete, subset, zero-artifact, unit, page, and transform seal cases;
- MyJCB and Vpass lineage shapes and unknown legacy evidence;
- privacy rejection for query values;
- streamed R2 checksum validation and object reuse;
- atomic artifact rejection without immutable residue;
- same-source, cross-session lineage;
- incomplete/failed attempt retry and conflict handling;
- resumable staged inventory chunk replay;
- route-scoped R2 integrity verification;
- end-to-end authenticated run, report, artifact, inventory, and seal retries.

The deployed account is on a paid Workers plan. Artifact child arrays are
bounded at 100 per kind and staged inventory chunks at 30; their worst-case D1
query counts fit the paid 1,000-query invocation limit. The service does not
claim compatibility with the Free-plan 50-query limit.

## Source ID mapping and origin enablement

The registry includes explicit collector-manifest aliases:

| External ID                        | Canonical source   |
| ---------------------------------- | ------------------ |
| `sbi-shinsei`                      | `sbi-shinsei-bank` |
| `prestia-globalpass`               | `global-pass`      |
| `smbc-direct`                      | `smbc-bank`        |
| `moneyforward-me`                  | `moneyforward-me`  |
| `v-point-pay-email`                | `v-point-pay`      |
| `v-point-pay-email-reconciliation` | `v-point`          |
| `v-point` (collector R2 importer)  | `v-point`          |

`v-point-pay-email-reconciliation` is a generated report emitted by the V Point
collector while reconciling its own point-history evidence with V Point Pay mail.
Layer A therefore catalogues the bytes as a `collector_summary` in the `v-point`
source run that produced it; it does not claim cross-source raw lineage or a
financial match. Any interpretation of its entries, including match confidence
and links to V Point Pay observations, starts in phase 3. The archived direct and
forwarded messages themselves remain `provider_message` artifacts under
`v-point-pay`.

The Layer A validator still proves every reconciliation candidate is structurally
real: its source names a validated history page, its index is within that page's
actual row count, and its fingerprint equals SHA-256 of the exact JSON-serialized
row. Duplicate source/index candidates in one entry fail closed. This integrity
check does not promote the generated match to financial truth.

Migration `0012` gives the V Point R2 importer a dedicated client route and
enables only the reviewed `raw/v-point/{date}/{run-id}/{artifact}.json` and
`derived/v-point-pay-email-reconciliation/{date}/{run-id}.json` storage
templates. The point collector outbox and generated reconciliation bucket are
validated separately; neither policy grants the importer access to the raw
V Point Pay mail source.

Financial HTTP and storage templates remain default-deny. Each importer PR must
add a reviewed source-specific scope and exact template-policy migration from
its checked-in manifest/docs before its backfill can start. The synthetic
fixture is the only HTTP rule seeded globally by this PR. Local-file policies
are seeded for every source because filenames are represented only as a fixed
redacted template plus a separate-key HMAC fingerprint.

## Deployment order

Run `bun run cf:deploy` from `services/raw-evidence`. The checked-in deployment
script lists and applies pending remote D1 migrations first, deploys the Worker
second, then runs the authenticated synthetic round trip. `0003` is additive;
the prior Worker remains compatible if Worker deployment fails after migration.
Do not deploy the new Worker before the migration because it reads the new
inventory digest-version column and synthetic route.

The sanitized `source-usecases.v1.json` acceptance fixture and its independent
Worker integration suite retain coverage
for Vpass multi-card bundles, SBI Securities partial/failure, SBI Shinsei
raw-to-normalized artifacts, SBI VC pagination, MyJCB multi-connection
redaction/re-encoding, Mobile Suica Shift-JIS pages, V Point empty pages, V Point
Pay direct/forwarded mail, Sony source non-retention, MoneyForward ordering, and
SMBC chunk resume. The same suite crosses the 1,000-item direct-seal boundary and
seals 1,001 artifacts through the resumable staged-inventory API. All fixture
payloads are invented and explicitly contain no credentials, real financial
values, raw URLs, or query values.

## Backfill order

Backfill is read-only against each staging bucket and must never delete or move
its source object. For every bucket:

1. list all keys with pagination and save a local inventory receipt;
2. classify run boundaries from its documented manifest, never just key names;
3. upload bytes by content hash and register storage-origin metadata with a
   redacted key template;
4. add the producer terminal report and the complete central inventory;
5. seal only when manifest counts, listed objects, R2 sizes, and hashes agree;
6. record partial/failed runs too, but do not invent a successful seal;
7. reconcile source object count, unique content count, artifact count, run
   count, and seal count before calling that bucket complete.

Current staging buckets to process are discovered from checked-in Wrangler
configuration, including SBI Securities, Vpass, SBI Shinsei, SBI VC Trade,
MyJCB, Mobile Suica, GLOBAL PASS, SMBC Direct backfill, Sony Bank, V Point, and
V Point Pay. Discovery is repeated at execution time because cloud resources
and object counts are live state.

## Remaining implementation steps

- Add importer commands for collector R2 and Kuebiko. The local-file importer is
  implemented. They share
  the same API and differ only in acquisition/origin mapping.
- Backfill staging buckets one at a time with count/hash reconciliation.
- Schedule a bounded caller for the route-scoped verifier; the endpoint already
  appends immutable `raw_object_verification_events` and suppresses duplicate
  checks from one client for five minutes.
