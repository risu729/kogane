# ADR 0029: Data classification for central storage; Vpass and MoneyForward identities derived without a secret

- Status: proposed
- Date: 2026-09-27
- Decided by: the owner (the only user of this deployment), 2026-09-27
- Carried by:
  `services/collector-vpass/src/card-binding.ts`,
  `services/collector-moneyforward/src/account-identity.ts`,
  `packages/storage-d1/migrations/core/0057_vpass_card_token_v2.sql`,
  `packages/storage-d1/src/core/identity-store.ts` (`accountEntityId`),
  `packages/identity/src/other.ts`,
  `packages/parsers/src/parsers/moneyforward.ts`,
  `packages/read-model/src/sql.ts`,
  [Vpass card binding](../vpass-card-identity.md),
  [identity operations](../identity-operations.md),
  [collection](../collection.md), [roadmap](../roadmap.md)
- Amends: [ADR 0023](0023-vpass-collector-card-binding.md) and
  [ADR 0027](0027-moneyforward-collector-account-identity.md) (each carries a
  dated amendment note)
- Related: the one-time crosswalk that joins each account's v1 and v2
  identity is a separate, later decision and is not made here
- Amended: 2026-09-27, class (d) applies to stored evidence (see
  [Amendment](#amendment-2026-09-27-names-are-removed-from-stored-evidence));
  merged in [#333](https://github.com/risu729/kogane/pull/333) and withdrawn
  by amendment 2
- Amended: 2026-09-27 (amendment 2), class (d) redefined: person names may be
  stored in raw evidence and observations as the provider shows them (see
  [Amendment 2](#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence));
  proposed until the amending PR merges

## Context

**The policy line the HMACs rested on.** The Vpass card binding
([ADR 0023](0023-vpass-collector-card-binding.md)) and the MoneyForward
account identity ([ADR 0027](0027-moneyforward-collector-account-identity.md))
are each an HMAC-SHA-256 of a provider-local tuple, under the retired
importer's `ORIGIN_FINGERPRINT_KEY` (key version `collector-r2-v1`): the Vpass
card reference `externalId`, `globalid`, `cardCode`, and the MoneyForward
`account[id_hash]`, `service[id]`. The only reason given for keying them was a
line in `docs/vpass-card-identity.md`: "Raw keys, names and provider
identifiers are not logged or copied into central storage." ADR 0023 and ADR
0027 therefore had the collectors read a Worker secret
(`VPASS_CARD_BINDING_KEY`, `MONEYFORWARD_ACCOUNT_IDENTITY_KEY`) that had to
hold the importer's key, and fail closed without it.

**The key is lost.** The importer that held the key is retired (#203, #206)
and the owner does not hold its value. Under the old line the collectors can
therefore never produce the importer's values, and the roadmap carried two
open "owner sets the key" items that cannot be completed as written.

**What CORE already stores.** The old line was never the rule elsewhere.
SBI Shinsei observations carry the provider account number in their source
account (`sbi-shinsei:<accountNo>`,
`packages/parsers/src/parsers/sbi-shinsei-common.ts`), and Mizuho
observations carry branch and account number
(`mizuho-bank:ordinary:<branch>:<account>`, accepted by
`packages/identity/src/other.ts`). Both are provider-local identifiers held
raw in CORE, and both were reviewed and merged. Stored provider pages in R2
(`kogane-raw-evidence`) hold provider identifiers under the existing
redaction templates.

**The deployment has one owner.** Kogane holds one person's evidence. There
is one perimeter: the processor generates reports against
`perimeter:all-visible-evidence` (`services/processor/src/worker.ts`) and no
other perimeter exists in production. No CORE or READ table has a tenant or
owner column (neither schema ledger names one). Cloudflare Access subjects
(`services/app/src/auth.ts`) distinguish the human operator from agents and
service tokens, never one owner from another. In a single-owner store a
provider-local account identifier cannot be confused with anyone else's
account, and it grants no access: it is not a credential.

## Options considered

1. **Keep the HMAC under a new key.** The owner creates a new secret, sets it
   on both collectors, and every value is a new key version. This keeps a
   secret whose only purpose is to hide identifiers the store may hold, adds
   an owner action and a rotation problem (a lost key again strands every
   identity), and still cannot reproduce the importer's values. Rejected.
2. **Store the raw identifiers.** Allowed by the classification below and the
   simplest identity, but the owner wants the field shapes confirmed first (a
   separate agent is checking them against captured pages), and storing them
   changes the binding payload and the unit keys' shape. Deferred, not
   rejected: it is permitted, and a later change may make it.
3. **Unkeyed, domain-separated SHA-256 of the same canonical tuple.** No
   secret, no owner action, a fixed-length value of the shape every consumer
   already checks (`<prefix>-<64 lowercase hex>`), deterministic across
   producers, and separated from every other derivation by its domain string.
   It hides nothing that needs hiding, and it does not have to: it only fixes
   the shape until option 2 is decided. Chosen now.

## Decision

**Single-owner premise.** Kogane holds one person's evidence, under one
perimeter. Multi-user is a non-goal. If it ever becomes a goal, a separate ADR
decides perimeters and tenant isolation first, before anything below is
relied on across owners.

**Data classification for central storage** (CORE, READ, the R2 bucket
`kogane-raw-evidence`, and logs):

- (a) **Credentials and keys** (passwords, session cookies, OTP seeds, HMAC
  keys, API tokens): never stored centrally, never logged. Unchanged.
- (b) **Payment-instrument numbers** (a full card PAN, a full bank card
  number, CVV, expiry paired with a PAN): never stored raw. A masked form the
  provider itself renders (last 4 digits as the page shows them) is provider
  content and follows the raw-evidence rules like any other page text.
- (c) **Provider-local opaque identifiers** (Vpass
  `externalId`/`globalid`/`cardCode`, MoneyForward `id_hash`/`service_id`,
  SBI Shinsei `accountNo`, Mizuho branch and account as already stored, MyJCB
  card ordinals): may be stored in CORE when identity needs them, raw or
  hashed. They identify an account inside one provider, they are not
  credentials, and in a single-owner store they cannot be confused with
  anyone else's. This is what the code already does for SBI Shinsei and
  Mizuho.
- (d) **Personal names** (account holder names, cardholder names): may be
  stored in raw evidence and in observations as the provider shows them; no
  collector removes them, and nothing reads them until a reviewed change needs
  one. Consistency checks may compare them in memory. _Redefined by
  [amendment 2](#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence);
  the original text read: "avoided in CORE. Consistency checks may compare
  them in memory but do not persist them. Provider pages that contain names
  stay in R2 under the existing redaction templates."_
- Logs and stored operational records keep the existing rule: counts and
  closed codes only.

**Identity derivation.** Both identities are an unkeyed, domain-separated
SHA-256 of the canonical JSON tuple the v1 derivation used, with a new version
in the prefix and the domain string:

- Vpass: `vpass-card-v2-` + SHA-256(`JSON(["vpass-card-binding-v2", externalId, globalid, cardCode])`),
  with the importer's tuple checks and closed codes; `binding_key_absent` and
  `binding_key_invalid` are removed (nothing can produce them).
- MoneyForward: `moneyforward-account-v2-` + SHA-256(`JSON(["moneyforward-account-v2", account[id_hash], service[id]])`),
  with the importer's checks and closed codes; `identity_key_absent` and
  `identity_key_invalid` are removed, and every run derives.

`VPASS_CARD_BINDING_KEY` and `MONEYFORWARD_ACCOUNT_IDENTITY_KEY` are removed
from the code and the docs. The v1 values stay valid historical evidence and
every reader accepts both versions: the trusted Vpass binding view and the
identity pin (migration 0057), the identity rules, the MoneyForward parsers
(`moneyforward-monthly-transactions` 2.0.3,
`moneyforward-canonical-evidence-boundary` 1.0.2), the transactions read and
the account-entity continuity rule. One value, v1 or v2, names one account
entity whichever producer read it. A v1 and a v2 value of the same account are
different values and different entities.

**The raw tuple is not stored in this change.** The classification permits it
(class c); the binding payload and the unit keys still carry only the digest
and closed fields. Storing the tuple is a later change, once the owner has
confirmed the field shapes.

## Consequences

- **No secret and no owner action.** The two "owner sets the key" items leave
  the roadmap. A secret set earlier is no longer read; the collectors'
  READMEs say how to delete it.
- **v1 and v2 are separate entities until a crosswalk.** The importer's key
  is lost, so no equal value links a v1 identity to its v2 successor. Until
  the separate, reviewed crosswalk decision joins them:
  - MoneyForward: collector runs parse as soon as they register, and the
    transactions read ranks snapshots per unit key and month, so a month both
    the importer and the collector captured is listed under two source
    accounts and two account entities. `services/processor/test/moneyforward-producer-switch.test.ts`
    pins this limit.
  - Vpass: the collector's statement pages are still registered without a
    parser dataset (ADR 0022), so none is parsed; when one is, purchase
    recognition retires the importer-era event of the card-month and
    recognises the collector's on the new entity, so the captured total is
    not doubled, but nothing carries over from the importer-era entity.
- **Migration 0057 rebuilds one identity table.** SQLite cannot alter a
  CHECK, so `identity_vpass_bindings` is rebuilt under the same name with the
  token CHECK widened, copying every row with explicit columns and recreating
  its triggers verbatim, as migrations 0045 and 0051 rebuilt the command
  tables. No row changes. The view text changes in the prefix condition only.
  The migration adds no table, so nothing new is classified.
- **Parser releases.** The two MoneyForward parsers change only their unit-key
  pattern and take new versions, so the repair lane re-parses stored
  MoneyForward artifacts under them; v1 artifacts parse as before, and
  positional ones stay rejected.
- **What a multi-user ADR would have to add.** A tenant or owner column (or
  one database per owner) in every CORE and READ table, perimeters per owner,
  Access subjects bound to owners, and a re-examination of class (c): an
  unkeyed digest of a provider-local identifier is not a secret, so two
  owners' identical provider identifiers would collide, and a keyed or
  owner-scoped derivation, or owner-scoped entity ids, would be needed.

## Verification

- `services/collector-vpass/test/shared-collection.test.ts` ("ADR 0023 and
  ADR 0029"): the v2 token of a synthetic tuple equals a literal computed
  outside the code with `sha256sum` and an independent `node:crypto`
  computation; the v1 domain string or a reordered tuple gives another digest;
  `deriveVpassCardBinding` and `vpassCardRunPlan` take no key argument; the
  binding payload names `vpass-card-binding-v2` and carries no key version and
  no tuple value; every doubtful input still fails closed with its closed
  code.
- `services/collector-moneyforward/test/account-identity.test.ts`: the same
  for the MoneyForward identity (two pinned literals, the domain and field
  order separation, no key argument), every failure code, and a Worker run
  that derives with no secret set and ignores a retired one.
- `packages/storage-d1/test/vpass-token-v2-migration.test.ts`: on a store
  migrated through 0056 with synthetic pins, 0057 keeps every pin, every
  trigger byte for byte and the column, key and foreign-key shape, with
  foreign keys on at every statement; the table SQL differs only in the
  CHECK; afterwards the table admits v1 and v2 tokens and refuses v3,
  uppercase, short, long and non-hex ones, and the provenance, replacement,
  update and delete guards still hold.
- `services/processor/test/vpass-binding-view.test.ts`: 0057's view text is
  0055's with the prefix condition replaced and nothing else; on random and
  scaled stores that draw v1, v2 and malformed tokens, the shipped view equals
  the frozen specification with the same prefix widened; its v1 rows are
  exactly 0055's, and its v2 rows are exactly 0055's once every v2 token is
  read as v1; mutations that refuse v2 or admit any version are caught.
- `services/processor/test/binding-query-plan.test.ts`: after 0057 every
  binding and identity read keeps 0055's plan step for step, without table
  statistics.
- `services/processor/test/vpass-collector-binding.test.ts`: on every CORE
  migration, the collector's v2 binding registers, the view admits it, and
  identity policy 2 pins it in the rebuilt table and binds the rows; tokens
  of the wrong shape are refused; one v1 or v2 token read by the importer's
  and the collector's producer is one account entity; the importer's v1 token
  and the collector's v2 token with the same hex are two entities, and the
  captured purchase total is not doubled.
- `services/processor/test/moneyforward-producer-switch.test.ts`: one v1 or v2
  identity read by two producers is read once per month and maps to one
  entity; the importer's v1 and the collector's v2 identity of one account
  list the months both captured under two source accounts and two entities
  (the stated limit).
- `services/processor/test/moneyforward-shared-r2.test.ts` and
  `collector-plans.test.ts`: a collector run with no secret registers, seals
  and parses under the v2 identity with the new parser versions; without a
  tuple its account pages are `parser_rejected`.
- `packages/identity/test/identity-other.test.ts`: v1 and v2 Vpass tokens and
  MoneyForward identities are recognised, other versions and shapes are not,
  and a v1 and a v2 token with the same hex key different accounts.
- Not verified: whether the provider's current responses still carry the
  Vpass session bean and the MoneyForward hidden inputs (no provider was
  contacted, production was not read); the field shapes that storing the raw
  tuple would need (being checked separately).

## Amendment (2026-09-27): names are removed from stored evidence

- Status: accepted (merged in [#333](https://github.com/risu729/kogane/pull/333));
  its decision is withdrawn by
  [amendment 2](#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence),
  and the code it names no longer exists. Kept as the record of what objects
  written under it contain.
- Date: 2026-09-27
- Carried by:
  `services/collector-sbi-shinsei/src/name-redaction.ts`,
  `services/collector-sbi-shinsei/src/local/windows-chrome-collector.ts`,
  `services/collector-sbi-shinsei/src/local/collector.ts`,
  `services/collector-sbi-shinsei/src/storage.ts`,
  `services/collector-sbi-shinsei/src/shared-collection.ts`,
  `services/collector-myjcb/src/name-redaction.ts`,
  `services/collector-myjcb/src/parsers.ts` (`redactedStatementHtml`),
  `services/collector-myjcb/src/redaction.ts`,
  `services/collector-myjcb/src/shared-collection.ts`,
  [SBI Shinsei](../sources/sbi-shinsei-bank.md#person-names-in-stored-captures-2026-09-27),
  [MyJCB](../sources/myjcb.md),
  [observations](../observations.md), [roadmap](../roadmap.md)

### Context

Class (d) above said names are avoided in CORE and that provider pages with
names "stay in R2 under the existing redaction templates". A structure-only
survey of stored objects on 2026-09-27 (key names, types and match results;
no value was read) found that those templates do not remove names:

- SBI Shinsei: the stored `raw-balance-summary-and-stage.json` (dataset
  `balance-summary-and-stage`, response `getBalanceSummaryAndStage`) carries
  `responseParam.summary.responseParam.customerName`, `customerNameKanji`
  and `customerNameKana`. The collector stored the provider's response text
  as it came, minus the rotating CSRF token.
- MyJCB: the stored statement page (`credit-detail-NN.html`) keeps the
  「カード情報」 table, whose 口座名義 row is the account holder's name as the
  provider masks it (some characters replaced by `*`, the rest visible). The
  sanitizer removes scripts, attributes and card numbers, not text.

The live SBI Shinsei page also keeps a user object in `sessionStorage`
(`SFC_USER_INFO`, with name and national-id fields). The collector never reads
`sessionStorage`: its bearer token and CSRF token come from the login response
(`src/browser-page.ts`, `scripts/windows-cdp-collect.ps1`) and it hands back
exactly the four responses of its plan, so that object is not stored.

### Options considered

1. **Keep names in R2, as class (d) read.** Nothing needs the names: no
   parser registers `balance-summary-and-stage`, the account-connection proof
   reads its branch and category blocks only, and the statement parsers read
   the ledger and totals. Rejected: storing a value nobody reads is exposure
   without a use.
2. **Delete the name fields or rows.** The SBI Shinsei response schema
   accepts the fields as optional, but an absent field is indistinguishable
   from a provider that stopped sending it, and a deleted table row changes
   the page structure other readers rely on. Rejected.
3. **Replace each observed name value with a fixed marker before the object
   is written, and record how many were replaced.** Shape, schema and every
   other value stay; the stored object says where a name was. Chosen.
4. **Rewrite the objects already stored.** Raw evidence is append-only
   ([mutation policy](../design.md#mutation-policy)). Rejected; see
   Consequences.

### Decision

- Class (d) applies to stored evidence, not only to identities: a collector
  removes the person-name fields it has observed **before** the object is
  written, and the fields are listed in code and here, by key or label.
  Nothing is guessed from a key's spelling or from free text.
- The value is replaced by the fixed marker `[redacted:name]`, so the object
  keeps the shape its response schema and parsers accept. An absent, `null`
  or empty field has nothing to remove and is left as it is.
- The collector manifest records the removal as a count per provider capture
  (`redactedFieldCount`, 0 when there was nothing to remove), never a value.
- Listed fields:
  - SBI Shinsei `sbi-shinsei-balance-summary-v1`:
    `responseParam.summary.responseParam.customerName`, `customerNameKanji`,
    `customerNameKana` (`PERSON_NAME_FIELDS`). The other `Name` fields the
    response schemas admit, `branchName` and `productName`, are not a person
    and are kept; a test fails when a schema admits a new `Name` field that is
    not classified.
  - MyJCB statement pages: the `td` that follows a `th` whose whole text is
    「口座名義」 (`PERSON_NAME_ROW_LABELS`). The other rows of the 「カード情報」
    table (カード名称, カード発行会社, 金融機関名, 支店名, 科目・口座番号) are
    class (b)/(c) or product text and are kept. A 口座名義 header without a
    following `td` is a layout nobody has observed; the page is refused with
    `artifact_name_redaction_invalid` rather than stored, and the shared
    path's `assertRedactedHtml` refuses any page whose 口座名義 cell is not the
    marker alone.
- The sanitizing steps are recorded under new versions:
  `sbi-shinsei-token-sanitizer` v2 and `myjcb-sanitizer` v2.

### Consequences

- An SBI Shinsei capture with a name is not serialized again: the marker is
  written into the provider's own text as the string value of each redacted
  key, so every other byte (numbers as written, spacing, escapes, key order)
  stays the provider's. The result must parse, pass the same schema and equal
  the original object with exactly the listed fields redacted; a listed key
  that also appears elsewhere, or a name value that is not a JSON string, is
  refused as an unknown shape (the closed `provider_response_invalid`)
  rather than stored altered. Captures of the other datasets leave the
  redaction as the provider's text byte for byte. Unchanged by this
  amendment: on the shared path the token sanitizer (`sanitizeProviderCapture`
  in `src/shared-collection.ts`, like the retired importer) parses every
  provider capture and serializes it again to drop `header.newToken`, so what
  reaches DATA there was never the provider's exact text. In memory the collector still holds the
  provider's values for the length of the run.
- **Objects already stored keep their names.** They are append-only and this
  change does not rewrite them. Deleting or replacing them is the owner's
  decision, not this change's. Known to carry names, by kind (counts from
  read-only aggregates of CORE on 2026-09-27; no value read):
  - SBI Shinsei `balance-summary-and-stage` captures registered from the
    retired importer: 29 artifacts, 17 distinct objects in
    `kogane-raw-evidence`.
  - MyJCB `credit-detail` pages registered from the retired importer: 132
    artifacts, 33 distinct objects. Whether every one of them has the
    「カード情報」 table was checked on one stored page only.
  - Shared-bucket runs written by the collectors themselves since U09 (not
    catalogued in CORE, so not counted) and the per-source staging buckets of
    the legacy path hold the same kinds of object.
    The roadmap carries this as an open owner decision.
- **Limits.** Only observed fields are removed. SBI Shinsei transaction
  descriptions (`activityDetails[].description`) and MyJCB ledger text are
  provider text that may name a counterparty; they are not person-name
  fields of the account holder and are kept, unexamined. MyJCB exports
  (CSV, PDF, OFX), which the surveyed connection does not offer, are not
  redacted by this change. The national-id and branch/account request echoes
  (`requestParam.nationalid`) are class (c) and are kept. The `requestParam`
  echoes are the one part of the SBI Shinsei response schemas that is an open
  object, so the test that every `Name` field is classified covers the exact
  response objects only; a name in a request echo has not been observed and
  would not be caught.

### Verification

- `services/collector-sbi-shinsei/test/name-redaction.test.ts`: the three
  fields of a synthetic balance summary become the marker and every other
  value is unchanged; the redacted object passes the schema; absent, null and
  empty fields are not counted and keep the provider bytes; with balances
  written as `1.50`, `1e3` and a 20-digit integer, indentation and an escaped
  name, the stored text differs from the input only in the three values; a
  name key found elsewhere or a non-string name is refused (also through the
  handoff, as a closed failure); the redaction returns the other datasets byte for byte; every `name` field in the schemas (any case) is classified; the Chrome handoff and the local diagnostic collector both
  produce redacted captures with their counts.
- `services/collector-sbi-shinsei/test/shared-collection.test.ts` (Worker end
  to end, synthetic container handoff): nothing in DATA and nothing logged
  contains the placeholder names; the stored balance summary carries the
  marker; the collector manifest carries `redactedFieldCount` 3 for it and 0
  for the other captures; the redaction steps are v2.
- `services/collector-myjcb/test/name-redaction.test.ts`: on a synthetic page
  with the observed table structure, the 口座名義 cell becomes the marker and
  金融機関名, 支店名, 科目・口座番号, カード名称 and カード発行会社 are kept;
  the label must be the whole header text; a header with no value cell is
  refused; `assertRedactedHtml` finds the header on the parsed tree the way
  the redaction does and refuses an unredacted cell in any markup; the shared run
  stores the marker, records the count on the page's manifest entry, and
  nothing logged contains any page value.
- `services/processor/test/account-connection-proof.test.ts`: a balance
  summary carrying the marker still proves the account connection.
- Not verified: the live pages were not fetched by this change; the list of
  stored objects above counts registered artifacts, not objects whose bytes
  were read.

## Amendment 2 (2026-09-27): person names are kept in stored evidence

- Status: proposed; accepted when the amending PR merges
- Date: 2026-09-27
- Decided by: the owner, 2026-09-27: person names in stored evidence are
  acceptable; what is forbidden is payment-instrument numbers such as a full
  card number, and credentials
- Withdraws: the [amendment above](#amendment-2026-09-27-names-are-removed-from-stored-evidence)
  ([#333](https://github.com/risu729/kogane/pull/333))
- Carried by:
  `services/collector-sbi-shinsei/src/local/windows-chrome-collector.ts`,
  `services/collector-sbi-shinsei/src/local/collector.ts`,
  `services/collector-sbi-shinsei/src/shared-collection.ts`,
  `services/collector-myjcb/src/parsers.ts` (`redactedStatementHtml`),
  `services/collector-myjcb/src/redaction.ts`,
  `services/collector-myjcb/src/shared-collection.ts`,
  [SBI Shinsei](../sources/sbi-shinsei-bank.md#person-names-in-stored-captures-2026-09-27),
  [MyJCB](../sources/myjcb.md), [collection](../collection.md),
  [observations](../observations.md), [design](../design.md#mutation-policy)

### Context

The amendment above read class (d) as applying to stored evidence and had the
SBI Shinsei and MyJCB collectors replace the account holder's name with
`[redacted:name]` before an object was written. The owner reviewed that
reading after #333 merged and decided the other way: in a deployment that
holds one person's own evidence (the single-owner premise of this ADR), the
owner's own name in the owner's own provider pages is not a thing to hide from
the owner. What must never be stored are the things that grant access or
spend money: credentials and full payment-instrument numbers. Nothing reads
the names today, but removing them costs a rewrite of provider text in every
collector that meets a name, a check that can fail a run, and a stored object
that no longer says what the provider showed.

### Options considered

1. **Keep the redaction (the amendment above).** Rejected by the owner: it
   hides the owner's own name from the owner and alters raw evidence for no
   use.
2. **Keep the redaction code but switch it off.** Leaves dead code and a
   check that still refuses pages. Rejected.
3. **Remove the redaction and redefine class (d); names are kept as the
   provider shows them.** Chosen.
4. **Rewrite the objects written under the redaction to restore the names.**
   Impossible (the names were never retained) and forbidden: raw evidence is
   append-only ([mutation policy](../design.md#mutation-policy)). Rejected.

### Decision

Class (d) is redefined, for CORE, READ, the R2 bucket `kogane-raw-evidence`
and every collector's stored objects:

- (d) **Personal names** (account holder names, customer name fields, the
  holder name a card page shows): **may** be stored in raw evidence and in
  observations exactly as the provider shows them, masked or not. No
  collector removes or replaces them. Nothing is required to read them either:
  a parser or reader copies a name only when a later, reviewed change needs it.

What stays forbidden in stored evidence is unchanged:

- (a) credentials and keys (passwords, session cookies, OTP seeds, HMAC keys,
  API tokens, rotating CSRF tokens): never stored, never logged.
- (b) full payment-instrument numbers (a full card PAN, a full bank card
  number, CVV, expiry paired with a PAN): never stored raw. A number the
  provider itself masks (a card's last digits, a bank account number shown
  with some digits replaced by `*`) is kept as displayed; bank account numbers
  remain class (c) as above.
- Logs and stored operational records keep carrying counts and closed codes
  only, never provider text: a name is provider text, so it never appears in
  a log, a tick record or a failure message.

In code:

- SBI Shinsei: `src/name-redaction.ts` is removed. The Chrome handoff
  (`parseCollectionHandoff`) and the local diagnostic collector write each
  provider capture as the provider's text, byte for byte; the shared path's
  token sanitizer still removes `header.newToken` (class a) as before.
- MyJCB: `src/name-redaction.ts` is removed; `redactedStatementHtml` runs the
  sanitizer only (executable and embedding elements, URL, session and
  credential attributes, full card numbers), and `assertRedactedHtml` no
  longer refuses a 口座名義 cell. The closed code
  `artifact_name_redaction_invalid`, which only the redaction raised, is
  retired.
- Manifests: the per-capture `redactedFieldCount` is removed from both
  collectors' manifests and types. Readers of collector manifests ignore
  unknown keys, so manifests written with it still read.
- The sanitizing steps move forward, never back, so every stored run says
  which step produced it: `sbi-shinsei-token-sanitizer` v3 and
  `myjcb-sanitizer` v3 (token and markup sanitizing only). v1 runs never
  redacted names, v2 runs (#333) replaced them with the marker.

### Consequences

- **Objects written under the amendment above keep the marker.** Every
  object a collector built from #333's merge up to this change wrote carries
  `[redacted:name]` where the name was, its manifest entry carries
  `redactedFieldCount`, and its `redacted` step says v2. They are append-only
  and are not rewritten; the names were never retained, so there is nothing
  to restore. When this amendment was written, whether any such object
  existed depended on whether a collector ran from that build. A read-only
  count on 2026-09-28 found none: no artifact was stored between #333's merge
  and #340's, and no stored object read since carries the marker
  ([observations](../observations.md#no-stored-object-carries-the-redactedname-marker)).
  This rule therefore applies to no object today. Every reader
  that meets one behaves as with a name: the SBI Shinsei response schema and
  the account-connection proof accept the marker (a scalar), and the MyJCB
  card-information reader never reads the 口座名義 value.
- **Objects stored before #333 keep their names**, now as permitted content.
  The owner decision the amendment above left open (whether to delete them)
  is closed: they are kept.
- **Nothing changes in parsing.** No parser or reader reads a name field, so
  no parser release and no observation changes.
- **Limits.** The logs rule is the only guard against a name reaching a log:
  names are not scanned for, because the collectors and the processor log
  closed codes and counts only.

### Verification

- `services/collector-sbi-shinsei/test/stored-captures.test.ts`: through the
  Chrome handoff, each of the four provider captures (indented, with an
  escaped name) is stored as the input text byte for byte, the balance
  summary's placeholder names included and no marker present, and no artifact
  carries `redactedFieldCount`; the local diagnostic collector stores the
  balance summary and exchange rate as the provider's bytes.
- `services/collector-sbi-shinsei/test/shared-collection.test.ts` (Worker end
  to end, synthetic container handoff): the stored balance summary carries the
  placeholder names, nothing logged contains them, the manifest has no
  `redactedFieldCount`, and the four `redacted` steps are
  `sbi-shinsei-token-sanitizer` v3; the existing tests still prove the
  rotating token and the relay secret never reach DATA.
- `services/collector-myjcb/test/person-names.test.ts`: on a synthetic page
  with the observed カード情報 structure, every row including 口座名義 is kept
  and passes `assertRedactedHtml`; a full card number is still removed by the
  sanitizer and refused by the check; the shared run stores the sanitized page
  byte for byte, logs no page value, has no `redactedFieldCount` and records
  `myjcb-sanitizer` v3.
- `services/collector-myjcb/test/shared-collection.test.ts`: the `redacted`
  step is `myjcb-sanitizer` v3.
- `services/processor/test/account-connection-proof.test.ts`: a balance
  summary with placeholder names, and one with the marker (objects written
  under #333), both prove the account connection.
- Not verified: whether any object was written with the marker between #333's
  merge and this change (production was not read); the live pages were not
  fetched.
