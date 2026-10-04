# ADR 0040: Deploy compatible Workers through prebuilt cf versions

- Status: accepted
- Date: 2026-10-05

## Context

The shared deployment Action v2.1.1 uploads Cloudflare Build Output through
`cf workers versions create`, deploys the exact returned version at 100%, and
reads its allocation back. Before this stage, Kogane deployed all 16 Workers
through v1, which rebuilt from Wrangler configuration during publication.

Three Workers own Container applications, and three others own legacy DO
migration histories. Version upload does not apply Container applications.
Converting legacy DO migrations to exports changes the compatibility boundary
for older rollback targets. Existing namespaces instead support code-only
version upload: native bindings explicitly reference the same Worker and class,
while neither migrations nor exports are sent. The two V Point Workers already
declare exports and retain them unchanged.

## Options considered

1. Replace every Action invocation: insufficient because Container applications
   would remain unchanged and legacy DO lifecycle changes need separate rollout.
2. Add `cf deploy` to the shared Action: supports additional application changes,
   but broadens its current exact-version and trigger permission contract.
3. Migrate compatible Workers, including three code-only legacy DO owners, and
   preserve the Container deployment path: achieves prebuilt publication with
   explicit namespace guards and no DO lifecycle conversion.

## Decision

Use option 3. Thirteen ledger entries declare `deployBackend: "cf"`, pin
`cf@1.0.0-beta.12` and Action v2.1.1, and add native configuration and
credential-free prebuilt version dry runs. The three Container owners retain v1.2.0.
Canonical Wrangler configurations and their tests and dry runs remain; native
configuration parity is checked against them. No Workers Previews are added.

The exact target checkout selects the backend. Older commits with no cf marker
use v1. A trusted workflow adapter maps actual cf-step outcomes onto the legacy
release helper's per-Worker identifiers, including failure and skipped steps.
Release order, schema-prefix rollback guards, compatibility floor, serialized
production concurrency, partial-release resume and authenticated health remain.

Stamp release identity before building. Digest every cf Build Output file,
native configuration and build configuration in the manifest, then verify it
before publication. Keep trigger synchronization disabled except for Processor,
whose existing Queue consumer options must be synchronized. No routes or domains
are synchronized and no bank secrets are written. Retain D1 migration commands.

The three legacy DO owners declare `doLifecycle: "preserve"`. Credential-free
build guards reject exports or migrations in their actual cf output and require
the exact self-Worker/class bindings. Before any release mutation, read each
selected Worker's live migration tag and active-version namespace IDs; the tag
must equal the latest canonical migration. After publication, read them again
and require identical namespace IDs. Pending lifecycle work fails closed:
apply it through a separately reviewed Wrangler lifecycle rollout before
resuming code-only cf deployment. Canonical migration histories remain unchanged
and old rollback commits continue to use their original v1 path.

## Consequences and verification

- This is a partial migration: three Container owners still use Wrangler for
  publication. Container application synchronization needs a separate design
  and production verification before moving them to cf.
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
[cf deployment](https://developers.cloudflare.com/cf/projects/),
[existing DO namespace considerations](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#considerations-with-durable-objects).

ADR 0043 proposes the subsequent migration of the three default-policy Container
owners. This ADR records the earlier thirteen-Worker stage.
