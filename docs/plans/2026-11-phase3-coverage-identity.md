# Plan: Phase 3 — coverage, collection requests and cross-source identity

- Status: **accepted** by the owner on 2026-11-08 (03:16 and 03:19 UTC), with the answers in [section 6](#6-owner-decisions-2026-11-08). Each unit is its own pull request; design changes inside a unit still get an ADR.
- Done: 2026-11-09. The roadmap's done-when holds ([outcome](../roadmap.md#phase-3-outcome), unit 3i, [#1148](https://github.com/risu729/kogane/issues/1148)); the owner chose on 2026-11-09 (11:27 UTC) to verify both requests over MCP instead of one from the page.
- Written: 2026-11-08 03:00 UTC against main [`2a1b681`](https://github.com/risu729/kogane/commit/2a1b681), revised after an independent subagent review (03:20 UTC).
- Roadmap: [Phase 3](../roadmap.md#phase-3--coverage-collection-requests-and-cross-source-identity) and [layers 0–5](../roadmap.md#layers-05--coverage-and-cross-source-identity). Issues [#542](https://github.com/risu729/kogane/issues/542), [#545](https://github.com/risu729/kogane/issues/545), the per-source issues #441–#454 under [#440](https://github.com/risu729/kogane/issues/440).

## 1. Where production was (read-only, MCP, 2026-11-08 ~02:35 UTC)

Read through `kogane.collection-quality.read`, `kogane.identity.read`, `kogane.accounts.candidates`, `kogane.instruments.coverage` and `kogane.instruments.candidates`. Closed codes and counts only.

### 1.1 Collection

Twelve daily collection schedules are enabled ([current status](../current-status.md)); PRESTIA bank's is disabled.

| source                                                                 | newest alarm occurrence              | newest terminal       | notes                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| sony-bank, sbi-securities, sbi-vc-trade, mobile-suica, moneyforward-me | completed                            | success / complete    |                                                                                                                                                                                                        |
| myjcb                                                                  | completed                            | success / partial     | `coverage_partial`                                                                                                                                                                                     |
| sbi-shinsei-bank                                                       | completed                            | partial / partial     | `acquisition_partial`                                                                                                                                                                                  |
| vpass                                                                  | uncertain (`dispatch_uncertain`)     | none                  | an answer naming more than 100 card runs ([#1111](https://github.com/risu729/kogane/pull/1111))                                                                                                        |
| mizuho-bank                                                            | failed (`collection_failed`)         | `provider_run_failed` | [#441](https://github.com/risu729/kogane/issues/441); the stored code read `unclassified` ([#1114](https://github.com/risu729/kogane/pull/1114), [#1115](https://github.com/risu729/kogane/pull/1115)) |
| global-pass                                                            | failed (`collection_failed`)         | `provider_run_failed` | [#443](https://github.com/risu729/kogane/issues/443); intermittent                                                                                                                                     |
| st-george                                                              | failed (`st_george_runtime_failed`)  | none                  | [#450](https://github.com/risu729/kogane/issues/450); the coordinator is `blocked` after a runtime failure and refuses every run until an operator resume                                              |
| v-point                                                                | failed (`reauthentication_pending`)  | failed                | display only: the alarm answer reports this by design and the email-triggered run completes after it (`services/collector-vpoint/src/scheduled-result.ts`)                                             |
| smbc-bank                                                              | manual only (`schedule_unsupported`) | —                     | [#442](https://github.com/risu729/kogane/issues/442); the debit bank of the Phase 2 cards                                                                                                              |
| prestia (bank)                                                         | schedule disabled                    | —                     | [#454](https://github.com/risu729/kogane/issues/454); never deployed                                                                                                                                   |
| v-point-pay                                                            | email path, unsupported schedule     | —                     | [#453](https://github.com/risu729/kogane/issues/453)                                                                                                                                                   |

The read reports stored stage codes and the capture time; it computes no age and judges nothing stale ([ADR 0045](../adr/0045-collection-quality-read.md)).

Collection requests: the ops API, `kogane.ops.collection.request` and the dispatcher exist ([ADR 0048](../adr/0048-operation-collector-dispatch.md)). 13 connections serve `runOperation` in code (`packages/collection/src/operation-rpc.ts`), none in production. `OPS_COLLECTOR_DISPATCH_CONNECTIONS` is `""` (`services/processor/wrangler.jsonc`, `cloudflare.config.ts`), so every request waits and expires after 24 hours. `ops.collection.request` lists the `ui` and `mcp` paths (`packages/application/src/operation-path/catalogue.ts`), but no page posts `/api/ops/v1/collections`. Collectors collect their daily scope, so a requested window is not applied; READ projection is not traced; a replay request completes nothing traceable ([processor](../processor.md)).

### 1.2 Accounts

Every source's eligible observations are organized but for five Sony Bank ones. Mapping status `identified` is 0 everywhere. `unresolved` appears only on MyJCB: one reference, the J-POINT total balance (`unrecognized-source-account`), with 23 observations.

MoneyForward has four connections:

| MF connection    | state      | stored reason                                                                                                                                           |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SBI Shinsei Bank | confirmed  | branch and account number equal the direct connection; 16 `connection_contains` relations accepted; which MF item is which direct account is unresolved |
| SMBC (bank)      | unresolved | the direct capture has no branch or account number                                                                                                      |
| SMBC Card        | unresolved | several cards and points; the card number field is blank                                                                                                |
| PRESTIA          | unresolved | no direct deposit collection                                                                                                                            |

No `same_account` is proposed or recorded. Balance reads rank MoneyForward as `aggregator` (`packages/read-model/src/authority.ts`) and drop an overlap only through an explicit relation (`packages/domain/src/scope.ts`); `economicallySummable` is false for every row ([read model](../read-model.md)); MoneyForward is outside the dated-state perimeter ([reported state](../reported-state.md#perimeter)).

### 1.3 Instruments

- sbi-securities: 40 identifiers, 32 of them in 16 proposed candidates, 8 with none. Every candidate pairs an `XTKS` listing (namespace `mic-symbol`) with SBI's own `sbi-security-code` identifier for country JP and the same code, seen on another venue (a PTS, a foreign-stock section of the exchange or no market); both are JPY securities, `security-code-equal`, `crossSource: false`. 0 adopted, 0 rejected.
- sbi-vc-trade: 46 identifiers, all `no-candidate`.
- No second broker is collected, so no production case of the same instrument at two brokers exists.

## 2. What already counts toward the done-when

Request → trail exists in code (unverified in production). Coverage cells per source × unit × dataset × period exist (ADR 0045), and per-source identity counts (ADR 0073). Account mapping states and reasons, instrument candidate states and MF connection states with reasons already distinguish resolved from unresolved. Missing: the request path in production, coverage per account, freshness, data types nobody collects, and decisions on the instrument candidates.

## 3. Work in flight elsewhere

Open pull requests from another session cover parts of this phase; the units below depend on them and take over their scope if one is closed instead.

| PR                                                   | what                                                                   | part                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------- | --------------------- |
| [#1071](https://github.com/risu729/kogane/pull/1071) | refuse foreign Origins on command and ops POSTs (ADR 0078)             | prerequisite of 3b    |
| [#1074](https://github.com/risu729/kogane/pull/1074) | list one's own ops requests on HTTP and MCP (ADR 0086)                 | follow a request      |
| [#1075](https://github.com/risu729/kogane/pull/1075) | read-only `依頼の経過` page                                            | follow a request (UI) |
| [#1097](https://github.com/risu729/kogane/pull/1097) | trace a request's `projected` stage against READ (ADR 0048 amendment)  | follow to READ        |
| [#1111](https://github.com/risu729/kogane/pull/1111) | over 100 runs ends `failed` with `run_ids_over_limit`                  | Vpass `uncertain`     |
| [#1112](https://github.com/risu729/kogane/pull/1112) | collection quality per account, page and `view: "accounts"` (ADR 0088) | coverage per account  |

## 4. Units (one pull request each)

### 3a Plan and baseline (docs only)

This file, the roadmap's Phase 3 section, and progress comments on #542 and #545.

### 3b Send a collection request from the UI (code; after #1071)

A `収集を依頼` action per connection on the `スケジュール` page, with a confirmation step (the MCP tool is R2: prepare, then confirm), posting `/api/ops/v1/collections` through the same service as `kogane.ops.collection.request`. The page then reads `operations/{id}` and links to `依頼の経過`. It shows which connections dispatch is enabled for; that new read field is also returned over MCP (ADR 0081). No new operation.

### 3c Enable dispatch and run the first production requests (config + production run)

Add every healthy connection to `OPS_COLLECTOR_DISPATCH_CONNECTIONS` (both Processor configurations), refresh the resource ledger and deploy ([operations API](../ops-api.md)), `sony-bank` first and one request at a time, each read with `kogane.ops.operation.get` until `published` (and `projected` once #1097 is in). Vpass, St George and container collectors go last, after their fixes. The owner allows agents to request collections without a limit, and the request tool's description tells the caller to read the history first: the source's collection quality, schedule, maintenance window, held lease and earlier requests ([section 6](#6-owner-decisions-2026-11-08)); 3c records that rule in AGENTS.md and the operations API page. Risks: the collector call is awaited inside the Processor tick and delays the decision outbox; a start without an outcome becomes `uncertain` after an hour and is never retried; a refused St George lease leaves a failed run that needs an operator resume (ADR 0048). The dispatcher already holds a request during maintenance and while the alarm holds the lease.

### 3d Freshness per cell (code + ADR 0045 amendment; after #1112)

Each cell, and #1112's per-account view, gets the age of its current capture and a closed state under a versioned policy: `same-day`, `recent` (1–3 days) and `stale` (more) for daily collectors, the values of `dated-state-freshness-v1`; `human_required` when a person must act (SMBC Direct's manual path, a blocked St George coordinator); `disabled`; `no_capture` without an age when nothing was captured. The answer names its `asOf`.

**3d outcome:** per source and cell in [#1127](https://github.com/risu729/kogane/pull/1127) ([ADR 0045 amendment](../adr/0045-collection-quality-read.md#amendment-2026-11-08-freshness-per-source-and-cell)); per account, data type and period of the account view in [ADR 0088's amendment of 2026-11-08](../adr/0088-collection-quality-per-account.md#amendment-2026-11-08-freshness-per-account-data-type-and-period): each period ages its named capture independently of standing, and a data type and account carry their newest named capture's freshness, as specified by [#1139](https://github.com/risu729/kogane/issues/1139).

### 3e Data types nobody collects (code + ADR; after #1112)

A checked-in, versioned catalogue per source of what the provider offers for the account kinds the source collects, in the layer 0–5 data types (balances, bank movements, card usage, statements, positions, executions, settlement cash, reward balance, activity and expiry): each `collected` with its datasets, or `not_collected` with its issue. For example, SBI Securities: positions and executions collected; dividends, distributions and interest, asset history and electronic documents `not_collected` ([#446](https://github.com/risu729/kogane/issues/446)). It is filled from the source research ([sources](../sources/README.md), [source research](../source-research.md)) and describes the provider, not the owner's holdings. Shown on the collection quality page, per account and in `kogane.collection-quality.read`.

### 3f Account identity (audit, then code where evidence allows)

1. A read-only audit of every read that sums or lists across sources (overview, latest balances, reported and reconstructed state, reports) for a MoneyForward row shown or totalled beside its direct account, starting from the authority ranks and overlap relations above, including whether the accepted SBI Shinsei `connection_contains` relations act as overlaps. A fix is its own pull request.
2. The MyJCB J-POINT total: an identity policy version and a re-identification sweep give it a role from observed evidence ([ADR 0004](../adr/0004-payment-type-shapes-from-evidence.md)); reward units have no resolution state, so it reads as a reward balance, not as resolved.
3. The three unresolved MF connections stay unresolved with their reasons shown per account: the evidence that would resolve them does not exist yet. No matching by label or amount ([ADR 0077](../adr/0077-account-connection-candidates.md)).

**3f outcome (2026-11-08):** no read totals a MoneyForward row beside its direct account, and the accepted `connection_contains` relations move no row ([audit](../account-connections.md#double-counting-audit-2026-11-08)). The audit found a per-unit subtotal false positive, fixed in [#1120](https://github.com/risu729/kogane/pull/1120). The J-POINT total is `reward-account` / `provider-local` under policy 2 for J-POINT captures only ([#1147](https://github.com/risu729/kogane/pull/1147), [ADR 0089](../adr/0089-myjcb-jpoint-identity.md)). Deposits at two banks stay `overlap_unknown` against each other because no account is `identified`; that design question is [#1150](https://github.com/risu729/kogane/issues/1150).

### 3g Adopt certain instrument matches automatically (code + ADR 0055 amendment)

Rule `instrument-auto-v1`: adopt a candidate when both identifiers are securities with country JP, the same Japanese securities code and no conflicting fact (kind, ISIN, currency), and no person's decision is on either side. A Japanese securities code names one issue on every Japanese venue, so a PTS trade's code and the exchange listing are the same share. The adoption is a new mapping revision carrying the rule's version and the candidate's evidence, audited, and a person undoes it with a later `identity.assign`. Everything else (foreign tickers, which can be reused; pairs across brokers; ISIN-only pairs) stays a candidate for an agent to decide over MCP after reading both evidence pages. This amends [ADR 0055](../adr/0055-instrument-candidates.md), under which a rule never adopts. Expected in production: the 16 SBI pairs adopted (their 32 identifiers read `resolved-by-rule`), 8 identifiers still without a candidate.

### 3h Failing collectors (read-only triage; fixes in their own pull requests)

Done read-only on 2026-11-08 for mizuho, GLOBAL PASS, St George, V Point and Vpass (section 1.1). Left: SBI Shinsei Bank and MyJCB partial. A step that needs a login, a manual run or a deploy that contacts a provider goes to the owner as one list. Not part of the done-when.

### 3i Production verification and close-out (docs)

Request one collection from the page and one over MCP and follow both to published (and projected); read per-account coverage for the Phase 2 accounts (a Vpass card, the MyJCB root, SMBC, SBI Shinsei) with data types and freshness; read identity and instrument counts. Record the outcome in the roadmap; close or narrow #542 and #545.

**3i outcome (2026-11-09):** both requests over MCP reached `published` (stages in the [roadmap outcome](../roadmap.md#phase-3-outcome)); the Phase 2 accounts read `same-day` (the MyJCB root and J-POINT; an older MyJCB aggregate account `stale`), `human-required` (SMBC) and `stale` (Vpass, SBI Shinsei, whose newest captures are not parse-eligible); `unresolved` is 0 among the organized observations of every source while about 21,000 observations were still being organized, and the 16 SBI pairs are `resolved-by-rule`.

Order: 3a, 3c, 3f and 3g now, in parallel threads; 3b after #1071; 3d and 3e after #1112, in one thread since they change the same query; 3i last.

## 5. Out of scope

Requested collection windows (collectors keep collecting their daily scope; a request records the window as not applied), replay tracing, new collectors (#455–#510), and fixing every failing collector.

## 6. Owner decisions (2026-11-08)

- 03:16 UTC: a match that is almost certainly correct (for example the SBI instrument candidates) is adopted automatically; one that needs judgement is decided by an agent over MCP. The catalogue of data types does not ask the owner what they hold.
- 03:19 UTC: scope as proposed: every source is visible, request → published is verified on the healthy connections, and fixing failing collectors does not gate the phase.
- 03:19 UTC: dispatch may be enabled and agents may request collections without a limit; the request tool's description tells the caller to read the past history first.
- 03:19 UTC: freshness states as proposed (provisional); requested windows and replay tracing stay out of Phase 3.
