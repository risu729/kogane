# Collection contract (`packages/collection`)

Unified plan work item **U07** (chapter 03, decisions D7/D8/D12). This package
is the shared contract for the central DATA R2 bucket: where objects live, what
a finished acquisition run records, how that record is written so it cannot lie,
and how a reader checks it afterwards.

It is pure TypeScript over a minimal `R2BucketLike` interface. It has no
Cloudflare `Env`, no D1, no HTTP and no credentials, so a collector Worker and
the Processor use the same implementation of "the terminal is the completion
record" instead of two.

Nothing in this package is wired into a deployed Worker yet. U09 gives each
collector `COLLECTION_TARGET=shared` and a `DATA` binding, and U08 gives the
Processor the terminal consumer; both stay behind `SHARED_R2_INGEST_ENABLED`,
default off. Merged is not enabled.

## Key layout

```text
objects/<first two hex>/<sha256>       content-addressed bytes that are safe to keep
runs/<source>/<runId>/terminal.json    the record that a run finished persisting
reports/<reportRef>/<path>             persisted outputs
projection-inputs/<digest>/<path>      frozen inputs for a repeatable projection
```

`objectKey`, `terminalKey`, `runPrefix`, `reportKey` and `projectionInputKey`
are the only places these strings are formed. Every input is validated and
never normalized: an upper-case digest, a `.`/`..` segment, an empty segment, a
backslash, a leading slash and an out-of-charset source or run id are all
rejected, because a normalized key would silently address a different object
than the caller named. `parseTerminalKey` is the exact inverse and returns null
for anything else, so a listing can skip unrelated objects.

The object prefix is the same content-addressed layout `docs/raw-store.md`
already describes for `kogane-raw-evidence`; this contract adds the `runs/`,
`reports/` and `projection-inputs/` prefixes beside it. Prefixes exist for
organisation, notification filters and recovery scans. They are **not** a
per-source ACL: a trusted collector holds a binding to the whole bucket.

## The terminal manifest (`terminal-v1`)

`TerminalManifest` carries the run identity, the requested scope, the window,
the provider outcome, the stored artifacts and the run's units, ranges, reports
and transformations:

| Field                                   | Meaning                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `manifestVersion`                       | Always `terminal-v1`.                                                                                            |
| `source`, `producer`, `producerVersion` | Who acquired it and with what code.                                                                              |
| `runId`, `attemptId`, `operationId?`    | Run identity and the attempt that wrote it.                                                                      |
| `acquisitionSessionRef?`                | Shared by the per-source runs of one session (03 §3).                                                            |
| `requestedScope`                        | `scopeKind`, `startValue`, `endValue`, `unitKeys`.                                                               |
| `startedAt`, `completedAt`              | ISO instants; `completedAt` may not precede `startedAt`.                                                         |
| `providerOutcome`                       | `success` \| `partial` \| `failed`.                                                                              |
| `coverageStatus`                        | `complete` \| `partial` \| `unknown`, the same words `packages/domain` uses.                                     |
| `persistenceComplete`                   | Always `true`: the terminal _is_ the persistence claim.                                                          |
| `safeErrorCode?`                        | A machine code, never provider text.                                                                             |
| `artifacts[]`                           | `artifactKey`, `storageRef {store:"DATA", key}`, `sha256`, `byteSize`, `mediaType`, `role`, `unitKey?`.          |
| `units[]`                               | `unitKey`, `unitKind`, `artifactCount`, `coverageStatus`, `safeErrorCode?`.                                      |
| `ranges[]`                              | `rangeKey`, `rangeKind`, `precision`, `basis`, `startValue`, `endValue`, `unitKey?`.                             |
| `reports[]`                             | `reportRef`, `reportKind`, `scope`, `outcome`, `unitKey?`, `storageRef?`, `safeErrorCode?`.                      |
| `transformations[]`                     | `transformationId`, `stepKind`, `transformerId`, `transformerVersion`, `inputArtifactKeys`, `outputArtifactKey`. |

