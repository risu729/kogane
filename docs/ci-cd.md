# CI/CD automation

How a change reaches `main` without anyone pressing the merge button, how it
reaches Cloudflare afterwards, and what stops it when it should.
[Continuous integration](ci.md) covers the checks themselves; this document
covers the automation around them and the deployment that follows.

## Auto-merge and risk gate

Two workflows implement it:

| Workflow                          | Trigger                                                        | Token                         | What it does                                                              |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `.github/workflows/automerge.yml` | `pull_request_target`, `pull_request_review`, `push` to `main` | GitHub App installation token | Registers native auto-merge (squash) and updates a branch that is behind. |
| `.github/workflows/risk-gate.yml` | `pull_request`, `pull_request_review`                          | `GITHUB_TOKEN` (read-only)    | Publishes the `Risk Gate` status check for high-risk changes.             |

Neither workflow checks out or executes pull request code. `automerge.yml`
checks out the repository default branch, `risk-gate.yml` checks out the base
commit of the pull request, and both then run a reviewed script from
`.github/scripts/`. Pull request titles, bodies, branch names and labels reach
those scripts only as environment values; nothing from a pull request is ever
interpolated into a `run:` block (acceptance G5-08). Both jobs install `node`
through mise from the lockfile checksums of that trusted checkout with the
tool cache off: `risk-gate.yml` shares its cache scope with the pull request's
own CI run, which executes pull request tests, so a restored archive is not a
trusted source of the interpreter that decides the gate.

Auto-merge never overrides a check. It registers GitHub's own auto-merge, so
the branch ruleset — `CI Check`, code scanning, signed commits, linear history,
squash only — stays in charge. The automation app is not a bypass actor, so a
failed, cancelled or unexpectedly skipped required job blocks the merge exactly
as it blocks a human (G5-01, G5-03).

### Who may auto-merge

`automerge.yml` re-reads the pull request from the API (the event payload can
be stale) and enables auto-merge when all of the following hold:

- the author is the repository owner, or `renovate[bot]` with account type
  `Bot`; **or** the pull request carries the `automerge-approved` label whose
  last `labeled` event was made by the repository owner **and** the review
  list holds an `APPROVED` review by the owner whose `commit_id` is the
  current head. The label alone is not enough: it would carry over to whatever
  the author pushes next, so the permission is bound to the reviewed commit
  exactly as the Risk Gate is (G5-05, plan 10 §6);
- the pull request is open, not merged and not a draft;
- `mergeable_state` is not `dirty` (G5-04).

`blocked`, `unstable` and `unknown` are deliberately not treated as failures:
those are the ruleset's decision, and native auto-merge waits for it.

When the permission goes away — the label is removed, the approval is
dismissed or superseded, or the author pushes after the approval — the script
disables native auto-merge again, but only when the automation app is the one
that enabled it (`auto_merge.enabled_by`). An auto-merge the owner enabled by
hand is the owner's decision and is left alone. To let an external pull
request in: review and approve its current head, then add the label (either
order; both events re-run the handler).

Every event log and review list is read to the end; a list longer than the
pagination limit is an error, never a prefix, because the entries that decide
are the latest ones.

### Keeping merges on the latest base (G5-02)

The ruleset's **"Require branches to be up to date before merging" must be
on**. With it, a pull request whose CI passed on an older base reports
`mergeable_state: behind` and GitHub refuses to merge it until it is updated,
so CI always runs on the base the merge commit will actually have.

The update is the automation's job, in two places:

- when a pull request event shows `behind`, the handler updates that pull
  request right away;
- after every push to `main` (a merge is one), the handler lists the open pull
  requests in creation order and updates the **oldest** one that is armed,
  eligible and behind. Only one is updated per push: updating them all would
  run CI on every one and only the first to finish could merge. The merge of
  that one is the next push, which brings the next one forward — a
  one-at-a-time merge queue without the organization feature (plan 10 §4).

