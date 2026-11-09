# ADR 0092: Sony Bank deposit history uses only the official CSV in current transactions

- Status: accepted (merged 2026-11-08 in [#1188](https://github.com/risu729/kogane/pull/1188))
- Date: 2026-11-08
- Owner decision: 2026-11-08 13:29 UTC, with the completeness addition on 2026-11-08
- Issue: [1182](https://github.com/risu729/kogane/issues/1182)

## Context

The JSON history is paged in groups of three. Identical rows on different
pages share an occurrence-qualified identity because the occurrence counter
starts again for each artifact. The CSV covers the whole currency/window and
counts these occurrences together. Using the JSON as a transaction fallback
can therefore lose a real row. Both representations must remain stored:
JSON uniquely carries the exchange counter-currency codes `currencyCdSpndl`,
`currencyCdStl` and `otherPrtyCcyCd`; CSV uniquely carries `参考情報`.

The owner confirmed that the collector skips CSV only for zero transactions,
and that the CSV row count must equal the first JSON page's `countCnt`.

## Options considered

1. Release a JSON parser that emits no transactions. Repair would eventually
   replace previously published parses, but until each artifact was repaired,
   historical JSON-only transactions would remain current. It would also
   require patch releases for all Sony parsers sharing its module.
2. Exclude the JSON parser from current transaction reads. This applies to
   every published release immediately, while keeping append-only evidence,
   observations and existing balance semantics.

## Decision

Choose option 2. Production `transactionsSql` and the local experiment's
`currentTransactions` exclude `sony-bank-history-json` before identity ranking.
This applies even when a CSV is absent or still unparsed. There is no JSON
fallback and no parser release or migration. JSON observations remain visible
as recorded evidence, rather than current deposit transactions. The existing
CSV identity and ranking across overlapping windows are unchanged.

The collector checks CSV completeness before returning collected artifacts.
For every nonempty currency/window, it counts logical data rows with the
shared CSV reader (including its quote recovery), excluding the header and
empty lines, and requires equality with the validated JSON total. A missing
body or failed CSV request, invalid CSV framing/header, or unequal row count
fails the run. Closed reasons survive into the terminal, its account unit and
its report. No provider value enters the reason or logs. Zero JSON transactions
still skip the CSV and succeed. The collector does not publish partial history
from JSON. Bytes of successful CSV and JSON responses are retained unchanged.

## Consumer audit

- `packages/read-model/src/sql.ts`: the transaction identity list and shared
  Sony family remain for historical identity compatibility; the exclusion
  prevents any JSON transaction from reaching ranking. The balance family at
  `latestBalancesInner` stays unchanged: after-transaction balances are a
  separate observation contract, outside this transaction decision.
- HTTP, MCP and `financial.query` reported transactions all call this reader
  (`packages/application/src/query/execute.ts` calls `listTransactions`).
  The local experiment's separate current-transactions SQL has the same gate.
- Recorded-evidence lists, artifact/parse detail and collection quality keep
  JSON records and counts. They describe stored observations and parsing, not
  current transaction history, and must not erase append-only evidence.
- Financial products, balance semantics, activity semantics, metric profiles
  and event-family rules keep their JSON interpretation for historical
  provenance and balances. Sony bank-movement and FX families remain
  unsupported (fingerprint-only identity); own-transfer and settlement
  writers do not gain an alternative JSON transaction path.
- Parser registry/digests, metadata extraction, provider-data-type catalogue
  and synthetic fixtures keep JSON support. No stored evidence, observation,
  parser release or frozen expectation is rewritten.

## Consequences

Historical JSON-only transaction rows disappear from current transaction
lists on release. They remain available through evidence inspection. A CSV
must be collected and parsed before that window has current transactions.
Existing historical collector outcomes are not rewritten. New incomplete
currency/windows fail before artifacts are returned, as other collector
failures already do; their failed terminal retains the closed reason.

## Verification

Synthetic tests use the real parsers on identical rows placed on different
JSON pages and in one CSV: the repeated rows appear twice, each only from the
CSV. A published JSON-only history has no current transactions. A literal
copy of the shipped SQL is frozen in `sony-transactions-legacy.sql`; full CORE
stores with random rows, failed runs, multiple sources, paging and scopes
compare equal apart from the intentional JSON exclusion. With no table
statistics, indexed access paths and their multiplicities match the frozen
query (SQLite can reorder seeks).

Collector tests exercise missing, short, long and invalid CSVs, HTTP failure,
foreign-currency mismatch, successful CSV with quoted multiline cells, and
zero transactions without CSV. They run the actual shared collection path and
assert its terminal outcome and closed codes. No production data or provider
requests are used.
