# ADR 0095: SBI Shinsei selected-period savings history

- Status: proposed
- Date: 2026-11-10
- Issue: [#1230](https://github.com/risu729/kogane/issues/1230)

## Context

The top-page capture contains only the latest ten activity rows. The owner's
read-only browser observation on 2026-11-10 confirmed that the selected-period
route returns the whole requested range for yen savings, Hyper Yokin and foreign
savings. The screen paginates these money rows locally at thirty rows. Requests
for subsequent screen pages return memo and description enrichment, with an
empty activity wrapper; they do not return another money page.

The bank accepts the current day back to the first day of the same month two
years earlier. A date before that first day was rejected by the visible form.
An empty foreign-currency range has an explicit no-activity status but no
account, currency or period echo. Its request must remain attached to the
response to make an account-specific empty claim.

## Options considered

1. Continue using the latest ten rows: leaves the retained history uncollected.
2. Use CSV or walk enrichment pages: adds requests without additional money rows.
3. Capture each selected-period response and bind a separate derived artifact to
   its validated request scope: selected.

## Decision

The scheduled same-page container collector serially reads one selected-period
response for every account in the already validated top overview's
`savingsDetails`. It derives the retention range from Tokyo's current day. No
request window or continuation state is added. A failed account does not retry
or prevent later account reads.

Each successful account produces a sanitized provider capture and a
`savings-activity` derived artifact containing the exact request scope and the
sanitized response. The extraction lineage names the provider capture. Both
artifacts belong to a stable account unit; its terminal report and requested
and declared ranges record complete coverage only after validation. Unit-scoped
eligibility admits a successful account when another account failed. History
is a union of transaction identities, not a replaceable balance snapshot.

Only the currently observed populated success and empty status are supported.
Unknown fields, codes, mismatched account/currency/period echoes, duplicate
references, invalid money rows or incomplete first-page enrichment fail closed.
The populated `purgeflag` value is checked against the observation, preserved
in the provider evidence, and assigned no inferred business meaning. No total
count exists in this response; parser `expectedCount` remains unknown.

The new parser preserves native currency, exact decimal debit/credit, posting
date, description, provider reference and row balance. Row balance semantics
remain unverified. Hyper Yokin has its own account stream; no balance timing is
inferred from it. Memo and description transformations are retained as evidence
but do not change the original description or amount.

Top-page and history rows share the existing account-local provider reference
identity. Current transaction selection uses the newest witness and prefers history at the same capture time; bank
debit facts and keyed card-settlement readiness admit both parsers under the
existing JPY/debit/status guards and rank the same provider key once. The same
provider-identity rule produces the same adoption alias across both parsers.
This extends evidence availability, not automatic economic adoption.

The provider data-type catalogue becomes `provider-data-types-v2`, with savings
cash movement collected. Runtime failures still make the affected run partial.

## Consequences

Each run makes one read per savings account in addition to the existing core
reads. It stores the provider capture and the request-bound derived view for
each supported account. The CSV route remains disabled. The older local
single-month inspection helper keeps its historical conservative contract; it
does not collect this scheduled history.

## Verification

Synthetic tests cover more than thirty money rows with thirty enrichment rows,
native foreign currency, no-echo empty responses, unsupported codes and keys,
duplicate references, scope mismatches, per-account failures, serialized token
rotation, raw-to-derived lineage, unit/range reports, mixed top/history current
selection and existing bank-debit eligibility. Workspace and root checks are
recorded on the PR. No production run or production publication is asserted.

The account-coverage view currently attributes cells from observation rows only.
A complete-empty savings history has no transaction observation, so this cell
remains in the view's unattributed list. Its exact account/currency/request
range remains in the derived artifact, and its hashed account unit, terminal
report, dated ranges and complete-empty parser claim retain the evidence.
No amount or synthetic statement observation is created to force attribution.