Both call `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with
`expected_head_sha`, so a branch that moved meanwhile is never updated blindly.
The update is made with the App installation token on purpose: an update pushed
with `GITHUB_TOKEN` would not start a new workflow run, and the pull request
would wait forever for a CI result that never arrives (G5-02, G5-06). For the
same reason the eventual merge commit, pushed by the App, does start the CD
chain on `main` (G5-07). A pull request from a fork cannot be updated by the
app (it is not installed on the fork; the API answers 403) and waits for its
author to update it.

An update creates a new head commit. For a label-approved external pull
request or a high-risk one that means the owner's approval no longer matches
the head and must be given again on the new commit; that is intended
(plan 10 §4: a pull request whose head changed while awaiting confirmation
stops), and it costs one extra review only when `main` moved in between.

### What the Risk Gate requires

`infra/risk-paths.json` is the ledger of high-risk changes. It lists path
patterns per rule:

| Rule                          | Covers                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core-schema`                 | CORE and READ migrations (`packages/storage-d1/migrations/**`; the pre-U05 ingest path was dropped in U15)                                                    |
| `authorization`               | `services/app/src/auth.ts` and any `packages/*/src/auth.ts`, the ingest-client declaration and its rendered bootstrap SQL                                     |
| `secret-consuming-collectors` | collector code, `package.json` and `bun.lock` of workers that run with a source's bank credentials (plan 12 §5: the dependency closure deploys with the code) |
| `automation`                  | `.github/workflows/**`, `.github/scripts/**`, `.github/actions/**`                                                                                            |
| `deployment-config`           | `wrangler*.jsonc`, `wrangler*.toml`, `infra/**`                                                                                                               |

Two things about the `secret-consuming-collectors` patterns are deliberate
and dated. The `poc/*-worker/**` and `poc/sbi-securities/**` entries cover the
collectors where they live today; the collector promotion (U04B,
`poc/<source>-worker` → `services/collector-<source>`) is what makes them
dead, and the item that lands it retires them together with the
`poc/moneyforward-worker/…` rows of `scripts/automerge.test.ts`, the same way
U15 retired the two patterns whose directories had already gone. The `bun.lock`
entries match nothing today — U03 left one lockfile at the root — and stay
because a per-workspace lockfile reappearing under a collector is exactly the
dependency-closure change the rule is about.

and label rules: a pull request labelled `high-risk` is treated as high risk
even when no listed path changed. Renovate applies that label to parser, money
and authentication dependencies (`.github/renovate.json5`), which keeps normal
dependency updates on the automatic path while these few need a look.

A high-risk pull request passes `Risk Gate` only when the review list contains
an `APPROVED` review by the repository owner whose `commit_id` equals the
current head commit. An approval of an earlier head never carries over to a new
one, and a later `CHANGES_REQUESTED` or `DISMISSED` review by the owner on the
same head withdraws it (G5-05). Low-risk pull requests pass with no approval.
If the changed-file list cannot be read completely, the gate fails closed.

The check reports the paths and rules that made it high risk. It never prints
the pull request title or body. The changed-file list comes from the compare
API and, when that list reaches its 300-file cap or has no merge base (forks,
force pushes), from the paginated pull request file list; past that list's own
cap the script throws, so an unreadable list never classifies as low risk.

The workflow also runs on `pull_request_review` (`submitted`, `dismissed`).
For that event `GITHUB_SHA` is the pull request head, so the run reports a
fresh `Risk Gate` result on the head the owner just approved and no manual
re-run is needed. If a review and a push race, the review run fails as stale
and the push's own run decides; **re-run the failed `Risk Gate` job** in that
case. The gate always runs with a read-only token and no access to secrets.

## Required GitHub settings

The integrator cannot change any of these. The repository owner must do them
once; until then, everything degrades safely (see below).

1. **Create a GitHub App** owned by the repository owner account, named for
   example `kogane-automation`:
   - repository permissions: `Contents: Read and write`,
     `Pull requests: Read and write`, `Metadata: Read-only`;
   - no webhook, no account permissions, no organization permissions;
   - install it **only** on `risu729/kogane`;
   - do **not** add it to any ruleset bypass list. The whole design depends on
     the app being subject to the same rules as a human.
