# Kogane

Kogane collects financial records from banks, cards, brokers, exchanges and
reward programs, preserves their original evidence, and builds financial views
whose source and interpretation can be traced. Saved evidence can be parsed and
interpreted again under versioned rules without rewriting the original.

- [Documentation index](docs/README.md)
- [Current implementation and limits](docs/current-status.md)
- [Roadmap](docs/roadmap.md)
- [Design](docs/design.md)
- [Architecture decision records](docs/adr/README.md)
- [Agent instructions](AGENTS.md)

## What works today

- **Evidence and observations:** shared raw storage, sealed collection history,
  versioned parsing, adoption and replay. The protected Japanese UI displays
  transactions, balances, positions, reported state and their evidence.
- **Card review:** Vpass/MyJCB single-payment purchase/refund recognition,
  pending-to-posted review, and statement/debit matching with SMBC and SBI Shinsei
  adapters. Decisions retain their history and do not create a second expense.
- **Scheduling:** fourteen Processor-owned alarm jobs cover twelve daily
  collectors, SBI VC session keepalive and the Processor tick. The management
  screen connects schedule/maintenance revisions to execution history.
- **Rewards and calculations:** typed reward buckets, observed expiry, READ
  projections, valuation components and fixed report artifacts exist. Useful
  forecasts and simulations still need verified rules and complete inputs.

Collection, parsing and adoption are separate outcomes. A saved capture or an
empty view does not prove complete source coverage. Vpass collector statement
pages remain withheld from parsing pending card-identity continuity. Full
transaction matching, reconstructed state, portfolio valuation, lots, cost
basis, P&L and tax outputs are incomplete.

The operator HTTP API can edit schedules and maintenance. Research is not
automatically refreshed. MCP query/explanation/proposal code exists, but agent
grants are empty and maintenance has no MCP tool. Generic collection-operation
requests still need executor wiring; alarm execution uses a separate implemented
private RPC path.

The next milestone is **card usage → statement → bank debit**, with an
explainable trail and no double expense. Dated holdings/liabilities, valuation,
lots/P&L and tax follow; rewards can progress in parallel. See
[current status](docs/current-status.md) for the bounded implementation assessment
and [roadmap](docs/roadmap.md) for the delivery order and acceptance criteria.

## Repository map

| Path                        | Role                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `services/collector-*`      | Per-source acquisition Workers and their runtime adapters             |
| `services/processor`        | Alarm coordination, registration, parsing and derived jobs            |
| `services/app` + `apps/web` | Protected APIs and the Japanese management/evidence UI                |
| `packages/`                 | Shared domain, collection, parsing, application and storage contracts |
| `infra/`                    | Generated resource/schema ledgers and release ordering                |
| `docs/`                     | Maintained references, decisions, plans and dated evidence            |

## Getting started

One Bun workspace, one lockfile, and mise as the only task runner. There are no
`package.json` scripts; every entry point is a mise task.

```sh
mise trust
mise install              # pinned tools (bun, node, hk, oxlint, ...)
mise run install          # frozen Bun install for every workspace
mise exec -- hk check --all --no-fail-fast # complete validation graph
mise run //services/app:ci # one workspace's checks
mise run fix              # explicitly apply lint/format fixes
mise tasks ls --all        # discover the monorepo tasks
```

See [Development checks and CI](docs/ci.md) for the task naming convention, how
CI uses the same `hk check` entry point, and what to do when adding a workspace.

## Collectors

Each source implementation lives under `services/collector-<source>`. Twelve
have daily automatic jobs; SMBC Direct and V Point Pay automatic login remain
unsupported. Their presence below does not claim unattended collection. The runtime
each of them needs, and why, is in the
[collector runtime inventory](docs/collector-runtime-profiles.md).

- [SMCC Vpass](services/collector-vpass/README.md)
- [SBI証券](services/collector-sbi-securities/README.md)
- [SBI新生銀行](services/collector-sbi-shinsei/README.md)
- [SBI VC TRADE](services/collector-sbi-vc-trade/README.md)
  (and its [local read-only client](packages/sbi-vc-trade-client/README.md))
- [Sony銀行](services/collector-sony-bank/README.md)
- [みずほ銀行](services/collector-mizuho/README.md)
- [St.George](services/collector-st-george/README.md)
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
