# Rollout: every flag the programme added, and the settings it needs once

Unified plan **U15**; decision **D13** (flags stay off by default — merged is
not enabled); chapters 11 §4 and §7, 12 §1–§2, 13, 15.

Sixteen work items each added their own flags, prerequisites and rollback
paragraph to their own document. This page is the single table those paragraphs
add up to, plus the one-time GitHub and Cloudflare settings the repository
owner has to create by hand.

Nothing on this page has been enabled. Every flag below is off in the
configuration that is committed, and every deploy this repository has ever run
has run with it off.

## 1. How a flag is read

Each Worker reads its flags from the `vars` of its Wrangler configuration, or
from the deployment's own variables where the owner set them by hand. Two
conventions, both deliberate:

- **Boolean flags are on only for `"1"` or `"true"`.** An absent, empty or
  misspelled value leaves the old behaviour, so a typo never half-enables
  something.
- **Grant and policy variables are off when empty.** `AGENT_GRANTS`,
  `AGENT_API_GRANTS` and `SESSION_REFRESH_POLICY` carry structured values; the
  empty string is "nobody", and an unparsable value is refused rather than
  widened.

A flag change is a `vars` edit plus a redeploy, or a deployment-level variable
change with no deploy at all. Neither needs a migration, and none of the flags
below is read by a migration.

## 2. The flags

`owner` is the Worker whose configuration carries the variable:
**app** = `kogane-evidence-browser` (`services/app/wrangler.jsonc`),
**processor** = `kogane-observation-pipeline`
(`services/processor/wrangler.jsonc`), **collector** = one per-source Worker.

