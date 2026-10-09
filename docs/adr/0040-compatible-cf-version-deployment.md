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

## Amendment: bounded authenticated App/Processor readiness

- Status: proposed
- Date: 2026-10-10

An ordinary deployment's authenticated health request returned HTTP 200 and
healthy stores and Processor while the App still answered with the previous
valid release SHA, six seconds after publication. Curl transport retries do
not retry a successful old identity; the previous jq comparison immediately
failed the release. A subsequent deployment succeeding would not repair this
failure class or prove the previous release healthy.

Options: increase a fixed delay, retry every response, or poll only a healthy
old identity inside the existing read budget. Select the last: a trusted Node
helper captured before target checkout performs at most six authenticated GETs,
with at most 30 seconds per request and five 5-second waits. One monotonic
205-second total deadline (6 × 30 + 5 × 5) includes response bodies, parsing,
validation, waits and final acceptance; shorter remaining time caps a request
or wait. There is no nested curl retry loop and no larger production budget.

Every response must be a single bounded JSON object with the expected health
shape, healthy CORE/DATA/grants/Processor, the manifest's required CORE
migration, and READ healthy when required. Only an otherwise healthy body
whose App or Processor has a valid 40-character old SHA is identity-pending.
Acceptance requires both exact immutable target SHAs on a new response. Pure
transport interruption or a request/body timeout may also use the same six
attempts. Auth rejection, redirects, any non-200 response, malformed/oversized
JSON, missing migration or unhealthy semantics fail immediately. Credentials
remain in process environment and request headers; no body, credential,
provider text or verified file is written. Diagnostics are closed codes.

This is read-only propagation readiness, not a second deployment, rollout,
manual ledger edit or authorization bypass. It does not alter Worker/version
allocation guards, Container deadlines, publication capture, workflow pins,
serial concurrency or supersession checks. Old healthy builds may eventually
remain pending and fail; the helper does not prove that a stale SHA is caused
by propagation, cannot certify production by itself, and cannot guarantee
readiness within this bound. Final ordinary Deploy/ledger/health evidence is
still required. The helper is fetched from the trusted workflow revision so
compatible older rollback target checkouts cannot replace or omit it.

Verification: synthetic real HTTP covers old-health-to-target recovery,
transport interruption, manual redirect handling, request/body/total timeout,
retry cap, strict health/schema refusals and late-response non-acceptance.
Target mutation never changes the captured expected SHA. No financial values
or production credentials enter tests; no test/source deadline is weakened.

### Amendment scope: authenticated future-alarm bootstrap

The next ordinary deployment passed authenticated GET health, but its POST
bootstrap reached an old App paired with the target Processor. Telemetry
reported the App's closed `release_mismatch` before any bootstrap write.
Readiness on one request does not prove identity on a later request.

The authenticated App now captures its release SHA, checks an optional
`x-kogane-release-sha` target header after service-token authorization, keeps
its existing App/Processor health equality guard, and forwards the captured
SHA to the internal bootstrap. After existing binding/caller authorization,
the Processor checks that target against its captured valid SHA before any
bookkeeping or reservation writes. Only valid differing release identities in those prewrite guards use HTTP 503
with the closed error `{ "error": "release_mismatch" }`. The App's existing
error writer may add exactly one `requestId` field containing a canonical
lowercase UUIDv4 (`crypto.randomUUID`); that existing envelope is accepted too.
Any other key, refs, malformed UUID or other error is refused. The metadata is
never logged or returned by the client; the existing error/audit writer stays
unchanged.
The actual Processor POST response returns that captured SHA; the App wraps
it with its captured App SHA. It never substitutes a prior health GET's SHA.
Invalid own identities, unhealthy/non-200 or malformed internal health, and
malformed or wrong-identity postwrite answers remain `scheduling_unavailable`,
which is never eligible for automatic replay.

The trusted bootstrap client sends the immutable workflow target and accepts
only complete armed reservations with both exact target identities. It may
retry only the exact authenticated prewrite refusal, at most six POSTs with
five 5-second waits under the existing single 120-second monotonic deadline.
That deadline includes every request, bounded 64-KiB UTF-8 response body,
parsing, backoff, reservation validation and final acceptance. It is not six
120-second attempts. A timeout, network failure, auth rejection, redirect,
generic 503, malformed response or invalid/old-identity HTTP 200 fails without
replay because writes may already have happened. No credentials, response
body or postdeadline verified file/output are produced.

Cron removal readback remains a prerequisite outside the existing POST budget.
No schedule setting, collection, adoption, grant or access authority changes.
For ordinary `release`, older servers may ignore the request header or omit
identity metadata; their HTTP 200 is refused without replay, even if writes
already happened. Explicit `rollback` preserves its previous invocation of
`mise run --no-deps automation:alarm-bootstrap` from the immutable target
checkout. Older targets keep their existing one-shot contract, without gaining
this retry or actual-POST identity proof; new targets use their strict helper.
Selection is solely the declared workflow mode, never an HTTP response or a
fallback after strict failure. The trusted GET readiness helper still applies
to both modes. No uncertain mutation becomes safe to repeat. Ordinary
Deploy and hosted evidence remain necessary; a later success alone does not
prove the reason for the previous mismatch.

Verification uses synthetic real HTTP and native Node for exact prewrite
refusal recovery, request cap, total body/backoff deadline and uncertain
failure/old-success non-replay. App authenticated route tests prove target
checks occur after authorization and before bootstrap writes, and that actual
POST identity differs from a health snapshot. Processor route tests prove
invalid/missing targets perform no DB/alarm operations, its captured identity
survives asynchronous writes, and operational failures keep a generic code.
