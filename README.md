# Kogane

A personal finance data platform: collect raw evidence from banks, cards,
brokers, exchanges, and reward programs, and keep it re-processable so that
balances, valuations, P&L, and tax views can be recomputed later under
different rules.

- [Design](docs/design.md)
- [ADR 0001: provenance classification plus domain axes](docs/adr/0001-domain-axes.md)
- [Domain contracts (`packages/domain`)](docs/domain-contracts.md)
- [Package layout and import boundaries](docs/package-layout.md)
- [Evidence collection](docs/collection.md)
- [Raw evidence store](docs/raw-store.md)
- [Collection contract (`packages/collection`)](docs/collection-contract.md)
- [Evidence ingest contract](docs/evidence-contract.md)
- [Observation layer](docs/observations.md)
- [Parser coverage contract](docs/parser-coverage.md)
- [Observation job lanes and scheduled stages](docs/observation-lanes.md)
- [Publication gate: adopted parse results](docs/publication-gate.md)
- [Release adoption, candidate results and rollback](docs/release-adoption.md)
- [Decision log, identity commands and read modes](docs/decision-log.md)
- [Change lifecycle: plan, simulate, approve, commit](docs/change-lifecycle.md)
- [Balance read model](docs/balance-read-model.md)
- [Fixed projection input, snapshot identity and completion](docs/projection-input.md)
- [CORE storage (`packages/storage-d1`)](docs/storage-d1.md)
- [The READ database](docs/read-model-d1.md)
- [Runbook: rebuilding the READ database](docs/read-rebuild-runbook.md)
- [Economic events, allocations and reconciliation](docs/economic-events.md)
- [Points, miles and prepaid balances](docs/rewards.md)
- [Prices, calculation policies and report artifacts](docs/calculation-and-reports.md)
- [Read model (`packages/read-model`)](docs/read-model.md)
- [Evidence browser](docs/evidence-browser.md)
- [Agent API and the shared query service](docs/agent-api.md)
- [Operations API (`/api/ops/v1`) and MCP parity](docs/ops-api.md)
- [The Processor: shared-R2 terminals, registration and job lanes](docs/processor.md)
- [Frontend stack and API handoff](docs/frontend.md)
- [Development checks and CI](docs/ci.md)
- [CI/CD automation: auto-merge, the Risk Gate and production deploys](docs/ci-cd.md)
- [Infrastructure ledgers: resources, CORE schema, dependencies, retention](docs/infra-ledgers.md)
- [Operations: health signals, load, retention and drills](docs/operations.md)
- [Rollout: every flag, its prerequisites, order and rollback](docs/rollout.md)
- [Runbook: retiring the legacy ingest, importer and buckets](docs/legacy-retirement.md)
- [Authenticated collectors](docs/authenticated-collectors.md)
- [Credential delivery](docs/credentials.md)
- [Library decisions](docs/libraries.md)
- [Existing tools and reuse](docs/tooling.md)
- [Prior art: self-hosted finance software](docs/prior-art.md)
- [Vpass aggregator alternatives](docs/vpass-aggregators.md)
- [Vpass Android app API](docs/vpass-android-api.md)
- [Account and source inventory](docs/account-inventory.md)
- [Direct source policy](docs/source-policy.md)
- [Source research board](docs/source-research.md)
- [Per-source research records](docs/sources/README.md)
- [Roadmap](docs/roadmap.md)

## Product status and next milestone

The infrastructure migration and legacy resource retirement are complete.
Financial product development continues: existing schemas, READ projections and
pure calculation functions do not yet provide complete transaction matching,
portfolio valuation, cost basis, P&L or tax reporting.

The next major milestone connects **Vpass/MyJCB purchases and statements to
bank debits**, separating purchase recognition from settlement and explaining
the balance impact without counting an expense twice. It builds on the current
Vpass pending/posted matcher; MyJCB and cross-source matching remain to implement.

The [roadmap](docs/roadmap.md) records the current implementation limits,
development order and acceptance criteria. Its main sequence is identity and
data coverage → reconciliation/events → dated holdings and liabilities →
price/FX valuation → lots/P&L → tax. Rewards progress in parallel, while UI and
AI/MCP flows are delivered with each feature.

## Getting started

One Bun workspace, one lockfile, and mise as the only task runner. There are no
`package.json` scripts; every entry point is a mise task.

```sh
mise trust
mise install              # pinned tools (bun, node, hk, oxlint, ...)
mise run install          # frozen Bun install for every workspace
mise run check --lint     # hk: lint and format check, never edits files
mise run ci:app           # one workspace's CI checks
mise run verify           # every workspace, then the Worker deployment dry runs
mise tasks ls             # what else is there
```

See [Development checks and CI](docs/ci.md) for the task naming convention, how
the CI matrices are generated, and what to do when adding a workspace.

## Collectors

One deployed Worker per source, under `services/collector-<source>`. The runtime
each of them needs, and why, is in the
[collector runtime inventory](docs/collector-runtime-profiles.md).

- [SMCC Vpass](services/collector-vpass/README.md)
- [SBI証券](services/collector-sbi-securities/README.md)
- [SBI新生銀行](services/collector-sbi-shinsei/README.md)
- [SBI VC TRADE](services/collector-sbi-vc-trade/README.md)
  (and its [local read-only client](packages/sbi-vc-trade-client/README.md))
- [Sony銀行](services/collector-sony-bank/README.md)
- [三井住友銀行 SMBCダイレクト](services/collector-smbc-direct/README.md)
- [PRESTIA GLOBAL PASS](services/collector-globalpass/README.md)
- [MyJCB](services/collector-myjcb/README.md)
- [Mobile Suica](services/collector-mobile-suica/README.md)
- [Money Forward](services/collector-moneyforward/README.md)
- [Vポイント](services/collector-vpoint/README.md)
- [V Point Pay](services/collector-vpoint-pay/README.md)

## Open experiments

Each one carries an `EXPERIMENT.md` with its owner, expiry and stop condition.
Deployed code never imports them.

- [Cloudflare Container runtime and egress probe](experiments/cloudflare-runtime-probe/EXPERIMENT.md)
- [Cloudflare Browser Run probe](experiments/cloudflare-browser-run/EXPERIMENT.md)
- [TAMIA raw TCP bridge](experiments/tamia-tcp-bridge/EXPERIMENT.md)

## Finished experiments

Their code is no longer on `main`; the result, the commit that carried it and
how to read it back are in [`docs/research/`](docs/research/).

- [SBI証券 Bitwarden CLI passkey overlay](docs/research/sbi-securities.md)
- [OCI/WSL Vpass browser comparison](docs/research/oci-browser.md)
- [Camoufox Windows/macOS fingerprint controls](docs/research/camoufox.md)
- [Kameleo Windows Chrome container control](docs/research/kameleo.md)