`parseTerminalManifest` validates it by hand, exactly as
`packages/evidence-contract` validates the ingest descriptor: no schema
library, no new dependency, stable error codes. **Unknown keys are rejected**
(`unknown_field`) at every level, not preserved: a field the contract does not
name cannot ride along into a digest. It also enforces the cross-references —
an artifact's `storageRef.key` must be `objectKey(sha256)`, a report's
`storageRef.key` must be `reports/<its own reportRef>/<safe path>`
(`report_storage_ref_mismatch`), and every `unitKey` and `outputArtifactKey`
must resolve inside the manifest. Instants must be `Z`-suffixed ISO strings
that survive a `Date` round trip, so `2026-02-30` is refused rather than
rolled into March. Identifiers are charset-restricted (`source` is the same
charset as the ingest contract's source ids; `role`, `unitKind`, `producer`,
`reportKind` and every `safeErrorCode` are `[a-z0-9_-]` machine codes), so
there is no free-text field in which provider text, an amount or a credential
could be recorded. `units[].artifactCount` is the collector's declaration and
is not cross-checked against `artifacts[]`.

This is **not** a replacement for the ingest descriptor contract. The Processor
derives descriptors from a terminal; the descriptor schema, its normalization
and its frozen digest stay in `packages/evidence-contract`
(`docs/evidence-contract.md`).

### Partial never becomes success

Two rules are refused at validation time rather than left to a caller:

- `providerOutcome != "success"` may not claim `coverageStatus: "complete"`;
- `providerOutcome != "success"` must carry a `safeErrorCode`.

So a `partial` run states persistence completeness and the coverage gap at the
same time, and a `failed` run with zero artifacts stays a failure instead of
reading downstream like a complete observation of zero. (`safeErrorCode` on a
`success` is refused too, so the two cannot be blurred from the other side.)

## Canonical encoding and `terminalDigest`

The terminal is stored as `canonicalJsonV1` bytes from
`packages/evidence-contract`: sorted keys at every depth, array order
preserved, safe integers only. Reusing that encoder means the terminal digest
and the persisted descriptor digests come from one frozen implementation.

`terminalDigest(manifest)` is the lower-case hex SHA-256 of those bytes, taken
over the **validated** manifest. Validation sorts `artifacts`, `units`,
`ranges`, `reports` and `transformations`, so two collectors that state the
same run produce the same digest regardless of the order they listed things in.

An ETag is never treated as a SHA-256, and a hash collision is never resolved
by a private identity rule: identical digest means resend, anything else is a
conflict.

## Terminal-last: `persistRun`

```text
for each artifact:  head → reuse if verified │ put (create-only) → verify size + digest
                    multipart: createMultipartUpload → uploadPart* → complete → verify
then:               put runs/<source>/<runId>/terminal.json, create-only, last
```

Every object write is awaited and then verified against what R2 actually
stored: the size, the native `checksums.sha256` when R2 recorded one, and the
`sha256`/`byteSize` custom metadata (the fallback for multipart objects, which
have no native checksum). A multipart artifact is `complete`d before anything
else continues, so no terminal can observe a half-uploaded object.

Bodies are hashed client-side before the put (`verifyBodyDigest`, default on),
so a declared digest that does not describe the bytes stops the run with
`artifact_digest_mismatch` and writes nothing. Single-part puts are additionally
checked by R2 itself through the `sha256` put option. Multipart bodies are
**always** hashed here whatever the option says: R2 cannot check a multipart
digest server-side, and the post-upload verification of a multipart object can
only read back the metadata this writer declared. A failed verification after
a put — including a `complete`d multipart — is `incomplete` with a checkpoint,
never a terminal.

Content-addressed objects are stored as `application/octet-stream`; the
declared `mediaType` stays in the manifest. Two artifacts with identical bytes
therefore share one object, and re-verification does not depend on which role
happened to write it first.

Outcomes:

| Outcome             | When                                                    | What it guarantees                                                     |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `persisted`         | every object verified, terminal created                 | the run's saved set is in R2                                           |
| `already_persisted` | terminal exists with the same digest                    | a resend; nothing was rewritten                                        |
| `conflict`          | terminal exists with a different (or unreadable) digest | nothing was overwritten; `storedDigest` and a reason code are returned |
| `incomplete`        | an object write or verification failed                  | **no terminal**; a checkpoint of persisted keys is returned            |

`incomplete` is what makes resume cheap: the checkpoint lists the keys already
stored and the artifact keys still pending, so the caller re-persists the same
plan and the stored objects are verified and reused rather than fetched from
the bank again. A lost put response is the same case — the object is in R2, the
retry HEADs it, verifies it and reuses it, and never writes different bytes
under the same content key.

### Create-only conditional put

