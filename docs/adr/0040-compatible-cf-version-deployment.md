# ADR 0040: Deploy compatible Workers through prebuilt cf versions

- Status: proposed
- Date: 2026-10-05

## Context

The shared deployment Action v2.1.1 uploads Cloudflare Build Output through
`cf workers versions create`, deploys the exact returned version at 100%, and
reads its allocation back. Kogane currently deploys all 16 Workers through v1,
which rebuilds from Wrangler configuration during publication.

Three Workers own Container applications, and three others own legacy DO
migration histories. Version upload does not apply Container applications.
Converting legacy DO migrations to exports changes the compatibility boundary
for older rollback targets. The two V Point Workers already declare exports;
their configuration needs no DO lifecycle conversion.

## Options considered

1. Replace every Action invocation: insufficient because Container applications
   would remain unchanged and legacy DO lifecycle changes need separate rollout.
2. Add `cf deploy` to the shared Action: supports additional application changes,
   but broadens its current exact-version and trigger permission contract.
3. Migrate only compatible Workers and preserve the existing paths for the six
   Container/legacy-DO owners: achieves prebuilt publication without a lifecycle
   or Container rollout change.

## Decision

Use option 3. Ten ledger entries declare `deployBackend: "cf"`, pin
`cf@1.0.0-beta.12` and Action v2.1.1, and add native configuration and
credential-free prebuilt version dry runs. The other six retain v1.2.0.
Canonical Wrangler configurations and their tests and dry runs remain; native
configuration parity is checked against them. No Workers Previews are added.

The exact target checkout selects the backend. Older commits with no cf marker
use v1. A trusted workflow adapter maps actual cf-step outcomes onto the legacy
release helper's per-Worker identifiers, including failure and skipped steps.
Release order, schema-prefix rollback guards, compatibility floor, serialized
production concurrency, partial-release resume and authenticated health remain.

Stamp release identity before building. Digest every cf Build Output file,
native configuration and build configuration in the manifest, then verify it
before publication. Do not enable trigger synchronization or synchronize bank
secrets. Retain existing D1 migration commands.

## Consequences and verification

- This is a partial migration: three Container owners and three legacy DO
  owners still use Wrangler for publication. They need a separate design and
  production verification before moving to cf.
- Two configuration formats coexist. Parity guards reject drift in settings,
  binding identities, variables, assets and existing exports.
- Existing validation remains and cf builds add work. Run the complete local
  `mise exec -- hk check --all --no-fail-fast` graph and the full hosted checks.
- Manifest tests change Worker metadata and asset bytes after measurement and
  require the release verification to reject them.
- Production completion requires all 16 deploy steps and the App/Processor
  authenticated SHA/schema postcheck, using the reduced production token.
  A same-commit ledger skip is not evidence of token or cf deployment success.

Sources: [cf Build Output](https://developers.cloudflare.com/workers/build-output/),
[cf migration](https://developers.cloudflare.com/cf/wrangler/migrate/),
[cf deployment](https://developers.cloudflare.com/cf/projects/).
