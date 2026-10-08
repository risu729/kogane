# ADR 0048: Propose cross-identifier instrument candidates from stored identifier facts; adopt only through a person's mapping

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
4. **Gaps** name what one side does not state (ISIN, market, currency, share
   class, product class). A candidate with gaps is still only a proposal.
5. **Market** is compared through MIC or RIC only. The provider's own market
   wording is shown to the reviewer and never compared: SBI's codes and labels
   already differ between its own datasets.
6. **Currency** of an identifier: for each observation that uses it as a
   security, the money `trade-unit` of the same identity observation, else its
   money `unit`; the identifier's set is the distinct values. A use in another
   role states none.
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
    `instrument:<anchor's instrument>` to `identifier:<subject>`. The anchor is
    ranked by ISIN first, then a listing identifier (RIC or MIC), then a
    provider code; a tie goes to the lower id.
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
  transitively: a candidate between the anchor and another identifier stays
  open until it is decided.
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
  identity catalogue's instrument list does. There is no index on
  `identity_instrument_uses(identifier_id)`. Not measured on D1.

## Explicitly not decided

- Mappings valid for a period (`identity.assign` has no validity); provider
  identifier changes over time (`replaces_identifier`).
- The HTTP route, page and MCP tool that serve this read.
- Which providers state ISIN, share class or product class: no identity rule
  records them, and no observation of them exists.
- Crypto identity across exchanges (network and contract): no observation.

## Verification

Synthetic data only, no production access:

- `packages/domain/test/instrument-candidates.test.ts`: evidence, conflicts
  (market, RIC, currency, share class, product class, country, kind), gaps,
  names as hints only, renaming not changing a candidate, status only from a
  stored mapping or rejection, identifier states, input-order independence and
  bounds.
- `packages/application/test/instrument-resolution.test.ts`: identifiers
  written by the production identity writer from synthetic SBI rows through the
  deployed SBI rules and a synthetic second-broker test policy; the read writes
  nothing; an agent can plan an adoption but not approve it; a person's
  `identity.assign` adopts as a new manual revision with the rule revision
  kept; a person's `relation.reject` keeps a pair apart; the history lists
  both; query plans scan no observation table and reach mappings, decisions and
  relations by index.
- `mise run //packages/domain:ci`, `mise run //packages/read-model:ci`,
  `mise run //packages/application:ci`, `mise run ci:root`.
