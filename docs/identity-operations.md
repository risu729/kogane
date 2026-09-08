# Identity projection operations

The existing private `kogane-observation-pipeline` runs identity projection
after parsing on its five-minute schedule. It has no public route. The browser
remains GET/HEAD-only behind the existing Access gate.

## Bounded catchup

From `services/observation-pipeline` in the authenticated WSL environment:

```sh
node scripts/identity-ops.ts catchup 500 sbi-securities
node scripts/identity-ops.ts catchup 1000
```

The first command is the SBI-first rollout; the second covers all existing
successful parses, including superseded history. Each service invocation has a
200-new-observation budget and up to 40 candidate parses. Pages checkpoint in
the immutable staging rows; an interrupted or budget-limited run skips completed
rows on its next invocation. Only a complete run is sealed/visible. Empty
successful parses can be sealed; failed or unsealed-A parses cannot.

Proven-empty parses use one bounded D1 batch: identity runs, any mandatory
Vpass binding pins, then completeness seals. All four observation tables,
successful acquisition visibility and required policy are rechecked inside the
write. Up to 40 empty parses therefore need three write statements rather than
sequential per-parse projection calls. Nonempty parses keep the existing
200-new-observation budget, and an empty trusted Vpass run still requires its
verified provenance pin. The optimization never creates accounts/instruments
for an empty parse or changes manual mappings.

`processedRuns` measures touched jobs, `identifiedRuns` newly completed jobs,
and `identifiedObservations` newly staged rows. The script stops only when there
are no candidate runs, not merely when a large partial job has no seal yet.
It prints counters only. The maximum sweep argument is a safety bound, not
proof of completion; verify remaining coverage afterward.

## Corrections

Inspect the protected account/instrument list for the reference ID, existing
target ID, current revision and provenance. Put a deliberately reviewed change
in a **local, uncommitted** JSON file:

```json
{
  "kind": "account",
  "referenceId": "source-reference-from-protected-ui",
  "targetId": "existing-target-from-protected-ui",
  "expectedRevision": 1,
  "reason": "Evidence supporting this explicit correction"
}
```

Then run `node scripts/identity-ops.ts revise /absolute/path/to/change.json`.
Instrument corrections use `kind: "instrument"`. Neither operation edits raw
evidence, observations, quantities, or financial classifications. A stale
revision fails, rather than replacing another operator's decision. Target
metadata is taken from its current mapping claims (or initial entity metadata
if it has no mapping), never silently from an obsolete claim. Ambiguous target
metadata is rejected. Manual mappings are not overwritten by scheduled rules.

## Verification and rollback

- `/api/identity/coverage` compares all eligible current B observations against
  completed C runs by source; organized is not globally identified.
- `/api/identity/accounts` and `/api/identity/instruments` read effective mapping
  revisions, expose their evidence links, and paginate at 100 rows.
- Preserve the original pinned decision IDs to audit what was recorded at the
  time, even after a manual correction.
- Old B parses/failed acquisitions remain in their own history and never
  become current merely because an identity run was sealed.
- Roll back code/scheduling if necessary; do not delete the append-only C tables
  or roll back unrelated ongoing collector ingestion.

## Policy 2: trusted Vpass sidecar upgrades

Apply additive migration `0020_vpass_identity_binding.sql` before deploying the
policy-2 pipeline. The lookup uses the exact acquisition session, source,
producer, financial card unit and sidecar run key described in
[the Vpass binding contract](vpass-card-identity.md). Both runs must be sealed and
successful, and the binding artifact's unit must belong to that same run with
the exact dataset, format, version and key. Extra/malformed/conflicting sidecar
units or binding artifacts fail closed. No field in provider `extra_json` can
supply a trusted identity.

Successful policy-2 decisions pin the sidecar artifact, financial unit and HMAC
token in immutable `identity_vpass_bindings`. The account reference uses the
trusted token plus the existing source/producer boundary, not ordinal, run,
merchant name or rotating selector. It is provider-local, not global identity.
SQL rejects mismatched pins and unproven durable account references. Read views
recheck binding eligibility, so later run exclusions revoke its current use
without deleting historical decisions.

Missing or ambiguous sidecars complete as policy-1 run-scoped projections; they
do not remain at the head of a pending queue. When valid sidecar evidence arrives,
the bounded sweep selects policy 2 automatically, including already completed
baseline parses. Run `node scripts/identity-ops.ts catchup 500 vpass` after a
sidecar backfill and continue only if the bounded run reports more candidates.
No financial reimport or B reparse is needed. A prior manual decision on the
run-scoped account reference is retained instead of being silently replaced by
the new automatic token mapping; the binding is still pinned for review.

Verify baseline versus policy-2 counts and pin provenance separately from
global identity status. Other sources remain on policy 1 because their rules did
not change; explicit future policies of 3 or higher retain numeric upgrade
behavior. Audits use the exported `requiredIdentityPolicySql` helper, the same
eligibility expression as the projector. Rollback must preserve migration 0020 and all pins/seals;
older policy-1 workers cannot replace a newer sealed decision.

Current-read query plans must be tested with many parse runs and pinned policies,
not only many observations in a few parses. Migration 0022 evaluates eligible,
sealed candidates once per current parse and selects the highest valid policy
before observation expansion. An unsealed or revoked higher policy cannot hide
the prior valid sealed policy; a valid sealed empty result still supersedes an
older result. The writer's keyed eligibility view stays unchanged. This avoids
the old plan that multiplied acquisition terminal reports by all successful
parses, even for a direct read of the core identity view without UI joins.