2. **Repository variable** `KOGANE_AUTOMATION_APP_ID` = the App ID (the number
   on the App's settings page).
3. **Repository secret** `KOGANE_AUTOMATION_APP_PRIVATE_KEY` = the contents of
   a generated private key `.pem` file, including the header and footer lines.
4. **Labels** (Issues → Labels): `automerge-approved` and `high-risk`.
   Renovate also uses `dependencies`, `workers` and `deployed`; Renovate creates
   labels it needs, so only the two above matter for the gate.
5. **Ruleset** (the `main` ruleset, id 21174448): add `Risk Gate` to the
   required status checks, next to `CI Check`, with GitHub Actions as the
   integration, and turn **on** "Require branches to be up to date before
   merging". The strict setting is what makes G5-02 hold (CI re-runs on the
   latest base before a merge); `automerge.yml` does the resulting branch
   updates one pull request at a time, so merges are serialized by design.
6. **Repository settings** that must stay as they are: allow auto-merge, squash
   merging only, automatically delete head branches, allow branch updates.
7. **The `production` environment, its Cloudflare token and account id** — see
   [Required GitHub and Cloudflare settings](#required-github-and-cloudflare-settings)
   below. Without them merging keeps working and only the deployment fails.

### When it is not configured

- No `KOGANE_AUTOMATION_APP_ID` variable: the first step of `automerge.yml`
  logs `automation app not configured` and the job ends successfully. Nothing
  else in the workflow runs, and no pull request is affected — merging stays
  manual.
- `Risk Gate` not in the ruleset: the check still runs and still reports on
  every pull request, but it does not block merging. Adding it to the ruleset
  is what turns it into a gate.
- A fork pull request: `risk-gate.yml` runs with a read-only token and works
  unchanged. `automerge.yml` runs in the base repository context, so it works
  too — but an external author is only eligible through the
  `automerge-approved` label plus an owner approval of the current head, and
  the app cannot update a fork branch (the author updates it).
- "Require branches to be up to date" still off: nothing breaks, but a pull
  request whose CI passed on an older base merges without re-running CI on
  the latest one, so G5-02 is not enforced until it is turned on.

## Continuous deployment

There is no preview deployment and no staging account (unified plan 11 §1).
What replaces them is everything CI already proves on the same commit — local
`workerd` tests on synthetic data, schema application from the migrations
directory, contract tests and a Wrangler dry run of every configuration — plus
a release job that refuses to upload anything it cannot account for. That is
not the same as "proven against the real Cloudflare account", and this page
never claims it is: the first production release and the first rollback are run
under supervision.

Three workflows implement it:

| Workflow                                | Trigger                                                  | What it does                                                                                   |
| --------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy.yml`          | `workflow_run` of `CI` on `main`, or `workflow_dispatch` | Guards the CI result and calls the release job with `github.event.workflow_run.head_sha`.      |
| `.github/workflows/rollback.yml`        | `workflow_dispatch` (`sha`, `targets`)                   | Calls the same release job in `rollback` mode.                                                 |
| `.github/workflows/_deploy-workers.yml` | `workflow_call`                                          | The single release job: the guards, the migrations, the uploads, the postcheck and the record. |

`deploy.yml` releases only for a CI run whose `conclusion` is `success`, whose
`event` is `push`, whose `head_branch` is `main` and whose `head_repository`
is this repository. The branch name alone would not do: CI also runs on
`pull_request`, and a pull request from a fork whose branch is called `main`
produces a successful CI run with `head_branch: main` — and its head commit
is fetchable from this repository. A `workflow_dispatch` supplies the sha by
hand and is held to the same test through the compare API, below.

Both callers hold the concurrency group `production-deploy` with
`cancel-in-progress: false`, so one production change runs at a time and a
later merge waits instead of interrupting a migration (G5-13). The group is
held by the calling job for the whole of the called workflow, which is also why
`environment: production` is declared inside `_deploy-workers.yml`: a job that
calls a reusable workflow cannot declare an environment itself.

### What the release job does, in order

1. **Refuses a target that is not a commit.** The sha must be 40 hex
   characters; the mode must be `release` or `rollback`.
2. **Confirms the commit is on the default branch** through the compare API
   (`identical` or `behind`), with the runner's own `gh` and `GITHUB_TOKEN`,
   **before anything from that commit is checked out**. A manual dispatch
   cannot put a pull request, branch or fork commit into production, and no
   file of an unconfirmed commit — not `mise.toml`, not a script — is ever
   read or run. An API error fails the step.
3. **Checks out that exact commit** (`persist-credentials: false`,
   `fetch-depth: 0`), then asserts `git rev-parse HEAD` is the requested sha. A
   branch tip is never used: the branch moves between the CI run and this one
   (plan 11 §2).
4. **Installs the pinned `node`** through mise, so the ledger steps never run
   on whatever interpreter the runner image happens to ship, then **reads the
   release ledger** and **decides** (below). An overtaken run stops here,
   successfully, having changed nothing.
5. **Installs the rest of the toolchain**, then `mise run install`,
   `mise run bundle` and `mise run dry-run`. Everything is built and validated
   before any credential exists in the job (G5-09). `mise run dry-run` covers
   every configuration, not only the deployed ones, and three PoC configurations
   build a container image, so the runner needs Docker — the same requirement
   CI's `Worker` jobs already have. The tool cache is off in every step of this
   job: its cache scope is shared with pull request CI, which runs pull request
   code, and `node` decides the guards.
6. **Computes the release manifest**, uploads it as a run artifact, and derives
   the compact release record that becomes the deployment payload.
7. **Compares the schema** with the record of the last successful release.
8. **Refuses an incompatible rollback** (below).
9. **Opens a GitHub deployment** in state `in_progress`.
10. **Applies the CORE migrations** — forward only, and only when this commit
    knows a migration the recorded release did not. Then the READ migrations,
    once a READ database exists.
11. **Re-verifies the release manifest** against the working tree. This is the
    last step before a credential reaches Wrangler.
12. **Uploads the Workers** in the ledger's order, one
    `risu729/wrangler-deploy-action` step each, `mode: production`.
13. **Postchecks** the health routes of what it deployed.
14. **Records** the deployment as `success`, or as `failure` and stops.

### The release ledger, and why a late run is harmless (G5-12)

The ledger is the GitHub Deployments API: the newest deployment of the
`production` environment whose latest status is `success`, with the release
record in its payload. It needs no commit (a push would need a signature and
would not start a workflow) and it does not expire the way a cache does.

Concurrency alone would not be enough. GitHub keeps at most one run _pending_
per group and states that ordering is not guaranteed, so with rapid merges an
intermediate run is cancelled and a run that started earlier can still reach
the deploy steps after a newer one finished. The decision is therefore made
against the ledger, by `git merge-base --is-ancestor`:

| This commit versus the recorded release | Outcome                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| nothing recorded                        | deploy (the first release)                                 |
| a descendant                            | deploy, and move the record forward                        |
| the same commit                         | nothing to do, run succeeds                                |
| an ancestor                             | **nothing to do**, run succeeds — the newer release stands |
| neither (diverged)                      | fail; `main` is linear, so this means something is wrong   |

A run that is cancelled or fails leaves its deployment without a `success`
status, so the next run keeps reading the one before it. The ledger is read
from the newest page of deployments; if that whole page failed and the list
goes on, the read is an error rather than an empty ledger, because an empty
ledger means "deploy anything". Nothing is rolled back automatically, and CORE
is never restored from a backup by a workflow (G5-16).

The record's migration lists say what the database holds once the deployment
is done, not what the commit knows. For a release the two are the same. For a
rollback the record keeps the deployed list: the rollback applied nothing, so
the database still has every migration the recorded release had, and a later
rollback to a commit in between is judged against the list that is actually
applied.

### The release manifest, and what it can and cannot prove (G5-11)

`.github/scripts/release-manifest.mjs` records, for one commit: the digest of
the root `bun.lock`, of every Wrangler configuration in the deploy ledger, of
every CORE (and later READ) migration file in order, of the parser build
identity file, and of every emitted bundle — plus the _names_ of the secrets
each deployed Worker needs. No secret value is ever read (G5-17).

The manifest is computed after the build and re-computed immediately before the
first upload; a difference names the field that moved and stops the deployment.
That is what the pipeline can honestly assert: **nothing changed between the
build that was validated and the upload that was performed**.

It is _not_ an assertion that the live script is byte-identical to the bundle
that was tested. The pinned deploy Action re-bundles in `production` mode and
exposes neither `--outdir` nor `--no-bundle`, and the Workers API returns a
version id, an author and a source for a deployed version — not a content
digest of the uploaded script. Emitting a per-service `dist/<name>/wrangler.json`
with `no_bundle` set and pointing the Action at it is the only route to byte
identity through this Action; it is deliberately not taken yet, because it moves
the deployed configuration into a generated file. Until then the pre-deploy
bundle digest in the manifest is the recorded build identity, and the
`<short>:bundle` mise tasks reproduce it from any checkout of the same commit:
two `mise run bundle` runs from a clean `dist/` produced the same five digests
when this was reviewed. That reproducibility is checked by hand, not by a CI
test, which would double the build; the CI test asserts determinism of the
manifest over one tree.

### Deploy order (G5-14, G5-15)

`infra/deploy-order.json` is the ledger: every Wrangler configuration that CI
validates appears exactly once, with a role, a deploy decision, the Worker name
and a health route. `tasks/_lib/deploy-order.test.ts` keeps it in step with
`infra/workers-ci.json` **and** with the deploy steps of
`_deploy-workers.yml` — same configurations, same order — so the workflow
cannot drift into a second, different order.

Consumers deploy before producers: a reader must understand the contract before
a writer starts using it. Today the deployed set is exactly the consumers:

| Order | Worker                         | Directory                        | Health route |
| ----- | ------------------------------ | -------------------------------- | ------------ |
| 1     | `kogane-observation-pipeline`  | `services/processor`             | none         |
| 2     | `kogane-evidence-browser`      | `services/app`                   | none         |
| 3     | `kogane-demo`                  | `services/app`                   | none         |
| 4     | `kogane-ingest`                | `services/raw-evidence`          | `/health`    |
| 5     | `kogane-collector-r2-importer` | `services/collector-r2-importer` | none         |

The PoC-era collectors are listed with `deploy: false` and keep being deployed
by hand until U09 switches each source to the shared bucket, one source at a
time. The `wrangler dev` helpers, the test harness config and the bootstrap
configs are excluded from CI in `infra/workers-ci.json` and may never be marked
deployable.

The ledger records the Wrangler `name` of each configuration and the test
asserts it still matches the file. A directory rename therefore cannot turn
into a new Worker, Durable Object class, queue, bucket or cron by accident
(G5-15); the resource identities live in `infra/resources.json`.

### Postcheck

The postcheck requests each deployed Worker's health route over its
`workers.dev` hostname and requires 200. Only `kogane-ingest` has an
unauthenticated one: the App and the demo authenticate every request through
Cloudflare Access, and the Processor and the importer are not published on
`workers.dev` at all — for those the ledger records an empty `healthPath` and
the postcheck skips them rather than pretending to check something. A public
health route for the App would be a change to its authorization boundary and is
not made here. The deeper postchecks plan 11 §6 asks for — schema readiness,
contract, job and READ freshness — are not implemented yet; they belong with
the operations API (U06) and the READ projection (U11).

### Rollback (plan 11 §7)

`rollback.yml` re-deploys an earlier commit with `sha` and an optional
`targets` list. It refuses unless the commit is an ancestor of the recorded
release, and unless the commit's CORE migration list is a **prefix** of the
deployed one: migrations are additive and are never reverted, so an older
commit may run against a database that has more migrations applied than it
knows about, but never against one that is missing migrations it needs. The
rollback applies no migration and restores no database.

| Problem                      | What to do                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| App or Processor code defect | `rollback.yml` with the last good, schema-compatible commit.                                                  |
| A collector defect           | Roll that source's Worker and flags back. Runs already stored stay; they are evidence, not state.             |
| READ projection defect       | Point back at the previous complete snapshot, or make it unavailable and rebuild. CORE is not touched.        |
| READ database lost           | Create an empty one, apply the schema, rebind, rebuild. No CORE restore.                                      |
| CORE data defect             | Audit and repair forward. A whole-database restore is a separate incident, not a rollback (operations.md §4). |
| Credential rotation defect   | Keep the previous generation per source and switch after verifying. Never from CD (docs/credentials.md).      |

What a code rollback does **not** undo: applied migrations, objects already
written to R2, decisions and seals already recorded, and any external state a
collector changed. Before relying on a rollback for a release, check that its
cleanup step has not already removed what the older code reads.

### Required GitHub and Cloudflare settings

The integrator cannot create any of these. The repository owner must, once:

1. **Environment** `production` (Settings → Environments → New environment).
   Deployment branch rules may be left open: the workflow already refuses a
   commit that is not on the default branch. Required reviewers are optional;
   with them, an overtaken run waits for an approval before reporting that it
   has nothing to do.
2. **Environment secret** `CLOUDFLARE_API_TOKEN` — a Cloudflare API token
   scoped to the account that holds the Workers, with:
   - `Workers Scripts: Edit` — upload the Workers;
   - `D1: Edit` — apply the migrations;
   - `Account Settings: Read` — Wrangler reads the account.

   Add `Queues: Edit` or `Workers R2 Storage: Edit` **only** if a deployment
   must create a queue or a bucket; binding to ones that already exist does
   not need them. Do not give the token Workers KV, Tail or zone permissions.
   This token is the whole of CD's Cloudflare authority: a Worker's own
   runtime secrets are set out of band and are never written by a workflow.

3. **Environment (or repository) variable** `CLOUDFLARE_ACCOUNT_ID` — the
   account id, already recorded in `infra/resources.json`.

Bank credentials stay where they are, per source, and are never placed in
GitHub. The deploy Action's `secrets-json` input is not used anywhere in this
repository and a test fails if it appears (G5-17). Note what this does _not_
remove: whoever can deploy a collector can deploy code that reads that
collector's secrets at runtime (plan 12 §5), which is why collector paths are
in the Risk Gate ledger.

### Enabling it the first time, under supervision

1. Create the environment, the secret and the variable above. Until the secret
   exists, the deploy job fails at its first upload rather than doing something
   partial — so create them before the next merge, or expect one red run.
2. Run `Deploy` manually (`workflow_dispatch`) with the current `main` sha and
   `only: ingest`. `kogane-ingest` is the one Worker with a health route, so
   this exercises the whole path — ledger, manifest, deployment record,
   migrations, upload, postcheck — with the smallest blast radius.
3. Check the run summary: the recorded release, the migration decision, the
   selected Workers, the health result. Check the Deployments tab shows one
   `production` deployment with the release record as its payload.
4. Re-run the same dispatch. It must report _"is already the recorded release;
   nothing to do"_ and deploy nothing.
5. Dispatch `Deploy` with the previous `main` sha. It must report _"a newer
   release is already recorded"_ and deploy nothing (G5-12).
6. Run `Rollback` with the previous `main` sha and `targets: ingest`, confirm
   the Worker version changed in the Cloudflare dashboard, then run `Deploy`
   with the current sha again.
7. Only then let the automatic path run: merge something small and watch
   `CI` → `Deploy` (G5-07).

### What is verified locally, and what is not

Verified in CI on every commit, with synthetic data only:

- the ledger interlock and the rollback prefix rule, against a real git history
  in a temporary repository (`scripts/release.test.ts`);
- the manifest: determinism over the same tree, `migrations_dir` read from the
  Wrangler configuration, bundle digests that ignore source maps, secret
  **names** only, and a changed input reported by field name;
- the deploy ledger against `infra/workers-ci.json`, the deploy steps against
  the ledger's order, the absence of a preview lane or a second environment,
  and the absence of any collector secret name in an Actions file
  (`tasks/_lib/deploy-order.test.ts`);
- `actionlint`, `ghalint` and `zizmor --pedantic` on every workflow.

Not verifiable without a live deployment, and therefore listed as such: that
the Cloudflare token's scopes are sufficient, that `wrangler d1 migrations
apply --remote` succeeds against the production database, that the uploaded
Worker serves traffic, that the `workers.dev` hostname in the ledger is
reachable, and that the `workflow_run` chain actually starts after a merge.

## Acceptance coverage

`scripts/automerge.test.ts` (run by `mise run ci:root`) unit-tests the
decision functions in `.github/scripts/automerge-policy.mjs` and
`.github/scripts/risk-paths.mjs` against fixtures. The workflow wiring itself
cannot be proven offline and is verified on the first live pull request.

| Acceptance | Covered by                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G5-01      | Tests: pending/blocked states are left to the ruleset. Live: a failing `CI Check` keeps auto-merge waiting.                                                                 |
| G5-02      | Tests: a `behind` branch stays eligible and requests an update; the sweep picks the oldest armed one. Live: strict up-to-date + update starts CI before the merge.          |
| G5-03      | Tests: owner and `renovate[bot]` eligibility. Live: the app merges without a bypass entry.                                                                                  |
| G5-04      | Tests: draft, closed, merged and `dirty` pull requests are refused.                                                                                                         |
| G5-05      | Tests: approval matching on `commit_id`, supersession, non-owner reviews, and the label path bound to the approved head. Live: push after approval re-gates.                |
| G5-06      | Live only: the App token update starts CI, no human approval loop. Not provable offline.                                                                                    |
| G5-07      | Live only: the merge push starts `CI`, whose successful run on `main` starts `Deploy` (push event, this repository, `main`). Proven by the first merge after enabling CD.   |
| G5-08      | Workflows pass pull request strings through `env` only; zizmor, ghalint and actionlint enforce the shape. Tests: pagination fails closed.                                   |
| G5-09      | CI runs the deploy Action in `dry-run` mode with no account or token, and the release job builds and dry-runs before any credential is in scope. Both asserted.             |
| G5-10      | Tests: no workflow declares an environment other than `production`, uses a preview mode or a preview alias. The deploy ledger carries no preview target.                    |
| G5-11      | Tests: a changed lockfile, configuration, migration or bundle is reported by field name. The workflow re-verifies the manifest immediately before the first upload.         |
| G5-12      | Tests: an older or already-recorded commit stops without deploying; a diverged history fails. Live: the Deployments API is the record it reads.                             |
| G5-13      | `production-deploy` with `cancel-in-progress: false` on both callers, and a migration step that only a run holding that group can reach. Live only.                         |
| G5-14      | Tests: the ledger is ordered consumer-before-producer and the workflow's deploy steps follow it. The PoC collectors stay `deploy: false` until U09.                         |
| G5-15      | Tests: every ledger entry still carries the Wrangler `name` its configuration declares, so a directory move cannot create a new resource.                                   |
| G5-16      | Tests: the rollback refuses a target that is not an ancestor, or whose migration list is not a prefix; its record keeps the deployed list. No workflow restores a database. |
| G5-17      | Tests: only the migration and deploy steps reference the Cloudflare token, `secrets-json` is never used, and no collector secret name appears in an Actions file.           |
| G5-18      | Out of scope here: the legacy Worker and its notification path stay deployed (plan D2) until U15 retires them with its own audit.                                           |

## Renovate

`.github/renovate.json5` extends `github>risu729/renovate-config#3.19.0`, which
already pins versions, automerges minor and digest updates, and keeps
`compatibility_date` in `wrangler.jsonc` in step with Miniflare. Kogane adds
only a Cloudflare Workers group (wrangler, Miniflare, `@cloudflare/*`), keeps
the type packages in the shared `typescript` group, and labels the dependencies
whose updates must pass the Risk Gate. Automerged Renovate pull requests take
exactly the same path as any other: `CI Check`, then native auto-merge.

`high-risk` is a **routing** label, not a block: Renovate still opens and
automerges the pull request, and the Risk Gate holds it until the owner
approves the current head. It marks packages whose behaviour reaches parsed
evidence, money values or authentication (`parse5`, `jsonc-parser`, `jose`,
`zod`, `drizzle-orm`); a human may add it to any pull request for the same
effect. Updates to a collector's own `package.json` need no label — those
paths are in the ledger already.
