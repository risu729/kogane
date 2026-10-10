# ADR 0055: Propose cross-identifier instrument candidates from stored identifier facts; adopt only through a person's mapping

- Status: accepted (merged 2026-10-08 in #578); the
  [2026-10-09 amendment](#amendment-2026-10-09-route-and-page-as-implemented)
  (route, page, agent read tool and cost) is proposed
- The [server anchor and history amendment](#amendment-2026-10-09-server-anchor-and-history) below is proposed.
- Date: 2026-10-08
- Issue: part of #546

## Context

The identity layer gives every provider reference for an instrument an
identifier (`instrument_identifiers`: namespace, scope, value and the detail
keys the rule recorded) and, by rule, an instrument of its own
(`instrument_<digest of the identifier>`). Identifiers in a listing namespace
(`mic-symbol` with a MIC scope, `ric`) are shared by every source that states
the same value. Everything else stays provider-local
([identity](../identity.md), [SBI identity](../identity-sbi.md)).

Today only SBI Securities and SBI VC Trade store security, crypto or product
identifiers. No second broker stores securities, so no cross-broker pair
exists in production yet. One security already appears under two identifiers
inside SBI, though:

- a domestic trade on a venue label the SBI rule does not map gets
  `sbi-security-code/JP/<code>`, while the position of the same code on a mapped
  venue gets `mic-symbol/<MIC>/<code>`;
- a foreign trade without a RIC gets `sbi-security-code/<country>/<code>`, while
  the position gets `ric//<RIC>`.

Correction already exists: `identity.assign` appends a manual mapping
revision with its decision through the change lifecycle, which grants approval
and commit to humans only ([change lifecycle](../change-lifecycle.md)).
[2026-10-09: that is today's grant lists, not a principle: only
`OPERATOR_SUBJECTS` may approve or commit under them; see the
[amendment](#amendment-2026-10-09-route-and-page-as-implemented).]
`listed_as` is a typed relation kind (ADR 0001, UC31), and `relation.accept` /
`relation.reject` can already name `instrument:` and `identifier:` references.
What was missing is the statement of which identifiers may denote the same
instrument, on what evidence, which pairs are known to differ, where each
identifier stands and how it got there. Issue #546 asks for this without ever
applying a price, a quantity or a cost to a different product (share class,
hedged and unhedged funds, another listing, a product instead of its coin).

## Options considered

1. **Merge by rule on an equal code or ISIN** (one rule-created instrument for
   both). Rejected: a rule would change adopted state (INV07); a security code
   is a ticker in some markets; one ISIN has several listings and prices.
2. **Match display names with a similarity score.** Rejected: names are
   display claims ([preferred names](../instrument-display-names.md)), equal
   names cover different products, and a score is not evidence (the same rule
   as `reconcile.ts`).
3. **Store candidates and add a command kind (`instrument.link`) with a
   migration.** Rejected for this step: candidates are derivable from stored
   facts at read time, so a stored copy could drift from them, and
   `identity.assign` already writes exactly the append-only manual revision
   and decision an adoption needs.
4. **A pure candidate function over stored identifier facts, closed evidence,
   conflict and gap codes, adoption by `identity.assign` and keeping apart by
   `relation.reject` of `listed_as`.** Chosen.

For the "keep apart" record, a new relation kind (`different_instrument`) needs
the `entity_relations` kind CHECK rebuilt by a migration; `contradicts` is a
claim about evidence, not about what an identifier denotes; recording nothing
leaves a rejected pair open forever. A rejected `listed_as` from the anchor's
instrument to the other identifier says "this identifier is not a listing of
that instrument", which is the judgement.

## Decision

`packages/domain/src/instrument-candidates.ts` (policy
`instrument-candidates-v1`), `packages/read-model/src/instrument-resolution.ts`
and `packages/application/src/query/instrument-resolution.ts`:

1. **Scope.** Identifiers whose current mapping targets a `security`, `crypto`
   or `product` instrument and that a currently published, sealed identity
   observation uses. Money and reward units are not paired.
2. **Evidence** (a pair must share one): an equal ISIN, an equal RIC, or an
   equal (country, security code), each as an identity rule recorded it. Only
   the listing namespaces (`mic-symbol` scope as MIC, `ric` value as RIC,
   `isin` value as ISIN) and the detail keys `securityCode`, `countryCode`,
   `ric`, `isin`, `shareClass` and `productClass` are read. No rule records an
   ISIN today; the rule that first records one validates its format.
3. **Conflicts** keep a pair apart, listed as `separated`, never a candidate:
   instrument kind, ISIN, RIC (two RICs are two listings), country, MIC,
   currency, share class and product class, each when both sides state it and
   they differ. Currencies conflict when the two stated sets are disjoint.
   A pair on two instruments is compared as those two instruments: every
   identifier that maps to one side's instrument now is compared with every
   identifier that maps to the other's, and any conflict among them separates
   the pair. `via` names the identifiers other than the two whose facts
   produced a conflict. So once a person maps a bare code onto one listing, a
   second listing of the same code on another market is separated from that
   code (`market-differs` via the first listing) instead of being offered as a
   place to move it. Two identifiers already on one instrument are a decision:
   only their own facts are reported against it (`sharedInstrument`).
4. **Gaps** name what at least one side does not state, one side or both
   (ISIN, market, currency, share class, product class). Since no identity
   rule records an ISIN, share class or product class today, every candidate
   names those three gaps. A candidate with gaps is still only a proposal.
5. **Market** is compared through MIC or RIC only. The provider's own market
   wording is shown to the reviewer and never compared: SBI's codes and labels
   already differ between its own datasets.
6. **Currency** of an identifier: each observation that uses it as a
   security is denominated by the `trade-unit` of the same identity
   observation; by its `unit` only when there is no `trade-unit` or the
   `trade-unit` is a crypto asset code (`provider-asset-code`, the base of an
   SBI VC Trade product). A denominating unit that is a resolved currency
   (`iso4217`, `currency-variant`) is stated; any other (a trade currency
   outside the explicit catalogue, stored as `unresolved-currency`), or no
   unit at all (a position row with no currency, which the SBI rule records
   only as `missing-monetary-unit`), makes the identifier's currency
   unconfirmed, so its pairs report
   `currency-unconfirmed`: such a use is neither dropped nor replaced by the
   settlement unit. The identifier's set is the distinct stated values. A use
   in another role states none. Valuation observations count like any other
   use: SBI's foreign position valuations are stated in yen as well as in the
   trading currency, so a foreign RIC identifier traded in USD reads as
   {JPY, USD}, and a pair with it is `currency-unconfirmed` rather than
   agreeing.
7. **Names** are never evidence. Two identifiers whose names are equal after
   NFKC, whitespace and case normalisation, and that share no evidence, are a
   `hint` with the conflicts already known; a hint has no status and no
   command. Two identifiers already on one instrument are not hinted, and a
   label that is only the identifier's own value or security code (the SBI
   rule falls back to the code when the provider gives no name) is not a name
   and hints nothing.
8. **Status from stored records only.** `adopted` when both identifiers map to
   one instrument now; `rejected` when the newest `listed_as` relation from
   either identifier's current instrument to the other identifier is rejected;
   otherwise `proposed`. An accepted `listed_as` relation alone is not
   adoption.
9. **Identifier states.** `unresolved-candidates` (a proposed candidate
   waits), `resolved-by-decision` (it shares its instrument and a manual
   mapping made that so), `shared-without-decision` (shares it with no manual
   mapping; no rule produces this, and it is not read as resolved),
   `kept-separate` (every candidate rejected), `no-candidate`.
10. **Commands** a proposed candidate names, for a person to plan with a
    reason: adopt is `identity.assign` of the subject identifier to the
    anchor's instrument; keep apart is `relation.reject` of `listed_as` from
    `instrument:<anchor's instrument>` to `identifier:<subject>`. An identifier
    that is settled (its current mapping is manual, or its instrument is
    shared with another identifier) is always the anchor over one that is
    not, so an adoption never moves a decided identifier. Between two settled
    or two unsettled identifiers the anchor is ranked by ISIN first, then a
    listing identifier (RIC or MIC), then a provider code; a tie goes to the
    lower id. When both are settled the candidate stays `proposed` with a
    closed `hold` code: `subject-decided-elsewhere` (the subject's mapping is
    manual) or `subject-shares-instrument` (re-mapping it would split a
    shared instrument). The hold withholds only the adopt command; moving a
    settled subject is a person's correction of the earlier decision, not an
    adoption. The keep-apart command is still named, because a rejected
    `listed_as` moves no mapping: without it a held candidate could never be
    closed and its identifiers would stay `unresolved-candidates`.
11. **History** of an identifier: every mapping revision, every decision on
    the mapping and every `listed_as` relation naming it, oldest first.
12. **Bounds.** 5,000 pairs, 1,000 hints, 10,000 fact rows and 10,000
    relations; a larger read is refused, never cut. A history read names at
    most 100 identifiers and is refused beyond that; the cap is on
    identifiers, not rows, so every entry of each named identifier is
    returned. The group comparison of §3 (`instrumentConflicts`) has no
    separate budget: it runs once per pair of instruments that share an
    evidence pair, comparing every identifier of one with every identifier
    of the other, so its work is bounded by those instrument pairs times
    their group sizes, all within the 10,000-row facts bound.

No migration, route or page is part of this decision.

**Libraries.** No dependency is added. The comparison, the codes and the
states are this application's business rules. Name normalisation is the
platform's `String.prototype.normalize("NFKC")`, as the parsers already use it;
stored detail JSON is read with the identity rules' own `record` and `string`
helpers; the read uses the existing `SqlExecutor` port and the decisions use
the existing change lifecycle and identity writer. No ISIN validator is
written here: the rule that first records an ISIN owns its validation and
should evaluate a maintained implementation (the `validator` package's
`isISIN`, for example) against the Bun and workerd setup at that point. The
tests reuse `packages/storage-d1/test/sqlite.ts`,
`packages/read-model/test/schema-template.ts` and the production
`identifyParse` writer rather than a second fixture writer.

## Consequences

- Nothing changes adopted state. The report job and price promotion still key
  holdings and prices by the provider-local `instrument:<source>:<market>:<code>`
  reference, and no reader uses the candidate set, so no price, quantity or
  cost crosses identifiers because of it.
- An adoption re-maps one identifier. It does not resolve a third identifier
  transitively: a candidate between the decided instrument and another
  identifier stays open until it is decided, with the decided identifier as
  its anchor, unless a fact stated by any identifier now on that instrument
  conflicts, in which case it is separated.
- A pair whose providers state amounts in different currencies (a foreign
  holding valued in yen at one broker, say) is separated, not proposed. A
  person can still assign it with `identity.assign`; the separated list names
  the conflict.
- A rejection names the instrument one identifier mapped to when it was made.
  If that identifier is re-mapped later, the rejection no longer names its
  current instrument and the pair is proposed again.
- Cross-broker candidates appear only when a second source's identity rule
  records a code and country, an ISIN or a RIC for securities. None does today.
- The facts read walks every current identity observation once, as the
  identity catalogue's instrument list does, and reaches each use's trade
  unit and unit by primary key. No index on
  `identity_instrument_uses(identifier_id)` is needed for that plan, and none
  is added. Its D1 cost is not measured and must be measured before a route
  serves the read. [Amended 2026-10-09: this precondition is replaced by a
  plan check without statistics plus `bun:sqlite` and workerd measurements,
  and a fail-closed bound on the observations the read walks; remote D1
  remains unmeasured. See the
  [amendment's Cost](#cost).]

Limits of this decision, stated so nobody reads more into an answer than it
says:

- **Country and code have no period.** Two identifiers with an equal
  (country, security code) are proposed whenever they were seen, even if the
  code was reassigned to another security after a delisting in between. No
  period is compared and no gap code names it; the only safeguard is that a
  candidate is a proposal a person decides.
- **A `listed_as` validity window is ignored.** The status read takes the
  newest `listed_as` relation per (instrument, identifier) whatever its
  `valid_from` and `valid_to`, so a rejection limited to a period reads as a
  permanent rejection. The keep-apart command this read names writes no
  window.
- **A rejection names an instrument, not an identifier.** A rejected
  `listed_as` from `instrument:<id>` to an identifier keeps that identifier
  apart from every identifier currently mapped to that instrument, not only
  from the anchor it was decided against.

## Explicitly not decided

- Mappings valid for a period (`identity.assign` has no validity); provider
  identifier changes over time (`replaces_identifier`).
- The HTTP route, page and MCP tool that serve this read.
- Which providers state ISIN, share class or product class: no identity rule
  records them, and no observation of them exists.
- Crypto identity across exchanges (network and contract): no observation.

## Verification

Synthetic data only, no production access. What the tests check, and
nothing more:

- `packages/domain/test/instrument-candidates.test.ts`:
  - evidence: an equal country-scoped code on one MIC is proposed with its
    agreements and gaps; a code without a MIC names `market-unconfirmed`;
    equal ISINs and equal RICs are evidence, an equal RIC states the market;
  - conflicts separate a pair: two MICs, two RICs, disjoint currencies, two
    share classes, two product classes, two countries, three instrument kinds;
    a conflict on two identifiers already on one instrument is reported with
    `sharedInstrument` and the decision stays;
  - gaps: an ISIN or share class on one side only, overlapping multi-currency
    sets, an unconfirmed currency (never agreeing or differing), and ISIN,
    share class and product class when both sides lack them;
  - names: equal normalised names without evidence are a hint with no status;
    same-name products with different ISINs and share classes stay apart;
    renaming either side changes nothing; no hint for two identifiers on one
    instrument or for a label that is only the code, while equal real names
    in two countries still hint with `country-differs`; normalisation is
    width, case and whitespace only;
  - status: an accepted `listed_as` alone does not adopt; a shared instrument
    is `adopted`; a rejection in either orientation rejects and a released one
    reopens; identifier states, including `shared-without-decision`;
  - instrument groups and orientation: S1 (a code a person mapped onto one
    listing is separated from a listing on another market, `via` the first),
    S2 (a decided identifier anchors a new one whichever id sorts first),
    both `hold` codes, and a held candidate closed by a rejection;
  - input-order independence; money and reward identifiers are not paired;
    more than 5,000 pairs, more than 1,000 hints and a duplicate identifier are
    refused.
- `packages/application/test/instrument-resolution.test.ts`, over CORE
  migrations with identifiers written by the production identity writer from
  synthetic SBI rows through the deployed SBI rules, synthetic SBI VC Trade
  rows through the deployed rule, and a synthetic second-broker test policy:
  - the read writes nothing; proposed, separated (two markets, two
    currencies) and hinted pairs; the provider's market wording is shown;
    every named command is a valid change payload once a reason is added;
  - an agent can plan an adoption but not approve it; a person's
    `identity.assign` adopts as a new manual revision with the rule revision
    kept, and the decided identifier then anchors the candidate still open
    with a third identifier; a person's `relation.reject` keeps a pair apart; the history lists
    both; a history read of more than 100 identifiers is refused;
  - S1 and S2 through the change lifecycle, with the anchor, the adopt and
    keep-apart payloads, and `subject-decided-elsewhere` with no adopt
    command once a person maps the subject elsewhere; a person's
    `relation.reject` from that keep-apart command closes both held
    candidates as `rejected` and leaves nothing unresolved;
  - currencies: an unresolved trade currency is unconfirmed rather than the
    settlement unit; a position with no currency makes the identifier
    unconfirmed; an SBI VC Trade product states its quote unit;
  - an unpublished capture and a superseded parse contribute no identifier;
  - each read asks for one row past its bound, and a stub returning 10,001
    fact rows or 10,001 relations is refused;
  - query plans: no observation table is named, identifier uses (and each
    use's trade unit and unit) are reached by primary key, and mappings,
    decisions and relations by index.
- `mise run //packages/domain:ci`, `mise run //packages/read-model:ci`,
  `mise run //packages/application:ci`, `mise run ci:root`.

D1 cost of the facts read is not measured (see Consequences). [Amended
2026-10-09: measured on `bun:sqlite` and on workerd through Miniflare, not on
remote D1; see the [amendment's Cost](#cost).]

## Amendment 2026-10-09: route and page as implemented

- Status: proposed (until its PR merges)
- Date: 2026-10-09
- Issue: part of #546; the owner approved this slice on 2026-10-09
  ("候補confirm/reject UI・既存service接続")
- Carried by: `reviewInstrumentCandidates` and
  `parseInstrumentCandidatesRequest` in
  `packages/application/src/query/instrument-candidates-review.ts`;
  `services/app/src/instrument-candidates-api.ts` (the route), the
  `kogane.instruments.candidates` case of `services/app/src/agent-service.ts`
  and its schema in `services/app/src/mcp.ts`;
  `packages/observation-shared/src/instrument-candidates-contract.ts` (the
  wire check); `apps/web/src/pages/InstrumentCandidates.tsx`,
  `apps/web/src/instrument-candidates-api.ts` and
  `apps/web/src/instrument-candidate-display.tsx` (the page)

### Context

The decision above left the HTTP route, the page and the MCP tool undecided
and required the facts read's D1 cost to be measured before a route served it
(Consequences, last item). The owner approved connecting the read to the
existing services and a page. The owner's direction for this slice:
everything a person can do through the UI, an AI holding explicit
owner-delegated grants should be able to do through the same application
layer, so the route and page add no new human-only constraint and keep the
existing grant checks exactly as they are; the agent read is the main path;
the delegated AI operation path and the shared audit log for human and AI
operations are designed in [ADR 0063](0063-delegated-ai-operation-path.md)
and [ADR 0064](0064-common-audit-log.md), not here.

### Options considered

1. **An operator-only route, like the card settlement review.** Rejected: it
   adds a human-only check to a read, which the owner's direction excludes,
   and an agent would need a second, stripped read.
2. **Separate reads for the page and for an agent.** Rejected: two answers
   to one question that neither can show to be wrong (AT72).
3. **A new command kind (`instrument.link`, `different_instrument`) for the
   two decisions.** Not needed: the decision above already names
   `identity.assign` to adopt and `relation.reject` of `listed_as` to keep
   apart, and both are change kinds the lifecycle plans today. No migration.
4. **One application service graded by a grant, called by the route with the
   browser's reader grant and by an agent tool with the agent's grant;
   decisions planned through the existing command API.** Chosen.
5. **For the cost precondition:** measure on remote D1 (not possible here:
   no production or remote store is read for this work), or replace it with
   the plan check without statistics, `bun:sqlite` and workerd measurements
   and a fail-closed bound on what the read walks. The second is chosen; see
   Cost.

### Decision

1. **Service.** `reviewInstrumentCandidates({ grant, sql, request })` returns
   one page of `queryInstrumentResolution`, or a `financial-error-v1`
   refusal. It requires `records.read` (`unauthorized`,
   `capability:records.read`) and a whole-store perimeter, sources and
   accounts `"*"` (`evidence_restricted`, `scope:source` / `scope:account`):
   candidates pair identifiers across sources, so a listed grant would be
   shown identifiers or counts outside it. Both refusals, and the paging
   budget, are decided before anything is read.
2. **Request**, a closed object: `view` (`open`: proposed with no hold;
   `held`: proposed with a hold; `decided`: adopted or rejected;
   `separated`; `hints`; default `open`), `offset` (0 to 5,000, the pair
   bound) and `identifierId` (only the items naming that identifier;
   `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`). An unknown key is
   `unsupported_semantics`, a malformed value `invalid_query` naming the key,
   an identifier the read does not hold `evidence_restricted`
   (`identifierId`).
3. **Answer** (`kogane-instrument-candidates-v1`): the resolved query; a
   manifest (policy, the read's bounds, the page size, the observation
   bound, every closed code list and the two command kinds); the summary
   counts of the whole read with `held` beside them;
   `decisions: "change-lifecycle"`; `total` of the view; at most 50 `items`,
   each with `evidenceRefs` (`identifier:<id>` of both sides and of every
   `via`); `nextOffset`, null past the last page and wherever the next page
   would exceed the grant's `maxRows`; and the `identifiers` the page's items
   name, with their facts, mapping method and revision, sources, currencies,
   provider market wording and state. A proposed candidate keeps the
   `commands` of the decision above.
4. **Bounds.** Before the walk, the number of current identity observations
   is read from the identity run seals (`IDENTITY_OBSERVATION_COUNT_SQL`, one
   row per published parse, no observation read; exact when every sealed
   run is eligible, an upper bound otherwise). Above
   `CURRENT_IDENTITY_OBSERVATION_BOUND` (500,000) the answer is
   `budget_exceeded` (`budget:identityObservations=500000`) and the walk
   does not start. The read keeps its own bounds (5,000 pairs, 1,000 hints,
   10,000 fact rows, 10,000 relations; past one the answer is
   `budget_exceeded`, `budget:instrumentResolution`, never cut). A page is 50
   items, and `offset + 50` above the grant's `maxRows` is `budget_exceeded`
   (`budget:maxRows=<n>`).
5. **Route.** `GET /api/identity/instrument-candidates?view=&offset=&identifierId=`,
   registered in its own module ahead of the identity catalogue (GET and
   HEAD only, as `worker.ts` answers 405 to any other method before a read
   route), behind the Access gate like every identity route, under the
   reader grant a signed-in browser already has over every GET route
   (`readerGrant`: `summary.read`, `records.read`, `evidence.read`, whole
   store, `maxRows` 1,000). A repeated, unknown, empty or over-long parameter
   is `400 invalid_query`; a non-numeric offset `400 invalid_offset`; a
   malformed value `400 invalid_query` with the key as ref. The service's
   refusals travel as `financial-error-v1` with their status (403, 413). No
   new capability flag: the page follows the existing `identities`
   capability.
6. **Agent read tool.** `kogane.instruments.candidates`
   (`POST /api/agent/v1/instruments.candidates` and MCP `tools/call`),
   read-only, always listed with the other agent tools, graded by the
   caller's `AGENT_API_GRANTS` entry through the same service, so it answers
   byte for byte what the route answers to the same request under an
   equivalent grant. It carries the same `commands`: an agent that wants a
   decision plans that payload through the change lifecycle, where the
   existing command grant lists (`OPERATOR_SUBJECTS`, `AGENT_GRANTS`) grade
   it.
7. **Page.** `/identities/instrument-candidates` (`銘柄の同一性の候補`), linked
   from `/identities`: the summary counts, one tab per view, one card per
   item with both identifiers (label, namespace/scope/value, kind, sources,
   currencies or `確認できない記録あり`, mapping method and revision, state),
   the evidence, agreement, gap and conflict codes in words beside the code,
   a held candidate's hold in words, and for a proposed candidate a reason
   field and the two buttons (`同じ銘柄として採用する内容を確認`, never
   shown while held; `別の銘柄として扱う内容を確認`). A button first reads the
   candidate again (its view, filtered to the subject) and plans nothing
   unless the same candidate is still there with the same anchor, subject
   and commands and neither identifier's mapping revision moved; then it
   plans the candidate's own command payload with the reason and
   `baseContextId = candidateId` through `POST /api/command/v1/plan`, and
   opens `/confirm/:planId`, where approval and commit stay exactly as the
   change lifecycle grades them today. An adoption plan whose pinned
   `instrument_mapping:<subject>` revision differs from the revision on the
   card (a change between the two requests) is not offered either. Either
   refusal says `候補が更新されています`. The buttons follow the `commands`
   capability. The page does not render `providerMarket`; the answer
   carries it.

   **Staleness is checked by the page, not by the server, for the anchor.**
   The `identity.assign` planner pins the subject's mapping revision only:
   its payload names the subject and the target instrument, not the anchor
   identifier, so pinning the anchor would need a new payload field or a
   change to what `identity.assign` pins for every caller, and the commit's
   guards check the pinned subject only. Neither is done here. So an agent
   or a direct API plan of an adopt payload gets only the server's subject
   pin; the anchor is not pinned, and such a plan can adopt the subject into
   an instrument the anchor has since left (a person re-mapped the anchor
   after the candidate was read). The page's re-read closes that window up
   to the plan request. `baseContextId = candidateId` is recorded with the
   plan and pins nothing.

8. **Principal and ids.** The route passes the Access subject as the grant's
   principal; a plan carries the subject the command API verifies as its
   actor, `baseContextId` the candidate id, and the existing approval and
   operation ids. Nothing here adds a context type.

### Cost

**Decision on the precondition.** The remote D1 measurement required by
Consequences (its last item) is replaced by the plan check without
statistics plus `bun:sqlite` and workerd measurements, and by the
fail-closed observation bound of Decision 4; remote D1 remains unmeasured.

Measured as [read model: cost](../read-model.md#cost) requires, on the
complete CORE schema without table statistics: on `bun:sqlite` (bun 1.4.2,
foreign keys on, `packages/application/test/instrument-resolution-scale.test.ts`
with `KOGANE_INSTRUMENT_RESOLUTION_SCALE=full` and
`KOGANE_INSTRUMENT_RESOLUTION_DAYS`) and on workerd's SQLite through
Miniflare (the services/app workers pool with every CORE migration,
`services/app/test/instrument-resolution-workerd.test.ts` with
`KOGANE_LOAD_INSTRUMENT_DAYS`, Layer A through the ingest path). One run each
in the development container, which other work shared at the time, so the
figures are indicative. The synthetic store in both: SBI Securities
captured daily, 150 domestic codes held on XTKS, 10 trades a day on an
unmapped venue, 30 foreign codes with a RIC; a synthetic second broker
holding 100 of the codes daily; every capture current; identifiers written
by the production identity writer. 430 identifiers, 430 fact rows, 350
candidates, no `listed_as` relation. Median of five:

| Current identity observations | Facts read, `bun:sqlite` | Facts read, workerd | One page, `bun:sqlite` | One page, workerd | Count, `bun:sqlite` | Count, workerd |
| ----------------------------- | ------------------------ | ------------------- | ---------------------- | ----------------- | ------------------- | -------------- |
| 105,850 (365 days)            | 652 ms                   | 868 ms              | 659 ms                 | 884 ms            | 0.5 ms              | 2 ms           |
| 211,700 (730 days)            | 1,484 ms                 | 1,965 ms            | 1,473 ms               | 2,007 ms          | 1.2 ms              | 2 ms           |

"One page" is the service with the count, the walk and the page; "Count" is
`IDENTITY_OBSERVATION_COUNT_SQL` alone.

The plan, without statistics: `current_identity_observations` scans the
published parse runs (`SCAN pub USING COVERING INDEX
published_parse_runs_run`), reaches each sealed identity run and its
observations by index, and the facts read reaches each observation's uses,
trade unit and unit by the use table's primary key and each identifier by
key; `eligible` scans the current instrument mappings (the mapping catalogue,
not observation history); no observation table is named. The `listed_as`
read is a range on `entity_relations_from`. The count scans the identity runs
and reaches each seal by key; it names no observation or use table. The
CI-scale run asserts those plan shapes and that the count equals the current
identity observations; the timings print only with the full scale.

**The bound.** Every request walks every current identity observation once,
roughly linear in captured history: 868 ms for 105,850 and 1,965 ms for
211,700 on workerd here, about 0.8 to 0.95 s per 100,000. The
count costs milliseconds (one row per published parse), so the bound is
cheap to enforce and is enforced. 500,000 observations extrapolate to about
5 s on workerd, against the 30-second CPU limit a Worker request has by
default (`services/app` sets no `limits.cpu_ms`) and the D1 query time limit
the identity catalogue once hit in production (33.7 s,
[identity query performance](../identity-query-performance.md)), leaving
room for remote D1 being slower than local workerd, which is unmeasured. At
the synthetic shape above that is about 4.7 years of daily captures. A store
past it is refused, never answered slowly or in part; raising the bound
needs a remote D1 measurement first.

What this does not bound: how often the read runs. The walk is linear in
history and is acceptable today for a single owner reading the page behind
Access; routine agent polling of `kogane.instruments.candidates` needs a
written bound (a rate, or a cached or projected candidate set) before it is
configured. Not measured: remote D1, a store with `listed_as` relations, or
history beyond 730 days.

### Consequences and limits

- Nothing adopts on a click or on the server: a click plans, and a plan
  changes nothing until it is approved and committed through the change
  lifecycle. Under today's grant lists (`AGENT_API_GRANTS` for the read,
  `OPERATOR_SUBJECTS` and `AGENT_GRANTS` for commands) an agent can read and
  plan, and cannot approve or commit; this slice neither widens nor narrows
  that.
- A signed-in reader can page to offset 950 of a view (`maxRows` 1,000; no
  `nextOffset` is offered past it); `identifierId` narrows a larger view. An
  agent pages within its own `maxRows`.
- The anchor of an adoption is checked by the page only (Decision 7).
- The confirmation screen shows an `identity.assign` or `relation.reject`
  plan generically (targets, revisions, staleness); it does not read the
  candidate back. The server's pinned subject revision makes an approval of
  a moved subject mapping stale.
- `queryInstrumentHistory` is still served by no route.
- `/api/identity/*` requests, this one included, are logged with the route
  class `unknown_api`: `classify` in `services/app/src/worker.ts` names no
  identity route. Left unchanged to keep this slice's `worker.ts` edit to
  the registration (five lines: the import and the registration call).

### Open items for the owner

- **Audit binding.** The existing types carry the principal (`Grant.principal`,
  the plan's `createdBy`, the approval's `approverActor`), the plan id, the
  approval id and the commit's `operationId` (the commit's idempotency key).
  None carries a channel (ui, mcp, api) or a correlation id, a read has no
  per-request id (its errors carry the constant `instruments.candidates`),
  and a plan request has no idempotency key of its own. ADR 0064 supplies
  them (`path`, `correlation_id`, `idempotency_key` on an `audit_records`
  row, written through ADR 0063's `executeOperation`); this slice implements
  neither. Against those ADRs: the read tool already follows ADR 0063 §10 (it
  calls the route's own service and refuses a listed source or account grant
  before any read), and it writes no ADR 0064 `read` record, which every
  agent and MCP tool call will need once `audit_records` and
  `executeOperation` exist. Its `commands` reach every `records.read`
  caller; ADR 0063 §10 strips decision payloads only from ADR 0013's card
  purchase candidates, and an agent's plan of them is still graded by the
  change lifecycle.
- **A server-side anchor pin** for adoption plans (Decision 7): a payload
  field naming the anchor, or a planner that pins the target instrument's
  identifiers. Either changes `identity.assign` for every caller.
- **A rate bound for agent polling**, or a cached or projected candidate
  set, before routine polling is configured; and a remote D1 measurement
  before the observation bound is raised.
- **A candidate panel on the confirmation screen**, like the settlement and
  purchase-link panels.
- Everything the decision above lists as not decided stays so: mappings for
  a period, provider identifier changes, which providers state ISIN, share
  class or product class, crypto identity across exchanges. Financial rules,
  price source selection and adoption semantics are not decided here.

### Verification

Synthetic data only, no production access:

- `packages/application/test/instrument-candidates-review.test.ts`: the open
  view (evidence refs, commands, named identifiers; nothing written), the
  separated and hints views, a separated pair's `via` in its evidence refs,
  the identifier filter and its refusal, a decision through the lifecycle
  moving a candidate to `decided` (an agent's plan stops at approval under
  today's grants), a held candidate offering keep-apart only, paging past
  50, a view of exactly 50, no `nextOffset` past `maxRows`, offset 950
  served and 951 refused, the four grant refusals (capability, both axes,
  accounts alone, `maxRows`) before any read, the observation bound refused
  after the count and before the walk, the count equal to the current
  identity observations, the read bound, and the closed request.
- `packages/application/test/instrument-resolution-scale.test.ts`: the plans
  and the answer on the CI scale; the `bun:sqlite` timings with the full
  scale.
- `services/app/test/instrument-resolution-workerd.test.ts`: on workerd, the
  read, the page and the count against the store at two days; the workerd
  timings with `KOGANE_LOAD_INSTRUMENT_DAYS` (`--reporter=verbose` prints
  them).
- `services/app/test/instrument-candidates-api.test.ts`: the route over the
  real Worker and CORE migrations with identifiers from the production
  writer (page, views, filter, parameter refusals, Access, GET-only, the
  `maxRows` and unknown-identifier refusals, nothing written), and the agent
  tool (listed, equal to the route over HTTP and MCP, the grant refusals);
  `agent-api.test.ts` and `ops-api.test.ts` pin the new tool list.
- `apps/web/test/instrument-candidates-contract.test.ts` (every view the
  service produces, a held one included, passes the wire check; unknown
  codes, a status in the wrong view, foreign command kinds and a held
  candidate naming an adoption do not; the route) and
  `apps/web/test/instrument-candidates.browser.test.ts` (Chromium against the
  production build: codes in words, an adoption and a keep-apart plan the
  server's payload with the reason and open the confirmation screen, a
  candidate whose anchor moved after the page was shown is read again and
  nothing is planned, a pinned subject revision that moved between the
  re-read and the plan is refused, a held candidate shows its reason and
  only the keep-apart button, decided, separated and hint views, disabled
  actions without `commands`, no horizontal scroll at 390 px).

## Amendment 2026-10-09: server anchor and history

- Status: proposed (until this PR merges)
- Date: 2026-10-09
- Issue: part of #546

### Context

The preceding amendment checked an anchor only in the page. An anchor
mapping could move after that read while the subject stayed unchanged, so
an API or agent plan could adopt into the anchor's former instrument. The
existing history query also had no route or page access. This slice uses the
existing lifecycle and history query; it adds no financial adoption rule.

### Options considered

1. Pin every identifier mapped to the target instrument on every assignment:
   this would change the scope of direct manual corrections and cannot tie a
   plan to the particular candidate whose evidence was reviewed.
2. Add optional anchor fields without distinguishing candidate provenance:
   omission would let a candidate context claim the old subject-only guard.
3. A candidate provenance bundle verified against the current open candidate,
   while explicit direct assignments remain distinguishable. Chosen.

### Decision

Candidate adoption payloads of `identity.assign` carry `candidate` with
`candidateId`, `anchorIdentifierId`, `anchorMappingRevision` and
`subjectMappingRevision`. The server verifies that the current resolution
still offers adoption for that exact candidate, with the same orientation,
subject, target and revisions. It refuses held, decided, missing or changed
candidates. The same 500,000 observation bound is checked before this read.
This applies to the shared `createPlan` service for every caller.

The bundle must match `baseContextId`; an assignment whose context starts
`instrument-candidate:` must carry it. A direct manual assignment omits it
and cannot claim candidate provenance. The plan payload and digest retain
the evidence bundle. The planner checks that the anchor still maps to the
target, pins both mappings in `expectedRevisions`, and leaves the simulation
target as the subject actually being changed. Existing simulation, approval
and commit guards apply to both pins, including the atomic receipt reservation
before any mutation, outbox write or approval consumption. A same-target
anchor revision also invalidates the plan. The page verifies both returned
pins before opening confirmation.
Stored candidate plans made under the earlier subject-only contract are
refused with `stale_context` at simulation, approval and commit and must be
re-planned. Direct manual plans remain valid under their existing contract.

`readInstrumentHistoryForGrant` serves the shipped `queryInstrumentHistory`
for one identifier. It requires `records.read` and whole-store source/account
scope before a read, validates the id, and counts every history branch by its
indexed key before loading entries. More than the grant's `maxRows` is refused
whole; a concurrent append is checked again against the returned row count.
The route is `GET /api/identity/instrument-history?identifierId=` behind the
existing Access gate; HEAD has the existing body suppression. The page loads
history on request, validates the wire contract, and displays every mapping,
decision and relation entry in stored order. No SQL history rewrite, schema
migration or new library is needed.

### Consequences and limits

Candidate adoption now has server anchor protection. Explicit manual
corrections keep their existing contract without claiming candidate evidence.
A candidate's entire evidence graph is not pinned: unrelated identifier facts
or `listed_as` decisions changed after planning are outside the two mapping
pins. The confirmation screen still renders the assignment generically.

The history adapter for agents/MCP remains pending integration with the shared
audit service in #619; the grant-graded application service is ready for that
connection. The route makes no audit implementation of its own. Remote D1 and
production are unmeasured. No second broker's securities, ISIN/share-class
observations, or price/quantity/cost connection are introduced. #546 remains
incomplete.

### Deferred effective-date model

Two separate meanings need a repository decision before implementation:
recorded-time history (which mapping was known at a cutoff) and effective-time
mapping (which product a code denoted on a business date). Reading append-only
revisions by `created_at` would provide only the first and cannot establish
the second. An additive effective-interval mapping model could preserve old
decisions and add new revisions, but requires chosen interval boundaries,
overlap and correction rules, the treatment of undated observations, and
explicit handling of provider identifier reuse/replacement.

Migrating every current mapping to an unbounded interval would make an
unobserved historical assertion; backfilling from first/last observation also
does not prove validity. No such migration is made. A future implementation
must move this work to an explicit next step, not treat deferral as completion.
The recommended next design is owner-stated intervals with cited evidence:
unset intervals are unknown, undated observations remain unresolved, a
correction appends a version, and conflicting intervals refuse rather than
choosing a winner. Retained earlier results stay immutable; a new valuation
pins the interval decision version it uses. This is a proposal for the next
ADR decision, not behavior this amendment implements.

Choices that can change financial results are the interval boundary convention,
which dated field determines a trade/position/price's applicability, whether
non-overlapping intervals can resolve reused provider codes, and whether a
new calculation restates past holdings or costs. None is assigned a default
here. The owner must authorize a concrete contract before code/schema changes.
A future implementation
must define how historical prices, quantities, costs and retained reports use
the new intervals and whether correction restates earlier derived results.
`listed_as.valid_from/valid_to` still have the documented ignored-window
limitation; choosing the reference date and interaction with superseding
relations is part of that decision, not inferred here.

### Verification

Synthetic stores only: candidate provenance omission/tampering/context mismatch,
held candidate refusal, plan payload/digest and both mapping pins; anchor
changes between reading and planning, between planning and simulation/approval,
after approval, and after the commit's preparatory reads immediately before
the batch, with no subject mutation, receipt, outbox or approval consumption.
The history service matches the shipped query after correction and rejection,
keeps every revision, checks grant refusals before reads, refuses above budget
before loading text, and uses indexed count plans without table statistics.
Worker tests cover Access, method/query validation, HEAD and the wire contract.

## Design proposal 2026-10-09: evidence-backed effective identity

- Status: proposed; design only, not an implemented or authorized policy.
- Date: 2026-10-09.
- Issue: remaining effective-time part of #546, after #629.
- Baseline: `ba775d914b3d3a54c489719a93823ab743db19f4`.
- Companion: [remaining implementation and verification plan](../plans/2026-10-instrument-resolution-remaining.md).

### Context

A provider code can denote different products in different periods. Current
mapping revisions state the latest accepted assignment, not when that
assignment was true. Their recorded time is not a listing, trade, position or
price effective time. A dated `listed_as` rejection is currently applied
without its validity window. Neither first nor last observation establishes
a period's endpoints. Existing retained reports and adopted event seals must
not be rewritten to manufacture this evidence.

The current lot adapter also reads current mappings and marks an identifier
remapped away `needs_review` (ADR 0059); the market-data selector reads
provider-local price bases and its knowledge mode does not bound positions
or identity (ADR 0056). Changing these consumers is a separately reviewed
integration step, not a consequence of creating a candidate.

### Options considered

1. Treat each current mapping as true for all time. Rejected: a migration
   would assert historical and future validity nobody observed.
2. Use recorded time, or the first/last observation, as effective time.
   Rejected: discovery time and observed coverage do not prove validity.
3. Resolve a historical observation by the latest accepted mapping.
   Rejected: a correction or reused code could move a price or quantity to
   another product; reproducible earlier results would silently change.
4. Owner-stated, evidence-cited intervals in append-only decision-set
   versions, with a pure two-time selector and pinned results. Recommended.
   Missing intervals and incomparable dates remain unresolved. This option
   needs the policy choices below decided before schema or consumer changes.

### Proposed decision contract

**Two axes and one acceptance order.** Effective intervals state when a
provider identifier denotes a target; knowledge states when the server
accepted that assertion. Every mapping and relation decision-set version
belongs to one atomic acceptance with its complete member list and explicit
supersession references. All their series share one dense acceptance sequence
per `coreEpoch`, not a separate clock or counter per identifier or pair.
At atomic acceptance the server allocates `max(sequence) + 1` and canonical
UTC-millisecond `known_at = max(server now, previous global known_at)` in the
same guarded database batch. Neither a payload clock, prepare time nor a
per-series predecessor's clock determines it. A mapping and relation accepted
together have one sequence, one time and all-or-nothing membership. Idempotent
resend returns that original acceptance and receipt; it adds no member or
sequence. A restored CORE changes epoch. A regression, gap, missing member,
ambiguous successor or successor accepted before its predecessor refuses.
An acceptance contains at most one complete version per series. Two versions
in one millisecond can be successive only in distinct, ordered acceptances;
there is no unstated intra-batch ordering by member position or id.

This adopts ADR 0054's acceptance-order pattern and ADR 0058's cut semantics,
not a claim that 0070's economic-event-only log currently stores identities.
The storage implementation must choose a compatible identity journal, with
one order across mapping and relation series, without copying #619's general
audit service. The common audit is not itself proof of an atomic identity
acceptance or of the complete member set.

The request explicitly chooses `current` or `known-at` and an effective
reference time; there is no implicit knowledge mode. A historical cut is
`{coreEpoch, commitSeq}` or `{coreEpoch, instant}`. Resolve an instant to the
largest sequence whose `known_at` is at or before its canonical bound, including
every acceptance with that same instant across every series. Reuse ADR 0058's
`canonicalCutInstant`: floor finer precision to milliseconds, never round up;
retain both the requested cut and resolved sequence/time. This does not change
ADR 0056's separately defined price-input validator. Sequence 0 means before
the first acceptance; beyond-head sequences and another epoch refuse. No
`created_at` or highest row id resolves the cut.

A sequence cut is `final`. An instant strictly before the journal's last
`known_at` is `final`; an instant at or after it is `provisional`, because a
later acceptance from a lagging server clock can share the same instant and
resolve that request to a later sequence. Return `cutStanding` explicitly.
Retain the resolved sequence and selected version set to reproduce either
answer. Standing is outside `setVersion`, so provisional becoming final alone
does not change a pinned set's digest; requesting the same instant again may
select a new sequence/context. No empty/pre-log cut proves historical coverage.

For `current`, capture the latest acceptance sequence once and read every
mapping and relation series at that sequence. Immutable member/version rows
permit subsequent reads constrained to the captured cut; an implementation
that also depends on mutable pointers must revalidate the shared revision or
use a database snapshot and refuse/retry the whole read on a race. It cannot
mix one mapping's newer version with a relation's older version. Echo the
captured sequence, pinned set and coverage. Do not label an unlogged legacy
row as accepted knowledge because it is present in a current table.

**Intervals.** Recommend half-open `[from, to)` rather than closed intervals:
two periods meeting at a boundary do not both apply there. The initial
contract should admit market business dates with an explicit canonical
zone; an instant or another temporal basis must be explicitly converted by
a named, versioned conversion contract, not string-compared or inferred.
Whether an instant-level interval is needed remains a review question.
An absent validity is `unknown`, not an unbounded interval. An explicitly
open-ended interval is a distinct owner assertion, with a finite start,
evidence and a reason; a nullable end alone cannot distinguish the two.
The owner may instead choose bounded intervals only. That alternative
would refuse observations after the last proved endpoint rather than
treating them as still covered, so it changes financial coverage.

**Reference role.** Recommend using the provider-confirmed trade role for
a trade's product identity, the position's own as-of for a holding, and the
price's own effective basis for a quote. A settlement date never silently
stands in for a trade date; a fetched instant never silently stands in for
a position date. A date with an unconfirmed role or zone, an undated fact,
or a date incomparable with an interval is unresolved. The lot engine's
explicit trade/settlement time-basis policy remains independent of this
identity reference role: selecting settlement for allocation must not
remap a traded product by its settlement day's reused code.

**Correction and conflict.** Each version supplies the complete interval
set for one identifier, with explicit evidence references and a reason.
It supersedes a prior complete set, not selected rows mutated in place.
There is at most one accepted successor of a version; two commands racing
to supersede the same version must be guarded by the common revision and
atomic commit checks. Within a set, overlapping intervals are refused,
including overlaps with the same target; a person may submit an explicit
merged interval with its combined evidence instead. Non-overlapping
intervals may name different targets when evidence demonstrates provider
code reuse. No equality of code, display name or currency adopts a set.

**Relation version before effective time.** A temporal relation series is
the exact directed tuple `(kind, fromRef, toRef)`; for `listed_as` the stored
instrument and identifier references retain their original meaning, not
today's remapped display names. A new operation-specific relation id is an
entry id, not a series key. Load all touched series and resolve each one's
single in-force, complete decision-set version at the same knowledge cut as
the mappings, before filtering its dates, disposition or target. An accepted
successor's membership declares the version it supersedes. Same-millisecond
decisions are ordered by the common sequence and that proved chain, never
`created_at DESC, id DESC`. Two in-force versions, an undeclared/missing
predecessor or a competing accepted successor refuse as chain conflicts.
Existing `LISTED_AS_SQL` top-1 and today's `relationMutation` rows are a
current-review implementation, not this temporal history contract.

A relation version restates its complete non-overlapping period set with
`accepted` or `rejected` assertions and evidence. An accept, reject or
correction supersedes the prior whole set, retaining any earlier periods
only when explicitly restated with their evidence. A release is an explicit
new version with an empty assertion set that supersedes the old version;
it withdraws the series, does not resurrect an earlier rejection and does
not assert that the pair is identical. Partial withdrawal is a complete
replacement set retaining the other periods, with withdrawn gaps unknown.
These are proposed temporal dispositions, not a claim that a relation-release
command exists today. All use the same guarded atomic lifecycle, expected
series revision and acceptance membership as mappings.

Only after version resolution apply the requested effective time. An active
rejection separates that pair in its covered period; an acceptance records
a relation but never independently adopts a mapping. A gap, a released set,
or missing relation evidence is no affirmative equivalence proof. A mapped
pair contradicting an applicable rejection refuses with both pinned versions;
there is no latest-write-wins precedence between mapping and relation.

Legacy relevant rows without acceptance membership are `knowledge_unlogged`;
undated, zone-less dated, or ambiguous-endpoint rows also carry
`relation_validity_unknown`. Do not invent their zone, endpoint convention,
open end or knowledge time from `created_at` or ids. A new logged version may
explicitly supersede named legacy rows with newly cited evidence, at its
honest acceptance cut only, never backdating their old assertions. Until
such evidence resolves the relevant pair, it is **unresolved**, not a usable
identity with a warning: price, quantity and cost adapters must not consume
it. This restriction applies to the requested identity closure, not unrelated
pairs. Legacy rows remain in recorded history; the old non-temporal candidate
review view is unchanged until a reviewed temporal mode replaces it.

**Retained results and new evaluations.** Stored reports, selected-event
seals and earlier manifests remain immutable. A new retrospective
evaluation under corrected knowledge is a new context, not an overwrite.
The manifest records selector release, interval-contract version, explicit
knowledge mode/cut, effective reference role/time/zone, decision-set ids
and versions, acceptance membership and common resolved sequence/time,
target ids, resolved relation sets/dispositions and evidence refs.
It also records every unresolved outcome, rather than omitting it or
turning it into zero. The canonical selection body and `setVersion` include
the resolved cut and every selected mapping/relation version in its at-cut
form, not mutable current pointers, requested mode or cut standing. The outer
manifest retains the original requested mode/cut. A current read pins one
captured sequence; a known-at read pins the historical chain and its cut.
A retained manifest's pinned version is not reinterpreted through
today's mapping. A later accepted correction yields a different context.

**Migration.** Additive only. No current mapping or old relation receives
an automatic interval, whether unbounded or inferred from observations.
Existing current-assignment commands remain explicitly non-temporal.
A future temporal command requires an evidence-backed interval set and
uses the shared prepare/simulate/approve/commit path; it must not let an
omitted interval bundle fall back to that manual command while claiming
temporal provenance. No migration number, table or command name is fixed
by this design proposal.

### Consequences and owner choices

The following choices can change which product receives a historical
price, quantity or cost, or whether a value is available at all:

- Half-open versus closed endpoints: recommend half-open, with the
  boundary belonging only to the successor period.
- Business-date plus named zone versus instant intervals: recommend the
  former initial contract, refusing incomparable inputs; broaden only
  with observed need and a reviewed conversion rule.
- Explicit open-ended validity versus bounded-only: recommend permitting
  an evidence-cited, deliberate open-ended assertion, never deriving it
  from missing metadata. Bounded-only gives narrower future coverage.
- Trade-role versus settlement-role identity: recommend trade-role,
  independently of lot allocation policy; missing trade-role evidence
  remains unknown rather than using settlement as a fallback.
- Corrected current knowledge versus historical known-at: require callers
  to choose; neither may replace an existing retained result. The UI may
  offer both named modes but must not silently choose on the caller's
  behalf.

These are recommendations awaiting owner/design review, not defaults
implemented by this amendment. They do not choose price source priority,
currency conversion, lot pooling, tax, fee inclusion or acquisition-cost
semantics. Those stay under ADRs 0051, 0056 and 0059. The first adapter must
still distinguish product identity from listing, unit and price basis;
one ISIN can cover multiple listings with different prices.

### Proposed verification

No executable implementation is added in this proposal. The companion
plan specifies synthetic contract cases, migration assertions and query
cost gates. Before implementation, a fresh independent design reviewer
must check the two-time semantics, unknown/open-ended distinction,
relation interaction and retained-manifest behavior against existing
adopted-event and market-data contracts. After implementation, the
reviewer must run the contract cases and atomic-race tests on the exact
head and review ordinary latest-main integration.
A read retains the existing caller grant and whole-store boundary. Explicit
limits on identifiers, decision versions and returned entries are required;
overflow refuses the whole request. Operational output contains counts and
closed codes only, never an interval's free-text reason or provider facts.

## Amendment 2026-10-09: pure temporal selector

- Status: proposed (until this PR merges).
- Date: 2026-10-09.
- Issue: part of #546; the issue remains incomplete.

### Context and options considered

The reviewed effective-identity proposal can be tested without choosing a
database journal or changing a financial consumer. Implementing a writer
first would mix its atomicity proof with temporal selection. This slice
instead adds the pure domain contract and synthetic selector, retaining the
existing current review queries and all their documented limitations.

### Decision

`selectInstrumentTemporal` takes a complete acceptance journal, all its
mapping and directed `listed_as` version members, explicit legacy records,
and a requested identifier closure. It verifies the common dense sequence,
canonical nondecreasing global acceptance time, epoch, exact membership and
single complete-version successor chain before selecting the cut. It then
resolves each series before applying effective dates or dispositions.

The caller must supply a versioned interval contract: half-open business
dates, a canonical named zone, whether deliberate open ends are allowed or
refused, and a reference role (`trade`, `position` or `price`). No field has a
default. This release supports provider-confirmed local dates only. Instants,
collector dates, mismatched roles or zones and missing dates remain
unresolved; no conversion is implemented. Unknown intervals are distinct
from explicit open ends. Relevant unlogged legacy records block use until a
logged version explicitly supersedes their exact series. Either an initial
logged version or a valid logged successor may name still-unsuperseded legacy
rows; each legacy row has one proved superseder at its honest acceptance cut.
All consumed arrays require an own element at every index before canonical
copying; a hole cannot denote missing evidence or an empty relation release.
Relations never
adopt a mapping; an applicable rejection of the mapped target conflicts.

The canonical selection pins its common resolved sequence/time, interval
contract, effective reference, complete membership of the selected versions'
acceptances, selected complete versions, relevant unlogged legacy records,
relation dispositions, evidence and all outcomes. `setVersion` digests this
body. The outer manifest also retains the requested mode/cut and standing.
Same-time instant cuts can advance provisionally; a retained sequence pin
reproduces its set, and becoming final alone leaves `setVersion` unchanged.

### Consequences, limits and verification

No schema, SQL, loader, command, transport, migration or production consumer
uses this module yet. Complete supplied membership is not proof of database
atomicity or loader completeness. Synthetic B14/B15/B16/B20 checks cover only
malformed-snapshot refusal and input preservation, not writer races,
migration execution or guarded command provenance. The later writer must
prove those separately. Price/quantity/unit/currency/cost conversion and real
second-provider evidence remain pending. Domain CI and synthetic selector
tests verify the implemented cut, interval, relation, legacy and manifest
semantics; production was not accessed.
