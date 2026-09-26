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

### Collector-vpass runs bind in their own run

The Vpass collector (`collector-vpass`) writes the binding itself
([ADR 0023](adr/0023-vpass-collector-card-binding.md#amendment-option-3-implemented)).
Before it sanitizes a card's responses, the Worker derives the same token the
retired importer did (the tuple from the selection and discovery
`vpSessionBean`, the same consistency checks, HMAC-SHA-256 of
`["vpass-card-binding-v1", externalId, globalid, cardCode]`, key version
`collector-r2-v1`) with the Worker secret `VPASS_CARD_BINDING_KEY`, and stores
only the token: a second `card` unit of the card's run, keyed by the token, with
one `collector_derived` artifact `card-identity-binding.json`. Registration
gives that artifact the dataset `card-identity-binding` and format
`vpass-card-identity-binding-json` version `1`. Without the secret, with a
malformed secret, without the tuple or with a tuple that fails a check, the run
is stored with no binding and the Worker log carries one closed code
(`binding_key_absent`, `binding_key_invalid`, `binding_tuple_absent`,
`binding_tuple_invalid`, `binding_selection_mismatch`,
`binding_inventory_invalid`, `binding_envelope_invalid`).

Migration 0055 recreates `trusted_vpass_card_bindings` to accept this shape;
the importer's rows are exactly migration 0021's. The evidence is the same: a
successful, sealed Vpass run whose `card-NNN` unit holds the financial
artifact, and exactly one binding unit keyed `vpass-card-v1-<64 hex>` with a
successful terminal report, holding the one binding artifact of that dataset
and format. Only the place differs: the collector's binding is inside the
card's own run (producer `collector-vpass`, session namespace `shared-r2`, run
key `<session>-card-NNN:terminal-registration-v<N>`) instead of a sibling run,
and the run may hold no other unit and no second binding. Policy 2, its pins,
the seal trigger and `eligible_identity_runs` read the view, so they need no
change.

The card's unit reports `complete` coverage. A `partial` unit makes
registration record a `partial` unit report, which makes the whole fetch run
`partial` in `observation_fetch_runs`; neither this view nor
`current_identity_observations` reads a partial run, so every row would stay
unresolved even with a binding.

**Account continuity.** A source-account reference still includes the
producer, so a collector row gets its own source account
`["vpass:card", <token>]` under `collector-vpass`. Its automatic mapping points
at the account entity derived from the importer's reference for the same
token, so the importer-era entity id is unchanged and both producers' source
accounts map to one entity. What is keyed by the entity carries over: its
label, role and status, ownership links on `account:<entity>`, and the
`account_id` card purchases and settlements carry. What is keyed by the
importer's source account does not: its mapping revisions and any manual
decision on it. If an operator had re-mapped the importer's source account to
another entity, the collector's source account still maps by rule to the
token's entity and needs its own decision. A token derived under a different
key is a different entity with nothing carried over. Card purchases churn once
per card-month (the recognition key carries the producer): the importer's
event is retired and the collector's is recognised on the same account, and
nothing is counted twice.

**Owner action and check.** Set the Worker secret on `kogane-vpass-collector-poc`:
`wrangler secret put VPASS_CARD_BINDING_KEY` with the value of the retired
importer's `ORIGIN_FINGERPRINT_KEY` (64 lowercase hex characters). No
repository check can prove it is the same key. After the next collection,
compare token counts (read-only, counts only):

```sql
SELECT r.producer_id, count(DISTINCT u.unit_key) AS tokens,
       count(DISTINCT CASE WHEN EXISTS(
         SELECT 1 FROM fetch_units i JOIN fetch_runs ir ON ir.id=i.fetch_run_id
         WHERE ir.producer_id='collector-r2-importer' AND i.unit_key=u.unit_key)
       THEN u.unit_key END) AS known_to_importer
FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
WHERE r.source_id='vpass' AND u.unit_key GLOB 'vpass-card-v1-*'
GROUP BY r.producer_id;
```

For `collector-vpass`, `known_to_importer` equal to `tokens` for the cards the
importer also saw means the key is the importer's. Zero means a different key:
remove the secret and keep the Vpass pages unparsed; the bindings already
registered stay (evidence is append-only), and each such card would become a
new account entity if its pages were parsed, so it needs a decision first. The
collector's statement pages are not parsed today: registration gives them no
parser dataset, and the change that introduces parser datasets for shared-R2
artifacts (ADR 0022) withholds the Vpass one. Releasing it is a later change,
made after this check.

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
