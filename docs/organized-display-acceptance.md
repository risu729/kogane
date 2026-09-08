# Organized display and connection evidence acceptance

Accepted on 2026-09-08. This closes the display/correspondence goal, not a combined
ledger, full financial-data recovery, or universal account-equivalence project.

## Delivered scope

- [PR 136](https://github.com/risu729/kogane/pull/136) selects preferred instrument
  names from eligible saved Japanese-script evidence for the exact identifier.
- [PR 137](https://github.com/risu729/kogane/pull/137) adds read-only organization
  metadata to all four observation kinds, retaining originals and historical lineage.
- [PR 138](https://github.com/risu729/kogane/pull/138) applies preferred names to
  those observation responses and carries the name-evidence origin.
- [PR 139](https://github.com/risu729/kogane/pull/139) uses the metadata in transaction,
  balance, position, valuation and detail views without replacing merchant descriptions.
- [PR 140](https://github.com/risu729/kogane/pull/140) records versioned provider
  connection evidence independently of leaf-account mappings.
- [PR 141](https://github.com/risu729/kogane/pull/141) names account filter options
  without changing their original source/account values.
- [PR 142](https://github.com/risu729/kogane/pull/142) displays the connection inventory,
  confidence boundary and evidence links, including connections with no observations.
- [PR 143](https://github.com/risu729/kogane/pull/143) makes MF filter names use the same
  reviewed label policy, preserves manual names and marks multi-target scopes ambiguous.

Each logical change received an independent subagent review before auto-merge.
The reviewed deployment tree `626139f` equals merged main `7f40a42`.

## Persistence and production acceptance

Migration 0023 was the only pending migration and was applied to the existing
`kogane-raw-evidence` D1 database. The private Node operator first rechecked R2
size/SHA-256 and the account correspondence in read-only mode, then appended four
review records. A repeat apply reported four `unchanged` decisions, not duplicates.
The operator writes only the new review table; it does not rewrite source records,
account mappings or instrument mappings. The resulting review count was four.

The [connection audit](account-connections.md) records one confirmed **provider
connection** (SBI Shinsei), covering 16 exact current direct references, three
unresolved connections and **zero proven leaf-account equivalences**. Evidence
artifacts remain 6071/6259/6262 for Shinsei, 6058 for SMBC, 6084 for Vpass and 6097
for PRESTIA. Raw account numbers and credentials are not copied into these reports.

The existing protected `kogane-evidence-browser` Worker was deployed as version
`5eee2d7c-d2b0-4751-86ec-8d96dd0a3a33`, with annotation
`Reviewed organized names and MF connection evidence PR136-143 626139f`.
No new public Worker, Container, bucket, database, authentication route or financial
login was created. Existing Access issuer/audience and worker-first asset protection
were retained. An unauthenticated request from the existing external test host to
`/api/identity/connections` returned 403 after deployment.

Before deployment, the actual read-only handlers were bundled locally and exercised
against production bindings. All 12 sampled routes returned 200 and passed the shared
response validators; measured elapsed times were 110–1,606 ms. This is handler/data
acceptance, not a substitute for checking the deployed authentication gate.

| Sample                                     | Result                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Identity accounts / instruments / coverage | 67 account references, 100-row instrument page, 12 sources                                                  |
| Connection inventory                       | 4 rows: 1 confirmed connection, 3 unresolved, 0 ineligible                                                  |
| Transaction filters                        | 22 raw scopes, 20 named, 2 explicitly ambiguous                                                             |
| Balance filters                            | 42 raw scopes, 41 named, 1 explicitly ambiguous                                                             |
| Position filters                           | 3 raw scopes, 2 named, 1 explicitly ambiguous                                                               |
| SBI transactions                           | 91 rows, all organized; 72 Japanese-name evidence occurrences                                               |
| MF transactions                            | First 500 rows, all organized                                                                               |
| Shinsei balances                           | 459 latest/history response occurrences, all organized                                                      |
| SBI positions and paired valuations        | 133 occurrences, all organized; 23 retained position source names and 97 Japanese-name evidence occurrences |

Counts above are page/response occurrences, not distinct securities, distinct financial
events or complete historical coverage. Latest/history rows can overlap.

After deployment, the existing authenticated Chrome tab was reloaded once and the
following real UI paths were checked:

- Transaction rows and account selectors show organized names; MF remains labeled
  as connection-scoped with individual-account correspondence unresolved.
- The account catalogue shows all four reviewed MF connections, including Shinsei,
  with a one-confirmed/three-unresolved summary and the direct-first/MF-complement policy.
- Expanding Shinsei exposes its narrow connection claim and three original-evidence links.
- Holdings show Japanese labels, including foreign securities with saved Japanese
  names, and retain provider names when the preferred name differs.
- A holding detail shows the exact identifier, current mapping revision, original
  stored values and a link to the Japanese-name observation that supports its label.
- Balances show organized account names and the separate confirmed-connection disclosure.

## Local verification

- Final evidence-browser suite: 59 passing D1/runtime tests; generated types and TypeScript pass.
- Full client/parser suite before the connection UI addition: 425 passing tests.
  A first run used an outdated evidence-preview build; rebuilding all client modes
  resolved the four preview failures, and the full rerun passed.
- Final combined connection/organization/production UI checks: 16 passing browser
  tests, 256 assertions; client TypeScript and production build pass.
- Representative scale fixture: 6,000 parse runs, 35,000 observations, 2,692 retained
  pins and 96 sidecars. Connection-aware filter labeling took 123 ms locally;
  the existing lineage/revision/exclusion assertions remained valid.
- Reviews added explicit unique-reference budgets, a real R2 object-size guard,
  eligible manual-label preservation, API fixture compatibility and negative limit tests.

## Remaining boundaries

- Matching a provider connection does not authorize suppressing either route,
  adding balances, or deduplicating transactions. MF-only periods/items require
  independently established leaf attribution and coverage before complementing a ledger.
- MF returned no parsed balance observations in this audit. This rollout does not
  add an account-detail balance parser or claim that MF balance display was exercised.
- The existing 568 failed parsing jobs are still disclosed; they are not new display
  errors and are not repaired by name/correspondence metadata.
- Japanese labels require retained eligible evidence for the exact identifier.
  Unsupported translations, guessed global crosswalks and automatic leaf aliases
  are intentionally not created. Manual names take precedence.
- The production free-text transaction search still searches original observation
  fields; it is not a new cross-page search index for organized names.
- Raw evidence/parsed-row panels intentionally retain original identifiers and text.
  The display layer does not rewrite malformed provider text or acquisition history.

There are no temporary Cloudflare resources to remove for this rollout. Private
local probe outputs can be discarded independently of the committed implementation,
review records and this acceptance report.
