# Protected production observations

The production UI uses the existing `kogane-evidence-browser` Worker and its
existing D1/R2 bindings. Layer B is persisted by the separate scheduled parser;
the browser Worker only reads. No public parser endpoint, service HTTP fetch,
Access policy change, or new hostname is needed.

All assets, API routes, and raw downloads still pass the existing Access JWT
verification first. Preserve `run_worker_first: true`, the issuer and audience,
`preview_urls: false`, and the enrolled WARP Access application. Missing or invalid
JWTs fail closed. Responses remain no-store, logs contain no values or URLs, and
raw bytes remain checksum-verified downloads with sandbox headers.

Apply raw-evidence migration 0017 and deploy the parser before switching the UI.
Run `mise run web:build-production`; this writes the
isolated `web/dist-production` asset directory. Deploy only the existing production
evidence-browser config. `web:build-evidence` retains the older raw-only UI build;
the isolated synthetic demo continues to use its separate config and snapshot.
These three builds have separate output directories; running the legacy tests
cannot replace the deployable production application. CI builds all three before
testing, and production-mode browser tests exercise the production asset bundle.

`/api/meta` identifies `source.kind=central-store` and
`source.classification=financial`. This describes the backing store, not freshness
or completeness. `/api/overview`, `/transactions`, `/balances`, `/positions`,
`/artifacts`, artifact detail and observation detail preserve the existing v1
observation DTO fields and add collection coverage where relevant. Failed D1
reads produce a 503, never an empty success. Existing `/api/evidence/v1` remains
the Sony raw-history API. Other parsed sources are accessible in the observation
artifact list; the existing Sony history route is not broadened.

Current-state SQL is ported from the PoC query policy, including complete-container
selection, successful parent run checks, supersession and provider deduplication.
The D1 adapter scopes every parse/observation read to sealed financial artifact
views and excludes pending publication. Excluding a parent run later also hides
its earlier parses, observations, counts and downloads. No browser persistence
contains financial values.

Collection responses expose `{coverage:{limit:500,truncated:boolean}}`. Source
and account filters are applied to the complete derived result before paging;
snapshot completeness and source deduplication are not evaluated on page fragments.
Transaction date/text filters and balance instrument/metric filters are also
server-side. `/api/filter-options?kind=transactions|balances|positions|artifacts`
provides eligible source/account choices independently of the current page.

Artifacts use descending immutable ID paging: `?cursor=<id>` and
`coverage.nextCursor`, preserving the source filter. Transactions, positions, and
balance history use explicit offsets with `coverage.nextOffset`. Latest balances
have an independent `latestOffset`/`coverage.latestNextOffset`, so browsing history
does not remove the current balances. SQL reads at most 501 final rows for each
page; the extra row indicates another page. Counts on a page are not lifetime
totals. Offset pages reflect current data at request time, not a frozen export
snapshot: concurrent new collector data can change page boundaries.

Complex intermediate reads remain bounded at 5,001 and fail with 413 rather than
silently corrupting a derived result. Position valuation lookup is scoped to the
positions on the requested page, not the global historical position population.
Detailed records remain independently addressable.

Before/after deployment, verify an authenticated enrolled-WARP browser and a
separate off-WARP request. A local WARP curl returning 200 is authenticated
evidence, not a missing-auth negative test. The main task verified the original
UI as 200 on WARP and 403 from the existing off-WARP OCI host before deployment;
repeat after deployment. Local tests cover JWT rejection for every observation
route, read-only methods, exact large minor-unit strings, typed DTOs, staged and
subsequently excluded observation visibility, raw integrity and evidence history.
