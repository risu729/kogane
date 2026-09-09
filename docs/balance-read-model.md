# Balance read model

The latest-balance list is served from a projection that is built once per
input context, not re-grouped on every request (design review D10/D11,
architecture addendum A07). This document is the contract: what the
projection is built from, how a measurement gets its adopted state, what the
API returns, what a cursor means, and how to deploy and roll it back.

Everything below was exercised locally against synthetic fixtures. Nothing
here is a claim about production data or production performance.

## Why

The old `/api/balances` fetched the complete bounded candidate set (up to
5,000 rows), grouped duplicate witnesses, classified every row and only then
cut a 500-row window — on every request, for every page. Two consequences the
review named:

- the work before the limit grows with the store, not with the page;
- new evidence or a mapping correction between two pages changes what an
  offset points at and which rows belong to which group.

The fix is not a bigger limit. It is a projection that can be rebuilt from a
declared input context, plus paging that is fixed to one build of it.

## What is built

`migration 0030` adds three derived tables. All three are deletable and
rebuildable; no Layer A or Layer B row is touched, and a wrong projection is
repaired by building a new snapshot, never by deleting an observation.

| Table                        | What it holds                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `balance_read_snapshots`     | One build. `snapshot_id` is the digest of the declared inputs; `status` moves `building` → `complete` → `retired` and never back.                |
| `current_balance_projection` | One candidate measurement per row: its scope, quantity, metric, adopted state, reason code, temporal reference, freshness and a dense `row_seq`. |
| `scope_relations`            | Typed relations between measurement scopes (`same`/`disjoint`/`subset`/`overlaps`/`unknown`) with the decision that produced each one.           |

### Declared inputs

The snapshot id is `sha256` of the canonical JSON of:

- `publishedHighWaterParseRunId` — the newest published parse run;
- `visibleFetchRunCount` / `visibleFetchRunHighWater` — the visible financial
  fetch runs, so an exclusion annotation or an unsealed run is a new context
  even though nothing was published;
- `identityRelease` — `current-mappings-v1` (the `latest` read mode);
- `metricRegistryRelease`, `decimalPolicyRelease`, `projectionRelease`,
  `authorityPolicyRelease`, `scopeRelationRelease`.

Same inputs ⇒ same id ⇒ same rows. That is what makes a partially written
build safe to resume instead of restart, and what makes a new publication
produce a _new_ snapshot rather than mutate the one a reader is paging.

## How a row gets its state

`packages/read-model/src/balance-projection.ts` is pure and does addendum 05
§5 step 1 (which candidates belong to the target). Steps 2–7 are performed by
`selectAdoptedSet` in `packages/domain`, unchanged.

1. **Candidates.** The same latest-balance query the reader serves, taken once
   unfiltered and once per measure view, so the projection holds their union
   and each view selects exactly the rows it selects today. More than 5,000
   candidates is refused: the job seals nothing and `/api/balances` keeps
   answering 413.
2. **Witness bundling.** `projectBalanceRows` from
   `poc/observation-pipeline/shared/balance-semantics.ts`, unchanged. The
   strict rule (identical provider minor units _and_ identical raw text, one
   identified product, one parse) is neither relaxed nor duplicated here.
   Disagreeing evidence stays a conflict and is never collapsed.
3. **Targets.** `(metricId, unit)` from the versioned metric registry. A
   metric the registry does not know is targeted per provider metric: unknown
   meanings are stored and displayed but never pooled with each other.
4. **Relations.** Adopted `entity_relations` become scope relations:
   `same_account` → `same`, `connection_contains` / `account_has_pocket` /
   `statement_covers` → `subset`. A _proposed_ relation contributes nothing,
   which is why SC06 stays an unknown overlap: knowing the connection never
   establishes which terminal account a line belongs to.
5. **Disjointness policy** (`distinct-identified-accounts-v1`). Within one
   source, two distinct non-aggregate scopes are disjoint, because the
   provider listed them as separate accounts. Across sources, only scopes the
   identity layer resolved to identified accounts are disjoint. Aggregates,
   aggregator lines and provider-local labels seen through a second route are
   deliberately absent, so their overlap stays unknown (INV06).
6. **Authority.** `packages/read-model/src/authority.ts`
   (`source-authority-v1`) supplies the caller policy `selectAdoptedSet`
   takes: direct sources rank 0, aggregators rank 1, unreviewed sources rank 2. A rank never establishes that two scopes are the same measurement; it
   only decides which side of an unproven overlap stays adopted, and equal
   ranks leave both sides unresolved.

### States and reason codes

