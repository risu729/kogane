# Adding a new collector

This page is the checklist for the open new-source issues under
[#440](https://github.com/risu729/kogane/issues/440)
([#455](https://github.com/risu729/kogane/issues/455)–[#510](https://github.com/risu729/kogane/issues/510)).
Each of those issues names its source, its target data and its own acceptance
criteria; this page holds what every one of them has in common: the order of
work, the files a new source touches and the checks that close it. It describes
the repository as it is today. When a step below no longer matches the code,
fix this page in the same PR.

Who does the work: these issues are implemented by Codex working on the
owner's PC from the issue text, not by Claude project threads. One starts
when the owner asks, and only after the coverage work on the existing
collectors (owner, 2026-11-09 19:06 UTC;
[roadmap: new sources](roadmap.md#new-sources)).

## 1. Order of work

Every new-source issue goes through these steps in order. Each step ends in a
pull request or an issue comment, so the next session can start from the
repository and the issue alone.

1. **Route check (no code).** With the owner present and approving the login
   ([section 3.5](#35-what-needs-the-owner)), log in through the official site
   or app and answer the questions the issue asks before any code. Write the
   answers as a new dated section of `docs/sources/<source>.md` (create the
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
5. **Production check.** The owner sets the Worker's secrets (whether a
   deploy needs them to exist first is not documented; if the deploy refuses
   the Worker, the owner sets them before it), the
   connection is added to the Processor's dispatch list
   ([section 3.3](#33-collection-schedule-and-dispatch)), one collection is
   requested, and the result is read back over MCP
   ([section 4](#4-done-when-common-to-every-new-source)). Then the schedule is
   enabled and the issue is closed with a comment that links the PRs and states
   what the read showed (counts and closed codes only).

Stop and ask the owner, instead of going on, when: the only working route
needs a write operation (charge, transfer, exchange, booking, setting change)
or bypasses an authentication or protection mechanism; login needs a device or
code the owner has to supply on every run; the provider's terms forbid
automated access; or the product turns out not to be held.

## 2. Routes

The research files rate each source from A (a documented API) to E (manual
capture is the safe default) ([source research levels](source-research.md)).
Kogane runs three kinds of route today:

| Route                                                        | What exists today                                                                                                                                                           | Examples                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker `fetch` (HTTP replay of the web or app protocol)      | Supported                                                                                                                                                                   | `collector-vpass`, `collector-sony-bank`, `collector-vpoint`           |
| Browser Run binding for login only, then `fetch`             | Supported                                                                                                                                                                   | `collector-myjcb`, `collector-mobile-suica`                            |
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
of a balance source; it has no README and has not passed its production check
yet (its schedule is disabled and it is not in the dispatch list). V Point
(`services/collector-vpoint`) is the example of a reward source. Search the
repository for `prestia-bank` and `prestia` (its CORE id), or `vpoint` and
`v-point`, and add the new source next to each hit. The guard tests named below
fail until a step is done.

### 3.1 Identity of the source

- **CORE source id.** More than half of the new-source issues name a source
  that already has a row in `sources`
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
  (add the collector's `src/storage.ts` import and its source and producer
  there).
- **Workspace and Worker.** `services/collector-<collector id>/`, Worker
  `kogane-<collector id>-collector`, copying the PRESTIA bank layout:
  `package.json`, `mise.toml` (tasks `types`, `typecheck`, `test`, `ci`,
  `cf-build`, `cf-typecheck`, `dry-run`, `bundle`), `wrangler.jsonc` (the
  `DATA` R2 binding to `kogane-raw-evidence`, `SCHEDULE_DB`, required secret
  **names** only, an empty `crons` list), `cloudflare.config.ts`,
  `wrangler.config.ts`, `tsconfig*.json`, `vitest.config.ts`, `src/`, `test/`
  (bun), `worker-test/` (vitest), and a README (PRESTIA bank has none; follow
  V Point's). Run `bun install` so the root `bun.lock` lists the workspace,
  then `mise run ledger:deps`.

### 3.2 Parsers

- One parser per dataset in `packages/parsers/src/parsers/<collector id>-*.ts`,
  registered in `packages/parsers/src/parsers/registry.ts`; run
  `mise run //packages/parsers:digests` to update
  `packages/parsers/src/parsers/digests.ts`.
- Synthetic fixtures that mirror the observed shape (never real values) and
  tests in `packages/parsers/test/`; add the source to the coverage contract
  (`packages/parsers/test/coverage-contract-cases.ts`, a new
  `tests/fixtures/observation-pipeline/coverage-contract/<source>-expected.json`
  named in `packages/parsers/test/coverage-contract.test.ts`). Every file added
  under `tests/fixtures/observation-pipeline/` gets its line in
  `tests/fixtures/MANIFEST.sha256` (guard: `tests/fixture-manifest.test.ts`).
- Map each stored artifact to its dataset in `ARTIFACT_DATASETS`
  (`descriptors.ts`, [ADR 0022](adr/0022-registration-artifact-datasets.md)).
  Guard: `scripts/artifact-datasets.test.ts` (add the collector's artifacts to
  its samples). State in the PR whether `REGISTRATION_CONTRACT_VERSION`
  changes; the comment above it says when it must.
- A snapshot dataset needs its row in `dataset_snapshot_policies` (a
  migration, as PRESTIA's `0066_prestia_bank_snapshot_schedule.sql` does) and
  its pair in `SNAPSHOT_DATASETS` (`packages/parsers/src/snapshot-query.ts`).
- A parser that emits transaction or position rows needs its entry in the
  transaction-family registry (`packages/domain/src/event-families.ts`,
  [ADR 0053](adr/0053-transaction-family-registry.md); guard:
  `packages/parsers/test/event-families.test.ts`).
- List the source in `PROVIDER_DATA_TYPE_CATALOGUE`
  (`packages/application/src/collection/provider-data-types.ts`,
  [ADR 0087](adr/0087-provider-data-type-catalogue.md); guard:
  `packages/application/test/provider-data-types.test.ts`) with one entry per
  data type the provider offers, `collected`, `partial` or `not_collected`,
  naming the issue for anything not fully collected.
- Balance metrics: add the source's metrics where PRESTIA's are
  (`packages/domain/src/metrics.ts`,
  `packages/observation-shared/src/balance-semantics.ts`), list it in
  `DIRECT_SOURCES` (or `AGGREGATOR_SOURCES`) in
  `packages/read-model/src/authority.ts`, and add its label and account
  reference rules in `packages/identity/src/other.ts`. A metric stays
  `non-additive` until evidence and the owner say otherwise.
- Reward sources (points, miles, prepaid value): a `reward_programs` row in a
  migration (as `0080_jpoint_program.sql` does for J-POINT), `expiry_rules`
  when the terms are recorded, and the promotion mapping in
  `services/processor/src/reward-claims-job.ts`
  ([rewards](rewards.md#6-tables-and-their-properties)). An expiry rule is
  `verified` only when `docs/sources/<source>.md` quotes the provider's terms;
  otherwise it is `needs-rule-verification` with family `unsupported`.
- An end-to-end Processor test from terminal to observations, as
  `services/processor/test/prestia-bank-pipeline.test.ts` is for PRESTIA.

### 3.3 Collection, schedule and dispatch

- The collector writes its run through `packages/collection`
  ([collection contract](collection-contract.md)): content-addressed objects,
  then `runs/<collector id>/<runId>/terminal.json` last. A failed or partial
  run says so with a closed `safeErrorCode`; logs carry counts and closed codes
  only.
- It serves `runOperation` for its own workspace (guard:
  `tests/collector-operation-rpc.test.ts`; add the collector's import and
  terminal source there). Add its connection to
  `packages/collection/src/operation-rpc.ts`, and the Processor's service
  binding `SCHEDULE_<NAME>` with entrypoint `ScheduledCollection` in
  `services/processor/wrangler.jsonc` and
  `services/processor/cloudflare.config.ts` (guard:
  `scripts/service-binding-chain.test.ts` counts the bindings).
- The schedule: an entry in `config/alarm-jobs.json` (`enabled: false`) and a
  disabled `collection_schedules` row in a migration. Guard:
  `scripts/alarm-config.test.ts`, which pins the job counts and applies only
  migrations `0065` and `0066`, so extend it to apply the new migration.
- Maintenance windows: `config/maintenance-research.json` is the 2026-10-04
  snapshot that migration `0065` seeded, and neither it nor
  `config/maintenance-survey.json` has a PRESTIA bank entry. Record what the
  route check found about maintenance in `docs/sources/<source>.md`. A window
  becomes a rule only through a maintenance edit (the schedule settings or
  `kogane.schedules.maintenance.update`,
  [schedules](schedules.md#agent-maintenance-tools)), which accepts a reference
  only on the source's registered host, the source's
  `provider_maintenance_references` row; a migration adds that row when the
  official notice page is known. `not-found` means unknown, not "never".
- Request dispatch: a requested collection reaches the collector only when its
  connection id is in `OPS_COLLECTOR_DISPATCH_CONNECTIONS`, in both
  `services/processor/wrangler.jsonc` and
  `services/processor/cloudflare.config.ts`; otherwise it waits and expires.
  Add it in a reviewed change once the collector is deployed and its secrets
  are set, refresh the resource ledger, and follow the first request as
  [ops API: enabling collector execution](ops-api.md#enabling-collector-execution-adr-0048)
  says (owner, 2026-11-08 03:19 UTC: every healthy connection may be added).

### 3.4 Build, deploy and ledgers

- `infra/workers-ci.json`, `infra/deploy-order.json` (the Worker's entry and
  the Processor's `after` list), `tasks-compat.toml` (`<name>-worker:bundle`),
  `tasks/_lib/coverage-suites.json`, and the deploy steps in
  `.github/workflows/_deploy-workers.yml`. Guards that list the Workers:
  `tasks/_lib/deploy-order.test.ts`, `tasks/_lib/cf-deploy.test.ts`.
- Add the workspace to `DISPOSITIONS` in `scripts/resource-ledger.ts`, then
  regenerate `infra/resources.json` and `infra/resources.md` with
  `mise run ledger:resources`.
- Docs in the same PR: the collector's section in
  [collection](collection.md), [collector runtime profiles](collector-runtime-profiles.md),
  [current status](current-status.md), the collector list in the
  [README](../README.md), and the source's `docs/sources/<source>.md`.

### 3.5 What needs the owner

Per action ([production data](../AGENTS.md#production-data)): every provider
login and every collector run by hand, the route check included; a hosted
Container experiment; reading or changing a secret, so the owner sets the
Worker's secrets (`wrangler secret put`). A collection requested through
`kogane.ops.collection.request`, and the login it makes, needs no approval.

Before merge ([merging](../AGENTS.md#merging)): the collector PR adds a Worker
to `infra/resources.json`, new secret names and deploy steps in
`.github/workflows/`, so the owner approves it unless the owner already asked
for that change. A D1 migration or a `wrangler.jsonc` binding change alone
needs no approval.

`infra/bootstrap/ingest-clients.sql` is applied to production by an operator,
not by CD
([processor: resources](processor.md#10-resources-to-create-before-the-flag-is-turned-on));
until it is, the source's runs do not register. Never ask the owner for a
password, code or HAR capture.

## 4. Done when, common to every new source

These hold in addition to the issue's own criteria.

- [ ] `docs/sources/<source>.md` has a dated section with the route-check
      answers, and the owner's route decision with its UTC time.
- [ ] `mise run //services/collector-<collector id>:ci`,
      `mise run //packages/parsers:ci`, `mise run ci:root` and the CI of every
      other workspace touched pass locally; `CI Check` is green on the PR.
- [ ] Every target-data row of the issue is covered by an entry of
      `PROVIDER_DATA_TYPE_CATALOGUE` (`collected`, `partial` or
      `not_collected`), with this issue's number for anything not collected.
- [ ] One production collection, requested with
      `kogane.ops.collection.request` after reading the source's history as
      [ops API](ops-api.md#requesting-a-collection-as-an-agent) asks, reaches
      `execution.state` `published` with every stage `completed`
      (`kogane.ops.operation.get`).
- [ ] `kogane.collection-quality.read` with the source and `view: accounts`
      lists the source's accounts with a freshness state, and the summary
      (no `source`) lists the issue's data types for the source.
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
