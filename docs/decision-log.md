# Decision log, identity commands and read modes

Architecture addendum A06 (review findings D06 and D08, root review 04). This
change makes manual identity decisions durable and corrigible, moves the
per-source policy selection out of the identity store, and lets readers ask
for observations as they were recorded rather than as they are interpreted
today. Nothing here deletes or updates an existing mapping row, and no public
write route is added.

## Tables (migration `0029_decision_log.sql`)

All new tables are append-only with the same `*_no_update` / `*_no_delete` /
`*_no_replace` triggers as the identity tables of 0018. Layer A, Layer B,
`account_mappings`, `instrument_mappings` and `identity_runs` are not altered.

| Table                   | Role                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision_operations`   | Idempotency ledger. `operation_id` (primary key), the server-verified `actor_id` and `actor_verification` (`server` or `legacy-unknown`), `action`, `payload_digest` (SHA-256 of the canonical JSON payload), `result_json` (the receipt returned to the caller), `created_at`.                                                                                                                                                  |
| `decision_revisions`    | One row per judgement. `subject_kind` (`account_mapping`, `instrument_mapping`, `relation`), `subject_ref` (the reference id or the relation id), `revision`, `decision_kind` (`assign`, `release-override`, `propose`, `accept`, `reject`, `supersede`), `method` (`manual`, `rule`, `ai`, `legacy-migration`), `actor_id`, `operation_id`, `reason`, `evidence_refs_json`, `previous_revision`, `superseded_by`, `created_at`. |
| `entity_relations`      | Typed relations (addendum 05 §2). `kind` is CHECK-constrained to the fifteen `RelationKind` values of `packages/domain`; `from_ref`, `to_ref`, `valid_from`, `valid_to`, `status` (`proposed`, `accepted`, `rejected`, `released`), `decision_revision_id`, `evidence_refs_json`, `created_at`. A relation must name a decision whose subject is that relation.                                                                  |
| `identity_run_policies` | Per identity run: `policy_family`, `policy_release`, `dependency_digest` (SHA-256 of the canonical dependency set) and `dependency_set_json`. `UNIQUE(parse_run_id,policy_family,policy_release,dependency_digest)`; rows can only be written before the run is sealed.                                                                                                                                                          |

Views:

- `active_manual_overrides`: `assign` decisions of method `manual` or
  `legacy-migration` whose `superseded_by` is null.
- `protected_mapping_subjects`: what automatic policy must not overwrite: every
  active override, plus any manual mapping row that no decision describes (a
  row written by an older build or by hand keeps its previous protection
  instead of being released silently) until a `release-override` at or after
  its revision is recorded for the subject.
- `identity_run_contexts`: every identity run with its policy family, release
  and dependency digest. Runs written before 0029 have no policy row; the view
  derives their labels from the integer policy version they were written with
  (`1` → `identity-default-v1`, `2` → `vpass-card-binding-v2`) and reports the
  digest `legacy`, with `policy_recorded = 0`.

The only permitted update anywhere is `decision_revisions.superseded_by`, set
once, to a later decision on the same subject. A `decision_revisions` insert
for a mapping subject must name a mapping row that exists at that revision
with the matching method, and a `release-override` must have an active
override to release; the trigger aborts the whole D1 batch otherwise.

## Command contract (`services/processor/src/identity-commands.ts`)

```ts
interface IdentityCommand {
  operationId: string; // caller-chosen idempotency key
  actorId: string; // the principal the server verified, never a body claim
  actorVerification: "server" | "legacy-unknown";
  action: "assign" | "release-override";
  kind: "account" | "instrument";
  referenceId: string;
  expectedRevision: number; // the current mapping revision the caller saw
  targetId: string | null; // required for assign, null for release-override
  reason: string;
}
```

- `assign` appends a `manual` mapping revision `expectedRevision + 1` (what
  `reviseIdentity` did) plus an `assign` decision and the ledger row. Target
  label and status come from the target's current claims, or the entity when
  it has none; ambiguous claims are refused.
- `release-override` appends a `release-override` decision at the current
  revision and sets `superseded_by` on every active override of the subject.
  It does not delete or replace the manual mapping row: the manual mapping
  stays current until automatic policy appends the next rule revision. It also
  releases a manual row no decision describes (one written by an older build):
  the decision then supersedes nothing and records `previous_revision` null.
- All writes of one command are one `D1Database.batch` (one transaction). The
  ledger insert carries every precondition (no such operation id, revision
  matches, target or active override exists); every later statement is joined
  on the ledger row, so a failed guard writes nothing, and a trigger failure
  aborts everything including the ledger row.
- Receipts: `{ operationId, action, kind, referenceId, revision, mappingId,
decisionRevisionId, payloadDigest }`; `revision` is the mapping revision after
  the command. Ids are derived from the operation id, so a resend produces the
  same ids.
- Errors: `invalid_command`, `idempotency_conflict`, `revision_conflict`,
  `target_missing`, `target_metadata_ambiguous`, `no_active_override`.

### Idempotency and actor verification

The same `operationId` with the same payload digest and the same actor returns
the stored receipt with `replayed: true`, without advancing any revision. The
same `operationId` with a different payload, or a different actor, is
`idempotency_conflict`. A stale `expectedRevision` is `revision_conflict`.

The actor is never read from a request body. The private `/identity-revise`
route of the observation pipeline records `legacy-cli` with verification
`legacy-unknown` unless the trusted caller on the private service binding sets
`x-kogane-verified-actor`; that header is trusted at the binding's existing
private trust level (the same as `/sweep` and `/replay/*`) and recorded with
verification `server`. A09 replaces this with the authenticated command path.
The route accepts the former body (`kind`, `referenceId`, `targetId`,
`expectedRevision`, `reason`) plus optional `operationId` and
`action: "release-override"` (with `targetId: null`). Failures keep the
former `409` text and add an `x-kogane-error` header with the error code.
`reviseIdentity` remains as a compatibility adapter: an `assign` by
`legacy-cli` with a fresh operation id, throwing the former error strings.

### A09: the same command under an authenticated lifecycle

`prepareIdentityCommand` builds the statements of one identity command without
running them; `executeIdentityCommand` is that plus the batch and the ledger
read. The A09 change commit
([change-lifecycle.md](change-lifecycle.md)) calls the same builder with an
extra guard on its own receipt reservation, so the identity mutation, the
plan-wide expected-revision check, the receipt and the decision outbox rows are
one D1 batch. There is no second copy of what an identity command writes, and
the ledger row (`decision_operations`) is still the precondition every later
statement of the command is joined to.

`/identity-revise` is unchanged and remains the private CLI path. The
authenticated path is `POST /api/command/v1/*` on the evidence browser, which
forwards to the pipeline's private `/command/v1/*` routes; the pipeline stays
the single writer of every table on this page.

## Automatic protection

`identifyParse` and the sweep append an automatic (`rule`) mapping only when
the subject is not in `protected_mapping_subjects` and the current mapping is
not already a rule decision of an equal or newer policy version. Protection
therefore follows the latest effective decision: a manual `assign` protects
until a `release-override`, after which the rule applies again and appends a
new revision. `identity-decisions.test.ts` compares this guard with the former
one (`method='manual' OR policy_version>=?`) over synthetic histories: they
agree everywhere except after a release, which is the intended change. A rule
revision written after a release has an id qualified by its revision
(`am_<digest>-r3`); first revisions keep the former id form.

## Migration of legacy manuals (addendum 13, A06/A09)

Every existing `manual` mapping revision becomes exactly one `assign` decision
with method `legacy-migration`, actor `legacy-unknown`, the original reason
(truncated to 2,000 characters if longer) and the original `created_at`,
`previous_revision` = the preceding mapping revision, and
`evidence_refs_json` = `["account_mapping:<id>"]` (or `instrument_mapping`).
Its `superseded_by` is null, so every existing manual is an active override
and existing behaviour is preserved. No approver is invented and no mapping
row changes. The backfill ids are deterministic (`dr_legacy_account_<id>`),
so running the inserts twice is refused by the replacement triggers.

Evidenced MoneyForward connection correspondences (migration 0023, current
`confirmed` reviews) become `connection_contains` relations from
`connection:<producer>/<connection key>` to each pinned
`source_account:<id>`, status `accepted`, with the three review artifacts as
evidence and an `accept` decision per relation. Only connection-level evidence
exists, so no `same_account` relation is written (SC06); nothing derives
`same_account` from `connection_contains`, and a `same_account` claim needs
its own explicit decision. Unresolved reviews and superseded revisions produce
no relation.

## Policy selection (D08, `src/identity-policies/`)

`selectIdentityPolicy(parse, evidence, requestedVersion)` returns
`{ policyFamily, release, policyVersion, dependencySet, eligibility }`. The
`vpass` module selects `vpass-card-binding` version 2 only with exactly one
trusted sidecar binding (the same `trusted_vpass_card_bindings` lookup as
before); a missing or ambiguous binding falls back to `identity-default`
version 1 with `eligibility.status = "fallback"` and the reason. Sources
without a module get `identity-default`. The standard request
(`IDENTITY_POLICY_VERSION`) runs the default family at the base version, as
before; an explicit other version is stored as requested, so the numeric
ordering tests are unchanged. `requiredIdentityPolicySql` is composed from the
modules and produces the same expression audits used before.

The store saves the selection: `identity_run_policies` records the family,
release, dependency digest and set for every new run (row path and the empty
fast path, which now batches four statements). The same release over a
different evidence set has a different digest. Because 0018's
`UNIQUE(parse_run_id,policy_version)` is unchanged, a new run for one parse
still needs a new numeric version; today evidence changes always come with one
(Vpass: 1 → 2), and the digest is what a later migration can key on.

## Read modes (D06)

`packages/read-model` gains `IdentityReadMode = "latest" | "as-recorded"`,
`organizationSql(mode)`, `interpretationContext(...)` and
`identityReleaseFor(...)`. The read mode chooses which mapping revision a row
is attributed to; it does not decide which parse run is current. That stays
the publication projection `published_parse_runs`
([publication-gate.md](publication-gate.md)): `organizationSql` marks a row
`historical` when the projection does not name its run, the identity
catalogue and coverage join the projection, and both modes read the same
published rows. `latest` joins `current_account_mappings` /
`current_instrument_mappings` (unchanged behaviour; the `latest` query is the
former query plus the run's policy release column). `as-recorded` joins the
mapping rows the sealed identity run pinned (`identity_observations.
account_mapping_id`, `identity_instrument_uses.instrument_mapping_id`) of the
same run selection, so a correction changes `latest` and not `as-recorded`
(AT63; `identity-read-modes.test.ts`, `packages/read-model/test/identity.test.ts`).

The evidence browser accepts `?identityRead=latest|as-recorded` on
`/api/transactions`, `/api/balances`, `/api/positions` and
`/api/identity/accounts|instruments|coverage`. The parameter is part of the
shared request schema (`identityRead: "identityReadModes"`) and is refused
where the capability is not advertised; the local PoC store and the hosted
demo advertise none. `identityRead=snapshot` is refused with
`400 unsupported_semantics`; other values with `400 invalid_query`. Detail
routes accept no parameters and read `latest`. The default is `latest`.

Responses carry `interpretationContext`:
`{ mode, snapshotId: null, identityRelease, productCatalogueRelease,
productResolverRelease, measurePolicyRelease: "metric-registry-v1",
decimalPolicyRelease: "decimal-v1" }`. `identityRelease` is
`current-mappings-v1` for `latest`; for `as-recorded` it names the distinct
policy releases of the runs behind the rows (joined with `+`, or
`as-recorded:none`). Each organized row carries `mappingRevision` (the account
mapping revision used) and `identityRelease`; identity catalogue rows report
the mapping revision in `revision`. Display-only overlays (preferred
instrument names, connection labels) stay current in both modes and carry
their own evidence; they never change which account or instrument a row is
attributed to.

## Deploy order and rollback

1. Apply `0029_decision_log.sql` (schema). It is additive and independent of
   `0026_publication_gate.sql`; both are applied before the writer.
2. Deploy `services/processor` (writer: commands, protection from
   the log, policy records).
3. Deploy `services/app` (reader: read modes, contexts).

Migration `0031_operations.sql` (A09) builds on this one:
`decision_outbox.decision_revision_id` references `decision_revisions(id)`, and
every A09 commit appends both a `decision_operations` ledger row and a
`decision_revisions` row through the code above. 0029 must be applied first.

Rollback: the previous pipeline and browser builds ignore the new tables and
views; nothing they read or write changed shape (that is why the policy record
is a side table rather than new `identity_runs` columns, whose positional
inserts the previous build would break on). Manual rows written by a rolled
back build have no decision and remain protected through
`protected_mapping_subjects`. Commands are disabled by removing the
`/identity-revise` route; decisions already recorded are never deleted (no
DELETE is used to undo a correction; a new decision is appended instead).
There is no feature flag: the reader's default stays `latest`, and the new
mode is only served when requested.

## Verified locally (synthetic data only)

Every test fixture publishes its successful parse runs through the projection
the way the writer does (`publishParse` in the pipeline harness and the
evidence-browser fixtures), because an unadopted `ok` run is current for no
reader since migration 0026.

`services/processor`: `identity-decisions.test.ts` (lifecycle,
resend, conflicts, nothing written on a failed guard, trigger abort of a
batch, guard comparison, policy records, Vpass evidence arrival, private route,
append-only rows, migration 0029 on 0017–0035 with seeded rows, relation
CHECK and SC06), `identity-policies.test.ts` (selector), and the pre-existing
identity suites. `packages/read-model`: `identity.test.ts`.
`services/app`: `identity-read-modes.test.ts`, conformance and the
pre-existing organization and identity API tests. Not verified: production
data, and the transitive behaviour of concurrent commands from several
Workers (the ledger and revision triggers are the arbiter; see the tests).
