# Preferred instrument display names

The protected browser selects a preferred display name independently of the
immutable instrument mapping revision. This fixes first-observation ordering:
when an English name is projected first and a Japanese name appears later for
the same identifier, both views can show the observed Japanese name.

`preferredInstrumentNames` performs one bounded set-oriented query for up to
500 distinct identifiers. It considers only successful, currently eligible,
sealed identity observations and the exact identifier already assigned to each
security use. Identifier namespace and scope remain part of equality: matching
tickers in different markets do not share names. A manual mapping's label is
always authoritative. The selector does not follow manual targets to harvest
names from unrelated identifiers or replace the operator's chosen label.

The currently supported name-bearing source is SBI Securities. Candidate fields
follow its resolver's precedence: position `security_name`, then
`extra.securities.securitiesName`, then `extra.issueName`; transaction and
valuation candidates use the latter two. Empty or non-text extra fields are
ignored. Kana names rank before Han-only names; Han is eligible because this
source has Japanese-language context, not because Han script proves Japanese
for arbitrary providers. Ties use binary label ordering, observation kind, and
observation ID, so arrival order does not determine the preferred spelling.
Names beyond 512 characters are not used as automatic display candidates.

If no Japanese-script candidate is available, the current mapping label remains
visible. No translation or alias is invented. The returned selection includes a
reason and the contributing observation kind/ID for observed names. The API's
original observation fields, identifier code, acquisition provenance, raw
evidence, mapping label, and revision are preserved. This projection changes
neither account identity nor transaction/holding arithmetic.

Tests cover the late Japanese name, transaction/position/valuation origins,
market separation, manual decisions, superseded parses, deterministic choice,
and bounded requests. The existing 35,000-observation/6,000-parse fixture also
executes the lookup and verifies a single materialized candidate relation.
