# ADR 0099: Sony Bank scheduled collection includes all retained deposit history

- Status: proposed
- Date: 2026-11-10
- Issue: [1231](https://github.com/risu729/kogane/issues/1231)

## Context

Only the current JST month was requested. A failed run on the first day of a
month left the prior month's last day unrequested. The owner observed that
all eleven currencies accept an omitted start and an end of yesterday; CSV
row counts match the declared JSON totals. No opening date needs to be guessed.
The current Sony parser contract required a closed window. ADR 0092 requires
that only complete official CSV contributes current deposit transactions.

## Options considered

1. Guess an opening date or walk artificial monthly ranges. Neither is needed
   when the provider accepts one range covering everything it retains.
2. Replace monthly requests. The issue explicitly retains these requests.
3. Keep monthly requests as evidence and publish the complete retained range.

## Decision

Choose option 3. In one authenticated session, validate the unchanged monthly
queries and then all retained history through yesterday for every currency.
Use the observed omitted-start request with `sortSelect=00002`,
three-row pages and the same date selection for CSV. Keep canonical artifact
names for retained history. Store monthly responses under `monthly-*` names,
which the existing closed production dataset selector leaves without a dataset.
This avoids a second current publication input and requires no registration
contract revision. Historical monthly CSV remains deduplicated against retained
CSV through the existing occurrence-qualified external IDs and reader ranking.

Terminals name `full_snapshot`, a null start and yesterday as the end. The
Processor maps Sony's null start to the Sony-only `retainedHistoryEnd` metadata
field, which participates in the parser input fingerprint. The common closed
`runWindow` type is unchanged. Sony history parsers accept this explicit field
while still requiring valid metadata and enforcing the upper date bound.
Missing metadata and empty, invalid or reversed dates still fail. All four
parsers in the shared Sony module receive patch releases and refreshed digests;
only the history window interpretation changes.

Every JSON page must match the stable declared total, its expected page size,
and `returnCnt` when supplied; CSV logical row counts must match the JSON total.
Missing or inconsistent pages/CSV and the 1,000-page cap fail closed with
allowlisted codes. No JSON transaction fallback, cursor, manual range parameter
or remote operation is introduced. At the observed account size the retained
walk is bounded by fewer than one hundred history/CSV requests.

## Consequences

Every later successful daily run recovers earlier missed dates, including a
missed first-day run. No account-opening date or coverage before the provider's
retention is claimed. Monthly bytes remain inspectable; the full official CSV
is the only new current transaction input. Raw evidence remains append-only.
Failure still persists no fetched artifacts, as before; a later run retries the
whole retained range. Histories beyond the page cap remain explicitly failed.
`cash_movement` is collected for retained yen and foreign ordinary deposits;
other Sony product limits remain separately named in the catalogue.

## Verification

Synthetic tests exercise all eleven currencies, monthly and omitted-start
request shapes, exact paging, matching CSV and a short retained CSV after a
complete monthly one. The production dataset selector and transaction SQL
prove evidence-only monthly artifacts, month-end recovery, legacy overlap,
repeated runs and preservation of identical-row occurrences. Parser tests
cover open-start JSON/CSV with end-date rejection, and Processor tests pin the
Sony-only metadata boundary. All tests use synthetic data; deployment and
production ingestion are not claimed.