| Flag / var                       | Owner                 | Default                 | What turning it on changes                                                                                                                                                                                                                                                   | Prerequisite resources                                                                                                                                              | Rollback                                                                                                                                                      |
| -------------------------------- | --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASE_CANDIDATES_ENABLED`     | processor             | `"false"`               | The candidate parse lane writes `parse_run_candidates` and the release command routes are routed. Published results are unaffected.                                                                                                                                          | CORE `0028`, `0029`, `0036`; `GET /publication/consistency` reports `mismatches: 0`                                                                                 | Set `"false"`. New candidates stop; the ones already written stay. **Once it has ever been on, the minimum rollback build is the release that introduced it** |
| `BALANCE_PROJECTION_ENABLED`     | processor **and** app | `"0"`                   | Processor: the balance projection is built. App: the v2 balance routes serve it. Both halves are needed for a reader to see anything.                                                                                                                                        | CORE `0030` (and `0038` for the pointer)                                                                                                                            | Set `"0"` on the app first, then the processor. The tables stay                                                                                               |
| `READ_PROJECTION_ENABLED`        | processor **and** app | `"false"`               | Processor: the same build writes the `READ` database instead of the CORE tables of `0030`, and completes the CORE job only after READ publishes. App: the v2 routes read `READ`, and a cursor from the other store is refused with `410`, not reinterpreted                  | D1 `kogane-read` (`320ebe31-…`) bound as `READ`, with `packages/storage-d1/migrations/read` applied                                                                 | Set `"false"` on the app, then the processor. CORE `0030` is still maintained by the same job, so the previous answers come back; READ cursors expire         |
| `RECONCILIATION_ENABLED`         | processor             | `"0"`                   | The scheduled `reconciliation_sweep` lane runs and writes **candidates**. A candidate is never an accepted link: acceptance stays a recorded decision (INV07)                                                                                                                | CORE `0032`                                                                                                                                                         | Set `"0"`. The lane is skipped; the candidates stay                                                                                                           |
| `REWARD_CLAIMS_ENABLED`          | processor             | `"false"`               | The `reward_claims_sweep` lane promotes published balance observations to typed reward claims for the three sources with recorded units                                                                                                                                      | CORE `0033`                                                                                                                                                         | Set `"false"`. The lane and its log line disappear                                                                                                            |
| `REPORTS_ENABLED`                | processor             | `"false"`               | The report stage joins the stage list and report artifacts are written                                                                                                                                                                                                       | CORE `0034`                                                                                                                                                         | Set `"false"`. Existing artifacts stay readable — a stored report keeps its fixed body                                                                        |
| `EVENTS_V2_ENABLED`              | app                   | `"0"`                   | `/api/v2/*` event routes are served **if** `economic_event_revisions` exists; `/api/meta` advertises `eventsV2`                                                                                                                                                              | CORE `0032`, plus `RECONCILIATION_ENABLED` for there to be anything to read                                                                                         | Set `"0"`. The routes 404 again and `/api/meta` stops advertising                                                                                             |
| `REWARDS_V2_ENABLED`             | app                   | `"false"`               | `/api/v2/rewards/*` is served and `/api/meta` advertises `rewardsV2`. Off means 404, not 400                                                                                                                                                                                 | CORE `0033`, plus `REWARD_CLAIMS_ENABLED` for there to be claims                                                                                                    | Set `"false"`. The nav entry and the routes disappear together                                                                                                |
| `COMMANDS_ENABLED`               | app                   | `""`                    | The command paths stop answering `403 commands_disabled`; `/api/meta` advertises `commands`. Display capability, not an authorization decision                                                                                                                               | CORE `0031` (needs `0029` applied)                                                                                                                                  | Unset. The command paths close immediately; receipts and outbox rows are additive and are never deleted                                                       |
| `AGENT_API_GRANTS`               | app                   | `""`                    | A JSON **object**, principal → grant: what the agent API lets that principal read, and whether it may propose. The grant table is the feature flag                                                                                                                           | none                                                                                                                                                                | Set `""` and redeploy. There is no per-route switch                                                                                                           |
| `AGENT_GRANTS`                   | app                   | `""`                    | A JSON **array** of subjects the change lifecycle treats as agents: they may plan and simulate, never approve or commit                                                                                                                                                      | none                                                                                                                                                                | Set `""`. **Do not** put the object shape here: `agentSubjects` would return nothing and every agent would be graded a human operator                         |
| `OPS_API_ENABLED`                | app                   | `""`                    | The six `/api/ops/v1/*` routes are served and the six MCP tools are published; `/api/meta` reports `opsApi`                                                                                                                                                                  | CORE `0040`                                                                                                                                                         | Set `""` (no code deploy needed). Accepted operations stay in `ops_requests` and are inert while nothing dispatches them                                      |
| `SESSION_REFRESH_POLICY`         | app                   | `""`                    | Names the sources whose session a collector may refresh unattended. Absent means a person does it — which is the safe default and the plan's rule                                                                                                                            | none; set it per source only after unattended renewal has been demonstrated                                                                                         | Set `""`. Refreshes go back to `waiting_for_human`                                                                                                            |
| `SHARED_R2_INGEST_ENABLED`       | processor             | `"false"`               | The `kogane-collection-terminals` Queue consumer **and** the `collection_scan` cron lane. Off is not a completed scan: nothing is recorded and the cursor does not move                                                                                                      | Queues `kogane-collection-terminals` + `kogane-collection-terminals-dlq`; the R2 event-notification rule; `infra/bootstrap/ingest-clients.sql` applied; CORE `0039` | Set `"false"`. Terminals stay in R2, `collection_runs` rows stay, and re-enabling continues from the cursor                                                   |
| `OPS_DISPATCH_ENABLED`           | processor             | `"false"`               | The `operation_dispatch` lane: accepted operations are dispatched instead of sitting inert                                                                                                                                                                                   | CORE `0040`; `OPS_API_ENABLED` on the app, or nothing is ever accepted                                                                                              | Set `"false"`. Accepted operations stay accepted and undispatched                                                                                             |
| `COLLECTION_DATA_BUCKET`         | processor             | `"kogane-raw-evidence"` | Not a switch: the bucket the Processor will accept a notification for. A notification naming another bucket is refused                                                                                                                                                       | the shared DATA bucket                                                                                                                                              | n/a — changing it is a resource change, not a rollout step                                                                                                    |
| `COLLECTION_ACCOUNT_ID`          | processor             | `"59ea63cc…"`           | Same: a notification from another account is refused                                                                                                                                                                                                                         | none                                                                                                                                                                | n/a                                                                                                                                                           |
| `COLLECTION_INGEST_CLIENT`       | processor             | `"processor-shared-r2"` | The ingest client the Processor registers as. Until its CORE rows exist, registration answers `retryable` with `inactive_ingest_client` and records it as a stage rather than blocking the run                                                                               | `infra/bootstrap/ingest-clients.sql` applied                                                                                                                        | n/a                                                                                                                                                           |
| `COLLECTION_TARGET` (per source) | collector             | `"legacy"`              | `"shared"` makes the collector write the central bucket through `packages/collection` and stop uploading to the legacy ingest API. `"legacy"` is byte-for-byte what it does today (decision D12)                                                                             | the queue and the notification rule above; the source's route in `config/ingest-clients.json` active                                                                | Set back to `"legacy"` for that one source. Runs already written to the shared bucket stay                                                                    |
| `REWARD_READ_PROJECTION_ENABLED` | processor **and** app | `"false"`               | The `reward_read_projection` lane builds the second-stage READ projection over a fixed evaluation time, and the reward routes answer from it. A stored simulation that carries only a digest reads `not_reproducible`; CORE claims, rules and offers are never moved (04 §2) | CORE `0041`, READ `0002`; `REWARD_CLAIMS_ENABLED` on, or there is nothing to project                                                                                | Set `"false"` on the app, then the processor. The routes go back to per-request calculation; the READ reward tables are rebuildable and may be dropped        |

`COLLECTION_TARGET` arrives with **U09**, one entry per collector; it is in this
table because the table is the whole programme's list, not one branch's. Every
other row is in the configuration on `main` today.

Two variables in `services/app/wrangler.jsonc` look like flags and are not:
`EVIDENCE_SOURCE_ID`, `ACCESS_ISSUER` and `ACCESS_AUDIENCE` are deployment
identity, not switches, and changing them changes who can read at all.

## 3. Prerequisite resources, and who creates them

None of these is created by merging anything. Four exist or are created once;
the deploy that carries the configuration creates the queues.

| Resource                                                                  | State today                                           | Created by                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 `kogane-read` (`320ebe31-a031-48a1-985f-0e6fabbd517a`, APAC)           | exists, **empty**; no migration applied               | already created; the READ migrations are applied by the deploy step, never by hand                                                                                                                                                       |
| READ migrations (`packages/storage-d1/migrations/read`)                   | not applied                                           | `wrangler d1 migrations apply kogane-read --remote --config services/processor/wrangler.read-migrations.jsonc`                                                                                                                           |
| Queue `kogane-collection-terminals` and `kogane-collection-terminals-dlq` | **do not exist**                                      | the first deploy that carries `services/processor/wrangler.jsonc`, or `wrangler queues create`                                                                                                                                           |
| R2 event-notification rule on `kogane-raw-evidence`                       | does not exist                                        | object-creation rule, prefix `runs/`, suffix `/terminal.json`, delivering to `kogane-collection-terminals`                                                                                                                               |
| Ingest client, producers and routes                                       | declared in `config/ingest-clients.json`, not applied | `mise run bootstrap:ingest-clients`, then `wrangler d1 execute kogane-raw-evidence --remote --file infra/bootstrap/ingest-clients.sql --config services/processor/wrangler.jsonc`. Idempotent, safe to re-apply, and **not** a migration |

The bootstrap SQL creates no schema and issues no credential: the Processor's
client registers in process and cannot authenticate to the legacy ingest
Worker, which is intended. To retire a route, set its `active` to `false`,
re-render and re-apply; the Processor then answers `retryable` with
`inactive_ingest_route` for that source.

## 4. Order of enablement

The rule under every row is the same one: **schema, then writer, then reader,
then the flag** — and a producer is never switched on before its consumer
exists.

1. **Migrations.** CD applies CORE and then READ. Every migration this
   programme added is additive and inert: a Worker that predates it never reads
   what it adds, which is what makes step 2 safe in either order.
2. **Deploy every Worker with the flags off.** This is where the queues are
   created. Nothing changes for any reader.
3. **Create the account-side resources of §3** that the deploy did not: the
   notification rule and the ingest-client rows.
4. **Processor flags, one at a time**, each left alone long enough to read its
   log line before the next:
   `SHARED_R2_INGEST_ENABLED` (with no collector switched yet, the scan lists
   nothing and the consumer receives nothing — that is the safe way to prove
   the lane runs) → `BALANCE_PROJECTION_ENABLED` → `READ_PROJECTION_ENABLED`
   → `RELEASE_CANDIDATES_ENABLED` → `RECONCILIATION_ENABLED` →
   `REWARD_CLAIMS_ENABLED` → `REPORTS_ENABLED`.
   `REWARD_READ_PROJECTION_ENABLED` comes after `REWARD_CLAIMS_ENABLED` and
   `READ_PROJECTION_ENABLED`, never before either.
5. **App read flags**, each only once its writer has produced something:
   `BALANCE_PROJECTION_ENABLED`, then `READ_PROJECTION_ENABLED` once a snapshot
   is published, then `EVENTS_V2_ENABLED`, `REWARDS_V2_ENABLED`, then
   `REWARD_READ_PROJECTION_ENABLED` once a reward snapshot is published.
6. **App write flags**, which are the ones a person can act through:
   `COMMANDS_ENABLED`, `OPS_API_ENABLED`, then the grants (`AGENT_GRANTS`,
   `AGENT_API_GRANTS`) for the principals that need them. `OPS_DISPATCH_ENABLED`
   on the processor comes after `OPS_API_ENABLED`, not before: dispatching
   nothing is pointless and dispatching before the API exists is impossible.
7. **Collectors, one source at a time** (`COLLECTION_TARGET=shared`), each
   verified against `collection_runs` before the next. This is the step that
   eventually makes the legacy path retirable — see
   [legacy-retirement.md](legacy-retirement.md).
8. **`SESSION_REFRESH_POLICY`** last, and only for a source whose unattended
   renewal has actually been demonstrated. Never as a convenience.

## 5. Rollback

Per flag, the table in §2. Three things hold across all of them:

- **Turning a flag off is always the first step of an incident response**, and
  it is always safe: no flag's "off" path reads or requires anything the "on"
  path wrote.
- **No migration is rolled back.** They are additive, and rolling one back
  would drop the record of what the enabled path already did.
- **A code rollback does not undo an applied migration, a recovery drill or a
  deletion** (plan 11 §7, [operations.md §5](operations.md#5-releases-and-rollback)).
  Once something on [legacy-retirement.md](legacy-retirement.md) is executed,
  the release that preceded it stops being a rollback target for that resource.

The per-case table for the other failure modes — a bad App/Processor build, a
bad collector, a wrong READ calculation, a total READ loss, a CORE data problem,
a credential update — is
[ci-cd.md § Rollback](ci-cd.md#rollback-plan-11-7).

## 6. One-time GitHub and Cloudflare settings

The integrator cannot create any of these; the repository owner must, once.
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

- [ ] `automerge-approved` — an owner-applied label that, together with an owner
      approval of the current head, makes an external pull request eligible.
- [ ] `high-risk` — raises the Risk Gate without a high-risk path. Renovate
      applies it to parser, money and authentication dependencies.

### 6.3 Branch ruleset (`main`, id 21174448)

- [ ] Add **`Risk Gate`** to the required status checks next to `CI Check`,
      with GitHub Actions as the integration.
- [ ] Turn **on** "Require branches to be up to date before merging". This is
      what makes G5-02 hold — CI re-runs on the latest base before a merge —
      and `automerge.yml` does the resulting branch updates one pull request at
      a time, so merges stay serialized.
- [ ] Leave as they are: allow auto-merge, squash merging only, automatically
      delete head branches, allow branch updates, signed commits, linear
      history.

_Not configured:_ `Risk Gate` still runs and still reports on every pull
request; it simply does not block. Strict-up-to-date still off means a pull
request whose CI passed on an older base can merge without re-running.

### 6.4 CodeQL triage of the rename artifact

- [ ] Dismiss or triage the CodeQL alert
      `js/insufficient-password-hash` at
      `services/collector-vpass/src/mobile-auth.ts:36`.

It is an artifact of a **byte-identical** file move: the same code sat at
`poc/vpass-json/src/mobile-auth.ts` and was scanned there before. The move
introduced no new code, and the alert is a high-severity finding that the main
ruleset blocks on, so it stops the collector promotion from merging until a
human triages it. Triage means one of two things and both are fine: dismiss it
as a known accepted finding with a reason, or treat it as a real finding and
open its own change — but it is not a reason to alter the moved file inside a
rename, because that would make the move unreviewable.

### 6.5 Cloudflare deployment

- [ ] Environment **`production`** (Settings → Environments → New environment).
      Deployment branch rules may be left open: the workflow already refuses a
      commit that is not on the default branch. Required reviewers are optional.
- [ ] Environment **secret** `CLOUDFLARE_API_TOKEN`, scoped to the account that
      holds the Workers, with `Workers Scripts: Edit`, `D1: Edit` and
      `Account Settings: Read`. Add `Queues: Edit` or
      `Workers R2 Storage: Edit` **only** when a deployment must create one;
      binding to an existing resource does not need them. No Workers KV, no
      Tail, no zone permissions.
- [ ] Environment (or repository) **variable** `CLOUDFLARE_ACCOUNT_ID` — the
      account id already recorded in `infra/resources.json`.

Bank credentials stay per source and are never placed in GitHub. The deploy
Action's `secrets-json` input is unused and a test fails if it appears (G5-17).
What this does **not** remove: whoever can deploy a collector can deploy code
that reads that collector's secrets at runtime (plan 12 §5), which is why
collector paths are in the Risk Gate ledger.

_Not configured:_ merging keeps working and only the deployment fails, at its
first upload rather than halfway.

### 6.6 First supervised run

The step-by-step first deployment — dispatch `only: ingest`, check the release
record, re-dispatch to prove the interlock, dispatch an older sha to prove the
"newer release already recorded" refusal, then a rollback and back — is
[ci-cd.md § Enabling it the first time](ci-cd.md#enabling-it-the-first-time-under-supervision).
Do it before letting the automatic `CI` → `Deploy` chain run.

## 7. What this page is not

It is not a claim that anything was rolled out. No flag has been turned on, no
resource in §3 has been created except the empty `kogane-read` database, no
setting in §6 has been made by this repository's automation, and no command on
this page has been run against the account. Everything here was verified only
in the sense that the defaults, the prerequisites and the rollback statements
match the configuration and the tests that are committed.