The writer HEADs the terminal key first and compares digests, then issues the
put with `onlyIf: { etagDoesNotMatch: "*" }`. If the runtime returns `null` it
re-reads the winner and compares digests again. The comparison uses the
reader's own `readTerminalAt`, so a stored terminal the Processor would block
(not canonical bytes, identity that does not match the key, corrupt JSON) is a
`conflict` carrying that reason code — never `already_persisted`, and never
overwritten. Both halves are deliberate:
the conditional put closes the race between the HEAD and the write, and the
digest comparison keeps the helper correct on an R2 implementation that does
not honour the wildcard condition. The public Workers R2 reference does not
document `"*"`, so it is verified here rather than assumed:
`packages/collection/worker-test/r2-terminal.test.ts` runs against real
workerd/Miniflare R2 and asserts that the second create-only put returns
`null` and leaves the first object in place. The same pattern is already in
production in `services/raw-evidence/src/store.ts`.

## Reading and re-checking

- `readTerminal(bucket, source, runId)` / `readTerminalAt(bucket, key)` return
  `found`, `missing`, or `blocked` with a reason code. A terminal whose bytes
  are not the canonical encoding of its own manifest, or whose identity does
  not match its key, is `blocked` rather than trusted.
- `verifyReferencedObjects(bucket, manifest)` re-checks existence, size and
  digest for every artifact and reports each problem
  (`object_missing`, `object_size_mismatch`, `object_hash_mismatch`,
  `object_digest_unverifiable`). The native `checksums.sha256` is R2's proof
  for single-part objects; for a multipart object the check is against the
  `customMetadata.sha256` the writer declared, which the writer computed over
  the bytes it uploaded but is still a declaration. With `{ streamHash: true }`
  the object is read and hashed when metadata cannot prove the digest. This is
  what lets the Processor register the collector's own bytes without copying
  them.
- `listTerminals(bucket, { source?, cursor, limit })` is a **bounded scan of
  the whole `runs/` prefix**, paged by the R2 cursor. It is never a time window
  and never a lexicographic watermark: a run whose terminal is confirmed after
  a newer run's sorts wherever its run id puts it, and "everything after the
  newest key I saw" drops it. `readTerminalPage` reads a page and reports a
  corrupt terminal as `blocked` for that run while returning the rest of the
  page, so one broken run cannot stop the scan.

## Stage semantics

`contracts/stages.json` in the plan, restated in `src/stages.ts`:

| Stage        | Guarantees                                                 | Does not guarantee                           |
| ------------ | ---------------------------------------------------------- | -------------------------------------------- |
| `persisted`  | the saved set this run decided on is in R2                 | full provider history, or a successful parse |
| `registered` | descriptor and reference set catalogued and sealed in CORE | parser success, adoption                     |
| `parsed`     | the named release's output is stored                       | that a reader adopted it                     |
| `adopted`    | the CORE publication/adoption transaction committed        | that READ reflects it                        |
| `projected`  | the READ content was validated and published               | that it stays current                        |

Job outcomes are `pending | completed | retryable | blocked`. `queued`,
`building`, `flag_off` and `no_processor` are **never** completion:
`stageRecord()` throws if one of them is paired with `completed`. Registration
idempotency is `(source, runId, terminalDigest, registrationContractVersion)` —
the contract version is part of the key so a changed ingest contract registers a
new revision instead of silently reusing the old one.

`last_success_at` may exist as a display or monitoring aggregate. It is not the
record of record: a newer run succeeding does not tell you an older run is
still unregistered.

## Legacy layouts (`src/adapters.ts`)

`LegacyCollectionAdapter` names what a legacy per-source bucket must answer to
be re-persisted under this contract: the terminal suffixes, a `matchTerminalKey`
that derives run identity from a key, the object keys the run needs, and a
`toPersistPlan` that maps already-read bytes to a `terminal-v1` plan. It is a
pure mapping: it reads no bucket, calls no service, and does not modify
`services/collector-r2-importer`, whose import path is unchanged.

**It stores no legacy byte verbatim.** Legacy responses carry the session
envelope the importer strips before anything reaches central storage, and that
sanitizer lives in the importer, not in this package. So every object in a plan
is one the caller has already passed through a named sanitizer
(`LegacyObject.sanitizer = { transformerId, transformerVersion }`), and the plan
records that step as a `redacted` transformation whose input is the legacy key
and whose output is the stored artifact. The legacy terminal record itself
(`manifest.json` / `error.json`) is parsed for identity, timestamps, outcome and
the declared statement months and is not stored; an error record's free-text
`message` is never copied anywhere.

