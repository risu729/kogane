# Architecture decision records

ADRs preserve the context, options, decision and consequences at adoption time.
Their original status/date and wording remain history; they are not current
release instructions. A changed choice needs an amendment or superseding ADR
and an update to the maintained reference. Conditional "accepted upon merge"
status means acceptance follows that record's merge, not that all later
verification/open risks are complete.

Use [current status](../current-status.md), [design](../design.md),
[rollout controls](../rollout.md) and the [documentation index](../README.md)
for current behavior.

- [ADR 0001: Keep A/B/C/D as provenance, add independent domain axes](0001-domain-axes.md)
- [ADR 0002: Recognise card purchases per provider row, one live holder per key](0002-card-purchase-recognition.md)
- [ADR 0003: Relative period labels are evidence; the month is derived afterwards](0003-relative-period-labels.md)
- [ADR 0004: Accept only the payment-type shapes production evidence shows](0004-payment-type-shapes-from-evidence.md) — accepted; amendment 2026-11-07 (accepted): closed reasons for unrecognised rows and `refundsAllocated: false` on the purchases read and `kogane.purchases.explain`
- [ADR 0005: Decide the MyJCB statement state from the page, not export links](0005-myjcb-statement-state-from-page.md)
- [ADR 0006: Keep the reconciliation lane to provider identifiers and the matching window](0006-reconciliation-lane-scope.md)
- [ADR 0007: Key MyJCB confirmed statements by the payment month the page names](0007-myjcb-statement-identity.md)
- [ADR 0008: Run 28 repair jobs and 40 identity runs a tick, with the D1 call risk documented](0008-repair-lane-throughput.md)
- [ADR 0009: Lane tick records are bounded operational state](0009-lane-tick-records.md) — accepted; amended 2026-11-06 (#947): the settlement sweep counts its unmatched statements
- [ADR 0010: Bound terminal registration by a per-invocation operation budget](0010-terminal-registration-budget.md)
- [ADR 0011: Resolve settlement ownership through keyed CTEs, keep the 0044 views as the contract](0011-keyed-ownership-ctes.md)
- [ADR 0012: Map Mizuho ordinary deposits under identity policy version 2](0012-mizuho-identity-policy-v2.md)
- [ADR 0013: Give agents card purchases through a separate read-only tool](0013-agent-card-purchase-read.md) — accepted; amended by ADR 0063
- [ADR 0014: A shared-R2 collector's producer is `collector-<collector id>`](0014-collector-producer-ids.md)
- [ADR 0015: Source authority v2 names CORE source ids](0015-source-authority-v2.md)
- [ADR 0016: Key MyJCB pending statements by payment month, current while their position shows them](0016-myjcb-pending-statement-slots.md)
- [ADR 0017: Add card purchase review command kinds with one rebuild, not relation markers](0017-card-purchase-review-commands.md)
- [ADR 0018: SBI Shinsei as the second bank debit adapter of card settlement review](0018-sbi-shinsei-bank-debit-adapter.md)
- [ADR 0019: Reported state on a date from the latest complete capture before it](0019-dated-reported-state.md) — accepted; agent read `kogane.reported-state.read` (amendment 2026-11-06, #953)
- [ADR 0020: Prices are provider observations promoted by a closed rule list](0020-price-promotion-by-rule.md)
- [ADR 0021: Collectors state the registration contract; the Processor's refusals stay](0021-collector-registration-contract.md)
- [ADR 0022: Give registered shared-R2 artifacts their parser dataset](0022-registration-artifact-datasets.md)
- [ADR 0023: Do not trust a card binding for collector-vpass runs until the collector writes one](0023-vpass-collector-card-binding.md)
- [ADR 0024: The collection scan does not spend registrations on terminals already judged](0024-collection-scan-judged-terminals.md)
- [ADR 0025: The MyJCB metadata extractor reads both manifest shapes](0025-myjcb-shared-manifest-metadata.md)
- [ADR 0026: A collector's unit coverage is a claim about what the run set out to collect](0026-collector-unit-coverage.md)
- [ADR 0027: The MoneyForward collector derives the account identity the parser requires](0027-moneyforward-collector-account-identity.md)
- [ADR 0028: The SBI Shinsei parsers accept the shapes the stored captures carry, with the unknowns kept as reasons](0028-sbi-shinsei-observed-capture-shapes.md)
- [ADR 0029: Data classification for central storage; Vpass and MoneyForward identities derived without a secret](0029-data-classification-and-unkeyed-identity.md)
- [ADR 0030: A one-time identity-value rewrite from importer-era to collector-era account identities (first decided as a crosswalk)](0030-identity-crosswalk.md)
- [ADR 0031: The owner's SBI Shinsei stage category, as the same run states it, selects the FX board tier](0031-sbi-shinsei-stage-category-fx-tier.md)
- [ADR 0032: The card provider's stated debit account is settlement evidence, proposed and never accepted by rule](0032-provider-stated-debit-accounts.md)
- [ADR 0033: Avoid repeated historical reads in processor maintenance](0033-processor-unchanged-read-cost.md)
- [ADR 0034: Account evidence before automatic card settlement](0034-card-settlement-automation-prerequisites.md)
- [ADR 0035: Bound identity view expansion and skip unchanged reward capture](0035-identity-reward-read-cost.md)
- [ADR 0036: Observe covered D1 costs and failures per Processor lane](0036-lane-cost-observability.md)
- [ADR 0037: Admit reconciliation pages by evidence and reuse clean purchase retirement checks](0037-reconciliation-purchase-cost.md)
- [ADR 0038: Isolate complete hosted verification while sharing preparation](0038-shared-verification-preparation.md)
- [ADR 0039: Alarm scheduling and public maintenance rules](0039-alarm-schedule-management.md) — accepted; amended by ADR 0063 and ADR 0085
- [ADR 0040: Deploy compatible Workers through prebuilt cf versions](0040-compatible-cf-version-deployment.md)
- [ADR 0041: Separate maintained documentation from historical records](0041-documentation-scope.md)
- [ADR 0042: PRESTIA bank snapshots and non-additive provider measures](0042-prestia-bank-worker.md) — accepted; production verification pending
- [ADR 0043: Deploy the remaining Container Workers through cf](0043-cf-container-deployment.md) — accepted
- [ADR 0044: SMBC backfill continuation publication](0044-smbc-resume-publication.md) — accepted
- [ADR 0045: Collection quality is a per-request read of stored stage states, in closed codes](0045-collection-quality-read.md) — accepted; amended 2026-11-07: `kogane.collection-quality.read` under `evidence.read`; the per-account view is ADR 0088; amendment 2026-11-08: `collection-freshness-v1` ages and states per source and cell
- [ADR 0046: Maintenance windows as a separately granted agent capability](0046-agent-maintenance-windows.md) — accepted; amended 2026-10-09 by ADR 0063 (the revision is a delegated operation, executable since #660; since ADR 0084 by any MCP client Access admits, over every schedule)
- [ADR 0047: Connect MCP clients through Cloudflare Access Managed OAuth, as an agent-only principal](0047-mcp-client-connection.md) — accepted; the grant table removed by ADR 0084 (any MCP client the MCP Access application admits reads the whole store); a client connection is not asserted
- [ADR 0048: Run an accepted collection or session refresh once through the named collector RPC](0048-operation-collector-dispatch.md) — accepted; production dispatch unverified; amended 2026-11-07 (`projected` derived from the READ pointer, proposed); 2026-11-07 amendment (依頼の経過 page) proposed; amended 2026-11-08 (a collection past 100 runs answers `run_ids_over_limit`, proposed)
- [ADR 0049: Keep the displayed and the computed reward expiry apart, each with its basis](0049-reward-expiry-basis.md) — accepted; offer simulation amended 2026-11-06 (#937): offer-set bound, caller-named version, reported search stops
- [ADR 0050: Re-survey official maintenance pages as proposals an operator accepts](0050-maintenance-survey-proposals.md) — accepted; no page enabled until the owner confirms it
- [ADR 0051: A pure lot engine over a provisional input contract](0051-provisional-lot-engine.md) — accepted; its adapter is ADR 0059
- [ADR 0052: Reconstructed state is a pure fold over a provisional adopted-event input, compared with reported snapshots](0052-reconstructed-state-fold.md) — accepted; amended by ADR 0058
- [ADR 0053: A closed transaction-family registry states which families have an event writer and why the others do not](0053-transaction-family-registry.md) — accepted
- [ADR 0054: One consumption guard for every economic writer: claims, seals and a commit log](0054-economic-consumption-guard.md) — accepted
- [ADR 0055: Propose cross-identifier instrument candidates from stored identifier facts; adopt only through a person's mapping](0055-instrument-candidates.md) — accepted; route, page and agent read amended 2026-10-09
- [ADR 0056: Price and FX selection at an as-of under an explicit, versioned policy](0056-as-of-price-fx-selection.md) — accepted; policy values are open questions
- [ADR 0057: Own-transfer proposals under an explicit policy, and planners that stay unregistered behind the production gate](0057-own-transfer-proposals.md) — accepted; no policy, no lane, planners unregistered
- [ADR 0058: A knowledge selector reads adopted events at a commit-log cut, and a B adapter feeds the reconstruction fold](0058-knowledge-selector-and-reconstruction-adapter.md) — accepted; served by `GET /api/v2/reconstructed-state`, `kogane.reconstructed-state.read` and `/reconstruction` (amendment 2026-10-09)
- [ADR 0059: A C adapter maps selected revisions to lot inputs, and answers unsupported until a securities writer exists](0059-lot-adapter-from-selected-revisions.md) — accepted; no securities writer, no route
- [ADR 0060: Resume verification of an exact published Container](0060-container-publication-checkpoint.md) — accepted (merged in #602)
- [ADR 0063: The AI is a delegated operation path: a verified MCP principal the owner names may apply operations within capability, scope, confirmation and audit](0063-delegated-ai-operation-path.md) — accepted; delegated execution implemented (#660); the `MCP_DELEGATIONS` declaration, roles, the delegation-status page and `AGENT_API_GRANTS` superseded by ADR 0084
- [ADR 0064: One append-only audit record per operation, for the human UI and the AI alike, referencing the existing logs](0064-common-audit-log.md) — accepted; CORE 0075; `alarm` and `lane` writers (S7) and the operator's `監査ログ` page (S8) amended 2026-11-06
- [ADR 0065: Collect native coverage by runtime, without a fabricated repository total](0065-native-test-coverage.md) — accepted; native measurements, no numerical threshold
- [ADR 0067: Current economic-row evidence readiness before event writers](0067-economic-row-readiness.md) — accepted; read-only diagnostic, served over HTTP and MCP to a whole-store `records.read` grant (S0b amendment, #995); no writer activation
- [ADR 0068: Preserve provider expiry subsets apart from reward holdings](0068-provider-reward-expiry-subsets.md) — accepted; natural production reward capture verification pending
- [ADR 0069: Retire collector-local public admin bearer entrypoints in bounded slices](0069-collector-admin-retirement.md) — accepted
- [ADR 0070: Validate observed SBI Shinsei history offline before enabling acquisition](0070-sbi-shinsei-observed-history-boundary.md) — accepted; offline-only request and capture inspection, no history acquisition or publication
- [ADR 0071: Let Renovate own dependency auto-merge](0071-remove-custom-automerge.md) — accepted; the custom merge workflow is removed
- [ADR 0072: List and re-display fixed report artifacts in the web UI](0072-report-artifact-pages.md) — accepted; catalogue route, `reportArtifacts` capability and read-only 評価レポート pages; amended 2026-11-06 (#942): export link, no agent report read yet; amended 2026-11-07: `kogane.reports.read` (list, detail, explanation; restricted and unavailable reports refused; no export)
- [ADR 0073: Count each source's instrument identifiers by their candidate state, in a read beside the account coverage](0073-instrument-coverage-per-source.md) — accepted; `GET /api/identity/instrument-coverage`, the `銘柄の整理状況` panel and (amendment 2026-11-06) the agent read `kogane.instruments.coverage`
- [ADR 0074: A pure planner states multi-debit allocations of a card statement and answers unsupported for partial payments and excesses](0074-card-statement-allocation-planner.md) — accepted; no writer; amended 2026-11-07: one read-only caller on the `カード照合` page and `kogane.card-settlements.unmatched` under a display policy; amended 2026-11-07 (proposed): each statement lists at most the first 50 allocations with `allocationCount` and `allocationsTruncated` (release `card-statement-allocation-v2`)
- [ADR 0075: Reported holdings change between two dates, per provider holding key, never totalled](0075-reported-holdings-change-between-dates.md) — accepted; an application query, served by a route, a wire contract and a panel of the `/state` page (2026-11-06 amendment); amended 2026-11-07: `kogane.reported-holdings-change.read`
- [ADR 0076: Classify SBI Shinsei's FX board and stage references as non-account statements under identity policy version 2](0076-sbi-shinsei-non-account-identity.md) — accepted; the sweep re-identifies SBI Shinsei parses append-only after deployment
- [ADR 0077: Propose aggregator-to-direct account containment from confirmed connection reviews; never propose the same account without leaf evidence](0077-account-connection-candidates.md) — accepted; read, route, agent tool and page; decisions through `relation.accept` / `relation.reject`; amendments 2026-11-08: a later proposal never replaces a pair's decision (accepted), and (proposed) one source account's correction history on the page and as `kogane.accounts.history`
- [ADR 0078: Refuse another site's Origin on the command and operations routes](0078-own-origin-state-changing-routes.md) — proposed; the agent paths' own-origin rule on every command and operations POST
- [ADR 0079: Index pending parse runs so the sweep's maintenance reads only them](0079-pending-parse-run-index.md) — accepted; additive partial index, migration 0083
- [ADR 0080: A change planned again after its plan expired is a renewal with its own id](0080-renew-expired-change-plans.md) — accepted; `createPlan` renews by lifetime-long window, `simulate` re-derives the id
- [ADR 0081: Every operation the web UI offers is also an MCP operation, served by the same application service](0081-ui-parity-through-mcp.md) — accepted; two screen-only `ui` entries and some read pages still lack MCP tools (the six `ops.*` tools are served to every MCP client since ADR 0084), all MCP-path SQL is in packages (import-graph guard test); catalogue and read-route guard tests with allow-listed gaps (`ui-mcp-parity.test.ts`); point 3 amended by ADR 0084; amended 2026-11-07: raw evidence bytes over MCP (`kogane.evidence.raw.read`, `evidence.read`, up to 1 MiB)
- [ADR 0082: An account with no recorded owner is the owner's, recorded per account as an owner-default ownership decision](0082-owner-default-ownership.md) — accepted; a closed marker on the existing ownership review, no read-time default
- [ADR 0083: Release the Vpass collector's statement pages under `terminal-registration-v3`; only a successful card run is parsed](0083-release-vpass-collector-statement-pages.md) — accepted; ends ADR 0022's Vpass withholding
- [ADR 0084: Every MCP client Access verifies acts with the UI's authority; MCP_DELEGATIONS and AGENT_API_GRANTS are removed](0084-mcp-operator-authority-without-delegation.md) — accepted; supersedes ADR 0063's declaration, roles and delegation-status page, and ADR 0047's grant table
- [ADR 0085: A collection execution lease proves its holder alive; the Processor frees a lease whose holder went silent](0085-collection-lease-heartbeat.md) — proposed; heartbeat (CORE 0082), 13-minute self-stop, `alarm.lease.expire` on every `processor-tick`
- [ADR 0086: Operations requests are read and listed whole-store, newest first, through the indexes of migration 0040, on the route and over MCP](0086-operator-operations-list.md) — proposed; `GET /api/ops/v1/operations` and `kogane.ops.operation.list` over `listOperations`, the single-operation read whole-store too (owner, 2026-11-08 04:21 UTC), no migration, no web page
- [ADR 0087: A checked-in catalogue of the data types each provider offers makes uncollected data visible](0087-provider-data-type-catalogue.md) — accepted; `provider-data-types-v1` per collected source in the collection-quality summary, page and MCP read
- [ADR 0088: Regroup one source's collection quality cells by the accounts their captures' observations name](0088-collection-quality-per-account.md) — proposed; `GET /api/collection-quality/<sourceId>/accounts`, the `口座ごと` view and `view: "accounts"` on `kogane.collection-quality.read`, through the routes' one reader (ADR 0081); the cell page's SQL is unchanged byte for byte; no migration
- [ADR 0089: Classify the MyJCB J-POINT total under identity policy 2, for J-POINT captures only](0089-myjcb-jpoint-identity.md) — accepted; `reward-account` / `provider-local`, re-identifies J-POINT captures only so the statement root's mapping id stays
