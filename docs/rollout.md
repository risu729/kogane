# Production rollout and feature controls

The committed Wrangler configurations are the deployment authority. Production
features were enabled on 2026-09-12 and the legacy path retired on 2026-09-13;
card purchase recognition was enabled on 2026-09-24.
See [the retirement record](legacy-retirement.md) for resource and data verification.

## Production enablement — 2026-09-12

The owner requested activation of every feature flag. Production configurations
enable all remaining boolean App/Processor flags. All twelve collectors always
write shared DATA. `COLLECTION_TARGET` and `READ_PROJECTION_ENABLED` are removed;
App reward reads always use READ. Remaining off switches pause features.
The Access user directory identifies the sole human operator; agent grants stay
empty and session refresh remains `human` until a source has a demonstrated
unattended renewal path. These are identity/policy settings, not boolean flags.

Prerequisites verified: CORE through 0041, READ through 0002, both collection
queues, the R2 terminal notification rule, and all 13 ingest-client routes.
The existing publication repair reconciled 540 legacy-only pointers with
append-only repair events; the resulting consistency check had zero mismatches.
Writer activation precedes App reader activation; snapshot and CD verification
are recorded with the rollout PR. Collection target activation does not itself
start a provider login, and does not prove every source's next scheduled run.
Legacy retirement is recorded separately; a destructive production READ-loss
exercise is not implied by successful deployment.

Initial production observation also exposed a reward-promotion stall: an
ineligible first page never advanced the claim-derived cursor. The job now
selects eligible, unpromoted facts before applying its batch limit. Stored
claims are the completion record, including for facts published out of ID
order; no migration or claim rewrite is needed.

The table below retains the original **safe default** column for feature suspension; the
production settings in `services/*/wrangler.jsonc` are the deployment authority.

## Production enablement — 2026-09-24: card purchase recognition

