# Current implementation status

Type: maintained reference. Reviewed: 2026-10-05 against main `dcf8aca` and the
PRESTIA bank Worker integration.
This is a code/configuration assessment, not a fresh production acceptance run.
Implementation, configured enablement, deployment and verified real-data coverage
are separate claims. Historical acceptance records are linked from the
[documentation index](README.md#historical-records).

## Implemented capabilities and limits

| Area                 | Implemented                                                                                                                                                                                                                                                                                                                                                                                                                             | Remaining boundary                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection           | Twelve enabled daily collector schedules, shared raw evidence and source-specific manual paths; separate PRESTIA bank Worker implemented; operations-API collection requests run through the same named collector RPC and are traced to publication or a closed reason                                                                                                                                                                  | A collector's presence does not prove every account/data type is captured or published; no operations-API connection is enabled and production dispatch is unverified                                                                                                                                                                                                     |
| Evidence and parsing | Immutable raw evidence, sealed inventories, versioned parsers, adoption and replay                                                                                                                                                                                                                                                                                                                                                      | Older permanently blocked terminals remain blocked; partial or unsupported shapes remain explicit                                                                                                                                                                                                                                                                         |
| Collection quality   | Read-only page and API for configured jobs, actual Alarm reservations and source/unit/dataset/period stages; missing artifacts, empty publication and unresolved identity have distinct reasons ([ADR 0045](adr/0045-collection-quality-read.md))                                                                                                                                                                                       | Production acceptance remains open; undeclared scope, provider retention completeness and age thresholds are not inferred ([verification checklist](plans/2026-10-collection-quality-completion.md))                                                                                                                                                                      |
| Scheduling           | Fourteen active alarm jobs: twelve daily collectors, SBI VC keepalive and Processor tick; two unsupported source jobs and the pending PRESTIA bank job disabled                                                                                                                                                                                                                                                                         | Re-survey only proposes and fetches no page yet; a saved setting with pending reservation is not an armed alarm                                                                                                                                                                                                                                                           |
| UI                   | Evidence/history, transactions, balances, positions, reported state (with holdings changes between two dates), reconstructed state, account/instrument identities with per-source coverage, rewards, fixed report artifacts (評価レポート), card review, schedule settings and the operator's audit log                                                                                                                                 | A view or empty list is not proof of complete financial coverage; identity coverage counts account mappings, not instrument matches; stored reward simulations have no page because none are stored                                                                                                                                                                       |
| Audit log            | One append-only record per operator write, agent call and MCP tool call, refusals included; the operator reads it on the 監査ログ page over `GET /api/v2/audit`, agents read scoped records under `audit.read` ([audit log](audit-log.md))                                                                                                                                                                                              | No `alarm`/`lane` records yet; the page shows no delegation status; not verified on production                                                                                                                                                                                                                                                                            |
| Identity             | Source-local identities, mappings and append-only decisions                                                                                                                                                                                                                                                                                                                                                                             | Cross-source account/instrument equivalence and unresolved identities still need review                                                                                                                                                                                                                                                                                   |
| Card flows           | Vpass/MyJCB single-payment purchase/refund recognition, pending-to-posted review, statement/debit review with SMBC and SBI Shinsei adapters; both writers record consumption claims, seals and commit rows ([ADR 0054](adr/0054-economic-consumption-guard.md))                                                                                                                                                                         | Full source coverage, installments/revolving/bonus rows, partial payments and refund allocation are incomplete; a statement paid by several debits is stated only by a pure planner nothing calls ([ADR 0074](adr/0074-card-statement-allocation-planner.md)), so it cannot be accepted; an SBI Shinsei debit cannot be accepted until its parser records its id's origin |
| State                | Provider-reported balances, holdings, valuations and card payables on a date; reported holdings changes between two dates, served by a route and a panel of the `/state` page ([ADR 0075](adr/0075-reported-holdings-change-between-dates.md)); a reconstruction fold, a knowledge selector and a one-account query served by a route, an agent read and a page ([ADR 0058](adr/0058-knowledge-selector-and-reconstruction-adapter.md)) | Full event-reconstructed balances/positions and all liabilities are incomplete                                                                                                                                                                                                                                                                                            |
| Rewards              | Bucket/quantity display; displayed and computed expiry apart with basis or closed reason; claim/read projections; pure simulation components                                                                                                                                                                                                                                                                                            | Useful forecasts need actual activity, verified rules, membership and applicable offers; no external exchange is performed                                                                                                                                                                                                                                                |
| Valuation/reports    | Provider price claims, pure valuation components, fixed report artifacts listed, re-displayed and exported from a read-only page ([ADR 0072](adr/0072-report-artifact-pages.md)) and as-of price/FX selection under an explicit policy                                                                                                                                                                                                  | No adopted selection policy, no general external price/FX acquisition or complete portfolio valuation product; no agent or MCP read of reports                                                                                                                                                                                                                            |
| Cost basis/P&L/tax   | Typed input/policy gates, decomposition components and a pure lot engine over provisional inputs                                                                                                                                                                                                                                                                                                                                        | `costBasis()` always returns `needs-policy`; the lot adapter answers `unsupported` (no securities writer); transfers, persistence, P&L and tax are absent                                                                                                                                                                                                                 |
| AI/MCP               | Shared query/explanation/proposal service, `/mcp` transport, a maintenance-window read on both agent paths, the common audit log, and the operator's read-only delegation notice on the schedules and confirm pages                                                                                                                                                                                                                     | The committed configuration grants one MCP reader summary and record reads and no schedule, proposal or evidence capability; `MCP_DELEGATIONS` is empty and no delegated operation executes (the maintenance revision tool refuses every call); configuration is not evidence that a client connected                                                                     |

## Source and execution blockers

- The [PRESTIA bank Worker](../services/collector-prestia-bank/) registers sanitized
  account-summary snapshots separately from GLOBAL PASS. Native-currency available
  amounts and term principal are balances; bank yen equivalents and three monthly
  qualification averages are non-additive valuations exposed through existing
  observation details, not added to native balance rows. Synthetic tests cover the
  production run plan through registration, parsing, publication and readback.
  Local authenticated page evidence is not deployed Worker evidence. Deployment,
  first production collection/publication and separate schedule activation remain
  pending; its daily 06:30 JST alarm is disabled. See [ADR 0042](adr/0042-prestia-bank-worker.md),
  the [plan](plans/2026-10-prestia-bank-worker.md) and the
  [dated source update](sources/prestia.md#prestia-bank-worker-integration-2026-10-05).

- Vpass collector statement pages remain withheld from a parser dataset pending
  trustworthy card-identity continuity. Saved pages are not automatically usable
  financial rows. See [card identity](vpass-card-identity.md) and
  [ADR 0022](adr/0022-registration-artifact-datasets.md).
- MyJCB partial/unsafe unit coverage is not promoted into complete statement
  evidence. GLOBAL PASS pagination support does not by itself prove that a
  particular production month's capture and parse are complete.
- GLOBAL PASS shared runs have no transaction observations yet: the only
  admitted run (fetch_run 989, 2026-10-04, one page per selected month)
  captured two empty months (no Found line, no pager, no table). 1.1.0
  refused both; `global-pass-activity@1.2.0` (deployed 2026-10-04) reads them
  `ok` with no row, and they are those months' current empty snapshots. Of the
  72 parse-eligible activity pages, 1.2.0 reads 70 `ok` (48 importer-era
  pages with the same 372 rows as 1.1.0, and 22 empty pages in 7 months: 20
  importer-era, 2 from run 989) and refuses 2 importer-era pages
  (`parser_rejected`, as under 1.0.0 and 1.1.0). Which check refused those 2
  is not stored; the owner's counts-only replay
  (`replay-diagnostics.ts globalpass-activity 2`, see
  [operations](operations.md#replaying-a-parser-rejection)) names it. For one
  of them it reported `unclassified_table`: 10 records but 9 detail pairs
  and a two-header table whose meaning is unobserved; the replay now also
  prints which record each pair carries and how that table compares, as
  closed values, and no parser change has followed
  ([observations](observations.md#global-pass-a-refused-page-has-ten-records-and-nine-detail-pairs-replay-diagnostics-no-parser-release)).
  The empty month was observed in English only. A newer empty capture of a
  month supersedes an older capture with rows under the per-month rule; since
  2026-10-08 `/api/meta` names such months (`globalPassEmptyMonths`) and the
  web app shows a notice to check the provider, without changing what is
  current (implemented; its deployment is not asserted here). A read-only
  count on 2026-10-08 found no such month in production (7 months with an
  empty current snapshot, none with older rows). See
  [observations](observations.md#global-pass-empty-months-are-read-as-no-rows-activity-parser-120).
- Money Forward identity revisions and the SBI Shinsei bank adapter are
  implemented; fresh production adoption/mapping counts are not asserted here.
- Collection and unattended session-refresh operations are connected to the
  alarm's private named collector RPC by the
  [operation dispatcher](../services/processor/src/operations/dispatch.ts)
  ([ADR 0048](adr/0048-operation-collector-dispatch.md)): one start per
  operation under the same execution lease, closed wait/failure/expiry states,
  and a trail from the request id to the reported runs, their registration,
  parse and CORE publication or a closed reason
  (`GET /api/ops/v1/operations/{id}`). No connection is enabled in the
  committed `OPS_COLLECTOR_DISPATCH_CONNECTIONS`, so requests wait and expire
  after 24 hours; production dispatch is unverified. Collectors run their daily
  scope, not a requested window; READ projection of a run is not traced; only
  SBI VC's keepalive is an unattended session refresh. An accepted operation is
  still not an executed collection.
- SMBC Direct unattended login and V Point Pay automatic app login remain
  unsupported. V Point email collection is a separate supported path.

## Configured enablement and API access

The committed [App config](../services/app/wrangler.jsonc) and
[Processor config](../services/processor/wrangler.jsonc) enable their existing
boolean feature flags, including scheduling, operations, purchase recognition,
rewards, reports and READ projections. CORE migrations reach 0078 (no
file uses 0067, 0073, 0074 or 0076); READ reaches 0004. The Processor's
`OPS_COLLECTOR_DISPATCH_CONNECTIONS` is empty, so the operation dispatch lane
calls no collector. These are repository facts, not live database/deployment readback.

App names a human operator in `OPERATOR_SUBJECTS`. `AGENT_GRANTS` and
`MCP_DELEGATIONS` are empty. `AGENT_API_GRANTS` holds one entry, for the
owner's MCP client (#640): `summary.read` and `records.read`, and no
proposal, evidence or schedule capability, so it reads no maintenance window
and can revise none. `/mcp` accepts only identities from a dedicated MCP
Access application (Cloudflare Access Managed OAuth), whose audience
`ACCESS_MCP_AUDIENCE` names, binds each to the agent-only principal
`mcp-client:<sub>` and serves it no operations tool. Configuration is not
evidence that a client connected ([ADR 0047](adr/0047-mcp-client-connection.md),
[connecting a client](agent-api.md#connecting-an-mcp-client)). See
[agent API](agent-api.md) and [operations API](ops-api.md).

The schedules and confirm pages show the delegation table as the App reads
it (`GET /api/v2/delegations`, operator only,
[agent API](agent-api.md#the-operators-delegation-status-s8-2026-11-06)):
with the committed empty value they say that no delegation exists, so no AI
approves, commits or changes a setting.

Schedule and maintenance edits use the operator-only
[HTTP settings API](schedules.md#settings-api), with version checks, verified
Access identity, same-origin JSON and the settings header. This API exists for
the management screen. An agent holding `schedules.read` can read maintenance
windows through the [maintenance tools](schedules.md#agent-maintenance-tools);
revising one through MCP is an operation the owner may delegate
([ADR 0063](adr/0063-delegated-ai-operation-path.md)), which no delegation can
execute until slice S3 connects delegated execution, so every such call is
refused. No grant or delegation holds a schedule capability.

## Next work

The next product milestone is card usage → statement → bank debit with an
explainable trail and no double expense. Finish representative coverage and
identity gaps, then extend dated holdings/liabilities, valuation, lots/P&L and
tax. Rewards can progress in parallel. See the [roadmap](roadmap.md) for delivery
order and acceptance criteria. Delegated maintenance revisions wait for slice
S3 (delegated execution and its audit record) and the owner's first delegation
entry; deferrals beyond seven days wait for the owner's answer to the
[plan's](plans/2026-10-ai-operation-path.md#10-questions-for-the-owner)
question 1. The official-site maintenance re-survey is
implemented as a proposal-only Processor lane
([ADR 0050](adr/0050-maintenance-survey-proposals.md),
[schedules](schedules.md#official-site-re-survey)), but no page is allowed
and its flag is unset: it has never fetched a provider page, and its reading
grammar is verified on synthetic text only.
