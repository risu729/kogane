# Production observations rollout

## Scope

Connect the merged collectors' stored Layer A evidence to persistent Layer B
observations and the existing protected Workers UI. This does not implement
Layer C cross-source reconciliation or Layer D financial calculations.
Source R2 objects and existing Layer A records are not modified or deleted.

## UI repair: local-first regression work (2026-09-08)

The initial deployment checks were insufficient: successful HTTP responses and
basic headings did not establish that navigation and filtering worked with
production-sized collections. The old browser suites covered a synthetic
observation app and the Sony raw-only app, not their production integration.

Confirmed defects repaired in this PR:

- Legacy and production builds shared `web/dist-evidence`; a legacy build could
  overwrite the deployable app. Production now has `web/dist-production`, and
  CI explicitly builds and validates all three isolated asset targets.
- Routing observed only the pathname. Query-only pagination changes were not
  reactive, and returning to the same list could retain its cursor.
- The embedded acquisition-history app replaced the navigation shell and
  incorrectly said parsed observations were unavailable. The raw-only app also
  advertised observation routes its API did not provide.
- Collection limits were applied before browser filtering. A source or account
  absent from the first 500 rows could not be discovered or displayed through
  those filters despite having stored observations.

Repairs are reproduced with local synthetic data and the actual production
bundle before deployment. Browser operation against the deployed site is reserved
for final verification. No collector, raw evidence, Access policy, or database
migration is changed by this UI repair.

Local verification: 338 observation/frontend tests passed, including the new
production-mode suite under CSP at desktop and mobile widths; 26 Workers-runtime
API tests passed, including 1,003-row pagination and 5,002-position regressions;
16 CI-policy tests passed. Typecheck, formatting/lint hooks, and both production
and demo deployment dry runs passed. Independent reviewers checked the API and
UI contracts, source/account identity, historical filter options, and build
isolation. These tests use synthetic data, not exported financial records.

## Deployment checks (2026-09-07 UTC)

- PR #105 merged as `ceb2bf3b52ad3387137eaf12add5dcf3ade855ee`.
- Reconciler provisioning and initial repair evidence is recorded in
  [the reconciler runbook](../services/collector-r2-importer/docs/r2-outbox-reconciler.md).
- Before the UI change, the existing enrolled WARP browser successfully
  displayed the production Sony evidence list. Local WARP HTTP returned 200;
  an HTTP request from the existing OCI `bots` host returned 403. Local HTTP
  without an explicit cookie is not an unauthenticated test: WARP can
  authenticate it transparently.
- Before migration, the only pending D1 migration was
  `0017_observation_pipeline.sql`. A pre-migration Time Travel bookmark was
  `0000007f-00000022-000050df-10a44068989b4c7fee043c1410141f69`.
  Restoring the entire database would also roll back concurrent collector
  imports, so this is an emergency recovery reference, not routine rollback.
- Existing raw-evidence tests: 54 Workers-runtime tests and all source-route
  shell checks passed with the additive migration present locally.

## Deployed services

- `kogane-observation-pipeline`: private scheduled Worker, no public route or
  workers.dev endpoint; every five minutes scans central evidence and processes
  durable D1 jobs. Migration 0017 was applied remotely (37 commands).
  Version `2d5ce979-7f21-4bd9-a39d-0525c99c0d19` includes numeric-version
  publication guards so late older parses cannot replace newer results.
- `kogane-evidence-browser`: existing protected UI, updated to read Layer B from
  the existing D1. Version `7abed494-1b29-4c2d-9909-fe702cbc73e1`.
  Existing Access application, issuer/audience and independent JWT verification
  are unchanged. The separate synthetic demo was not redeployed.
- `kogane-collector-r2-importer`: version
  `75cc8c7e-88f5-436f-a64b-9e796b071f0a`; 13 managed notifications across
  12 source buckets, reconciler queue and DLQ, weekly `23 19 * * SUN` repair.
  The original numeric Sunday expression was rejected by Cloudflare; config,
  scheduled-handler guard and regression were corrected together.
- `kogane-vpoint-collector-poc`: V Point Pay writer was also deployed, version
  `89bcdeee-e128-42df-b936-d214c427906b`, so #105's EML-before-terminal-JSON
  publication order is live. Existing variables, secrets and schedules retained.

## Real-data verification

At 2026-09-07 15:05 UTC, the authenticated read-only API returned 200 for metadata,
overview, transactions, balances, positions and artifacts. Current positions
contained 23 rows (18 domestic and 5 foreign SBI securities positions).
The live Chrome UI showed both domestic account types and foreign holdings;
following a position reached its parse run, original artifact and download link.
An old rejected parse and its later successful 108-observation replacement were
both visible in artifact history. Original provider bytes were not edited.

The off-WARP OCI host returned 403 for `/api/balances` after deployment. A local
WARP request returned 200, which is expected enrolled-device authentication, not
evidence of public exposure. Tests additionally reject absent/invalid JWTs before
serving assets, APIs or raw downloads.

Initial real-data parsing exposed discrepancies not represented by synthetic
fixtures. They were reproduced against size/SHA-verified raw objects in memory:

- SBI domestic MTS index can equal the total count on a complete response; accept
  only verified complete count/index and exact base/trailer lengths.
- SBI yen history includes a legacy direct single page. Accept it only when its
  own pagination metadata proves completeness, and preserve actual raw locators.
- Sony date formats include ISO offsets/milliseconds and Japanese calendar dates;
  blank optional rates do not become numeric values. WALLET's exact MIME comes from the
  verified collector manifest, not a guessed encoding.