`VPASS_LEGACY_ADAPTER` is the worked example, over the key grammar the importer
already recognises (`vpass/<yyyy>/<mm>/<dd>/<runId>/[card-NNN/]{manifest,error}.json`,
path date agreeing with the run id). One Vpass session visits several cards
under one run timestamp, so each card becomes its own run (`<runId>-card-NNN`)
and all of them carry the session timestamp as `acquisitionSessionRef`: the
cards stay distinguishable instead of collapsing into one run whose provenance
is lost (G1-16). A successful card run maps to `providerOutcome: success` with
`coverageStatus: partial`, because a card exposes a rolling window of statement
months and a finished run is not a claim about the card's whole history; an
error record maps to `failed` / `unknown` / `collector_failed`.

What it does **not** map: the importer's snapshot schema checks, its card and
month inventory cross-checks, its legacy partial-error object layout
(`session/`, `cards/`) and its sanitizer. Those stay in the importer until U08
moves them behind the Processor; this adapter gives such a move one target
shape, nothing more.

Legacy buckets are not decommissioned by this change (plan 03 §7). They stay
readable until nothing exists only there.

## What this does not guarantee

- **Financial completeness.** A terminal says the bytes the run decided to keep
  are in R2. It does not say the provider returned every transaction, every
  account or every month. `providerOutcome` and `coverageStatus` are separate
  fields for that reason and the validator refuses to let one imply the other.
- **Parse, adoption or projection.** Those are later stages with their own
  records.
- **Delivery.** An R2 event notification is a hint. Queues are at-least-once
  and a notification can be lost, so the bounded `runs/` scan is the safety net
  and a notification id is never the idempotency key.
- **Garbage collection.** No object is deleted by anything here. An object not
  referenced by a terminal may still be an in-flight run, a legacy manifest, a
  report or a transformation input.

## Verification

Verified locally with synthetic data only. No provider was contacted, no
production bucket was read or written, and no fixture contains a real account,
name, balance or token.

| Acceptance                                                                         | Covered by                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| G1-01 last put fails → no terminal, resumable checkpoint                           | `test/persist-run.test.ts`                                    |
| G1-02 terminal after every put, references match storage                           | `test/persist-run.test.ts`                                    |
| G1-03 unfinished multipart never reaches the terminal                              | `test/persist-run.test.ts`                                    |
| G1-05 same run + digest is a no-op (also when the create-only put loses the race)  | `test/persist-run.test.ts`, `worker-test/r2-terminal.test.ts` |
| G1-06 different manifest for the same run conflicts, no overwrite (also as a race) | `test/persist-run.test.ts`, `worker-test/r2-terminal.test.ts` |
| G1-07 lost put response → verify and reuse; different bytes (size or hash) refused | `test/persist-run.test.ts`                                    |
| G1-08 partial stays partial with its coverage gap                                  | `test/manifest.test.ts`                                       |
| G1-09 failed with zero artifacts stays a failure                                   | `test/manifest.test.ts`                                       |
| G1-12 a late terminal for an older run is still found                              | `test/reader.test.ts`                                         |
| G1-13 a corrupt terminal is blocked without stopping the scan                      | `test/reader.test.ts`                                         |
| G1-14 missing / size-mismatched objects reported with codes, not ok                | `test/reader.test.ts`                                         |
| G1-16 a multi-source session keeps one run per source                              | `test/manifest.test.ts`, `test/adapters.test.ts`              |

Real R2 semantics (create-only conditional put, checksum rejection, native
checksum presence, the whole persist/read/verify/list path through
`R2BucketLike`) are checked in the Workers runtime by
`worker-test/r2-terminal.test.ts` via Miniflare.

Not verified: behaviour against production R2 at scale, multipart objects
larger than the Workers memory limit (the writer holds a multipart body in
memory to hash it), whether production R2 honours `etagDoesNotMatch: "*"` the
way Miniflare does (the HEAD-then-compare path covers it either way), and any
end-to-end path into CORE or READ — those belong to U08. G1-04, G1-10, G1-11
and G1-15 need the Processor and are not claimed here.

## Flags, deploy order, rollback

- Flags: none in this package. The consumers add `SHARED_R2_INGEST_ENABLED`
  (Processor, U08) and `COLLECTION_TARGET` (collectors, U09), both default off
  / `legacy`.
- Deploy order when the consumers land: reader (Processor) before writer
  (collectors), so a terminal is never written before something can read it.
- Rollback: this package is pure and unreferenced by any deployed Worker, so
  reverting the commit is the rollback. Once the consumers exist, rollback is
  turning the flags off; terminals already written stay valid and are read on
  the next scan.
