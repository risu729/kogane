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

The importer let only a domain-separated HMAC of the exact JSON tuple
`["vpass-card-binding-v1", externalId, globalid, cardCode]` leave the derivation
function, keyed by its `ORIGIN_FINGERPRINT_KEY`, and wrote it as a
`vpass-card-v1-<64 hex>` token. The key was retired with the importer and is
lost, so nothing derives a v1 token any more; the stored v1 tokens remain valid
historical evidence.

What central storage may hold is decided by
[ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md). The card
tuple is a provider-local opaque identifier (class c): it names a card inside
Vpass, it is not a credential, and in this single-owner store it cannot be
confused with anyone else's, so CORE may hold it raw or hashed when identity
needs it. Card holder names (class d) are compared in memory as consistency
checks and are not part of the binding (class d as redefined by ADR 0029's
amendment 2 permits names in stored evidence; the binding does not need them); credentials and keys (class a) are never stored or
logged; logs and operational records carry counts and closed codes only. The
collector therefore derives the token without a secret, as the unkeyed,
domain-separated SHA-256 `vpass-card-v2-` +
SHA-256(`JSON(["vpass-card-binding-v2", externalId, globalid, cardCode])`). The
binding payload still carries only the token and closed fields, never the
tuple: storing the tuple itself is permitted by ADR 0029 and is a later change,
once the field shapes are confirmed. The original private source remains
untouched.

Each binding is a separate Layer A fetch run, using the original acquisition
namespace and session with source `vpass`, producer `collector-r2-importer`, and
`source_run_key = card-NNN-vpass-card-binding-v1`. It contains one
`collector_derived` artifact with dataset `card-identity-binding`,
format ID `vpass-card-identity-binding-json`, version `1`, artifact key
`card-identity-binding.json`, and a card unit whose key matches
`^vpass-card-v1-[0-9a-f]{64}$` (since migration 0057 the trusted lookup also
admits the collector's `^vpass-card-v2-[0-9a-f]{64}$`, and nothing else). Its
payload records the HMAC, source ordinal/session,
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
run, and the strict token pattern (v1 or, since migration 0057, v2). Resolve only when the number of distinct
candidate HMAC values is exactly one. Pin the binding `fetch_artifacts.id`
alongside the C decision; a missing or ambiguous binding stays unresolved.
The identity evidence is provider-local, not a global physical-card claim.

Existing observations retain their original Layer B source account, amounts and
provenance. Re-identification attaches the HMAC account key in Layer C. There is
no financial reimport or financial reparse requirement.

## The collector's binding (ADR 0023, ADR 0029)

The importer and its private source bucket are retired. The Vpass collector
(`services/collector-vpass/src/card-binding.ts`) derives the token from the
same tuple with the importer's checks while the responses are still in the
Worker's memory, before the sanitizer redacts `vpSessionBean`, as the unkeyed
v2 digest above; it needs no secret. It stores the token as a second `card`
unit of the card's own shared-R2 run with one `card-identity-binding.json` of
the same dataset, format and version, whose payload names the derivation
(`schemaVersion: "vpass-card-binding-v2"`) and has no key version, no snapshot
or manifest digest and no storage-key fingerprint, because the collector
keeps no key and no private source object to name. The trusted lookup accepts
it through the view as migration 0057 recreates it: migration 0055's
evidence, with the binding inside the financial run (producer
`collector-vpass`, session namespace `shared-r2`, a run key naming the card
ordinal) instead of a sibling run, and the token prefix `vpass-card-v1-` or
`vpass-card-v2-`. One token value maps to one account entity whichever
producer read it
([identity operations](identity-operations.md#collector-vpass-runs-bind-in-their-own-run)).

A card's importer-era v1 token and its collector-era v2 token are different
values and so, in this repository today, different account entities until the
one-time identity-value rewrite of ADR 0030's amendment replaces each card's
v1 token by its v2 token
([identity operations](identity-operations.md#one-time-identity-value-rewrite);
the owner stages the Vpass pairs, and the rewrite migration is not in the
repository yet). The collector's
statement pages are not parsed today (ADR 0022), so no card-month is read
under both yet; once they are, purchase recognition retires the importer-era
event of a card-month and recognises the collector's on the new entity, so
the captured total is not doubled. That rewrite is not part of ADR 0029.
The operations below describe the retired importer.

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