| State        | Meaning                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adopted`    | In the adopted set for its metric and unit.                                                                                                                                                                    |
| `excluded`   | Another record explains the same scope (`covered_by_breakdown`, `covered_by_total`, `duplicate_evidence`, `metric_mismatch`, `unit_mismatch`, `conflict_resolved_by_rank`).                                    |
| `unresolved` | Neither adopted nor excluded (`overlap_unknown`, `overlap_declared`, `total_breakdown_mismatch`, `value_not_exact`, `coverage_partial`, `coverage_unknown`, `ownership_unknown`, `adoption_target_oversized`). |
| `conflict`   | Evidence of one measurement disagrees (`witness_value_conflict`, `conflicting_evidence`).                                                                                                                      |
| `stale`      | The newest published attempt over the same source and dataset did not re-observe this scope. The row is kept and the failure is reported next to it (SC15, AT61, AT62).                                        |

Freshness is recorded separately (`current` / `stale` / `unknown`) with the
`snapshotEligibility` reason code of the failing claim, so "we could not
observe" is never rendered as "the balance is gone".

### Build budgets

| Budget                    | Value | Why                                                                                                                                                                  |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate bound           | 5,000 | The existing read bound; above it the build is refused, not cut.                                                                                                     |
| `ADOPTION_SUBJECT_BOUND`  | 250   | Adoption compares scopes pairwise. A larger target records every candidate `unresolved`/`adoption_target_oversized` — never silently adopted, never silently summed. |
| `PROJECTION_WRITE_BUDGET` | 1,000 | Rows written per cron invocation; the rest resume from the stored build cursor.                                                                                      |

## The API

`GET /api/v2/balances/latest` and `GET /api/v2/balances/history` are separate
routes with separate budgets. Both return the D10 envelope:

```jsonc
{
  "schemaVersion": "snapshot-page-v1",
  "items": [/* ... */],
  "page": {
    "limit": 100,
    "hasMore": true,
    "nextCursor": "…",
    "snapshotId": "…",
    "paginationVersion": "keyset-v2",
  },
  "dataCoverage": {
    "completeness": "partial",
    "stale": false,
    "reasons": ["unresolved:overlap_unknown"],
  },
}
```

`page` describes this page. `dataCoverage` describes the data behind it. A
response limit is never evidence about a portfolio, and the two are never
merged into one `truncated` flag.

Each latest item carries:

- `row` — the v1-shaped evidence row, with `organization`, `normalized` and
  the same `interpretation` record `/api/balances` returns today;
- `quantity` — `ObservedQuantity`: the decimal-v1 `normalized` value (the only
  input a calculation may use), the unit reference, and the legacy provider
  columns under `sourceRepresentation` as evidence. An unknown minor-unit
  exponent stays `null` rather than being guessed;
- `metric` — `{ metricId, definitionRelease, measurementKind, aggregationRule }`;
- `adoption` — `{ state, reasonCode, memberEvidence[], evidenceCount }`. The
  evidence count is the number of witnesses of one measurement, which is not
  the number of balances shown (addendum 11 §4);
- `temporal` — a `TemporalReference`: a date stays a date, an instant keeps its
  offset, and anything else is `unknown` with a reason;
- `freshness` — `{ state, reasonCode }`.

The latest page also carries `subtotals`:

```jsonc
{
  "policyRelease": "known-assets-subtotal-v1",
  "knownAssetsSubtotal": [
    { "unitRef": "JPY", "coefficient": "160000", "scale": 0, "adoptedCount": 2 },
  ],
  "liabilitiesCoverage": "unknown",
  "reasonCode": null,
}
```

**There is no `netWorth` field, and the response validator rejects one.**
Unfetched liabilities mean an asset subtotal is not even a lower bound
(addendum 05 §5). Only `sum-disjoint` currency stocks with an asset-positive
sign and no overlap group are summable; capacities, aggregates, statement
amounts, period totals, reward units and balances restated after a
transaction are excluded by their registry entries. The sum is exact integer
arithmetic outside SQL, over the whole filter scope rather than the page, and
a subject that appears twice makes the subtotal unavailable instead of double
counting it. Above 5,000 adopted rows the subtotal is `null` with
`scope_exceeds_subtotal_bound`.

### Cursor contract

A cursor is base64url of `{v, s: snapshotId, f: filterDigest, k: sortKey, t: position}`.
It is **opaque but never trusted**:

- `f` is the digest of the route, the resolved scope, the page size and the
  identity read mode. A different filter set is a different query.
- `t` is the projection's dense `row_seq`, not a business identifier. A cursor
  therefore contains no account label, no provider metric and no amount.
- Every continuation request goes through the same Access gate and the same
  scope resolution as the first. A cursor is never an authorisation.

| Situation                                | Answer                |
| ---------------------------------------- | --------------------- |
| Undecodable or wrong shape               | `400 invalid_cursor`  |
| Filter digest differs                    | `400 cursor_mismatch` |
| Snapshot retired or deleted              | `410 context_expired` |
| Page size outside `50 / 100 / 200 / 500` | `400 invalid_limit`   |

The reader is never moved silently to a newer list. "Read the newest
snapshot" is an explicit action: drop the cursor.

Order is the recorded effective time descending, then the scope key
ascending, made dense as `row_seq`. A row with no recorded time sorts last and
says so; it never borrows another row's date.

### History

History is not a projection. It is the append-only record of visible parse
results, pinned to the snapshot's `publishedHighWaterParseRunId` so a
publication landing between two pages cannot insert a row into a page already
read. Its `dataCoverage.completeness` is always `unknown`: a history window is
not a membership claim. It is not bounded by the 5,000 candidate limit, so it
routinely holds more rows than the latest list.

## Capabilities and the v1 route

`/api/meta` advertises `balancesV2` and `balancesV2Pagination` only when the
reader flag is on **and** a sealed snapshot exists; otherwise the v2 paths
answer 404. The v1 routes keep `paginationVersion: "offset-v1"`.

`/api/balances` is unchanged. With the flag on it is served through a compat
adapter over the same projection — identical rows, order, offset window and
`interpretation` record, proved by a parity test on one synthetic fixture. The
adapter declines whenever the snapshot is behind the published evidence, so
the v1 promise of current data and its 413 for an oversized candidate set are
kept exactly.

## Rebuild and invalidation

The cron job (`services/observation-pipeline/src/balance-projection-job.ts`,
one call from `scheduled`) recomputes the input manifest each tick. If the
digest matches a sealed snapshot it does nothing. Otherwise it builds, writing
at most `PROJECTION_WRITE_BUDGET` rows per invocation and storing its resume
position; the snapshot is sealed in one statement after the last row, so a
reader that selects `status='complete'` never observes a partial build. Two
complete snapshots are retained so a reader with an open cursor survives one
rebuild; older builds are retired first and only then lose their rows.

Rebuild is currently whole-context, not per scope: the snapshot id changes on
any published parse, and the build recomputes every candidate. That is bounded
(5,000 candidates, 1,000 writes per tick) and correct. Incremental rebuild by
affected scope is the next step and needs a per-scope dependency record; it is
not implemented here.

Dropping the projection is safe: retire the snapshots, delete the rows, and
let the job rebuild from the same inputs.

## Forbidden optimisations

Named by the review, and none of them is used here:

- a plain `LIMIT` before grouping, which would push another witness of the
  same measurement off the page;
- resurrecting a instrument that vanished from an older snapshot because "it
  has no current row";
- raising the 5,000 bound and calling that scaling;
- `DELETE` against Layer B to fix a wrong projection.

## Deploy order

1. **Schema** — apply migration `0030`. Nothing reads or writes the new tables
   yet.
2. **Writer** — deploy `services/observation-pipeline`. The job is off; set
   `BALANCE_PROJECTION_ENABLED=1` when you want the first build. Watch the
   `balance_projection` line of the scheduled log for `status` and `written`.
3. **Reader** — deploy `services/evidence-browser` with
   `BALANCE_PROJECTION_ENABLED=0`. Nothing changes for any caller.
4. **Reader flag** — set `BALANCE_PROJECTION_ENABLED=1` on the browser once a
   snapshot is `complete`. `/api/meta` starts advertising `balancesV2` and
   `/api/balances` moves to the compat adapter.
5. **UI** — the frontend switches on the advertised capability, not on the
   name of the connection; no separate step is needed.

## Rollback

Set `BALANCE_PROJECTION_ENABLED=0` on the evidence browser. `/api/meta` stops
advertising `balancesV2`, the v2 routes answer 404, and `/api/balances`
returns to today's query path unchanged. Set it to `0` on the pipeline to stop
building. The projection tables can then be dropped and rebuilt later; no
observation, parse, publication or identity row depends on them.

## Verified locally

| Check                                                                                                                                                      | Where                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SC01 adopted set, SC06 unknown overlap, SC15 four empty meanings, oversized target bound                                                                   | `packages/read-model/test/balance-projection.test.ts`                                                    |
| Page envelope, cursor round-trip, mismatch and expiry, `ObservedQuantity`                                                                                  | `packages/domain/test/paging.test.ts`                                                                    |
| Seal, resume, immutability, retirement, deterministic snapshot id                                                                                          | `services/observation-pipeline/test/balance-projection.test.ts`                                          |
| 1,003-row keyset paging on a fixed snapshot while new evidence lands; 5,002-row history paging; cursor mismatch; 410; v1 parity; no `netWorth`; query plan | `services/evidence-browser/test/balances-v2.test.ts`                                                     |
| Capability schema pinned on both sides                                                                                                                     | `poc/observation-pipeline/test/api-schema.test.ts`, `services/evidence-browser/test/conformance.test.ts` |

Not verified: behaviour on production data volumes, real query-plan timings,
and incremental per-scope rebuild (not implemented).
