# MoneyForward connection correspondence

This layer records evidence about a provider connection separately from Layer C
leaf-account identity. It never changes `account_mappings`, deduplicates
transactions, adds balances, or converts debit-card activity into a deposit.
An MF connection can contain multiple cards, currencies, products, or points.
Even a confirmed connection does not establish which leaf account produced a
monthly-calendar transaction.

## Saved-evidence audit, 2026-09-08

The audit read the latest complete MF inventory and its four account-detail
artifacts, plus retained direct-collector responses. R2 bytes were checked against
the central SHA-256 and byte-size descriptors. Original account numbers, request
identifiers, amounts and bodies were not copied into this report or review rows.

| Connection  | Evidence and result                                                                                                                                                                                                                                                                                                                 | Remaining boundary                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SBI Shinsei | MF detail artifact 6071 supplies a three-digit branch and seven-digit displayed account number. Their exact concatenation equals the direct `nationalid` in all five checked request sections of artifacts 6259 and 6262. Branch code and branch name also agree. The direct overview supplies 16 distinct leaf account references. | Confirmed **same provider connection**, not 16 leaf-account equivalences. MF ordinary and hyper-deposit rows use the same displayed number; direct internal leaf IDs use a different namespace. |
| SMBC        | MF detail 6058 lists ordinary and foreign-currency items. Audited direct balance/transaction JSON contains no branch/account number witness.                                                                                                                                                                                        | Unresolved. Institution or branch names alone cannot establish correspondence.                                                                                                                  |
| Vpass       | MF detail 6084 contains points, card totals and member subrows; number cells are empty. Direct card identities come from independently verified provider descriptors.                                                                                                                                                               | Unresolved. Card product names do not bind the MF connection or rows to individual direct cards.                                                                                                |
| PRESTIA     | MF detail 6097 lists four deposit/product scopes. No PRESTIA deposit collector exists in the audited scope.                                                                                                                                                                                                                         | MF only. GLOBAL PASS debit activity is a different product/measurement scope.                                                                                                                   |

The original MF summary rows contain classes but no opaque leaf-reference
attributes. Saved detail-transaction forms have empty `sub_account_id_hash`
values; the generic input form's default is not a transaction identity. The
canonical monthly tooltip exposes two plain cells: description and amount.
Its observations therefore remain connection-scoped. It is not valid to copy a
single account number onto all those observations.

## Persistence and replay

Migration `0023_account_connections.sql` adds append-only versioned review rows.
Each record pins the MF detail artifact and, for confirmed Shinsei connections,
the direct overview and branch-summary artifacts from the same successful run.
The stored direct-reference set consists of exact existing Layer C reference IDs
whose provider accounts occur in that overview, scoped to its producer. It is
not a wildcard that automatically includes future credentials or accounts.

`account-connection-proof.ts` verifies provider success, the exact branch/number
relationship, agreement among request sections, the audited MF product scope,
unique direct leaf references, and the activity-account membership. It returns
no account-equivalence claim. Original identifiers stay only in verifier memory
and their existing evidence/observation stores.

The database rejects wrong source/producer/dataset/run evidence, unknown direct
references, revision gaps, replacement, update and deletion. Effective reads
recheck financial-evidence eligibility, including later run exclusions. Excluded
proof remains visible as historical `evidence-ineligible` with its original
artifact links, and is not presented as currently confirmed. Multiple connection
claims on one direct reference are explicitly unresolved.

Run the private operator script with Node and an existing private configuration
that binds `DB` and `EVIDENCE` to the authorized database and bucket:

```sh
node services/observation-pipeline/scripts/review-account-connections.ts --config /absolute/path/to/wrangler.diagnostic.jsonc
```

The default is read-only and works before migration 0023 is applied. After the
migration and review, append `--apply` to persist verified decisions. The script
only appends changed semantic claims and checks the expected next revision. It
does not contact financial institutions or deploy a Worker. The read helpers
must only run after the browser's existing Access gate. `listAccountConnections`
also includes connections with no parsed observations, such as the audited
Shinsei MF calendar, so absence of transactions does not hide its evidence.

## Display preference and completion boundary

For a verified individual account and the same period, item, currency and
measurement, the direct provider view is the preferred presentation. MF-only
periods or items may supplement it only when leaf attribution and the coverage
boundary are independently established. A connection-level match by itself
does not authorize replacing, suppressing, merging or summing either route.
Current observations continue to show both routes and their original provenance.
Missing attribution remains visible; this change does not implement a combined
ledger or a combined balance.

The first production dry-run found four reviewed connections, one confirmed
connection correspondence covering 16 exact direct references, three unresolved
connections, and zero proven leaf-account equivalences. Publication and protected
UI acceptance are tracked separately by the parent rollout.