The owner, the only user of production, turned on
`PURCHASE_RECOGNITION_ENABLED` (`"true"` in `services/processor/wrangler.jsonc`).
The `purchase_recognition` lane turns adopted Vpass/MyJCB single-payment usage
rows into purchase and refund events, each with a recorded `rule` decision. It
works through the rows already published in bounded five-minute ticks: the
retire pass retires at most 100 events and the recognition pass commits at most
200 guarded writes (recognize, revise, reanchor), so one tick makes at most 300
event mutations ([bounds](economic-events.md#bounds)).

Prerequisites: CORE `0047`, which the release's migration step applies before
the Workers deploy. The Vpass statement parser 1.2.0 (page-qualified external
ids, [observations.md](observations.md#vpass-page-qualified-external-ids-statement-parser-120))
is still draining through the repair lane. That drain is not a hard
prerequisite: when a later re-parse re-keys a row, the lane retires the event
recognised under the old key and recognises the new key as a new event, so the
purchase is not counted twice.

Rollback: set the var back to `"0"`. The lane is skipped; its events and
decisions stay, and a fix appends revisions, never a DELETE.

## Current release boundary — 2026-10-05

The committed configs enable existing boolean App/Processor features and name
a human operator. Both agent grant variables remain empty. CORE reaches 0065;
READ reaches 0002. This is repository state, not a live readback.

Scheduling uses fourteen active Processor-owned alarms, with two unsupported
source jobs disabled. Active Worker Cron arrays are empty. Public maintenance
rules are operator-edited and not automatically researched again. See
[schedules](schedules.md) and [current status](current-status.md).

The enablement paragraphs above are dated history. The safe-default column
below describes suspension behavior, not committed or currently deployed values.
The release workflow and `infra/deploy-order.json` determine current sequencing.

## 1. How a flag is read

Each Worker reads its flags from the `vars` of its Wrangler configuration, or
from the deployment's own variables where the owner set them by hand. Two
conventions, both deliberate:

- **Boolean flags are on only for the exact string the reader accepts.** An
  absent, empty or misspelled value leaves the feature disabled, so a typo never
  half-enables something. Which string that is differs by flag, and the
  difference is in the code, not a convention: `"1"` or `"true"` for
  `RECONCILIATION_ENABLED`, `PURCHASE_RECOGNITION_ENABLED`, `REWARD_CLAIMS_ENABLED`,
  `REWARD_READ_PROJECTION_ENABLED`, `SHARED_R2_INGEST_ENABLED` and
  `OPS_DISPATCH_ENABLED`; exactly `"true"` for `RELEASE_CANDIDATES_ENABLED`,
  `REPORTS_ENABLED`, `COMMANDS_ENABLED` and `OPS_API_ENABLED`; exactly `"1"` for
  Processor `BALANCE_PROJECTION_ENABLED`. The App does not read that name.
  When in doubt use the spelling of that flag's own document; `"1"` on
  `REPORTS_ENABLED` is silently off.
- **Grant and policy variables are off when empty.** `OPERATOR_SUBJECTS`,
  `AGENT_GRANTS`, `AGENT_API_GRANTS`, `SESSION_REFRESH_POLICY` and
  `OPS_COLLECTOR_DISPATCH_CONNECTIONS` carry structured values; the empty
  string is "nobody" (or "no connection"), and an unparsable value is refused
  rather than widened. For the two command lists the refusal is
  deployment-wide: while either is present and unreadable, or they name the
  same subject, every command and operations request answers
  `503 grants_misconfigured` — nobody, not even the named operator, is graded
  (see [change-lifecycle.md](change-lifecycle.md), "Grants").
- **`OPERATOR_SUBJECTS` empty means nobody can approve or commit, and that is
  intended.** `COMMANDS_ENABLED` and `OPS_API_ENABLED` open the paths; they do
  not grant anybody. A deployment with the flags on and no operator named
  answers `403 subject_not_granted` on every command and operations request.
  Naming the operator is a deliberate, separate step — step 6 below.

A flag change is a `vars` edit plus a redeploy, or a deployment-level variable
change with no deploy at all. Neither needs a migration, and none of the flags
below is read by a migration.

## 2. The flags

`owner` is the Worker whose configuration carries the variable:
**app** = `kogane-evidence-browser` (`services/app/wrangler.jsonc`),
**processor** = `kogane-observation-pipeline`
(`services/processor/wrangler.jsonc`), **collector** = one per-source Worker.

| Flag / var                           | Owner     | Default                 | What turning it on changes                                                                                                                                                                                                                                                                                                   | Prerequisite resources                                                                                                                                              | Rollback                                                                                                                                                         |
| ------------------------------------ | --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASE_CANDIDATES_ENABLED`         | processor | `"false"`               | The candidate parse lane writes `parse_run_candidates` and the release command routes are routed. Published results are unaffected.                                                                                                                                                                                          | CORE `0027` and `0028` (both on `0026`); `GET /publication/consistency` reports `mismatches: 0`                                                                     | Set `"false"`. New candidates stop; the ones already written stay. **Once it has ever been on, the minimum rollback build is the release that introduced it**    |
| `BALANCE_PROJECTION_ENABLED`         | processor | `"0"`                   | The balance READ build runs only for exact `"1"`. The App does not read this name. With READ bound, v2 balance paths exist and a missing snapshot is `503 read_model_unavailable`. `/api/meta` advertises `balancesV2` only when a sealed snapshot can be served.                                                            | READ migrations through `0002`                                                                                                                                      | Set `"0"` on the processor. New builds stop. App v2 paths stay and keep answering from a sealed snapshot, or `503` when none can be served. The tables stay      |
| `RECONCILIATION_ENABLED`             | processor | `"0"`                   | The scheduled `reconciliation_sweep` lane runs and writes stage A **candidates** (none for Vpass and MyJCB, whose rows carry no provider row id; their pending-to-posted candidates are `purchase_recognition`'s). A candidate is never an accepted link: acceptance stays a recorded decision (INV07)                       | CORE `0032` and `0048` (its scan cursor)                                                                                                                            | Set `"0"`. The lane is skipped; the candidates stay                                                                                                              |
| `PURCHASE_RECOGNITION_ENABLED`       | processor | `"0"`                   | The `purchase_recognition` lane turns adopted Vpass/MyJCB single-payment usage rows into purchase and refund events with recorded `rule` decisions; one tick retires at most 100 events and commits at most 200 recognition writes ([bounds](economic-events.md#bounds))                                                     | CORE `0047`                                                                                                                                                         | Set `"0"`. The lane is skipped; its events and decisions stay. Fixes append revisions, never a DELETE                                                            |
| `REWARD_CLAIMS_ENABLED`              | processor | `"false"`               | The `reward_claims_sweep` lane promotes published balance observations to typed reward claims for the three sources with recorded units                                                                                                                                                                                      | CORE `0033`                                                                                                                                                         | Set `"false"`. The lane and its log line disappear                                                                                                               |
| `REPORTS_ENABLED`                    | processor | `"false"`               | The report stage joins the stage list and report artifacts are written                                                                                                                                                                                                                                                       | CORE `0034`                                                                                                                                                         | Set `"false"`. Existing artifacts stay readable — a stored report keeps its fixed body                                                                           |
| `COMMANDS_ENABLED`                   | app       | `""`                    | The command paths stop answering `403 commands_disabled`; `/api/meta` advertises `commands`. Display capability, not an authorization decision                                                                                                                                                                               | CORE `0031` (needs `0029` applied)                                                                                                                                  | Unset. The command paths close immediately; receipts and outbox rows are additive and are never deleted                                                          |
| `AGENT_API_GRANTS`                   | app       | `""`                    | A JSON **object**, principal → grant: what the agent API lets that principal read, and whether it may propose. The grant table is the feature flag                                                                                                                                                                           | none                                                                                                                                                                | Set `""` and redeploy. There is no per-route switch                                                                                                              |
| `OPERATOR_SUBJECTS`                  | app       | `""`                    | A JSON **array** of verified subjects the change lifecycle treats as the human operator: the only subjects that may approve, commit and request an operation. Empty means nobody; the committed configuration names an operator. Empty configuration refuses every command and operations request with `subject_not_granted` | none                                                                                                                                                                | Set `""`. The command and operations paths stay open and refuse everyone; nothing already accepted is undone                                                     |
| `AGENT_GRANTS`                       | app       | `""`                    | A JSON **array** of subjects the change lifecycle treats as agents: they may plan and simulate, never approve or commit                                                                                                                                                                                                      | none                                                                                                                                                                | Set `""`. **Do not** put the object shape here, and never list a subject in both arrays: either makes the deployment `grants_misconfigured` and refuses everyone |
| `OPS_API_ENABLED`                    | app       | `""`                    | The six `/api/ops/v1/*` routes are served (no `/mcp` caller is offered or accepted for them, ADR 0047); `/api/meta` reports `opsApi`                                                                                                                                                                                         | CORE `0040`                                                                                                                                                         | Set `""` (no code deploy needed). Accepted operations stay in `ops_requests` and are inert while nothing dispatches them                                         |
| `SESSION_REFRESH_POLICY`             | app       | `""`                    | Names the sources whose session a collector may refresh unattended. Absent means a person does it — which is the safe default and the plan's rule                                                                                                                                                                            | none; set it per source only after unattended renewal has been demonstrated                                                                                         | Set `""`. Refreshes go back to `waiting_for_human`                                                                                                               |
| `SHARED_R2_INGEST_ENABLED`           | processor | `"false"`               | The `kogane-collection-terminals` Queue consumer **and** the alarm-driven `collection_scan` lane. Off is not a completed scan: nothing is recorded and the cursor does not move                                                                                                                                              | Queues `kogane-collection-terminals` + `kogane-collection-terminals-dlq`; the R2 event-notification rule; `infra/bootstrap/ingest-clients.sql` applied; CORE `0039` | Set `"false"`. Terminals stay in R2, `collection_runs` rows stay, and re-enabling continues from the cursor                                                      |
| `OPS_DISPATCH_ENABLED`               | processor | `"false"`               | The `operation_dispatch` lane: accepted operations are dispatched instead of sitting inert                                                                                                                                                                                                                                   | CORE `0040`; `OPS_API_ENABLED` on the app, or nothing is ever accepted                                                                                              | Set `"false"`. Accepted operations stay accepted and undispatched                                                                                                |
| `OPS_COLLECTOR_DISPATCH_CONNECTIONS` | processor | `""`                    | A JSON **array** of connection ids (alarm job ids) whose collector the `operation_dispatch` lane may call for an accepted collection or unattended session refresh ([ADR 0048](adr/0048-operation-collector-dispatch.md)). Empty or malformed means none: such requests wait and expire after 24 hours                       | CORE `0068`; collectors serving `runOperation`; `OPS_DISPATCH_ENABLED` on                                                                                           | Remove the id. A started request is not interrupted and nothing started is retried                                                                               |
| `COLLECTION_DATA_BUCKET`             | processor | `"kogane-raw-evidence"` | Not a switch: the bucket the Processor will accept a notification for. A notification naming another bucket is refused                                                                                                                                                                                                       | the shared DATA bucket                                                                                                                                              | n/a — changing it is a resource change, not a rollout step                                                                                                       |
| `COLLECTION_ACCOUNT_ID`              | processor | `"59ea63cc…"`           | Same: a notification from another account is refused                                                                                                                                                                                                                                                                         | none                                                                                                                                                                | n/a                                                                                                                                                              |
| `COLLECTION_INGEST_CLIENT`           | processor | `"processor-shared-r2"` | The ingest client the Processor registers as. Until its CORE rows exist, registration answers `retryable` with `inactive_ingest_client` and records it as a stage rather than blocking the run                                                                                                                               | `infra/bootstrap/ingest-clients.sql` applied                                                                                                                        | n/a                                                                                                                                                              |
| `REWARD_READ_PROJECTION_ENABLED`     | processor | `"false"`               | The `reward_read_projection` lane builds the second-stage READ projection over a fixed evaluation time, and the reward routes answer from it. A stored simulation that carries only a digest reads `not_reproducible`; CORE claims, rules and offers are never moved (04 §2)                                                 | CORE `0041`, READ `0002`; `REWARD_CLAIMS_ENABLED` on, or there is nothing to project                                                                                | Set `"false"` on Processor to pause new reward snapshots; App continues to require READ                                                                          |

`EVENTS_V2_ENABLED` and `REWARDS_V2_ENABLED` are not read, so they are not
suspension controls. Event routes are served when `economic_event_revisions`
is present (`present === 1`); otherwise they 404 and `/api/meta` reports
`eventsV2: false`. Card-purchase routes are served when the CORE 0047 table
and two views are present (`present === 3`). Card-settlement routes are served
when `card_settlement_reviews` and `card_settlement_readiness` are both present
(`present === 2`). Reward routes are served and
`/api/meta` reports `rewardsV2: true`; expiry and simulations stay `503` when
no reward snapshot can be served. `balancesV2` is advertised only when a
sealed snapshot can be served.

Two variables in `services/app/wrangler.jsonc` look like flags and are not:
`EVIDENCE_SOURCE_ID`, `ACCESS_ISSUER` and `ACCESS_AUDIENCE` are deployment
identity, not switches, and changing them changes who can read at all.
`ACCESS_MCP_AUDIENCE`, absent from both configuration files, is the same kind
of value for `/mcp` alone: the AUD tag of a dedicated MCP Access application.
Absent, `/mcp` accepts nobody ([ADR 0047](adr/0047-mcp-client-connection.md)).

## 3. Prerequisite resources, and who creates them

None of these is created by merging anything. Four exist or are created once;
the deploy that carries the configuration creates the queues.

| Resource                                                                  | State today                             | Created by                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 `kogane-read` (`320ebe31-a031-48a1-985f-0e6fabbd517a`, APAC)           | exists; migrations through 0002 applied | already created; the READ migrations are applied by the deploy step, never by hand                                                                                                                                                       |
| READ migrations (`packages/storage-d1/migrations/read`)                   | applied through 0002                    | `wrangler d1 migrations apply kogane-read --remote --config services/processor/wrangler.read-migrations.jsonc`                                                                                                                           |
| Queue `kogane-collection-terminals` and `kogane-collection-terminals-dlq` | exist (verified 2026-09-12)             | the first deploy that carries `services/processor/wrangler.jsonc`, or `wrangler queues create`                                                                                                                                           |
| R2 event-notification rule on `kogane-raw-evidence`                       | exists (verified 2026-09-12)            | object-creation rule, prefix `runs/`, suffix `/terminal.json`, delivering to `kogane-collection-terminals`                                                                                                                               |
| Ingest client, producers and routes                                       | applied; all 13 routes verified active  | `mise run bootstrap:ingest-clients`, then `wrangler d1 execute kogane-raw-evidence --remote --file infra/bootstrap/ingest-clients.sql --config services/processor/wrangler.jsonc`. Idempotent, safe to re-apply, and **not** a migration |

The bootstrap SQL creates no schema and issues no credential: the Processor's
client registers in process. To retire a route, set its `active` to `false`,
re-render and re-apply; the Processor then answers `retryable` with
`inactive_ingest_route` for that source.

## 4. Deployment order

GitHub Actions applies CORE and READ migrations, uploads collectors with their
named scheduling entrypoints, then Processor, App and demo, and performs health
checks. The existing Processor understands the unchanged terminal protocol
during collector uploads. See the [CI/CD deploy ledger](ci-cd.md#deploy-order-g5-14-g5-15).

After health and matching release identities, CD reads deployed empty Cron
arrays through the Cloudflare API and reconciles future alarm reservations.
The initial twenty-minute activation floor covers Cron propagation. A partial
release requires completing/re-running that release, not restoring old Cron
configs. See [schedule verification](schedules.md).

For a new environment, create prerequisite resources and configure grants
before enabling readers. Projection readers require a published READ snapshot.
There is no collector legacy mode or CORE projection fallback.
`SESSION_REFRESH_POLICY` remains a separate per-source decision.

### What deploying a collector does not do

Uploading a collector does not immediately log in, collect, re-authenticate or
backfill. Active Cron arrays are empty and collector constructors do not start
provider work. CD writes no provider secret and calls no provider route.

The complete release postcheck does perform a narrowly authorized scheduling
bootstrap: it arms future alarm reservations, including Processor tick and SBI
VC keepalive. Their later due occurrences run the configured jobs with the
source's credentials. Deployment is therefore distinct from a collection run,
but successful bootstrap does schedule future execution.

## 5. Incident controls and rollback

Remaining feature flags can pause a lane or hide a route. They do not change the
storage backend. A code rollback does not undo migrations or resource deletion;
select a release compatible with the current schema and resource ledger.
Releases requiring retired resources or CORE projections are no longer targets.
The trusted workflow also refuses pre-alarm targets before production mutation.
Removing ScheduleAlarm requires a separate retirement migration; do not use
historical component rollback recipes to restore old Cron triggers.
Repair READ using [the rebuild runbook](read-rebuild-runbook.md).

## 6. One-time GitHub and Cloudflare settings

These settings are maintained in the repository owner's GitHub and Cloudflare accounts.
Until each is done the corresponding automation degrades safely rather than
doing something partial. The authoritative text is
[ci-cd.md](ci-cd.md#required-github-settings); this is the checklist form.

### 6.1 GitHub App for auto-merge

- [ ] Create a GitHub App owned by the owner account (e.g. `kogane-automation`)
      with repository permissions `Contents: Read and write`,
      `Pull requests: Read and write`, `Metadata: Read-only`; no webhook, no
      account or organization permissions.
- [ ] Install it **only** on `risu729/kogane`.
- [ ] Do **not** add it to any ruleset bypass list. The design depends on the
      app being subject to the same rules as a human.
- [ ] Repository **variable** `KOGANE_AUTOMATION_APP_ID` = the App ID.
- [ ] Repository **secret** `KOGANE_AUTOMATION_APP_PRIVATE_KEY` = the whole
      `.pem`, header and footer lines included.

_Not configured:_ `automerge.yml` logs `automation app not configured`, exits 0,
and merging stays manual.

### 6.2 Labels

- [ ] `automerge-approved` — an owner-applied label that makes an external
      pull request eligible for native auto-merge. GitHub enforces required reviews.

### 6.3 Branch ruleset (`main`, id 21174448)

- [ ] Keep `CI Check` required and remove any obsolete `Risk Gate` entry.
- [ ] Turn on "Require branches to be up to date before merging" so CI runs
      on the latest base; automation updates eligible branches one at a time.
- [ ] Keep the automation app out of bypass lists. Preserve squash merging,
      signed commits, linear history, auto-merge and branch updates.

These settings preserve CI enforcement. There is no owner-review prerequisite
and no replacement approval requirement.

### 6.4 CodeQL triage of the rename artifact

- [ ] Dismiss or triage the CodeQL alert `js/insufficient-password-hash` that
      the collector promotion (U04B, `poc/vpass-json` →
      `services/collector-vpass`) raises at
      `services/collector-vpass/src/mobile-auth.ts:36`. Until that promotion
      lands the same line is `poc/vpass-json/src/mobile-auth.ts:36` — the
      `sha256Hex` helper the public-key pin uses.

It is an artifact of a **byte-identical** file move: the same code sat at
`poc/vpass-json/src/mobile-auth.ts` and was scanned there before. The move
introduces no new code, and the alert is a high-severity finding that the main
ruleset blocks on, so it stops the collector promotion from merging until a
human triages it. Triage means one of two things and both are fine: dismiss it
as a known accepted finding with a reason, or treat it as a real finding and
open its own change — but it is not a reason to alter the moved file inside a
rename, because that would make the move unreviewable.

### 6.5 Cloudflare deployment

- [ ] Environment **`production`** (Settings → Environments → New environment).
      Deployment branch rules may be left open: the workflow already refuses a
      commit that is not on the default branch. Required reviewers are optional.
- [ ] Environment **secret** `CLOUDFLARE_API_TOKEN`, with Editor on the 16
      individual deployed Workers, plus account `D1: Edit`, `Queues: Edit`,
      `Containers: Edit` and `Connectivity Directory: Admin`. D1 applies CORE/READ
      migrations; Queues updates the existing Processor consumer; Containers
      publishes GlobalPass/SBI Shinsei/St.George images and applications; direct
      Tunnel VPC bindings require Connectivity Directory Admin. Existing
      Worker-bound R2/D1 resources need no extra storage role
      ([binding authorization](https://developers.cloudflare.com/workers/authorization/#bindings)).
      Account Settings Read and R2 Storage Read were removed on 2026-10-05;
      verify through a full changed-commit release, since an already-recorded
      commit can end as "nothing to do". No Previews, KV, Tail or zone permission.
- [ ] Environment (or repository) **variable** `CLOUDFLARE_ACCOUNT_ID` — the
      account id already recorded in `infra/resources.json`.

Bank credentials stay per source and are never placed in GitHub. The deploy
Action's `secrets-json` input is unused and a test fails if it appears (G5-17).
What this does **not** remove: whoever can deploy a collector can deploy code
that reads that collector's secrets at runtime (plan 12 §5). CI and the existing
branch rules also apply to these changes.

_Not configured:_ merging keeps working and only the deployment fails, at its
credential preflight — after the build, before the deployment record, the
migrations and every upload. Both callers of the release workflow pass
`secrets: inherit`, which is what makes an environment secret reachable from a
called workflow at all; without it the values are empty strings and the release
fails at that same step.

### 6.6 Access service token for the release postcheck

The App authenticates every request through Cloudflare Access and the Processor
is published on no hostname, so the release checks them through the App's
authenticated health route
([ci-cd.md § Postcheck](ci-cd.md#postcheck)). That needs a non-human caller:

- [ ] Zero Trust → Access → **Service auth** → create a service token, e.g.
      `kogane-release-postcheck`. The Client Secret is shown once.
- [ ] Add a policy to the **`kogane-evidence-browser`** Access application:
      action **Service Auth**, include **Service Token → that token**. Leave
      the existing `default` Allow policy as it is. A Service Auth policy does
      not go through the identity or WARP rules, so it must name that one token.
- [ ] Environment **secrets** `CF_ACCESS_CLIENT_ID` and
      `CF_ACCESS_CLIENT_SECRET` in `production`.
- [ ] Put the token's Client ID — the value Cloudflare puts in the JWT's
      `common_name` claim — into `HEALTH_PROBE_TOKENS` in
      `services/app/wrangler.jsonc` as a one-element JSON array, and deploy.
      Access decides who reaches the Worker; the Worker decides who may read
      the health route, and an empty list means nobody.

_Not configured:_ the release fails at the authenticated postcheck, **after**
the uploads, with a message naming these secrets. Nothing is rolled back
automatically; re-running the release after adding them is safe (the uploads
are idempotent and the migrations are already applied). The token can read the
health route. If separately listed in `DEPLOYMENT_SCHEDULE_TOKENS`, it may also
reconcile future reservations through the bodyless schedule bootstrap; that
allowlist does not permit settings edits, commands, operation requests or
evidence reads.

### 6.7 Release verification

Dispatch the current main commit through Deploy and check the per-Worker release
record, migration list and postchecks, including alarm reservations and deployed
Cron readback. The deploy ledger currently contains sixteen deployed Workers
(fourteen collectors, Processor and App). The credentials and service token are configured in production; do not
recreate them as part of routine deployment.

## 7. Verification boundary

Historical retirement evidence is recorded in
[legacy-retirement.md](legacy-retirement.md). Each current release records its
manifest, per-target migration/deployment receipts, health postchecks and alarm
readback in the Deploy run. A successful deploy verifies the
health contracts, not every provider's next scheduled collection or a
production READ-loss exercise.
