# Account and instrument identity (Layers C, phases 4–5)

The identity layer organizes the observations already collected. It does not
deduplicate purchases, turn debit-card activity into another deposit, add
balances, calculate holdings, or invent an instrument's ISIN/network.

## Contract and scope

`src/identity` in the observation PoC contains deterministic, independently
tested source rules. The production pipeline persists their interpretation in
migration `0018`. All four observation shapes and every merged parser source
are covered; the manual PayPay CSV path is also handled. Provider specifics are
in [SBI](identity-sbi.md) and [other sources](identity-sources.md).

A source account reference consists of source, producer, and exact source
account/discriminators. **Producer is a collector credential-slot boundary,
not proof of a person's permanent bank account.** The existing deployment has
one configured credential slot per such route (MyJCB/MoneyForward additionally
carry their connection/account keys). Changing the principal in that slot
requires a new producer/connection epoch, not silently reusing it. No rule
claims multi-login identity from a parser constant. Provider-local accounts
remain visibly provider-local until evidence or an explicit correction links
them. Ordinal-only card/reward references are scoped to the fetch run.

`source_accounts` preserve the exact reference; `accounts` are the independent
targets. Append-only `account_mappings` can link several references to one
account, or correct an earlier link without rewriting any observation. A
manual revision requires the expected current revision and an explanation.
Automatic policy upgrades never replace manual decisions; older policy
versions cannot replace newer ones. Labels/status are versioned mapping
claims, not updates to original evidence.

Instruments have opaque IDs, a kind, and separate namespaced identifiers.
ISO currency codes, offshore CNH, V POINT program units, exchange product IDs,
MIC+listing symbols and provider-reported RICs are different namespaces.
Tickers and labels are **not global identities**. A provider-local security can
later be mapped to an externally verified canonical instrument without changing
its observations. No currency suffix is treated as proof of a crypto asset,
and no derivative/product is automatically treated as the underlying coin.
Instrument identifier details retain identifier semantics only, not prices,
balances or credential fields. Type-specific financial metadata/valuations are
not inferred here and remain in later phases.

## Publication, provenance, and correction

Each `identity_run` names a successful parse run and an integer policy version.
Observations retain their original B identity and pinned mapping revisions;
instrument uses retain the roles unit/security/trade-unit/usage-unit. D1 checks
the actual parse/source/producer lineage rather than trusting a caller's DTO.
Publication uses an immutable completeness seal: incomplete runs are invisible
and safely resumable. Duplicate inserts, including SQLite `REPLACE`, and
updates/deletes are rejected. A seal does not make a superseded B parse current.

The effective read views select the newest sealed policy for each currently
eligible B parse and join current mapping revisions. Thus corrections change
the effective organization immediately while the original decision remains
auditable. Raw R2, Layer A and Layer B are never modified by this layer.

## Acceptance gates

- All merged source patterns exercised with synthetic tests; all seven SBI
  datasets exercised through their real parsers.
- Real stored observations audited with bounded read-only pagination; unknown
  patterns/identifiers reported by source, not hidden as successful matches.
- D1 runtime tests cover all four kinds, idempotence, interrupted resume,
  out-of-order versions, stale/manual corrections, immutable rows, invalid
  provenance, wrong mappings and incomplete seals.
- Source-level production coverage compares all currently eligible B rows to
  sealed C rows, separately from resolution status. “Organized” is not “globally
  identified,” and account resolution counts are not a security resolution rate.
- Source-specific evidence-only datasets and rejected B parses have no invented
  account/instrument observations. Their existing raw/parse coverage remains
  visible separately.
- Protected UI/API tests run locally before a combined final production check.
  Existing Cloudflare Access protections and read-only browser behavior remain.

## Deployment boundary

The additive migration precedes the private observation pipeline and protected
browser deployments. No new database, bucket, public diagnostic Worker or
financial-institution login is required. Rollback can stop the identity sweep
or revert the UI without removing the additive schema or identity history.
Do not restore the whole D1 database as a routine rollback: collectors continue
to append independent evidence while this rollout is running.
