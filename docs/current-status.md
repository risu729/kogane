# Current implementation status

Type: maintained reference. Reviewed: 2026-10-05 against main `dcf8aca` and the
PRESTIA bank Worker integration.
This is a code/configuration assessment, not a fresh production acceptance run.
Implementation, configured enablement, deployment and verified real-data coverage
are separate claims. Historical acceptance records are linked from the
[documentation index](README.md#historical-records).

## Implemented capabilities and limits

| Area                 | Implemented                                                                                                                                                     | Remaining boundary                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Collection           | Twelve enabled daily collector schedules, shared raw evidence and source-specific manual paths; separate PRESTIA bank Worker implemented                        | A collector's presence does not prove every account/data type is captured or published                                     |
| Evidence and parsing | Immutable raw evidence, sealed inventories, versioned parsers, adoption and replay                                                                              | Older permanently blocked terminals remain blocked; partial or unsupported shapes remain explicit                          |
| Collection quality   | Read-only per job, source and source/unit/dataset/period stage states in closed reason codes ([ADR 0045](adr/0045-collection-quality-read.md))                  | No page yet; not verified on production; some per-query rules, empty captures and retention caps are not distinguished     |
| Scheduling           | Fourteen active alarm jobs: twelve daily collectors, SBI VC keepalive and Processor tick; two unsupported source jobs and the pending PRESTIA bank job disabled | Maintenance research is manually refreshed; a saved setting with pending reservation is not an armed alarm                 |
| UI                   | Evidence/history, transactions, balances, positions, reported state, card review and schedule settings                                                          | A view or empty list is not proof of complete financial coverage                                                           |
| Identity             | Source-local identities, mappings and append-only decisions                                                                                                     | Cross-source account/instrument equivalence and unresolved identities still need review                                    |
| Card flows           | Vpass/MyJCB single-payment purchase/refund recognition, pending-to-posted review, statement/debit review with SMBC and SBI Shinsei adapters                     | Full source coverage, installments/revolving/bonus rows, partial payments and refund allocation are incomplete             |
| State                | Provider-reported balances, holdings, valuations and card payables on a date                                                                                    | Full event-reconstructed balances/positions and all liabilities are incomplete                                             |
| Rewards              | Bucket/quantity/observed-expiry display, claim/read projections and pure simulation components                                                                  | Useful forecasts need actual activity, verified rules, membership and applicable offers; no external exchange is performed |
| Valuation/reports    | Provider price claims, pure valuation components and fixed report artifacts                                                                                     | No general external price/FX acquisition or complete portfolio valuation product                                           |
| Cost basis/P&L/tax   | Typed input/policy gates and decomposition components                                                                                                           | `costBasis()` always returns `needs-policy`; lots, disposal allocation and complete P&L/tax outputs are absent             |
| AI/MCP               | Shared query/explanation/proposal service and `/mcp` transport exist                                                                                            | Agent grants are empty; maintenance has no MCP tool; client access is not established by having an adapter                 |

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
  [operations](operations.md#replaying-a-parser-rejection)) names it. The
  empty month was observed in English only. See
  [observations](observations.md#global-pass-empty-months-are-read-as-no-rows-activity-parser-120).
- Money Forward identity revisions and the SBI Shinsei bank adapter are
  implemented; fresh production adoption/mapping counts are not asserted here.
- Generic collection/session-refresh operations still reach
  `awaiting_collector_dispatch` in the
  [operation dispatcher](../services/processor/src/operations/dispatch.ts).
  An accepted operation is not an executed collection. The alarm's private named
  collector RPC path is separate and implemented.
- SMBC Direct unattended login and V Point Pay automatic app login remain
  unsupported. V Point email collection is a separate supported path.

## Configured enablement and API access

The committed [App config](../services/app/wrangler.jsonc) and
[Processor config](../services/processor/wrangler.jsonc) enable their existing
boolean feature flags, including scheduling, operations, purchase recognition,
rewards, reports and READ projections. CORE migrations reach 0066; READ reaches 0002. These are repository facts, not live database/deployment readback.

App names a human operator in `OPERATOR_SUBJECTS`. `AGENT_GRANTS` and
`AGENT_API_GRANTS` remain empty. The MCP handler requires an agent-API grant
before listing tools, including the separate operations tool set; the operations
flag alone does not make MCP usable. See [agent API](agent-api.md) and
[operations API](ops-api.md).

Schedule and maintenance edits use the operator-only
[HTTP settings API](schedules.md#settings-api), with version checks, verified
Access identity, same-origin JSON and the settings header. This API exists for
the management screen. AI access needs a deliberately designed authentication
and permission path plus a maintenance MCP adapter; these are not implemented.

## Next work

The next product milestone is card usage → statement → bank debit with an
explainable trail and no double expense. Finish representative coverage and
identity gaps, then extend dated holdings/liabilities, valuation, lots/P&L and
tax. Rewards can progress in parallel. See the [roadmap](roadmap.md) for delivery
order and acceptance criteria. Maintenance MCP access and automatic research
refresh are separate unfinished capabilities.
