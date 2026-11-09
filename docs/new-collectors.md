# Adding a new collector

This page is the checklist for the new-source issues under
[#440](https://github.com/risu729/kogane/issues/440) (#455–#510). Each of those
issues names its source, its target data and its own acceptance criteria; this
page holds what every one of them has in common: the order of work, the files a
new source touches and the checks that close it. It describes the repository
as it is today. When a step below no longer matches the code, fix this page in
the same PR.

Who does the work: these issues are implemented by Codex working on the
owner's PC from the issue text, not by Claude project threads, and they start
after the coverage work on the existing collectors (owner, 2026-11-09 19:06
UTC; [roadmap: new sources](roadmap.md#new-sources)).

## 1. Order of work

Every new-source issue goes through these steps in order. Each step ends in a
pull request or an issue comment, so the next session can start from the
repository and the issue alone.

1. **Route check (no code).** With the owner present, log in through the
   official site or app and answer the questions in the issue's step 1. Write
   the answers as a new dated section of `docs/sources/<source>.md` (create the
   file in the [research record outline](sources/README.md#record-outline) when
   it does not exist) and land it in a docs-only PR. Record counts, field
   names, page sizes, retention, export formats and authentication steps only:
   no amounts, names, account, card or member numbers, cookies or tokens.
2. **Route decision by the owner.** Post a comment on the issue that proposes
   one of the routes in [section 2](#2-routes), with the reason and what is
   left uncollected. Write no collector code until the owner answers. Record
   the answer with its UTC time in the source's `docs/sources/<source>.md`
   section, and in an ADR when it changes a shared contract.
3. **Parsers first.** Land the parsers with synthetic fixtures before the
   collector ([section 3.2](#32-parsers)). A parser PR can merge on its own; it
   changes nothing in production until a terminal names its dataset.
4. **Collector and wiring.** Land the collector and every wiring file in
   [section 3](#3-files-a-new-source-touches) in one PR, with the schedule
   seeded disabled.
5. **Production check.** After the deploy, the owner sets the secrets, one
   collection is requested, and the result is read back over MCP
   ([section 4](#4-done-when-common-to-every-new-source)). Then the schedule is
   enabled and the issue is closed with a comment that links the PRs and states
   what the read showed (counts and closed codes only).

Stop and ask the owner, instead of going on, when: the only working route
needs a write operation (charge, transfer, exchange, booking, setting change)
or bypasses an authentication or protection mechanism; login needs a device or
code the owner has to supply on every run; the provider's terms forbid
automated access; or the product turns out not to be held.

## 2. Routes

The research files rate each route from A (documented API) to E (manual
capture is the safe default) ([source research levels](source-research.md)).
Kogane can run three of them today:

| Route                                                        | What exists today                                                                                                                                                           | Examples                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker `fetch` (HTTP replay of the web or app protocol)      | Supported                                                                                                                                                                   | `collector-vpass`, `collector-sony-bank`, `collector-vpoint`           |
| Browser Run binding for login only, then `fetch`             | Supported                                                                                                                                                                   | `collector-myjcb`                                                      |
| Container Chrome for the whole collection                    | Supported; needs a Docker daemon for local checks ([ADR 0043](adr/0043-cf-container-deployment.md))                                                                         | `collector-globalpass`, `collector-sbi-shinsei`, `collector-st-george` |
| A file the owner downloads by hand (CSV, PDF) or a local run | **Not supported.** No route writes a file from the owner's PC to the shared `DATA` bucket; `kogane.ops.import.request` only registers a run whose terminal is already there | —                                                                      |

A source whose only workable route is the last row stops at step 2 until a
shared upload route exists; do not build one inside a single source's PR.
Classify every new collector in
[collector runtime profiles](collector-runtime-profiles.md#required-information-for-a-new-collector)
and give its README the `Runtime profile` section that page asks for.

## 3. Files a new source touches

The PRESTIA bank collector (`services/collector-prestia-bank`,
[ADR 0042](adr/0042-prestia-bank-worker.md)) is the smallest complete example
of a balance source; V Point (`services/collector-vpoint`) is the example of a
reward source. Search the repository for `prestia-bank` or `v-point` and add
the new source next to each hit. The guard tests named below fail until a step
is done.

### 3.1 Identity of the source

- **CORE source id.** Most of these sources already have a row in `sources`
  ([`0002_registry.sql`](../packages/storage-d1/migrations/core/0002_registry.sql)):
  `airwallet`, `amazon`, `ana`, `au-pay`, `bank-of-kyoto`, `epos`, `j-coin-pay`,
  `jal`, `jp-bank-card`, `mercari-family`, `minna-bank`, `mufg-bank`,
  `mufg-card`, `opal`, `paypay`, `rakuten`, `smart-ex`, `sumishin-sbi-bank`,
  `wester`, `westpac`, `wise`, `yucho-bank`. Use that id. A source without a row
  gets one in a new additive migration (next free number in
  `packages/storage-d1/migrations/core/`; then `mise run ledger:schema` and the
  migration pin in `services/processor/test/lanes.test.ts`). Several issues
  share one CORE id (for example Mercari, Merpay, Mercoin and Mercard under
  `mercari-family`); each still gets its own collector id below when its login
  or protocol differs.
- **Collector id.** The id the collector writes in its terminal and under
  `runs/<collector id>/`. Map it to the CORE id in `COLLECTOR_SOURCE_IDS`
  (`packages/application/src/collection/descriptors.ts`) and declare the route
  `{ source: <CORE id>, producer: "collector-<collector id>" }` in
  `config/ingest-clients.json`; regenerate `infra/bootstrap/ingest-clients.sql`
  with `mise run bootstrap:ingest-clients`. Guards:
  `scripts/config-bootstrap.test.ts`, `tests/collector-producers.test.ts`
  (add the collector's import and pair there).
- **Workspace and Worker.** `services/collector-<collector id>/`, Worker
  `kogane-<collector id>-collector`, copying the PRESTIA bank layout:
  `package.json`, `mise.toml` (tasks `types`, `typecheck`, `test`, `ci`,
  `cf-build`, `cf-typecheck`, `dry-run`, `bundle`), `wrangler.jsonc` (the
  `DATA` R2 binding to `kogane-raw-evidence`, `SCHEDULE_DB`, required secret
  **names** only, no `crons`), `cloudflare.config.ts`, `wrangler.config.ts`,
  `tsconfig*.json`, `src/`, `test/` (bun), `worker-test/` (vitest), README.

### 3.2 Parsers

- One parser per dataset in `packages/parsers/src/parsers/<collector id>-*.ts`,
  registered in `packages/parsers/src/parsers/registry.ts`; run
  `mise run //packages/parsers:digests` to update `digests.ts`.
- Synthetic fixtures that mirror the observed shape (never real values) and
  tests in `packages/parsers/test/`; add the source to the coverage contract
  (`packages/parsers/test/coverage-contract-cases.ts` and
  `tests/fixtures/observation-pipeline/coverage-contract/<source>-expected.json`).
- Map each stored artifact to its dataset in `ARTIFACT_DATASETS`
  (`descriptors.ts`, [ADR 0022](adr/0022-registration-artifact-datasets.md)).
  Guard: `scripts/artifact-datasets.test.ts`. State in the PR whether
  `REGISTRATION_CONTRACT_VERSION` changes; the comment above it says when it
  must.
- A snapshot dataset needs its row in `dataset_snapshot_policies` (a
  migration, as PRESTIA's `0066_prestia_bank_snapshot_schedule.sql` does).
- List the source in `PROVIDER_DATA_TYPE_CATALOGUE`
  (`packages/application/src/collection/provider-data-types.ts`,
  [ADR 0087](adr/0087-provider-data-type-catalogue.md)) with one entry per
  data type the provider offers, `collected`, `partial` or `not_collected`,
  naming the issue for anything not fully collected.
- Balance metrics: add the source's metrics where PRESTIA's are
  (`packages/domain/src/metrics.ts`,
  `packages/observation-shared/src/balance-semantics.ts`), its authority rank in
  `packages/read-model/src/authority.ts`, and its label in
  `packages/identity/src/other.ts`. Unknown metrics stay non-additive; never
  mark a new metric summable without an owner decision.
- Reward sources (points, miles, prepaid value): a `reward_programs` row and
  `expiry_rules` in a migration, and the promotion mapping in
  `services/processor/src/reward-claims-job.ts`
  ([rewards](rewards.md#6-tables-and-their-properties)). An expiry rule is
  `verified` only when `docs/sources/<source>.md` quotes the provider's terms;
  otherwise it is `needs-rule-verification` with family `unsupported`.

### 3.3 Collection, schedule and dispatch

- The collector writes its run through `packages/collection`
  ([collection contract](collection-contract.md)): content-addressed objects,
  then `runs/<collector id>/<runId>/terminal.json` last. A failed or partial
  run says so with a closed `safeErrorCode`; logs carry counts and closed codes
  only.
- It serves `runOperation` for its own workspace (guard:
  `tests/collector-operation-rpc.test.ts`). Add its connection to
  `packages/collection/src/operation-rpc.ts`, the Processor's service binding
  `SCHEDULE_<NAME>` in `services/processor/wrangler.jsonc` and
  `services/processor/cloudflare.config.ts`.
- The schedule: an entry in `config/alarm-jobs.json` and a disabled
  `collection_schedules` row in a migration (guard:
  `scripts/alarm-config.test.ts`). Add the source's maintenance research to
  `config/maintenance-research.json` and `config/maintenance-survey.json`
  (`not-found` is allowed and means unknown, not "never").
- Request dispatch: once a production run has been checked, add the
  connection id to `OPS_COLLECTOR_DISPATCH_CONNECTIONS` in
  `services/processor/wrangler.jsonc` (owner, 2026-11-08 03:19 UTC: every
  healthy connection may be added).

### 3.4 Build, deploy and ledgers

- `infra/workers-ci.json`, `infra/deploy-order.json`, `tasks-compat.toml`
  (`<name>-worker:bundle`), `tasks/_lib/coverage-suites.json`, and the deploy
  steps in `.github/workflows/_deploy-workers.yml`.
- Regenerate `infra/resources.json` and `infra/resources.md` with
  `mise run ledger:resources`.
- Docs in the same PR: the collector's section in
  [collection](collection.md), [collector runtime profiles](collector-runtime-profiles.md),
  [current status](current-status.md), the collector list in the
  [README](../README.md), and the source's `docs/sources/<source>.md`.

### 3.5 What needs the owner

The owner approves these per action ([AGENTS.md](../AGENTS.md#merging),
[production data](../AGENTS.md#production-data)): every provider login and
every hand-run of a collector; setting Worker secrets (`wrangler secret put`);
changes to `infra/resources.json` and `.github/workflows/`; applying
`infra/bootstrap/ingest-clients.sql` to production. Never ask the owner for a
password, code or HAR capture; read credentials from where the owner put them.

## 4. Done when, common to every new source

These hold in addition to the issue's own criteria.

- [ ] `docs/sources/<source>.md` has a dated section with the step 1 answers,
      and the owner's route decision with its UTC time.
- [ ] `mise run //services/collector-<collector id>:ci`,
      `mise run //packages/parsers:ci`, `mise run ci:root` and the CI of every
      other workspace touched pass locally; `CI Check` is green on the PR.
- [ ] Every target-data row of the issue appears in
      `PROVIDER_DATA_TYPE_CATALOGUE` as `collected`, `partial` or
      `not_collected`, with this issue's number for anything not collected.
- [ ] One production collection, requested with
      `kogane.ops.collection.request` after reading the source's history as
      [ops API](ops-api.md#requesting-a-collection-as-an-agent) asks, reaches
      `published` with every stage `completed` (`kogane.ops.operation.get`).
- [ ] `kogane.collection-quality.read` (`view: accounts`) lists the source's
      accounts with a freshness state, and its summary lists the issue's data
      types.
- [ ] Balances read back through `kogane.balances.read` or
      `kogane.reported-state.read`; reward balances and expiry through
      `kogane.rewards.read`. A value the provider does not show is a reason,
      never zero.
- [ ] Nothing is counted twice with another source that shows the same money
      (the issue names the overlaps).
- [ ] No amount, name, account, card or member number, cookie or token is in
      the repository, an issue, a PR or a log.
- [ ] The schedule is enabled only after the check above, and the issue is
      closed with a comment linking the PRs and the read results.
