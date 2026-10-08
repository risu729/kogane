# ADR 0055: Propose cross-identifier instrument candidates from stored identifier facts; adopt only through a person's mapping

- Status: proposed until this PR merges; accepted upon merge
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
   outside the explicit catalogue, stored as `unresolved-currency`) makes the
   identifier's currency unconfirmed, so its pairs report
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
   command.
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
    lower id. When both are settled the candidate stays `proposed` with no
    commands and a closed `hold` code: `subject-decided-elsewhere` (the
    subject's mapping is manual) or `subject-shares-instrument` (re-mapping
    it would split a shared instrument). Re-deciding it is a person's
    correction of the earlier decision, not an adoption.
11. **History** of an identifier: every mapping revision, every decision on
    the mapping and every `listed_as` relation naming it, oldest first.
12. **Bounds.** 5,000 pairs, 1,000 hints, 10,000 fact rows, 10,000 relations
    and 100 identifiers per history read; a larger read is refused, never cut.

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
  serves the read.

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
    renaming either side changes nothing; normalisation is width, case and
    whitespace only;
  - status: an accepted `listed_as` alone does not adopt; a shared instrument
    is `adopted`; a rejection in either orientation rejects and a released one
    reopens; identifier states, including `shared-without-decision`;
  - instrument groups and orientation: S1 (a code a person mapped onto one
    listing is separated from a listing on another market, `via` the first),
    S2 (a decided identifier anchors a new one whichever id sorts first), and
    both `hold` codes;
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
    kept; a person's `relation.reject` keeps a pair apart; the history lists
    both; a history read of more than 100 identifiers is refused;
  - S1 and S2 through the change lifecycle, with the anchor, the adopt and
    keep-apart payloads, and `subject-decided-elsewhere` with no commands once
    a person maps the subject elsewhere;
  - currencies: an unresolved trade currency is unconfirmed rather than the
    settlement unit; an SBI VC Trade product states its quote unit;
  - an unpublished capture and a superseded parse contribute no identifier;
  - each read asks for one row past its bound, and a stub returning 10,001
    fact rows or 10,001 relations is refused;
  - query plans: no observation table is named, identifier uses (and each
    use's trade unit and unit) are reached by primary key, and mappings,
    decisions and relations by index.
- `mise run //packages/domain:ci`, `mise run //packages/read-model:ci`,
  `mise run //packages/application:ci`, `mise run ci:root`.

D1 cost of the facts read is not measured (see Consequences).
