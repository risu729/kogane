# ADR 0043: Deploy the remaining Container Workers through cf

- Status: accepted
- Date: 2026-10-05

## Context

ADR 0040 moves thirteen Workers to exact prebuilt version publication. The
three remaining Workers own Container applications using the default scheduling
policy. Version upload alone does not synchronize those applications. Their
existing application names and IDs, Durable Object namespaces, SQLite storage,
APAC constraint, basic instance type and maximum instance counts (2, 2, 1) must
survive the deployment migration.

The new Durable Object scheduling policy requires replacement applications and
namespaces and does not support equivalent APAC/basic/max-instance settings.
This decision preserves the default policy. The separate native Container API
migration changes runtime code in a different PR; this PR changes no collector
source and does not wake a bank collector to verify deployment.

## Options considered

1. Keep Container publication on Wrangler v1: leaves three deployment paths
   outside the shared prebuilt contract.
2. Reimplement image push and application synchronization around version upload:
   duplicates the pinned CLI's synchronization, rollout and validation logic.
3. Opt into the shared Action's prebuilt full deploy and verify the resulting
   application and immutable image independently: reuses the existing cf path.

## Decision

Adopt option 3. All seventeen entries declare cf; only the three Container
entries select `production-strategy: deploy` and explicit `deploy-triggers: true`.
The shared Action still verifies its returned Worker version at 100%. It also
synchronizes triggers as part of full deploy. These three configurations have no
routes/custom domains and preserve their existing empty Cron configuration.
Workers Previews and secret synchronization are absent. Among code-only versions
steps, Processor and PRESTIA explicitly enable deploy-triggers. Processor retains
its existing Queue consumer synchronization. PRESTIA's already checked-in
workersDev:true and previewUrls:false must be applied after its first version
upload: version publication alone left its workers.dev endpoint disabled. The
exact v2.1.1 Action synchronizes prebuilt triggers after its 100% version
readback; pinned cf beta12 applies the configured workers.dev/preview flags.
PRESTIA adds no route, custom domain or schedule activation.

The workflow pins the approved and released Action v2.2.0 at its immutable
release commit. Action PR #109 has been independently reviewed, approved by the
owner, and merged. No temporary pinact exception remains. PR #438 merged after
the authenticated preflight and validation gates below.
Every publication still requires the application and image readback gates.

Each cf build creates its Docker image on the same daemon that later publishes
it. A separate image manifest records the local tag, Docker image ID, daemon ID,
and hashes of Dockerfile, optional .dockerignore and the container source tree
excluding the generated node_modules directory. The admitted Dockerfiles may COPY only actual
regular, non-symlink files directly inside container; directory COPY and unknown
COPY forms are rejected. A regular file named node_modules remains hashed.
Generated dependencies are not consumed by these images. The manifest
is hashed into the release record and uploaded with the ordinary release
manifest. Before publication the trusted adapter re-inspects the tags and
inputs; replacement tags or a different daemon fail closed. File measurement
opens with O_NOFOLLOW, verifies the same descriptor is a regular file, and hashes
that descriptor, so replacing the pathname between checking and reading cannot
substitute another inode. Registry requests remain on the exact controlled host,
namespace and app repository, with manual redirects and bounded reads. Persisted
API snapshots contain only validated operational IDs, immutable image digest,
integer version and optional rollout UUID; no response body or provider text
is written.

Before publication, read the fixed application ID/name and the selected
Worker's active-version DO bindings, then require the expected default policy,
APAC/basic/max-instance configuration and namespace linkage. After each upload,
read those identities again and require unchanged namespaces/application
identity. Require the desired application version to have its exact immutable
image at 100% with no active rollout. This is control-plane completion and does
not demand that sleeping instances start or that a collector run.

The registry verifier accepts only registry.cloudflare.com and the namespace
returned by the same authenticated account's Containers /me API. It verifies
sha256 manifest bytes, selects linux/amd64 when an OCI index is present, and
compares its image-config digest with the recorded local Docker image ID.
Registry credentials have a short pull-only lifetime; requests never follow
redirects and have bounded time/response size. Child CLI errors and API failures
print closed codes rather than captured stdout, stderr, provider text or tokens.

A publication whose application/image readback has not succeeded is recorded as
failed, even when Worker publication succeeded. ADR 0060 adds immutable same-run
publication checkpoints: a bound Container is reverified without republishing;
a new normal release still follows the ordinary ledger decision.
The operation is not transactional: Worker publication can precede an image,
application, trigger or readback failure. No automatic rollback is attempted.

### Older source rollback after SQLite exports conversion

The native configurations declare SQLite exports, an irreversible lifecycle
boundary for returning to legacy migration metadata. The current trusted
workflow therefore fetches its small compatibility adapter at its own workflow
SHA before checking out the requested older source.

For the exact three admitted histories only, the adapter converts the canonical
single v1/new_sqlite_classes migration into equivalent SQLite exports. It keeps
both StGeorgeCollectorContainer and StGeorgeCollectionState. Any other history,
class set, binding, external script, container identity, scheduling policy or
build options is rejected. All other target source remains unchanged.

The admitted alarm floor is commit
2231dc0743bc879ee9c0d547af281aa9ab5855be. Its three workspace manifests and lock
pin Wrangler 4.145.0, which supports SQLite exports. Require the target's exact
already installed pin to be stable Wrangler 4.145.0 or later within major 4;
unknown or incompatible versions fail. No replacement CLI is installed.

