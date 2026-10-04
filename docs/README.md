# Documentation

Start with [current status](current-status.md) for what is implemented and
unimplemented, then [roadmap](roadmap.md) for the next milestone. This index
classifies the maintained references and dated records; it does not certify
production freshness.

## What belongs where

| Kind                                                                    | Purpose                                                         | Update rule                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Maintained reference / runbook                                          | What the code does now, limits, how to operate it               | Update with the implementation; mark historical migration sections explicitly |
| [ADR](adr/README.md)                                                    | Why a design decision was chosen; alternatives and consequences | Preserve history; amend or supersede when the decision changes                |
| [Plan](plans/README.md)                                                 | Proposed future work and acceptance criteria                    | Keep an explicit status; do not treat a proposal as an adopted decision       |
| [History](history/README.md) / acceptance record                        | What was observed or verified at a stated time                  | Preserve the dated evidence; do not use it as a current runbook               |
| [Source research](sources/README.md) / [experiment](research/README.md) | Dated feasibility, evidence, unknowns and stop conditions       | Recheck time-sensitive facts before implementation                            |

Do not move old docs wholesale into ADRs. Move only an actual design decision
that lacks a repository decision record; keep contracts and operational steps in
living docs. Existing ADRs remain historical even when their original trigger
or deployment assumptions have been superseded. See [ADR 0041](adr/0041-documentation-scope.md).

Code/configs and generated [infrastructure ledgers](infra-ledgers.md) are the
implementation authority. Distinguish implemented, enabled, deployed and verified
with real data; do not infer product completion from a schema or a pure function.

## Start here

- [Current implementation status](current-status.md)
- [Roadmap](roadmap.md)
- [Design](design.md)

## Collection, storage and parsing

- [Evidence Collection](collection.md)
- [Collection contract (`packages/collection`)](collection-contract.md)
- [Evidence ingest contract (descriptor-v1)](evidence-contract.md)
- [Authenticated Collectors](authenticated-collectors.md)
- [Collector runtime profiles](collector-runtime-profiles.md)
- [Credential Delivery](credentials.md)
- [Observation layer](observations.md)
- [Parser coverage contract (issues, coverage claims, snapshot policies)](parser-coverage.md)
- [Observation job lanes: incremental parsing, repair scan, targeted replay](observation-lanes.md)
- [Publication gate: adopted parse results as an explicit projection](publication-gate.md)
- [Release adoption: versioned metadata, candidate results, comparison and rollback](release-adoption.md)
- [Processor: shared-R2 terminals, registration, lanes and operations dispatch](processor.md)

## Identity and financial interpretation

- [Domain contracts (`packages/domain`)](domain-contracts.md)
- [Account and instrument identity (Layers C, phases 4–5)](identity.md)
- [Layer C source identity boundaries](identity-sources.md)
- [SBI securities identity interpretation](identity-sbi.md)
- [Identity projection operations](identity-operations.md)
- [Production identity audit](identity-audit.md)
- [Identity catalogue query performance](identity-query-performance.md)
- [Decision log, identity commands and read modes](decision-log.md)
- [MoneyForward connection correspondence](account-connections.md)
- [Preferred instrument display names](instrument-display-names.md)
- [Financial product identity](financial-products.md)
- [DBでの金額・数量の正規化](normalized-decimals.md)
- [Economic events, allocations, obligations and reconciliation](economic-events.md)
- [Card statement settlement review](card-settlements.md)
- [Reported state on a date](reported-state.md)
- [ポイント・マイル・前払式残高（A11）](rewards.md)
- [Prices, calculation policies and fixed report artifacts](calculation-and-reports.md)
- [Vpass durable card binding](vpass-card-identity.md)

## Read models, APIs and UI

- [Balance read model](balance-read-model.md)
- [残高・請求額の表示方針](balance-presentation.md)
- [Fixed projection input, snapshot identity and completion](projection-input.md)
- [Read model](read-model.md)
- [The READ database](read-model-d1.md)
- [Frontend foundation](frontend.md)
- [Evidence browser](evidence-browser.md)
- [Evidence file preview and download names](evidence-file-preview.md)
- [Website data and zero-filter audit (2026-09-08)](website-data-boundaries.md)
- [UI review and column design](ui-guidelines.md)
- [Change lifecycle: plan, simulate, approve, commit](change-lifecycle.md)
- [Agent API and the shared query service](agent-api.md)
- [Operations API](ops-api.md)
- [Schedule administration](schedules.md)

## Development and operations

- [Continuous integration](ci.md)
- [CI/CD automation](ci-cd.md)
- [Infrastructure ledgers](infra-ledgers.md)
- [Operations: health signals, load budgets, retention and recovery drills](operations.md)
- [Production rollout and feature controls](rollout.md)
- [Runbook: rebuilding the READ database](read-rebuild-runbook.md)
- [`packages/storage-d1`: CORE database access](storage-d1.md)
- [Package layout and import boundaries](package-layout.md)
- [Library decisions](libraries.md)
- [Existing Tools and Reuse](tooling.md)
- [Dependency and unused-code checks](unused-report.md)

## Source selection and dated research

- [Account and Source Inventory](account-inventory.md)
- [Direct Source Policy](source-policy.md)
- [Source Research Board](source-research.md)
- [Prior art: self-hosted personal finance software](prior-art.md)
- [Vpass via Personal-Finance Aggregators](vpass-aggregators.md)
- [Vpass Android app API investigation](vpass-android-api.md)
- [Reproducing the Vpass Android static analysis](vpass-android-reproduction.md)

## Historical records

- [Initial raw evidence store contract and rollout](raw-store.md)

- [Production observations rollout](production-observations-rollout.md)
- [Production evidence browser](production-evidence-browser.md)
- [Account and instrument identity rollout](identity-rollout.md)
- [金融データの意味の監査（2026-09-08）](financial-domain-audit.md)
- [Organized display and connection evidence acceptance](organized-display-acceptance.md)
- [Legacy retirement — 2026-09-13](legacy-retirement.md)
- [Temporary Cloudflare collector](vpass-cloudflare-temporary-collector.md)

The historical root paths above are retained for existing links. Additional
chronology is in [history](history/README.md), including
[implementation notes through 2026-10-04](history/2026-10-04-implementation-notes.md).
Research/acceptance dates bound claims; an old rollback instruction is not
permission to bypass current release compatibility checks.
