# MoneyForward ME collector source record

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research dates: 2026-08-31, 2026-09-07 (Asia/Tokyo)
- Canonical source: `moneyforward-me`
- Collector: `services/collector-moneyforward`
- Scope: linked institution lists, account details, latest 12 months of monthly statement fragments in authenticated MoneyForward ME screens
- Out of scope: requests to refresh financial institutions, adding/deleting links, transfers/payments/transactions, MoneyForward settings changes,
  claims of completeness equivalent to official provider statements

## Conclusion

Use MoneyForward ME as supplementary snapshots while official financial institution sources are inaccessible.
This is data MoneyForward retrieved/normalized/displayed, not a guarantee of each institution's official raw
responses, complete periods, pending/posted states, transaction IDs, or completeness immediately after refresh.
Retain canonical source `moneyforward-me` centrally; do not relabel it as SMBC, Vpass, or other official sources.

Existing collectors create new sessions every run using stored MoneyForward ID passkeys, retrieving only
read-only routes.

The collector writes the collected bytes to the shared `DATA` bucket as
content-addressed objects and the `terminal-v1` manifest last; the Processor
registers that terminal ([U09 below](#switch-to-shared-data-r2-u09)). The private
bucket and the Layer A importer that validated and forwarded it, described in
the sections below, were retired on 2026-09-13
([legacy retirement](../legacy-retirement.md)). The daily run is the
Processor's alarm job `moneyforward-me` (06:15 JST, `15 21 * * *` in
`config/alarm-jobs.json`); the Worker has no Cron trigger.

## Research method and confidentiality boundaries

Collector verification on 2026-08-31 performed local/Cloudflare Workers read-only collection using the owner's
existing account/Bitwarden-stored passkey. The 2026-09-07 importer audit used a localhost-only temporary Worker
and production R2 read-only binding to scan all available objects.

Audit results/Git records retain only counts, schemas, fixed failure codes. Do not output/store object keys,
individual hashes, bodies, balances, transactions, account identifiers, CSRF, sessions, cookies, passkey material,
secrets. No source R2 writes/deletes before or after the audit.

## Collection surfaces and run boundaries

Only three collector read surfaces are allowed.

1. One complete linked-institutions index HTML
2. One detail HTML for each account enumerated from that index
3. Monthly statement HTML fragments for the latest 12 months including current month, per account

Manifest `moneyforward-worker-poc-v1` declares dates, run UUID, start/completion times, status, artifact order,
dataset, media type, byte size, SHA-256, failure stage. Saving it last prevents incomplete runs being treated
as successes based only on prefixes.

Complete order: accounts index, then each account's detail and its 12 monthly fragments. On R2 write failure,
saved artifacts must be a subsequence of that order and failures the exact complement of missing items.
Distinguish provider read failures from R2 write failures, cross-checking status, failure stages/codes,
and saved artifact counts.

Pin accepted saved-manifest failure contracts to collector generation sites.

| Operation      | failureCode                         | Allowed stages                                                                                                                                                | Required detail                                                      |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `collect`      | `credential_configuration_required` | `credential-load`                                                                                                                                             | `errorType: Error`, no HTTP/reason                                   |
| `collect`      | `operation_failed`                  | `login-entry`, `passkey-options`, `passkey-sign`, `passkey-assert`, `auth-redirect`, `accounts-index`, `account-selector`, `account-detail`, `monthly-detail` | Allowlisted generic `errorType`, no HTTP/reason                      |
| `collect`      | `provider_http_failed`              | `passkey-options`, `passkey-assert`, `account-detail`, `monthly-detail`                                                                                       | Required `MoneyForwardHttpError` and `httpStatus`, no reason         |
| `collect`      | `provider_protocol_failed`          | `login-entry`, `passkey-options`, `passkey-assert`, `auth-redirect`, `accounts-index`, `account-selector`, `account-detail`                                   | Required `MoneyForwardProtocolError` and stage-specific `reasonCode` |
| `r2:{dataset}` | `operation_failed`                  | `artifact-store`                                                                                                                                              | Allowlisted generic `errorType`, no HTTP/reason                      |

Likewise constrain protocol reasons to generation sites.

| reasonCode                  | Allowed stages                                                       | Protocol `httpStatus`                                                                                 |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `unexpected-redirect`       | `login-entry`, `auth-redirect`, `accounts-index`, `account-selector` | Optional only for `login-entry`, `auth-redirect`, `account-selector`; prohibited for `accounts-index` |
| `redirect-limit`            | `login-entry`, `auth-redirect`, `accounts-index`, `account-selector` | Prohibited                                                                                            |
| `missing-location`          | `login-entry`, `auth-redirect`, `accounts-index`, `account-selector` | Prohibited                                                                                            |
| `invalid-response`          | `passkey-options`, `passkey-assert`, `account-selector`              | Prohibited                                                                                            |
| `missing-csrf`              | `login-entry`, `account-detail`                                      | Prohibited                                                                                            |
| `missing-account-context`   | `account-detail`                                                     | Prohibited                                                                                            |
| `session-not-authenticated` | `accounts-index`                                                     | Prohibited                                                                                            |

`manifest-store` failures cannot save the manifest itself, so are not accepted as failures within manifests.

## Layer A strict validation

Before creating central state, the Importer validates all of:

- Manifest key date/run UUID agreement with body, exact field set, fixed schema
- Manifest object content type, size, exact custom metadata, native checksum (if present),
  recomputed SHA-256
- Cursor-based full same-prefix object inventory, exactly matching the manifest
- Each artifact's filename, dataset, media type, size, metadata, native/recomputed SHA-256
- UTF-8 HTML, unique accounts index detail-link count, detail CSRF/account/service markers
- Monthly artifacts are fragments, not full documents; declared year/month matches filenames
- Exact relationships among status, failures, expected datasets, saved artifacts, order, counts

Fail closed on unknown fields/datasets, duplicate keys, excessive accounts, 13 or more months, huge objects,
stalled cursors, out-of-prefix keys, undeclared objects. Implementation limits: 64 accounts, 12 months each,
833 data artifacts maximum, 8 MiB per artifact, 64 MiB total run including manifest.

## Central raw-evidence contract

Central route allows only dedicated client `collector-r2-moneyforward`, producer `collector-r2-importer`,
source `moneyforward-me` defined by migration `0014_moneyforward_collector_r2.sql`. Fixed storage origin template
`raw/moneyforward/{date}/{run-id}/{artifact}`; convert specific source keys to HMAC fingerprints.

Catalogue data artifacts as `provider_response / exact / not_applicable` without reserializing source R2 bytes.
Central manifests are newly generated, replacing free-form failure messages with fixed codes; do not treat them
as byte-identical to source manifests.

Central runs use fixed `sourceRunKey` and contract `producerVersion: moneyforward-r2-v2`. Do not include
per-deployment Importer revisions in terminal reports; record only for failed/interrupted attempt diagnostics.
This lets replay of the same source run from different deployments converge on immutable descriptors,
terminal reports, seals.

## Bounded replay

After fixing complete inventories, transfer five data artifacts per request into staged inventory. Versioned
AES-256-GCM continuations encrypt/authenticate manifests, central runs/units, inventory digests, offsets.
Reread artifacts per chunk; stop on size/hash differences from fixed inventories. Only the final chunk appends
unit/run terminal reports and seals.

Backfill scan cursors also use versioned AES-256-GCM with keys derived from dedicated client tokens. Bound
R2 cursor length, outer cursor length, maximum pages, transfer token length, offset progress. Do not advance
source scan cursors until the current manifest is sealed. Save only encrypted cursors in collector state
with mode 0600; direct/backfill responses return no source object keys. After dedicated client token or
fingerprint key rotation, reject old cursors, delete saved cursors, rescan idempotently from the start.

## Production R2 aggregate audit

Read-only full scan on 2026-09-07 examined 10 manifests/530 data artifacts: success 10 / partial 0 / failed 0;
10 accounts indexes, 40 account details, 480 monthly fragments. All 10 manifests/referenced artifacts passed
strict validation.

This is a snapshot of objects available then, not a fixed future run count. Rerun the same audit during rollout,
confirming zero strict failures. Compare source object counts/aggregate checksums before/after backfill;
exclude object keys, individual hashes, bodies, financial values from operational output.

## Layer B semantic boundary

Only `monthly-transactions` is the canonical transaction route. `account-detail` also shows recent transactions,
but is a bounded recent view containing the same transactions. Its recent transactions stay evidence-only;
the observed detail-measure parser below reads only aggregate/point values. The frozen
evidence boundary still validates `accounts-index` and detail surface markers without
financial observations. Do not relabel sources as
underlying banks/cards. Separate source accounts by account units HMAC-ing verified detail account/service JSON
tuples with a dedicated key. Verify agreement with the same ordinal in sorted accounts index and uniqueness
within runs; retain ordinals only as provenance. Ordinal changes from link additions/deletions do not change
identity. Keep raw identifiers out of unit metadata/logs; do not promote legacy ordinal-only artifacts to Layer B.

Monthly fragments require a unique provider `YYYY-MM-DD` within 100 bytes preceding each tooltip table,
with table count equal to ISO date token count. Calendar edges include previous/next-month days. Validate their
row shapes, descriptions, explicit signed JPY integers, then promote only days matching artifact filename's
declared year/month to observations, avoiding overlap between adjacent monthly fragments. Do not infer provider
IDs, pending/posted states, or underlying financial institution transaction identities.

Current views select latest successful/failure-free parsed artifacts per source, HMAC account unit, year/month.
New complete empty fragments also become snapshots, removing old rows for that month. Partial/failed runs remain
raw evidence only, not Layer B. All fragments require one calendar marker. Additional structure audit: 407
nonempty, 73 empty; all 480 had zero scripts/tables other than tooltips. Pin tag/attribute-name structures of
dialog/calendar/select shared by the 73 empty fragments; arbitrary divs, lone calendars, or truncated tables
must not erase old snapshots.

Same-day Layer B read-only full canary rescanned 540 objects: 10 successful manifests/530 data artifacts.
Validated all 8,603 tooltip body rows from 480 monthly artifacts, generating only 6,880 in-month observations
(inflow 1,883 / outflow 4,997). Validated shapes/amount representations of 1,723 adjacent-month rows without
emitting; accepted 50 accounts index/detail artifacts as evidence-only. Zero Layer A/Layer B failures.
Output contained only aggregate counts/fixed failure codes, no bodies, keys, hashes, individual financial values.

## Detail measures observed on 2026-11-09 and verified on 2026-11-10

The owner's authenticated Chrome session exposed four linked details: three bank
and one card. Every accessible detail was observed read-only using
`GET /accounts/show/{accountId}`; private identifiers were not recorded. Other
group selection and securities details were unavailable. No refresh, settings,
payment or premium action was used.

- Bank table: `section.accounts-form > table.table-bordered`, direct
  `thead > tr > th` / `tbody > tr > td`; headers exactly
  `名称 / 種類 / 番号 / 残高`, four cells per row. The observed bank TDs
  contain plain text without child elements. Observed row counts: 4, 2, 2;
  missing amount counts: 2, 1, 0, displayed as `-`.
  Root `section.accounts-form > h1.heading-small` reports
  `資産総額：<integer>円`. In all three details, the exact sum of the
  available numeric rows matched that aggregate. Missing rows are unavailable,
  not zero. Foreign product labels do not change the explicit JPY amount unit.
  No stable subrow identifier or native foreign amount/rate was observed.
- Deposit table: `section#portfolio_det_depo.bs-detail ... table.table-depo`,
  headers `種類・名称 / 残高`. It repeats the known main-table values and
  never becomes another published balance.
- Card main table has headers `名称 / 種類 / 番号 / 引き落とし予定額`,
  but five body cells, the last unlabeled. Fifteen rows had `-` amounts and
  trailing cells; the heading reported `引き落とし予定額：未定`.
- Two `section#portfolio_det_po.margin-top` sections share an ID and
  `table.table-bordered.table-pns`. Debt headers are
  `名称 / 残高 / 取得日`: seven rows, balance TD
  `.restrict-premium-text` containing a premium link, date TD `.entry-date`.
  Those gated amounts remain unavailable. The other full header is
  `名称 / 種類 / ポイント・マイル数 / 換算レート / 現在の価値`.
  Its single row has five TDs; the last three have class `number` with plain
  text: integer plus `ポイント`, ASCII rate with two fractional digits,
  and integer plus `円`. Exact quantity times rate matched the reported
  JPY value; the parser requires that equality. Header and column shape
  distinguish it from debt.
- No independent provider balance/reward as-of was observed.
  `input#updated-at[name="user_asset_act[updated_at]"]` belongs to manual
  transaction entry. Debt acquisition dates also do not timestamp balances.

`moneyforward-detail-balances@1.0.1` parses stored matching pages under
[ADR 0103](../adr/0103-moneyforward-detail-measures.md). It publishes the bank's
reported JPY aggregate and the observed single point quantity/current JPY value,
with capture time as `observedAt` and no invented `asOf`.
All are non-additive MoneyForward measures, outside the direct-deposit allow list.
The existing descriptor already registers detail HTML; no new request or
registration-contract version is needed.

Closed diagnostics name `product_balance_missing`, `card_payment_undetermined`,
`card_debt_premium_gated` and `securities_holdings_unobserved`, prefixed
`moneyforward_detail_`. Unknown page kinds/headers, malformed units/amounts and
disagreeing bank totals are rejected with closed parser errors.
Document HTML/body and selected section closing tags must be present, so a
truncated capture cannot replace complete membership through DOM repair.
Securities positions remain unimplemented because no securities schema was observed.
The catalogue is partial; production replay/publication and live-reader
validation remain outstanding.

## Runtime feasibility and recommendation

| Route                                     | Assessment          | Purpose                                                   |
| ----------------------------------------- | ------------------- | --------------------------------------------------------- |
| MoneyForward ME collector                 | C / cost 3          | Supplementary read-only snapshots after passkey bootstrap |
| Private R2 Layer A replay                 | A / cost 1          | Bounded central ingestion of manifest-finalized runs      |
| Official financial institution collectors | Assessed per source | Prefer as authoritative when accessible                   |

Private collector HTML routes/fragment structures may change. Do not loosen validators by guessing;
verify new shapes with fixtures keeping bodies private and aggregate audits, then raise contract versions.
Do not overwrite existing central runs; replay under new fixed contract namespaces.

## Implementation and related records

- `services/collector-moneyforward/README.md`: authentication, read-only collection, source limitations
- `services/collector-r2-importer/README.md` (removed with the importer on 2026-09-13): strict validator, chunking, cursors, rollout order
- `docs/sources/smbc-bank.md`: SMBC/Vpass-specific information weakened/missing through MoneyForward
- `packages/storage-d1/migrations/core/0014_moneyforward_collector_r2.sql`: central route/policy

## Unverified items

- MoneyForward HTML revision/private route change frequency in long-term operation
- Actual source refresh frequency/delays for free accounts
- Safe official export routes for off-screen data older than 12 months
- Per-linked-source pending/posted semantics and reconciliation with official transaction IDs

Do not fill these gaps by guessing. Retain MoneyForward snapshot provenance/retrieval times; do not claim
completeness equivalent to official financial institution sources.

## Switch to shared DATA R2 (U09)

Collector does not read `COLLECTION_TARGET`. Its only destination is shared bucket `kogane-raw-evidence`
(binding `DATA`). Switching and the importer were retired on 2026-09-13 (`docs/collection.md`). Runs are
stored through `packages/collection`, writing terminal manifests last. Saved HTML is byte-identical to what
was sent centrally before retirement; terminals contain per-account units and ranges for retrieved months.
See the relevant section of `docs/collection.md` for artifact/role mappings.

Account unit keys are unkeyed, domain-separated SHA-256 of account/service tuples:
`moneyforward-account-v2-<64 hex>` ([ADR 0027](../adr/0027-moneyforward-collector-account-identity.md),
[ADR 0029](../adr/0029-data-classification-and-unkeyed-identity.md)). Collector reads tuples from account detail
HTML before saving, using the same validation as the old importer, and hashes
`["moneyforward-account-v2", account[id_hash], service[id]]`. No secret used. Missing/invalid tuples leave
the entire run stored as positional units (`account-NN`); parsers mark account-naming artifacts `parser_rejected`.
Logs carry only fixed code `identity`, no identifiers. Parsers also accept old importer HMAC identities
(`moneyforward-account-v1-`), but their key was lost, so v1/v2 for the same account become separate accounts
(ADR 0030's amendment maps owner-confirmed v1→v2 pairs through a one-time stored-value overwrite rewrite.
Migration 0062 stages pairs; 0063 overwrites importer-side stored values to v2, aligning with importer-era
account entities. [Identity operations](../identity-operations.md#one-time-identity-value-rewrite)).
