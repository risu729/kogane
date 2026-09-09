# Production observations

This private Worker turns sealed, successful financial Layer A artifacts into
versioned Layer B observations in the existing `kogane-raw-evidence` D1 database.
It imports the deterministic parser registry directly; it never imports the
PoC SQLite store. All 12 existing collector sources retain their source-specific
parser contracts, duplicate identities and provider evidence locators.

Apply additive raw-evidence migration `0017_observation_pipeline.sql` before
deployment. The Worker has no public workers.dev endpoint or route. The protected
evidence browser reads the projection views and retains the existing complete
snapshot and pagination queries, including empty successful snapshots.

Every five minutes, the Worker runs three independently budgeted lanes (see
`docs/observation-lanes.md`, migration `0035_observation_job_lanes.sql`):
`incremental` consumes the durable work items a D1 trigger appends whenever a
run is sealed and executes up to 12 jobs; `repair` advances the historical
cyclic cursor over at most 100 artifact IDs and executes up to 4 jobs, so lost
notifications and new parser versions are still discovered; `replay` steps
operator-created plans and executes up to 8 jobs. A large replay never delays
newly sealed evidence. Jobs are
unique per artifact/parser/version. Failed attempts remain in `parse_runs`.
Transient errors retry with exponential delay up to five attempts; deterministic
parser rejections fail immediately and remain visible for operator inspection.
New parser versions create new jobs; obsolete pending versions are retired.
A ten-minute lease
guards concurrent runs; interrupted pending attempts are marked error on reclaim.

Raw objects must match both size and SHA-256. Reads are capped at 16 MiB; parsed
observations at 2 MiB per artifact, and each insertion chunk at 500 KB. Larger
artifacts fail with explicit bounded-resource codes rather than publishing a
partial financial snapshot. Current production raw artifacts are much smaller;
raising limits requires reassessing D1's invocation query budget.

Observation inserts remain hidden under a pending parse run. A final atomic D1
batch publishes success, supersedes the older parser version and completes the
job. A parser failure never supersedes existing observations. Metadata and all
observation rows are append-only; original raw artifacts remain authoritative.
Publication compares numeric major/minor/patch versions: a late older parse is
retained as superseded, never made current over a newer successful parse. Parser
versions must be three safe nonnegative integers, with no prerelease suffix.
MyJCB statement state and period come from the verified central manifest, whose
artifact ID is retained as metadata provenance.

Metadata extraction is a versioned transform and every parse records the release
it ran and the fingerprint of its input (migrations
`0027_metadata_projections.sql` and `0028_parse_releases.sql`). Candidate
results, release comparison, adoption and rollback are behind
`RELEASE_CANDIDATES_ENABLED`; with the flag absent nothing a reader sees
changes. See `docs/release-adoption.md` for the contract, the routes and both
runbooks.

## Operations

From this package, with the usual authorized Cloudflare environment:

```sh
node scripts/ops.ts status
node scripts/ops.ts catchup 100
node scripts/ops.ts sweep replay 20
node scripts/ops.ts replay plan '{"source":"smbc-bank","dataset":"balance-normalized","parser":"smbc-direct-balance","version":"1.0.0","reason":"..."}'
node scripts/ops.ts replay start '{"planId":1}'
node scripts/status.ts
```

Use the project's pinned Node runtime: Bun's remote proxy stalled in the local
rollout environment. `status.ts` emits only aggregate coverage/job counters.
The catchup command makes the requested bounded number of private service-binding
calls, at most 40 incremental jobs per call plus the default repair and replay
budgets. `sweep <lane> [maxJobs]` runs a single lane. `replay <plan|start|pause|resume|cancel|inspect> <json>`
calls the internal replay commands; `start` performs one bounded creation step
per call and the cron continues the rest. None of this deploys an ops Worker or
exposes a local server. `status` reports per-lane backlog, oldest pending age,
unprocessed work items, latest sealed versus latest parsed time and replay plan
states, with no financial values. Failed jobs require inspecting their
safe error code and artifact/parser/version, repairing the cause, then explicitly
resetting that exact job or deploying a corrected parser version.

Validation: `bun test`, `bun run typecheck`, and `bun run cf:check`. Runtime tests
use Miniflare D1/R2 with successful, empty, failed, missing/checksum, concurrent,
supersession, interrupted-attempt, and MyJCB metadata cases.
