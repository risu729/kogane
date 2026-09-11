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

| Rule                          | Covers                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core-schema`                 | CORE and READ migrations (`packages/storage-d1/migrations/**`; the pre-U05 ingest path was dropped in U15)                                                                                                                                                                                             |
| `authorization`               | `services/app/src/auth.ts` and any `packages/*/src/auth.ts`, the ingest-client declaration and its rendered bootstrap SQL                                                                                                                                                                              |
| `secret-consuming-collectors` | collector code, `package.json` and `bun.lock` of workers that run with a source's bank credentials, plus their container images, `Dockerfile` and operator scripts, and the shared `packages/collector-diagnostics` every collector bundles (plan 12 §5: the dependency closure deploys with the code) |
| `automation`                  | `.github/workflows/**`, `.github/scripts/**`, `.github/actions/**`                                                                                                                                                                                                                                     |
| `deployment-config`           | `wrangler*.jsonc`, `wrangler*.toml`, `infra/**`                                                                                                                                                                                                                                                        |

One thing about the `secret-consuming-collectors` patterns is deliberate. The
`services/collector-*/bun.lock` entry matches nothing today — U03 left one
lockfile at the root — and stays because a per-workspace lockfile reappearing
under a collector is exactly the dependency-closure change the rule is about.

The `poc/*-worker/**` and `poc/sbi-securities/**` entries U15 dated are gone:
the collector promotion (U04B, `poc/<source>-worker` →
`services/collector-<source>`) made them dead, and the item that landed it
retired them together with the `poc/moneyforward-worker/…` rows of
`scripts/automerge.test.ts`, as U15 said it should.

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

| Workflow                                | Trigger                                                          | What it does                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/deploy.yml`          | `workflow_run` of `CI` on `main`, or `workflow_dispatch` (`sha`) | Guards the CI result and calls the release job with `github.event.workflow_run.head_sha`. It has no way to narrow the set: a release always covers every Worker the ledger marks `deploy`. |
| `.github/workflows/rollback.yml`        | `workflow_dispatch` (`sha`, `targets`)                           | Calls the same release job in `rollback` mode, for every Worker or for the ones `targets` names.                                                                                           |
| `.github/workflows/_deploy-workers.yml` | `workflow_call`                                                  | The single release job: the guards, the migrations, the uploads, the postcheck and the record.                                                                                             |

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

Both callers pass `secrets: inherit`, and that is not optional. The Cloudflare
credentials are scoped to the `production` Environment; only the _called_
workflow's job declares that environment, and GitHub resolves a called
workflow's `secrets.*` from what the caller passed — an unpassed secret is the
empty string, not an error. Passing the token by name does not help either: the
name resolves in the caller, where the environment is not in scope. The first
real release (run 34635388395) therefore built everything, opened a deployment
record and then failed inside `wrangler d1 migrations apply` with _"In a
non-interactive environment, it's necessary to set a `CLOUDFLARE_API_TOKEN`
environment variable"_, having applied nothing. `secrets: inherit` is the only
route for an environment secret into a called workflow, so `ghalint`'s
`deny_inherit_secrets` is excluded for exactly these two jobs in `ghalint.yaml`
and `zizmor`'s `secrets-inherit` is ignored on exactly these two `uses:` lines;
`credentialWiringViolations` in `tasks/_lib/deploy-order.test.ts` fails if a
caller ever drops it again.

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
   release ledger** and **decides, per Worker** (below), writing the plan every
   later step reads. A run with nothing left to do stops here, successfully,
   having changed nothing; a run that finds the ledger cannot account for some
   Workers deploys exactly those.
5. **Installs the rest of the toolchain**, then `mise run install`,
   `mise run bundle` and `mise run dry-run`. Everything is built and validated
   before any credential exists in the job (G5-09). `mise run dry-run` covers
   every configuration, not only the deployed ones, and `mise run bundle` covers
   every deployed one, collectors included; several of those configurations build
   a container image, so the runner needs Docker — the same requirement CI's
   `Worker` jobs already have. The tool cache is off in every step of this
   job: its cache scope is shared with pull request CI, which runs pull request
   code, and `node` decides the guards.
6. **Confirms the production credentials reached this job.** The first step in
   which `secrets.CLOUDFLARE_API_TOKEN` and `vars.CLOUDFLARE_ACCOUNT_ID` exist;
   it reads neither value and prints neither, it only fails the run when either
   is empty and says what to create. Everything before it is credential-free
   (G5-09, G4-16), and everything after it would otherwise fail later and less
   clearly — an empty secret is not an error in Actions, so without this step a
   missing setting looks like a Wrangler bug halfway through a release.
7. **Computes the release manifest**, uploads it as a run artifact, and derives
   the release record that becomes the deployment payload.
8. **Compares the schema** with the record of the last successful release.
9. **Refuses an incompatible rollback** (below).
10. **Opens a GitHub deployment** in state `in_progress`.
11. **Applies the CORE migrations** — forward only, and only when this commit
    knows a migration the recorded release did not. Then the READ migrations,
    once a READ database exists. Each step brackets the apply with
    `wrangler d1 migrations list --remote`, so the release log names the
    migrations that were pending before it ran and shows none pending after:
    Wrangler reports what it applied per invocation only, and a release record
    is not a substitute for the database's own answer.
12. **Re-verifies the release manifest** against the working tree. This is the
    last step before a credential reaches a Worker upload.
13. **Uploads the Workers** the plan selected, in the ledger's order, one
    `risu729/wrangler-deploy-action` step each, `mode: production`. Re-uploading
    a Worker that is already at this commit is harmless — Wrangler creates a new
    version of the same code — so a resume never has to reason about whether a
    particular upload happened.
14. **Records what it actually did**, from its own step outcomes, and uploads
    that as the `release-progress-<sha>` artifact. This step runs even when
    something failed: that is the run that most needs an account of itself.
15. **Postchecks** the health routes of what it deployed.
16. **Records** the deployment as `success`, or as `failure` and stops, with the
    progress summary in the status description either way.

### The release ledger, and why a late run is harmless (G5-12)

The ledger is the GitHub Deployments API: the newest deployment of the
`production` environment whose latest status is `success`, with the release
record in its payload. It needs no commit (a push would need a signature and
would not start a workflow) and it does not expire the way a cache does.

Concurrency alone would not be enough. GitHub keeps at most one run _pending_
per group and states that ordering is not guaranteed, so with rapid merges an
intermediate run is cancelled and a run that started earlier can still reach
the deploy steps after a newer one finished. The decision is therefore made
against the ledger, by `git merge-base --is-ancestor` — and it is made **per
Worker**, because the environment is not one thing that is at one commit:

| The commit the ledger records for a Worker | What the run does with that Worker           |
| ------------------------------------------ | -------------------------------------------- |
| nothing recorded                           | deploy it                                    |
| an ancestor of this commit                 | deploy it, moving it forward                 |
| this commit                                | leave it alone, and record it as still here  |
| a descendant of this commit                | **leave it alone** — a newer release owns it |

The run itself proceeds when that leaves at least one Worker to deploy, reports
_"nothing to do"_ and succeeds when it does not, and fails when this commit and
the recorded one have diverged (`main` is linear, so that means something is
wrong). An overtaken run is still harmless — every Worker of the newer release
is at a descendant of its commit, so it deploys none of them — but it is no
longer blind: if the newer release never reached some Worker, the older run
finishes that one rather than reporting success over a half-deployed
environment.

That per-Worker rule is what makes a re-run a **resume**. The bug it replaces:
a release that deployed one Worker recorded the whole commit as released, so a
later full release of the same commit answered _"already the recorded release;
nothing to do"_ and the Workers it had never deployed stayed behind for good.

A run that is cancelled or fails leaves its deployment without a `success`
status, so the next run keeps reading the one before it — a failed deployment is
never the environment's state. A re-run of that commit therefore deploys every
Worker the last _successful_ record does not place at it, including any the
failed run had already uploaded: that re-upload is harmless (above), whereas
believing a failed run's account of itself would not be — a Worker whose upload
succeeded but whose postcheck failed is exactly the one that must be deployed
and checked again. The failed deployment is not ignored either: the next run reads its
payload and prints it as _"it is not the environment's state, and it may have
applied…"_, with the migrations and the Workers that run was working through,
because a half-finished release is exactly the situation where the log has to
say what might already be out there. The ledger is read from the newest page of
deployments; if that whole page failed and the list goes on, the read is an
error rather than an empty ledger, because an empty ledger means "deploy
anything".

Only a deployment whose payload is a release record counts. Not every
`production` deployment is one: a job that declares `environment: production`
makes GitHub open a deployment of its own, with an empty payload, and close it
with the job's result — so a release job that correctly decides it has nothing
to do leaves behind a **successful** production deployment that names no Worker
and no migration. The repository's ledger already holds a pile of those from the
failed first attempts. Reading one as the state would be the same mistake as
reading a partial release as a complete one, so the read skips any payload
without a `manifestVersion`. Nothing is rolled back automatically, and CORE is never restored
from a backup by a workflow (G5-16).

The record's migration lists say what the database holds once the deployment is
done, not what the commit knows. For a release the two are the same. For a
rollback the record keeps the deployed list: the rollback applied nothing, so
the database still has every migration the recorded release had, and a later
rollback to a commit in between is judged against the list that is actually
applied.

### What a release record holds, and what a run says it did

The deployment payload is the record. It carries the commit, the manifest
digest, the CORE and READ migration lists the database holds afterwards, the two
database names, and one entry per deployable Worker:

```jsonc
{
  "manifestVersion": "release-manifest-v2",
  "mode": "release",
  "sha": "<40 hex>",
  "manifestSha256": "<64 hex>",
  "coreDatabase": "kogane-raw-evidence",
  "coreMigrations": ["0001_….sql", "…"],
  "readDatabase": "kogane-read",
  "readMigrations": null,
  "workers": [
    {
      "name": "ingest", // the deploy-ledger name
      "worker": "kogane-ingest", // the Cloudflare script name
      "config": "services/raw-evidence/wrangler.jsonc",
      "sha": "<the commit this Worker is at>",
      "outcome": "planned", // or "kept": this run did not touch it
    },
  ],
}
```

A record written by the previous scheme (`release-manifest-v1`, a list of
Worker names) is still read: every Worker it names is taken to be at the
record's own commit.

`outcome` is a plan, not a result, and that is a property of the API rather than
a choice: `POST /deployments` fixes the payload when the deployment is created,
which is before the first upload, and there is no way to amend it afterwards.
What makes `planned` true is the `success` status, which is only posted when
every step of the run succeeded. What a run actually did is recorded twice
over, from the job's own step outcomes: as a one-line summary in the deployment
status description (`3/5 deployed at abc123…, CORE migrations done, failed:
app-demo`) and in full in the `release-progress-<sha>` artifact, which
distinguishes `deployed`, `failed` and `skipped` per Worker (Actions records a
step whose condition was not met as skipped, so a planned upload that never ran
because an earlier step failed shows as `skipped`; `not reached` appears only
when the step id is absent from the job's context altogether) and carries the
deploy Action's `deployment-targets` for the ones that uploaded. The `success`
status is refused by the ledger script itself while any planned Worker is not
`deployed`, on top of the workflow's own `success()` condition.
Each deploy step is identified as `deploy-<ledger name>` for exactly that
reason, and a test fails if a new one omits it.

Not the Wrangler version id, though: the pinned Action reports the `targets` of
its deploy entry and nothing else, and asking Cloudflare for the id afterwards
would mean another credentialed step per Worker for a value nothing here
decides on. What identifies what was deployed is the commit and the manifest
digest; the version id is one dashboard lookup away when a human needs it.

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
a writer starts using it. The five consumers come first, then every collector:

| Order | Worker                            | Directory                           | Health route                | Reachable by    |
| ----- | --------------------------------- | ----------------------------------- | --------------------------- | --------------- |
| 1     | `kogane-observation-pipeline`     | `services/processor`                | `/internal/health`, binding | through the App |
| 2     | `kogane-evidence-browser`         | `services/app`                      | `/api/ops/v1/health`        | Access token    |
| 3     | `kogane-demo`                     | `services/app`                      | none                        | —               |
| 4     | `kogane-ingest`                   | `services/raw-evidence`             | `/health`                   | unauthenticated |
| 5     | `kogane-collector-r2-importer`    | `services/collector-r2-importer`    | none                        | —               |
| 6     | `kogane-globalpass-collector-poc` | `services/collector-globalpass`     | `/health`                   | unauthenticated |
| 7     | `kogane-mobile-suica-...-poc`     | `services/collector-mobile-suica`   | `/health`                   | unauthenticated |
| 8     | `kogane-moneyforward-...-poc`     | `services/collector-moneyforward`   | `/health`                   | unauthenticated |
| 9     | `kogane-myjcb-collector-poc`      | `services/collector-myjcb`          | `/health`                   | unauthenticated |
| 10    | `kogane-sbi-collector-poc`        | `services/collector-sbi-securities` | `/health`                   | unauthenticated |
| 11    | `kogane-sbi-shinsei-...-poc`      | `services/collector-sbi-shinsei`    | `/health`                   | unauthenticated |
| 12    | `kogane-sbi-vc-session-poc`       | `services/collector-sbi-vc-trade`   | `/health`                   | unauthenticated |
| 13    | `kogane-smbc-direct-backfill-poc` | `services/collector-smbc-direct`    | none                        | —               |
| 14    | `kogane-sony-bank-collector-poc`  | `services/collector-sony-bank`      | `/health`                   | unauthenticated |
| 15    | `kogane-vpass-collector-poc`      | `services/collector-vpass`          | `/health`                   | unauthenticated |
| 16    | `kogane-vpoint-pay-...-poc`       | `services/collector-vpoint-pay`     | `/health`                   | unauthenticated |
| 17    | `kogane-vpoint-collector-poc`     | `services/collector-vpoint`         | `/health`                   | unauthenticated |

Every collector is a CD target: leaving them out meant a merged collector
change was live in the repository and not in production, which is a worse
failure than deploying one. `services/collector-globalpass` and
`services/collector-sbi-shinsei` carry a container image, so their upload — like
their `mise run dry-run` and `<short>:bundle` — needs Docker on the runner.

The `wrangler dev` helpers, the audit configurations, the test harness config,
the bootstrap configs and the three experiments stay `deploy: false` and are
excluded from CI in `infra/workers-ci.json`; a configuration CI excludes may
never be marked deployable.

#### Deploying a collector starts nothing (plan 11 §6)

An upload replaces a collector's script and its declared triggers; it is not an
invocation. What was checked, in the code as it is:

- **No `scheduled` event is triggered by a deploy.** Every collector's
  collection path is behind `scheduled` (or an authenticated admin POST), and
  the crons come from the same `wrangler.jsonc` the deploy carries, so a
  release re-declares the existing schedule rather than adding a run. A cron
  change is a configuration change, visible in review and in the Risk Gate.
- **No Durable Object alarm is set at startup.** The only collector that uses
  alarms is `services/collector-smbc-direct`, and every `setAlarm` sits inside
  a Durable Object method reached from a request or from a previous alarm
  (`src/session.ts`). The Durable Object constructors of the V Point, V Point
  Pay, SBI VC Trade and SMBC Direct collectors assign fields and nothing else —
  no `blockConcurrencyWhile`, no storage write, no alarm. An alarm an earlier
  run already set still fires on its own schedule; a deploy neither sets one nor
  brings one forward.
- **No module-level side effect.** No collector entry point runs code at import
  time: the modules export a handler, the container classes only set ports and
  log lifecycle callbacks.
- **The one queue consumer among the collectors** (`services/collector-vpass`)
  re-imports artifacts that are already stored into `kogane-ingest`; it contacts
  no provider. A deploy does not enqueue anything, and a backlog would have been
  delivered to the previous version anyway.
- **No credential is touched.** CD never writes a Worker secret, never calls a
  re-authentication route and never runs a backfill; the release postcheck reads
  health routes only (below).

What a deploy of a collector _does_ change is which code will run the next time
its cron fires — and that code runs with the source's bank credentials. That is
why every path that decides what a collector bundles (`src/**`,
`package.json`, `bun.lock`, `container/**`, `scripts/**`, `Dockerfile`, and the
shared `packages/collector-diagnostics/src/**`) is in `infra/risk-paths.json`:
the owner approves it on the exact head **before** the merge, and the upload
afterwards is automatic (plan 12 §5).

The ledger records the Wrangler `name` of each configuration and the test
asserts it still matches the file. A directory rename therefore cannot turn
into a new Worker, Durable Object class, queue, bucket or cron by accident
(G5-15); the resource identities live in `infra/resources.json`.

### Postcheck

Three fields of the ledger decide what is checked, per Worker: `healthPath` is
the route, `healthAuth` is how CD authenticates it (`access` or `none`), and
`healthIdentity` is the field of the JSON answer that has to be there. A Worker
with an empty `healthPath` is not requested at all, and the ledger says so
rather than pretending to check something.

**The public half.** `kogane-ingest` and every collector with a `/health` are
requested over their `workers.dev` hostname, unauthenticated, and must answer
200 **with** the identity field the ledger names (`schemaVersion` for most,
`service` for Vpass, `waitingForHuman` for SBI VC Trade). 200 alone is not a
pass: an edge error page and an empty body are both 200-shaped.

**The authenticated half.** The App authenticates every request through
Cloudflare Access, and the Processor is published on no hostname at all
(`workers_dev: false`, no routes) — which is why both used to have an empty
`healthPath`, and why a broken App or Processor deployed and reported success.
CD now calls

```text
GET https://kogane-evidence-browser.takuanimal.workers.dev/api/ops/v1/health
    CF-Access-Client-Id: <service token id>
    CF-Access-Client-Secret: <service token secret>
```

with the Access **service token** in the `production` Environment, without
following redirects (a redirect to the Access login screen must stay a
redirect, not become a 200 with an HTML body), and asserts all of:

| Assertion                                                            | Why it is the release's business                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| HTTP 200 and `status == "ok"`                                        | the App can serve at all; anything degraded is 503                   |
| `releaseSha == <the released sha>`                                   | the Worker that is running is the commit this run uploaded           |
| `core.migrationsApplied` contains the manifest's last CORE migration | the schema the code needs is applied (plan 11 §6 "schema readiness") |
| `read.required == false` or `read.ok`                                | READ answers whenever this deployment reads it                       |
| `processor.releaseSha == <the released sha>`                         | the other half of the pair is the same release                       |

`status == "ok"` also covers the deployment's grant configuration: the App
reports `grants.usable` (false, with a problem _code_, when
`OPERATOR_SUBJECTS`/`AGENT_GRANTS` are present but unreadable or overlap) and
is `degraded` while it is false, so a release cannot certify a Worker that
grades nobody. Empty lists — the committed deny-all default — are usable.
The App's answer also carries the capability snapshot, the DATA bucket probe
and the Processor's lane flags, cursor ages and READ pointer
([ops-api.md](ops-api.md#get-apiopsv1health--the-release-postchecks-route),
[processor.md](processor.md#13-internal-health-and-the-release-postcheck)).
Everything it reads is read-only: `SELECT 1`, the applied-migration list, one
R2 `head` of `health/release-marker`, one capability snapshot, one
service-binding call. **No bank login, no collection, no credential rotation
and no backfill are part of a normal smoke check** (plan 11 §6), and nothing
synthetic is written to a financial view.

**How the sha gets in.** A Worker cannot know its own commit: the value comes
from the variable `RELEASE_SHA`, which is empty in the repository and stamped
into the App's and the Processor's configuration by
`.github/scripts/release-sha.mjs` in the runner's checkout — the pinned deploy
Action exposes `mode`, `working-directory`, `config`, `environment`,
`preview-alias`, the two credentials and `secrets-json`, and no input for a
variable. The stamp runs **before** the manifest is computed, so the manifest
digests the configuration that is actually uploaded and the re-verification
before the first upload still holds. A configuration that already carries a
sha is an error, not a second rewrite.

**When the service token is missing** the step fails with a message naming the
two secrets and this page's setup section. That is deliberate: skipping the
authenticated postcheck is exactly the hole that let a broken App pass.

What is still not checked: contract-level behaviour of a deployed Worker beyond
its own health (a synthetic terminal end to end in production is not part of a
release), and the collectors' build identity — their `/health` predates
`RELEASE_SHA` and carries `schemaVersion`, so for them CD proves reachability
and shape, not which commit answered.

### Rollback (plan 11 §7)

`rollback.yml` re-deploys an earlier commit with `sha` and an optional
`targets` list — the one place where a subset is deliberate, and the reason
`deploy.yml` has no such input. It is judged per target, against the commit the
ledger records for _that_ Worker (after one Worker has been rolled back, the
recorded release's own sha is the older commit while the others are still at
the newer one): a target recorded ahead of the commit is rolled back, one
already at it is left alone, and one recorded behind it or never recorded at
all refuses the run, because that would be a roll forward and a roll forward
goes through `deploy.yml`. It also refuses unless the commit's CORE migration
list is a **prefix** of the deployed one: migrations are additive and are never reverted,
so an older commit may run against a database that has more migrations applied
than it knows about, but never against one that is missing migrations it needs.
The rollback applies no migration and restores no database.

Its record is per target: the Workers it rolled back are recorded at the older
commit and the others keep the commit the previous record gave them. So the next
release sees a mixed environment for what it is and moves each Worker forward
from where it actually is, instead of treating one rolled-back Worker as proof
that the whole commit is live.

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

Both must be reachable from the _called_ workflow, which is why both callers
pass `secrets: inherit` (above). The release job's preflight step fails
immediately, before any migration or upload, if either resolves to an empty
string — which is what a secret that exists only at another scope, or a caller
that stopped inheriting, looks like from inside the job.

4. **Cloudflare Access service token**, for the authenticated postcheck
   (Zero Trust → Access → Service auth → Create service token; name it for what
   it is, e.g. `kogane-release-postcheck`). The Client Secret is shown once.
   - Add a policy to the **`kogane-evidence-browser` Access application** with
     action **Service Auth** and the include rule **Service Token → that
     token**. It sits next to the existing `default` Allow policy; a Service
     Auth policy does not go through the identity or WARP requirements, which
     is why it must name that one token and nothing broader.
   - Environment secrets `CF_ACCESS_CLIENT_ID` (the token's Client ID) and
     `CF_ACCESS_CLIENT_SECRET` (its Client Secret).
   - Deployment variable: add the token's Client ID to `HEALTH_PROBE_TOKENS` in
     `services/app/wrangler.jsonc` as a one-element JSON array, e.g.
     `"HEALTH_PROBE_TOKENS": "[\"<client id>.access\"]"`. The App verifies the
     Access JWT itself, so the token has to be listed there as well as allowed
     by the policy: Access decides who reaches the Worker, the Worker decides
     who may read the health route. Cloudflare puts the Client ID in the JWT's
     `common_name` claim; use exactly the value the claim carries.

   Until all three exist the release fails at the authenticated postcheck,
   after the uploads. That is the intended direction: an unchecked App is the
   failure this postcheck exists to prevent. The token grants the health route
   and nothing else — it is not a subject, so it cannot reach a command, an
   operation or any evidence route.

Bank credentials stay where they are, per source, and are never placed in
GitHub. The deploy Action's `secrets-json` input is not used anywhere in this
repository and a test fails if it appears (G5-17). Note what this does _not_
remove: whoever can deploy a collector can deploy code that reads that
collector's secrets at runtime (plan 12 §5), which is why collector paths are
in the Risk Gate ledger.

### Enabling it the first time, under supervision

1. Create the environment, the secret, the variable and the Access service
   token above. Until the Cloudflare secret and variable exist, the release
   fails at the preflight step — after the build, before the deployment record,
   the migrations and every upload; until the service token exists it fails at
   the authenticated postcheck, after the uploads. Create all four before the
   next merge, or expect one red run.
2. Run `Deploy` manually (`workflow_dispatch`) with the current `main` sha. It
   deploys every Worker the ledger marks `deploy` — there is no `only` input,
   because a partial release used to record the whole commit as live and leave
   the rest behind (above). All seventeen — the five consumers and the twelve
   collectors — are already dry-run on every commit, and
   the run stops before its first upload if anything about the checkout, the
   credentials or the manifest is wrong. If a smaller first blast radius is
   wanted anyway, the honest way is a reviewed change: set `deploy: false` for
   the others in `infra/deploy-order.json` and remove their deploy steps (the
   ledger test requires the two to agree), release, then revert that change.
3. Check the run summary: the recorded release, what the ledger could and could
   not account for per Worker, the migration listings before and after the
   apply, both postcheck results, and the `N/N deployed` line. Check the Deployments
   tab shows one `production` deployment whose payload names every Worker with
   the commit it is at, and download the `release-progress-<sha>` artifact once
   to see what the run recorded about itself.
4. Re-run the same dispatch. It must report _"every deployable Worker is already
   recorded at …; nothing to do"_ and deploy nothing.
5. Dispatch `Deploy` with the previous `main` sha. It must report _"a newer
   release … covers every deployable Worker"_ and deploy nothing (G5-12).
6. Run `Rollback` with the previous `main` sha and `targets: ingest`, confirm
   the Worker version changed in the Cloudflare dashboard and that the new
   record shows `ingest` at the older commit and the other four at the newer
   one, then run `Deploy` with the current sha again — it must deploy `ingest`
   alone, because that is the only Worker that is behind.
7. Only then let the automatic path run: merge something small and watch
   `CI` → `Deploy` (G5-07).

### What is verified locally, and what is not

Verified in CI on every commit, with synthetic data only:

- the ledger interlock and the rollback prefix rule, against a real git history
  in a temporary repository, including the per-Worker decisions — a covering
  record skips, a partial one resumes with exactly the missing Workers, a
  Worker at a newer commit is left alone, a diverged history fails — the two
  record versions, the per-target rollback record, and what a run records about
  itself from its step outcomes (`scripts/release.test.ts`);
- the manifest: determinism over the same tree, `migrations_dir` read from the
  Wrangler configuration, bundle digests that ignore source maps, secret
  **names** only, and a changed input reported by field name;
- the deploy ledger against `infra/workers-ci.json`, the deploy steps against
  the ledger's order and each one's `deploy-<name>` id, the absence of a subset
  input on the release path, that every caller inherits the environment
  secrets, that the credentials are checked before anything is applied, the
  absence of a preview lane or a second environment, and the absence of any
  collector secret name in an Actions file (`tasks/_lib/deploy-order.test.ts`);
- that every collector directory is a CD target with a bundle task that
  exists, that exactly one health route is authenticated and the Access token
  reaches exactly one step (`tasks/_lib/deploy-order.test.ts`);
- the build-identity stamp: one variable, one occurrence, an already-stamped
  configuration refused, and the repository's own configurations committed
  empty (`scripts/release-sha.test.ts`);
- both health routes against the real Worker, the real migrations and a
  synthetic store: refused without an Access assertion, refused for an unlisted
  service token, refused for an agent subject, degraded with 503 when the
  Processor cannot be reached, and refused on the Processor for a caller that
  did not arrive through the service binding (`services/app/test/health.test.ts`,
  `services/processor/test/internal-health.test.ts`);
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

| Acceptance | Covered by                                                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G5-01      | Tests: pending/blocked states are left to the ruleset. Live: a failing `CI Check` keeps auto-merge waiting.                                                                                                                                                    |
| G5-02      | Tests: a `behind` branch stays eligible and requests an update; the sweep picks the oldest armed one. Live: strict up-to-date + update starts CI before the merge.                                                                                             |
| G5-03      | Tests: owner and `renovate[bot]` eligibility. Live: the app merges without a bypass entry.                                                                                                                                                                     |
| G5-04      | Tests: draft, closed, merged and `dirty` pull requests are refused.                                                                                                                                                                                            |
| G5-05      | Tests: approval matching on `commit_id`, supersession, non-owner reviews, and the label path bound to the approved head. Live: push after approval re-gates.                                                                                                   |
| G5-06      | Live only: the App token update starts CI, no human approval loop. Not provable offline.                                                                                                                                                                       |
| G5-07      | Live only: the merge push starts `CI`, whose successful run on `main` starts `Deploy` (push event, this repository, `main`). Proven by the first merge after enabling CD.                                                                                      |
| G5-08      | Workflows pass pull request strings through `env` only; zizmor, ghalint and actionlint enforce the shape. Tests: pagination fails closed.                                                                                                                      |
| G5-09      | CI runs the deploy Action in `dry-run` mode with no account or token, and the release job builds and dry-runs before any credential is in scope. Both asserted.                                                                                                |
| G5-10      | Tests: no workflow declares an environment other than `production`, uses a preview mode or a preview alias. The deploy ledger carries no preview target.                                                                                                       |
| G5-11      | Tests: a changed lockfile, configuration, migration or bundle is reported by field name. The workflow re-verifies the manifest immediately before the first upload.                                                                                            |
| G5-12      | Tests: a commit every Worker is already recorded at stops without deploying, a partial record resumes with the missing Workers only, a Worker at a newer commit is left alone, and a diverged history fails. Live: the Deployments API is the record it reads. |
| G5-13      | `production-deploy` with `cancel-in-progress: false` on both callers, and a migration step that only a run holding that group can reach. Live only.                                                                                                            |
| G5-14      | Tests: the ledger is ordered consumer-before-producer and the workflow's deploy steps follow it. The PoC collectors stay `deploy: false` until U09.                                                                                                            |
| G5-15      | Tests: every ledger entry still carries the Wrangler `name` its configuration declares, so a directory move cannot create a new resource.                                                                                                                      |
| G5-16      | Tests: the rollback refuses a target that is not an ancestor, or whose migration list is not a prefix; its record keeps the deployed migration list and is per target. No workflow restores a database.                                                        |
| G5-17      | Tests: only the credential preflight, the migration steps and the deploy steps reference the Cloudflare token, `secrets-json` is never used, and no collector secret name appears in an Actions file.                                                          |
| G5-18      | Out of scope here: the legacy Worker and its notification path stay deployed (plan D2) until U15 retires them with its own audit.                                                                                                                              |

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
