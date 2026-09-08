# Vpass durable card binding

The original private snapshot's successful card-selection response contains
`header.vpSessionBean.externalId`, `globalid`, and `cardCode`. These form a
provider-local card reference. The dropdown `value` is a rotating selector and
must never be treated as durable identity. Names are only consistency checks.

The binding importer validates the full original acquisition with the existing
Vpass validator, verifies native checksums when present, and compares source
manifest and snapshot SHA-256 before and after validation. It checks the declared
card index, unique dropdown descriptors/selectors, successful responses, and
matching selected card name and card code in selection and discovery.

Only a domain-separated HMAC of the exact JSON tuple
`["vpass-card-binding-v1", externalId, globalid, cardCode]` leaves the derivation
function. The key is the existing `ORIGIN_FINGERPRINT_KEY`; the domain is distinct
from MoneyForward account identity and storage-origin fingerprints. Raw keys,
names and provider identifiers are not logged or copied into central storage.
The original private source remains untouched. Changing the fingerprint secret
requires an explicit key-version/crosswalk migration; it is not routine rotation.

Each binding is a separate Layer A fetch run, using the original acquisition
namespace and session with source `vpass`, producer `collector-r2-importer`, and
`source_run_key = card-NNN-vpass-card-binding-v1`. It contains one
`collector_derived` artifact with dataset `card-identity-binding`,
format ID `vpass-card-identity-binding-json`, version `1`, artifact key
`card-identity-binding.json`, and a card unit whose key matches
`^vpass-card-v1-[0-9a-f]{64}$`. Its payload records the HMAC, source ordinal/session,
source SHA-256 hashes, storage-key fingerprint, and verified consistency checks.
Existing financial runs and statement artifacts are never duplicated or edited.
The storage-origin template/policy is the existing Vpass v1 policy from migration
0013; the separate transformation is recorded as `vpass-card-binding@v1`.

## Trusted Layer C lookup contract

Join the financial `fetch_runs` row to the binding run by the **same**
`acquisition_session_id`, `source_id`, and `producer_id`. Require financial source
`vpass` and producer `collector-r2-importer`, and the expected card ordinal from
the financial `fetch_units.unit_key` (not a display-name or current-order match).
Match binding `fetch_runs.source_run_key` exactly to
`financialUnitKey || '-vpass-card-binding-v1'`. Require its `fetch_run_seals` row,
successful terminal `fetch_run_reports` and `fetch_unit_reports`, the exact
artifact dataset/format/version above, artifact-to-unit ownership in the same
run, and the strict HMAC key pattern. Resolve only when the number of distinct
candidate HMAC values is exactly one. Pin the binding `fetch_artifacts.id`
alongside the C decision; a missing or ambiguous binding stays unresolved.
The identity evidence is provider-local, not a global physical-card claim.

Existing observations retain their original Layer B source account, amounts and
provenance. Re-identification attaches the HMAC account key in Layer C. There is
no financial reimport or financial reparse requirement.

## Operations

Normal Vpass imports, including scheduled/outbox reconciliation, attempt the
sidecar after the original financial run seals. Failed sidecar writes retry
idempotently; unsupported legacy layouts remain explicitly unavailable.

For historical snapshots, first deploy the reviewed importer, then run
`node --experimental-strip-types scripts/backfill-vpass-identities.ts` from the
importer service for read-only inventory. The same command with `--execute`
invokes only `/v1/vpass/import-card-binding` through the private Service Binding.
It is bounded, emits counts only, and can safely restart after interruption.
Afterward, verify sealed binding counts and run Layer C identification.

The sidecar uses seven sequential central calls. Current Workers Paid limits
allow 10,000 subrequests by default; it does not introduce a legacy 32-call cap
or change existing financial chunking. See the
[official Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests).

## Production verification — 2026-09-08

Only `kogane-collector-r2-importer` was deployed, from clean main `34e697a`
(including implementation PR #119). Cloudflare version:
`3d3e54e0-6d56-419b-891c-0210d755ccf7`. Existing required secrets,
private bindings, queue and schedule were retained; no other Worker was deployed.

Historical binding-only execution scanned 391 original objects and completed
all 96 eligible manifests: 96 sealed, zero unavailable. Read-only D1 verification
found 96 binding runs, 96 binding artifacts and six distinct provider-local card
identities. All 96 had successful run/unit reports and exact original
acquisition-session, source, producer and ordinal matches.

Original nonbinding Vpass evidence remained exactly 3,227 artifacts across 101
runs before and after the operation. No financial artifacts were duplicated.
Layer C consumption is a separate deployment and verification step.

The first CLI attempt stopped locally before sending a Service Binding request:
Node 26's native Request is not compatible with Miniflare's Request realm.
The script now passes `fetch(url, init)` instead; the successful 96-item execution
verified that path. No Worker redeployment was needed for this local CLI fix.
