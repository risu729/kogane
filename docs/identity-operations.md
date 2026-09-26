# Identity projection operations

The existing private `kogane-observation-pipeline` runs identity projection
after parsing on its five-minute schedule. It has no public route. The browser
remains GET/HEAD-only behind the existing Access gate.

## Bounded catchup

From `services/processor` in the authenticated WSL environment:

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

Since migration 0029 every correction is an identity command recorded in the
durable decision log ([decision-log.md](decision-log.md)). The JSON file may
carry `"operationId"` (an idempotency key: resending the same file returns the
stored receipt without a second revision, and reusing the key with a changed
body is refused) and `"action": "release-override"` with `"targetId": null`,
which appends a decision that lets automatic policy apply to the reference
again from its current revision on. A release does not delete the manual
mapping; the next scheduled sweep appends the rule's revision. Corrections
sent through this script are recorded with the actor `legacy-cli`
(verification `legacy-unknown`); the trusted-caller header
`x-kogane-verified-actor` records a named actor. The response carries the
receipt (`revision`, `mappingId`, `decisionRevisionId`); a `409` carries the
error code in `x-kogane-error` (`revision_conflict`, `idempotency_conflict`,
`target_missing`, `target_metadata_ambiguous`, `no_active_override`).

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
not change, except Mizuho (below); explicit future policies of 3 or higher retain numeric upgrade
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

### Collector-vpass runs have no trusted binding

Only the retired importer wrote the sidecar, and the trusted view accepts only
its producer, `collector-r2-importer`
([ADR 0023](adr/0023-vpass-collector-card-binding.md)). A run of the Vpass
collector (`collector-vpass`) has no sidecar to find: the collector stores no
binding artifact, redacts the session bean the token was derived from before
storing anything, holds no fingerprint secret, and registers under the session
namespace `shared-r2` with a registration run key, which the view's session and
run-key joins cannot match. Its rows therefore resolve to run-scoped
`unresolved` accounts under the producer `collector-vpass`, and card purchase
recognition skips them as `account_not_resolved`. Even with a trusted token, a
collector row's source account would differ from the importer-era one, because
the reference includes the producer, so importer-era mappings and manual
decisions would not carry over. Collector-vpass captures must not become
parseable in production until a collector-written binding is decided and
implemented, or the owner accepts that the importer-era purchases of every
re-captured card-month leave the totals.

## Policy 2: Mizuho rule re-identification

The resolver had no `mizuho-bank` rule when the Mizuho collector started, so
every policy-1 run mapped its accounts as `unresolved` /
`unrecognized-source-account`. The rule now accepts the parser's exact
reference `mizuho-bank:ordinary:{3-digit branch}:{7-digit account}` as a
provider-local `deposit` (`provider-branch-and-account`, label
`みずほ銀行 普通預金`); any other Mizuho shape stays unresolved.

A new run for one parse needs a new numeric version, so the `mizuho-bank`
policy module (`identity-policies/mizuho.ts`) requires version 2 for every
Mizuho parse. It needs no evidence: the family stays `identity-default`, the
release is `identity-default-v2` and the dependency set is empty. The bounded
sweep therefore treats sealed policy-1 Mizuho parses as candidates again and
appends a policy-2 run and rule mapping revision per source account; the
current views select the newer sealed run. The source account and account
entity are the same references as before, so balances and transactions are not
counted twice. Account entities are append-only, so a Mizuho entity first
written under policy 1 keeps its `source-account` role (shown as the role in the
identity browser); the `deposit` label, `provider-local` status and reason are
on the policy-2 mapping revision, which is what the projections read. Policy-1 runs, their rows and Layer A/B stay as recorded, and a
manual decision on a Mizuho reference is not replaced.

After deployment the five-minute pipeline sweep picks the parses up on its own;
to finish sooner run `node scripts/identity-ops.ts catchup 100 mizuho-bank` and
continue only if the bounded run reports more candidates. Verify that the
current Mizuho account mappings read `provider-local` at policy 2. No reimport
or B reparse is needed. Rolling back the code leaves the policy-2 runs current:
an older build cannot replace a newer sealed decision.