Legacy targets build the Docker image once with the existing Wrangler 4.145/
4.146 no-build-vars linux/amd64 build command and Dockerfile on stdin. The schema
prefix gate runs before registry upload. The target's existing Wrangler
containers push primitive saves that local image; the adapter resolves and
verifies its immutable registry digest and replaces only containers[0].image
with that digest before computing the final release manifest. The legacy v1
Worker deploy therefore uses the saved image instead of rebuilding mutable
external installation steps. The target's normal bundle/validation and legacy
manifest/ledger entrypoints remain in use.

## Consequences and verification

- Configuration formats coexist, with the real pinned @cloudflare/config
  converter checking every canonical field and the equivalent SQLite exports.
- Synthetic guard tests cover changed identities, history, local image tags,
  allocation, OCI platforms, registry digests, redirects and failed ledger
  outcomes. Focused checks use the native mise toolchain.
- The real Wrangler 4.145.0 parser and credential-free deployment dry run accept
  both normalized St.George SQLite exports and an immutable image reference.
- Docker is unavailable in the local development container. Hosted CI builds
  and validates the three native cf outputs and inspects actual local Docker
  image IDs. The final signed PR head passed these checks before merge.
- Read-only preflight 37231245363 observed three matches to the Cloudflare account
  ID, zero to Containers /me.id, and three registry namespaces matching
  /me.external_account_id. Strict Cloudflare-ID comparison is retained.
  Application/Worker/namespace identities and desired-version 100% allocation
  matched all three. The workflow was cancelled after its read step because concurrent CD was
  observed. These are structural observations, not an atomic rollout completion proof.
  Default policy/resource conjunction initially matched zero because GET
  applications omits instance_type and expands basic into vcpu:0.25,
  memory_mib:1024 and disk.size_mb:4000. Read-only GETs of all three apps confirmed
  those exact quantities, default policy, APAC, max2/2/1 and no active rollout.
  The API guard requires all three numeric values; an optional instance_type
  must be basic, with null, aliases, numeric strings and partial/contradictory
  resources rejected. Display memory/disk strings are not used for comparison.
  Quiet preflight 37233007498 completed successfully on main6ffc at
  2026-10-04 20:40:53 UTC, with all three app/account/registry/max/APAC/Worker/
  namespace matches, all three desired versions at 100%, zero active/assigned
  instances and no active rollouts. Its raw basicInstanceTypes count was zero
  and missingInstanceTypes three, distinguishing API representation from size.
  The preflight now uses the same numeric guard for basicResourceSizesMatch and
  the combined policy/resources count, retaining the raw diagnostic counters.
  These structural reads do not verify a future deployment or registry push.
  Native Build Output still requires its explicit instanceType:basic declaration.
- Authenticated registry push, application API shape/identity and zero-instance
  rollout readback remain production-verification gates. Synthetic/local passes
  are not evidence that those operations succeeded. A controlled rollback test
  and independent review are required before claiming old rollback verified.
- The full hk graph ran at revision fb98 and exited 1 solely because the local
  container lacks Docker: seven Docker-dependent checks could not run. Hosted
  CI passed those same seven checks at that exact revision. The shared Action
  approval was granted and Action PR 109 merged; no further Action approval is
  outstanding. The final signed Kogane PR head,
  3a6ab4494d9062518df286432b85e1178890dbab, passed independent review
  (116 focused tests, 1471 assertions) and hosted CI 37233558645, including
  the real Docker checks. CodeQL 37233556481 also passed. PR #438 merged
  normally as 1b484a0a082f73818b20a79aea0e49001b3465c2. Production
  verification remains separate.

- The first full cf Container release, 37235079565 at source
  1875263d91e77e6a5fd557dc279284a091a22798, published the GlobalPass Worker,
  then failed its Container postcheck with cf_container_api_http. The release
  ledger correctly records GlobalPass as failed and the other sixteen Workers
  as skipped. The original error did not retain the failing operation or HTTP
  status, so its historical cause is not established. Quiet GET-only preflight
  37237772405 subsequently passed on the same source at
  2026-10-04 21:51:57 UTC: all three identity/resource/namespace and 100%
  allocation checks matched, with zero active/assigned instances and no active
  rollouts. This does not substitute for immutable registry image verification.
- A single explicit credential probe, 37240919803 on main
  afa898e34c514f179a3d5e0765d6e86e8c09fa67, failed at
  2026-10-04 22:40:56 UTC with the fixed operation registry_pull_credentials,
  POST, HTTP 201. Its rejected response body was not read, displayed or stored.
  This reproduces a credentials-status incompatibility; it does not establish
  the original release's unrecorded operation/status. The shared API accepts
  only 200/201 for that exact five-minute pull-only managed-registry POST,
  validates its successful envelope and documented required credential fields
  and exact registry host before use, and reports the actual status.
  Every GET remains 200-only. Deadlines, registry digest/image identity,
  application/namespace/resource/rollout gates and failure-ledger semantics
  remain unchanged. Synthetic tests verify valid 201, malformed 201, rejected
  GET 201, unknown routes/bodies and credential-safe diagnostics. Live
  credential/image verification and complete production rollout remain separate.

Sources: [cf project configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/),
[Container rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/),
[application versions](https://developers.cloudflare.com/api/resources/containers/subresources/applications/subresources/versions/methods/list/),
[DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
[scheduling policy migration](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/).

Resource reference: [Cloudflare instance types](https://developers.cloudflare.com/containers/platform/limits/)
defines basic as 1/4 vCPU, 1 GiB memory and 4 GB disk.
The admitted minimum Wrangler 4.145.0 source defines the same
[basic preset and strict inferInstanceType comparison](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.145.0/packages/containers-shared/src/limits.ts)
and [normalizes expanded GET configuration in cleanApplicationFromAPI](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.145.0/packages/containers-shared/src/deploy.ts).
