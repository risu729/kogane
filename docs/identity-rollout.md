# Account and instrument identity rollout

## 2026-09-08 implementation and initial deployment

- #114: append-only account/instrument mappings, pinned decisions and sealed projections.
- #115: SBI Securities account scopes and instrument references.
- #116: remaining collector rules, with explicit provider-local and aggregate classifications.
- #118: bounded scheduled projection, resumable historical processing and private corrections.
- #119: Vpass durable-card binding artifacts without duplicating financial artifacts.
- #120: protected React identity inspection page and read-only APIs.
- #121: private-operation input bounds and non-disclosure regression tests.

Applied migrations `0018_identity.sql` and `0019_identity_seal_provenance.sql`
to the existing production D1 database. No replacement database or public
diagnostic endpoint was created. The pre-migration Time Travel bookmark was
`000000c7-00000000-000050e0-5672c6438836d598c169786087d6e6f1`.
This is an audit reference, not permission to restore and discard later collector writes.

Initial deployed versions:

- Observation pipeline: `e2718b8a-a616-4cab-b482-2676b6da23dd`.
- Protected evidence browser: `cf45ba1e-9aac-40df-8d9a-bc1e28c0e53c`.
- Production frontend entry: `index-B9HyGQUd.js` (includes the separately merged
  evidence highlighting and UI layout changes).

Local verification on the combined tree: 18 identity storage/private-operation
tests, 35 evidence-browser service tests, and six identity frontend/contract
tests passed. Browser fixtures covered widths 390 and 1280, returning from
evidence details, pagination, and clearing cached data after authorization loss.
Existing Access issuer/audience and private pipeline routing were retained.

The SBI-first historical command stopped after 23 successful bounded sweeps with
HTTP 500 at the local service proxy. The cause was not captured and must not be
called a confirmed provider or D1 failure. A diagnostic tail was attached; a
single resumed sweep succeeded, then the next catchup completed with
`processedRuns: 0`, exit 0, without further captured Worker errors. Durable
checkpoints were reused; existing evidence was not deleted or re-imported.

This initial deployment record is not full rollout acceptance. Final acceptance
requires per-source current coverage, historical pending counts, Vpass trusted
binding consumption, and the final protected UI/access check. Provider-local
identification does not assert a verified global security-master crosswalk;
aggregate account rows are not independently owned assets to sum.
