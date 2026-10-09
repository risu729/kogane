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

### Instrument candidates

`/identities/instrument-candidates` lists which instrument identifiers may
denote the same instrument ([identity](identity.md#review-page-route-and-agent-tool),
ADR 0055). A proposed candidate's buttons plan its own command with the
reason you write: adopting is `identity.assign` of the subject identifier to
the anchor's instrument, keeping apart is `relation.reject` of `listed_as`
from the anchor's instrument to the subject. The plan opens on
`/confirm/:planId`, where it is approved and committed like any other
correction, recorded in the decision log and refused when stale. A held
candidate (its subject already decided elsewhere or sharing an instrument)
offers keeping apart only; moving that subject is a correction of the
earlier decision, made as above. An agent reads the same list through
`kogane.instruments.candidates` and plans through the same command API.

## Verification and rollback

- `/api/identity/coverage` compares all eligible current B observations against
  completed C runs by source; organized is not globally identified.
- `/api/identity/accounts` and `/api/identity/instruments` read effective mapping
  revisions, expose their evidence links, and paginate at 100 rows.
- `/api/identity/instrument-candidates` reads the ADR 0055 candidate set and
  pages it at 50 items per view; it writes nothing.
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
Before it sanitizes a card's responses, the Worker derives the card token from
the tuple in the selection and discovery `vpSessionBean`, with the retired
importer's consistency checks, as the unkeyed, domain-separated SHA-256
`vpass-card-v2-` + SHA-256(`JSON(["vpass-card-binding-v2", externalId,
globalid, cardCode])`) ([ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md)).
No secret is involved. It stores only the token: a second `card` unit of the
card's run, keyed by the token, with one `collector_derived` artifact
`card-identity-binding.json`. Registration gives that artifact the dataset
`card-identity-binding` and format `vpass-card-identity-binding-json` version
`1`. Without the tuple or with a tuple that fails a check, the run is stored
with no binding and the Worker log carries one closed code
(`binding_tuple_absent`, `binding_tuple_invalid`,
`binding_selection_mismatch`, `binding_inventory_invalid`,
`binding_envelope_invalid`).

Migration 0055 recreated `trusted_vpass_card_bindings` to accept this shape,
and migration 0057 recreates it again with one change: the token prefix may be
`vpass-card-v1-` (the importer's HMAC tokens) or `vpass-card-v2-`, and nothing
else; it also rebuilds the pin table `identity_vpass_bindings` with the same
widened CHECK, copying every pin unchanged. The importer's rows are exactly
migration 0021's. The evidence is the same: a successful, sealed Vpass run
whose `card-NNN` unit holds the financial artifact, and exactly one binding
unit keyed `vpass-card-v1-<64 hex>` or `vpass-card-v2-<64 hex>` with a
successful terminal report, holding the one binding artifact of that dataset
and format. Only the place differs: the collector's binding is inside the
card's own run (producer `collector-vpass`, session namespace `shared-r2`, run
key `<session>-card-NNN:terminal-registration-v<N>`) instead of a sibling run,
and the run may hold no other unit and no second binding. Policy 2, its pins,
the seal trigger and `eligible_identity_runs` read the view, so they need no
change.

The card's unit reports `complete` coverage only when every month's captured
rows equal the total the provider states for it
([collection: Vpass](collection.md#vpass-servicescollector-vpass-kogane-vpass-collector-poc)).
Otherwise it is `partial`: registration records a `partial` unit report,
which makes the whole fetch run `partial` in `observation_fetch_runs`, and
neither this view nor `current_identity_observations` reads a partial run, so
the rows stay unresolved even with a binding. The persist diagnostic's
`coverage` code says which it was.

**Account continuity.** A source-account reference still includes the
producer, so a collector row gets its own source account
`["vpass:card", <token>]` under `collector-vpass`. Its automatic mapping points
at the account entity derived from the importer producer's reference for the
same token, so one token value is one entity whichever producer read it: for a
v1 token the importer-era entity id is unchanged, and a v2 token (which the
importer never registered) names an entity no importer reference names but
every producer reaches. What is keyed by the entity carries over: its label,
role and status, ownership links on `account:<entity>`, and the `account_id`
card purchases and settlements carry. What is keyed by the importer's source
account does not: its mapping revisions and any manual decision on it. If an
operator had re-mapped the importer's source account to another entity, the
collector's source account still maps by rule to the token's entity and needs
its own decision. Card purchases churn once per card-month (the recognition
key carries the producer): the importer's event is retired and the collector's
is recognised, and nothing is counted twice.

**The v1 and v2 tokens of one card are two entities.** The collector derives
only v2 tokens, and the importer's key that made the v1 tokens is lost, so no
equal value links a card's importer-era account to its collector-era account.
Until the one-time identity-value rewrite
([below](#one-time-identity-value-rewrite)) replaces a card's v1 token by
its v2 token, a card read under both is two account
entities with nothing carried over; its purchases are recognised again on the
new account (the importer's event is retired, so the captured total is not
doubled). No owner action or secret is needed any more. After the next
collection, count tokens per producer and version (read-only, counts only):

```sql
SELECT r.producer_id, substr(u.unit_key,1,14) AS version, count(DISTINCT u.unit_key) AS tokens
FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
WHERE r.source_id='vpass' AND u.unit_key GLOB 'vpass-card-v[12]-*'
GROUP BY r.producer_id, version;
```

The collector's statement pages are not parsed today: registration gives them
no parser dataset, and the change that introduces parser datasets for
shared-R2 artifacts (ADR 0022) withholds the Vpass one. Releasing it is a
later change, made once the v1 and v2 entities of each card are decided.

## MoneyForward collector runs carry the account identity

The MoneyForward parsers accept an account page only when its unit key is
`moneyforward-account-v1-<64 hex>` (the retired importer's identities) or
`moneyforward-account-v2-<64 hex>`
([ADR 0027](adr/0027-moneyforward-collector-account-identity.md),
[ADR 0029](adr/0029-data-classification-and-unkeyed-identity.md)). The
collector (`collector-moneyforward-me`) derives the v2 identity: for each
account-detail page, with the importer's checks, the unkeyed,
domain-separated SHA-256 of
`["moneyforward-account-v2", account[id_hash], service[id]]`. No secret is
involved. When a check fails the run keeps positional units (`account-NN`),
its account pages are `parser_rejected`, and the persist diagnostic's
`identity` field says why (`identity_tuple_absent`, `identity_tuple_invalid`,
`identity_duplicate`, `identity_index_mismatch`, `identity_incomplete`). Both
identity versions are `aggregator-mirror` accounts
([identity sources](identity-sources.md)).

**The v1 and v2 identities of one account are two accounts.** The importer's
key that made the v1 identities is lost, so no equal value links an
importer-era account to the collector's. The transactions read ranks the
current monthly snapshot per unit key and month, so for a month both
producers captured the importer's v1 snapshot and the collector's v2 snapshot
are both current: the same provider rows are listed under two source accounts
and two account entities, and nothing maps one to the other. That is a known
limit until the one-time identity-value rewrite replaces each account's v1
identity by its v2 identity ([below](#one-time-identity-value-rewrite)).
The runs are parsed as soon as they register (MoneyForward's datasets are not
withheld). No owner action or secret is needed any more. After the next
collection, count identities per producer and version (read-only, counts only):

```sql
SELECT r.producer_id, substr(u.unit_key,1,24) AS version,
       count(DISTINCT u.unit_key) AS identities,
       count(DISTINCT CASE WHEN EXISTS(
         SELECT 1 FROM fetch_units i JOIN fetch_runs ir ON ir.id=i.fetch_run_id
         WHERE ir.source_id='moneyforward-me' AND ir.producer_id='collector-r2-importer'
           AND i.unit_key=u.unit_key)
       THEN u.unit_key END) AS known_to_importer
FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
WHERE r.source_id='moneyforward-me' AND u.unit_key GLOB 'moneyforward-account-v[12]-*'
GROUP BY r.producer_id, version;
```

`known_to_importer` is zero for every v2 row: the importer registered only v1
identities.

**Account continuity.** The collector's rows get their own source account
(the reference includes the producer), with its own mapping revisions and
manual decisions. As for a trusted Vpass token, the account entity of a
MoneyForward identity is derived from the importer producer's reference for
that identity (`accountEntityId`), so one identity value, v1 or v2, maps to
one entity whichever producer read it. An operator's re-mapping of the
importer's source account is not followed, and account connection reviews,
keyed by producer, do not carry over. A v1 and a v2 identity differ, and so do
their entities.

## One-time identity-value rewrite

The retired importer's Vpass tokens and MoneyForward identities were derived
under the importer's key, which no deployed component holds any more, so a
collector's value for the same card or account differs and resolves to a second account entity. The owner decided to
replace each importer-era (`v1`) value by its collector-era (`v2`) value in
the stored rows, once
([ADR 0030's amendment](adr/0030-identity-crosswalk.md#amendment-2026-09-28-a-one-time-identity-value-rewrite-replaces-the-crosswalk)).
The earlier crosswalk command and its proposal script are removed. The
rewrite takes two migrations:

- **0062 (in the repository)** creates `identity_value_rewrites`, stages the
  MoneyForward pairs the stored rows prove (basis `shared-rows`), and drops
  the crosswalk table. It aborts, and the deploy stops, if the crosswalk table
  holds a row.
- **0063 (in the repository)** rewrites the staged values and drops the
  staging table: it replaces each staged old value by its new value in the
  importer's rows of five columns (fetch unit keys, Vpass pins, the
  importer's source-account references, the MoneyForward importer parses'
  `transaction_observations.source_account`, connection review keys),
  appends a `rule` mapping revision (reason `identity-value-rewrite`) that
  points each collector source account of a staged new value to the
  importer-era entity, and recreates the append-only guards with their exact
  text. It aborts, and the deploy stops, if a staged pair is no longer valid,
  a held mapping exists, or an old value would remain; nothing of it applies
  then. With an empty stage it only drops the staging table. It is merged
  only after the steps below; step 4 is read after it applies.

Every query here is read-only and returns counts only, except the one
`INSERT` of step 2, which writes only the staging table. Run them from the
D1 console of the CORE database, or with
`wrangler d1 execute kogane-raw-evidence --remote --config services/processor/wrangler.jsonc --command "<sql>"`.

**0. Before the release with 0062 (optional).** It must be 0, or 0062
aborts:

```sql
SELECT count(*) AS crosswalk_rows FROM account_identity_crosswalk;
```

**1. Preflight after 0062.** What the migration staged, and whether
anything outside the rewrite's scope carries a MoneyForward `v1` value (0063
rewrites the MoneyForward value in transaction observations only; every
count of the second query must be 0):

```sql
SELECT source_id, basis, count(*) AS pairs FROM identity_value_rewrites GROUP BY 1, 2;

SELECT
 (SELECT count(*) FROM balance_observations WHERE source_account GLOB 'moneyforward-me:moneyforward-account-v1-*') AS balance,
 (SELECT count(*) FROM position_observations WHERE source_account GLOB 'moneyforward-me:moneyforward-account-v1-*') AS position,
 (SELECT count(*) FROM valuation_observations WHERE source_account GLOB 'moneyforward-me:moneyforward-account-v1-*') AS valuation,
 (SELECT count(*) FROM scheduled_payment_observations WHERE source_account GLOB 'moneyforward-me:moneyforward-account-v1-*') AS scheduled_payment;
```

A staged MoneyForward pair is a proposal from shared rows (the selected
month, date, description, amount and occurrence of current transaction
observations, compared across the two values): only a one-to-one overlap is
staged, and coincidental rows in another account can make a real pair not
one-to-one or, in principle, stage an unrelated one. If a staged pair is
wrong, remove that row before 0063 (the table is operational, not evidence):

```sql
DELETE FROM identity_value_rewrites WHERE source_id='moneyforward-me' AND old_value='<v1 value>';
```

**2. Stage the Vpass pairs.** No collector-era Vpass statement row is parsed,
so the rows cannot pair Vpass tokens. The owner recomputes each card's pair
on their own machine from the card's tuple: the importer's `vpass-card-v1-`
token as the importer's HMAC under the importer's key (which the owner holds
outside the platform) and the collector's `vpass-card-v2-` token as the
unkeyed digest of ADR 0029. The pairs go in one statement (all rows or
none):

```sql
INSERT INTO identity_value_rewrites (source_id, old_value, new_value, basis) VALUES
 ('vpass', 'vpass-card-v1-<64 hex>', 'vpass-card-v2-<64 hex>', 'owner-recomputed'),
 ('vpass', 'vpass-card-v1-<64 hex>', 'vpass-card-v2-<64 hex>', 'owner-recomputed');
```

One row per card. The trigger refuses the statement with a closed code:
`identity_value_rewrite_old_unknown` (no importer source account with that
token, or no importer fetch unit keyed by it),
`identity_value_rewrite_new_unknown` (no collector fetch unit keyed by the
new token, or the importer carries it), `identity_value_rewrite_not_one_to_one`
(either token is already staged). A shape error (`v1` and `v2` swapped,
upper-case hex, wrong length) fails the table's CHECK.

**3. Confirm.** The owner's reports of 2026-09-28 expect `moneyforward-me`
`shared-rows` 4 and `vpass` `owner-recomputed` 6 (an expectation to compare
against, not a count this repository verifies), each with as many distinct
old and new values as pairs; and 0 held mappings (a manual or protected mapping on a collector
source account of a staged new value, which 0063 would refuse to re-point):

```sql
SELECT source_id, basis, count(*) AS pairs,
       count(DISTINCT old_value) AS old_values, count(DISTINCT new_value) AS new_values
FROM identity_value_rewrites GROUP BY 1, 2 ORDER BY 1;

SELECT count(*) AS held
FROM identity_value_rewrites x
JOIN source_accounts s ON s.source_id=x.source_id AND s.producer_id<>'collector-r2-importer'
 AND s.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card', x.new_value)
  ELSE json_array('moneyforward-me:'||x.new_value) END
JOIN current_account_mappings m ON m.source_account_id=s.id
WHERE m.method<>'rule'
   OR EXISTS(SELECT 1 FROM protected_mapping_subjects p
             WHERE p.subject_kind='account_mapping' AND p.subject_ref=s.id);
```

Report these counts (counts only) on the pull request that carries 0063.
Until 0063 applies, nothing reads the staging table and every value keeps
its current entity. Adding or deleting a staged row after the counts are
reported changes what 0063 rewrites; report the counts again if it happens.

**4. After 0063 applies.** Read-only, counts only. The staging table is gone
and the five guards exist (expected `0` and `5`):

```sql
SELECT
 (SELECT count(*) FROM sqlite_schema WHERE name='identity_value_rewrites') AS staging_tables,
 (SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN
   ('fetch_units_no_update','identity_vpass_bindings_no_update','source_accounts_no_update',
    'transaction_observations_no_update','account_connection_no_update')) AS guards;
```

The importer's source accounts by era: the `v2` rows are the rewritten ones
(expected as many as the staged pairs of each source), and each `v1` row
left is a value that was not staged:

```sql
SELECT source_id,
       CASE WHEN reference_json GLOB '*-v1-*' THEN 'v1' WHEN reference_json GLOB '*-v2-*' THEN 'v2' ELSE 'other' END AS era,
       count(*) AS source_accounts
FROM source_accounts WHERE producer_id='collector-r2-importer' AND source_id IN ('vpass','moneyforward-me')
GROUP BY 1, 2 ORDER BY 1, 2;
```

The appended mapping revisions (one per collector source account of a
staged value; no Vpass one while no collector-era Vpass statement is
parsed), and the collector source accounts of a rewritten value that do not
map to the importer's entity (expected `0`):

```sql
SELECT count(*) AS repointed FROM account_mappings WHERE reason='identity-value-rewrite';

SELECT count(*) AS split
FROM source_accounts o
JOIN source_accounts c ON c.source_id=o.source_id AND c.reference_json=o.reference_json
 AND c.producer_id<>'collector-r2-importer'
JOIN current_account_mappings m ON m.source_account_id=c.id
WHERE o.producer_id='collector-r2-importer' AND o.source_id IN ('vpass','moneyforward-me')
  AND o.reference_json GLOB '*-v2-*'
  AND m.account_id<>(SELECT e.account_id FROM account_mappings e
                     WHERE e.source_account_id=o.id AND e.method='rule'
                     ORDER BY e.revision DESC LIMIT 1);
```

What stays as recorded: every id, the importer's manifests and raw objects
in R2, the external ids, the Vpass identity run policies' dependency JSON
(which names the `v1` token) and the importer's run registration labels
(`fetch_unit_reports.report_key`, `fetch_run_ranges.range_key`). The
collector-era entity of a rewritten value stays in `accounts` with no
current mapping.

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