- SBI Shinsei timestamps also use slash-separated local date/time, and the yen
  response uses an explicit successful status wrapper.
- D1 rejects LIKE patterns over 50 bytes; equivalent `instr` fixed the shared
  current-snapshot predicate. Current position/valuation membership must be
  selected before applying the intermediate query bound, rather than counting
  thousands of historical snapshot pairs.

## Coverage and remaining work

The UI is an evidence viewer, not a complete portfolio calculation. Transactions
and balance history currently expose a bounded 500-record window with an explicit
coverage warning. Artifacts support server cursor paging. Cross-source matching,
tax calculations, FX conversion and aggregate net worth are not implemented.

At 15:05 UTC, Layer B had no pending/running jobs and 117 unresolved parser
rejections (retired versions excluded). The importer repair queue still had 113
messages and its DLQ was empty; queue provisioning and deployment do not prove
that every source's historical import has completed. Source-specific follow-up
results are recorded below as they are verified.

Follow-up diagnoses distinguish a code mismatch from genuinely insufficient
evidence. SBI yen 1.0.2 accepts the audited legacy schema with only the primary
limit flag (still explicitly false); all 30 previously rejected captures replayed
successfully. Sony WALLET 1.0.2 handles blank optional usage amounts and preserves
unmodelled original-currency values without inventing currency exponents or fees;
all 12 distinct payloads covering 40 failed artifacts replayed successfully.
Malformed comma grouping remains rejected, including in supplemental amounts.

MoneyForward already had 10 sealed successful runs in central storage: its absent
jobs were caused by a MIME acceptance mismatch, not the remaining repair queue.
The importer declares verified HTML as `text/html`. Monthly 2.0.1 and evidence
1.0.1 accept that exact MIME as well as the charset-qualified form, with strict
UTF-8 decoding and the original source/identity/body checks intact. Its subsequent
real-data replay results must be assessed separately from this routing fix.

Independent subagent review covered the persistence/publication path, protected
UI queries, parser changes and diagnostic scripts. A review caught a malformed
comma grouping case in optional Sony amounts; it was fixed with negative and
positive regressions before deployment. Local full observation tests passed
333/333, evidence-browser Workers tests 23/23, backend workerd tests 11/11,
and CI package-registry tests 16/16. Typechecks and dry runs passed. The shared
repository checks passed using existing GitHub authentication after unauthenticated
action-pin verification hit the shared-IP API rate limit.

The first clean GitHub runner found a missing shared-parser dependency install
that the developer checkout already had. The explicit CI plan now installs the
parser package's frozen dependencies before Worker checks, without building the
UI or starting a collector. A regression verifies this ordering.

## Final targeted backfill

The MoneyForward correction re-imported exactly the 10 resolved legacy source
captures through the existing v2 importer. Read-only verification confirmed 10
new sealed v2 runs, 530 provider artifacts and 10 manifests; all legacy runs and
source R2 objects remain unchanged. The bounded replay received 120 successful
chunk responses, including ten idempotently repeated chunks after one final-seal
`central_500_internal_error`. A resumed pass succeeded; the original 500's cause
was not established and is not labelled a confirmed platform incident.

The old 520 MoneyForward account/monthly parse failures remain historical
evidence: they lack stable account identity and were not silently admitted or
deleted. New v2 runs carry verified keyed identities. Alongside these are 22
unsupported GLOBAL PASS captures and 25 Shinsei top activity captures without a
coverage interval. These failures are separate from current collector success
and from the asynchronous R2 repair queue. A zero pending-job count is never
proof that every source's raw archive or every account is fully represented.

Final verification at approximately 2026-09-07 15:45 UTC:

- All 530 new MoneyForward provider artifacts parsed successfully: 480 monthly
  and 50 evidence-only artifacts. Its 10 older index artifacts also remain
  successful, hence the source's total successful-artifact counter is 540.
- Across 12 source IDs, 4,251 distinct artifacts have a successful unsuperseded
  parse. There are zero pending/running parser jobs. The displayed 567 failures
  are the 520 legacy identity failures plus 22 GLOBAL PASS and 25 Shinsei cases
  described above; retired/replaced versions are not counted as unresolved.
- The store retains 16,463 transaction, 7,807 balance, 1,171 position and 8,126
  valuation observation rows, including superseded history. These are storage
  counters, not counts of unique current financial events.
- All six main authenticated APIs still return 200 after full targeted replay.
  Chrome's transaction source filter displays MoneyForward records; its counts
  remain bounded to the API's explicitly limited display window.
- The separate historical R2 repair queue still reports 110 outstanding messages,
  DLQ zero, with its weekly Cron and configured single consumer intact. This
  rollout does not claim that this independent repair queue has drained.

CodeQL flagged a substring host check in the read-only diagnostic script; it now
parses the URL and compares the HTTPS hostname exactly. No access-control gate
depended on that diagnostic. The deployed runtime code and all implementation
checks passed on signed commit `412b874b3cffe9a2aeebe5b0326861027bd43efc`;
the final documentation-only update records the completed rollout counters.

## Resource and rollback inventory

No public diagnostic Worker, new database, new bucket, container, or paid external
service was created for this rollout. Local remote-binding diagnostics only read
metadata/counters or verified bytes in memory and do not store financial bodies.

To stop new parsing, remove the private parser's cron or roll back that Worker;
retain additive D1 tables, parse history and all Layer A/R2 evidence. To revert
the UI, deploy the previous evidence-browser version while retaining Access.
The reconciler's exact managed queue/notification cleanup procedure is in its
runbook; do not remove unrelated Vpass queues or source objects. No cleanup is
required to keep these production components running.
