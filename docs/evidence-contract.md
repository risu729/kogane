# Evidence ingest contract (descriptor-v1)

Status: shared package introduced by PR A02 (design-review finding D05,
implementation plan PR-03). Verified locally with synthetic fixtures only; no
production digest was recomputed or rewritten.

`packages/evidence-contract` (`@kogane/evidence-contract`) is the single
definition of the kogane-ingest v1 request schemas, the artifact descriptor
normalization, the canonical encoding, and the digest. The collector importer
(`services/collector-r2-importer`) and the raw-evidence Worker
(`services/raw-evidence`) import it by relative path. The package is pure
TypeScript: no HTTP, no R2, no D1, no credentials, no runtime dependencies.

## Why one definition

`fetch_artifacts.descriptor_sha256` is a persistent identifier. It is compared
on every artifact replay, on every staged inventory item, and on every seal.
Before A02 the normalization that feeds it existed twice: the server's
`parseArtifact` and the importer's `centralDescriptorSha256`, plus five
per-source copies of the sorted-key JSON encoder. A change on one side and not
the other would not corrupt stored evidence (the server recomputes), but it
would stop ingest and mid-run resume with `central_descriptor_mismatch`.
Sharing the code removes that class of drift; the golden vectors make any
remaining change visible in review.

## Pipeline

```text
unknown JSON body ──parseArtifactRequest──▶ ValidatedArtifactRequest
ArtifactRequest ──normalizeDescriptorV1──▶ CanonicalDescriptorV1
CanonicalDescriptorV1 ──encodeDescriptorV1──▶ bytes ──descriptorDigestV1──▶ sha256 hex
```

`descriptorContractV1` bundles the four steps:

```ts
interface DescriptorContract {
  readonly contractVersion: "descriptor-v1";
  parseRequest(input: unknown, context: { runId: number }): ValidatedArtifactRequest;
  normalize<T extends ArtifactRequest>(request: T): CanonicalDescriptorV1<T>;
  encode(value: CanonicalDescriptorV1<ArtifactRequest>): Uint8Array;
  digest(canonicalBytes: Uint8Array): Promise<string>;
}
```

- **Server** (`store.ts` `addArtifact`): `digest(encode(normalize(parseRequest(body))))`.
  The server always re-validates and recomputes. A client-declared
  `descriptorSha256` in an inventory item or seal is only ever compared against
  the stored value; it is never taken on trust (`inventory_artifact_conflict`,
  `inventory_mismatch`).
- **Client** (`central.ts` `centralDescriptorSha256`): `digest(encode(normalize(request)))`
  without `parseRequest`, exactly as before A02. The importer sends the request
  as given and fails closed if the server's digest differs.

## Request schemas

| Endpoint                                    | Request type                 | Parser                            | Hashed            |
| ------------------------------------------- | ---------------------------- | --------------------------------- | ----------------- |
| `POST /v1/runs`                             | `CreateRunRequest`           | `parseCreateRunRequest`           | no                |
| `POST /v1/runs/{id}/units`                  | `AddUnitRequest`             | `parseAddUnitRequest`             | no                |
| `POST /v1/runs/{id}/ranges`                 | `AddRunRangeRequest`         | `parseAddRunRangeRequest`         | no                |
| `POST /v1/runs/{id}/page-groups`            | `AddPageGroupRequest`        | `parseAddPageGroupRequest`        | no                |
| `POST /v1/units/{id}/reports`               | `AddUnitReportRequest`       | `parseAddUnitReportRequest`       | no                |
| `POST /v1/runs/{id}/reports`                | `AddRunReportRequest`        | `parseAddRunReportRequest`        | no                |
| `POST /v1/runs/{id}/artifacts`              | `ArtifactRequest`            | `parseArtifactRequest`            | **descriptor-v1** |
| `POST /v1/runs/{id}/inventories`            | `BeginInventoryRequest`      | `parseBeginInventoryRequest`      | no                |
| `POST /v1/runs/{id}/inventories/{id}/items` | `AddInventoryItemsRequest`   | `parseAddInventoryItemsRequest`   | inventory v1      |
| `POST /v1/runs/{id}/inventories/{id}/seal`  | `SealStagedInventoryRequest` | `parseSealStagedInventoryRequest` | no                |
| `POST /v1/runs/{id}/seal`                   | `SealRunRequest`             | `parseSealRunRequest`             | inventory v1      |
| `POST /v1/runs/{id}/attempts`               | `RecordAttemptRequest`       | `parseRecordAttemptRequest`       | no                |

Every parser rejects unknown keys (`unknown_field`) and keeps the historical
`invalid_<field>` and pair-mismatch codes; the Worker maps `ContractError` to
HTTP 400 with the same code. Database-dependent checks (routes, scope rules,
template policies, parent rows, conflicts) stay in the Worker.

The inventory digest (`inventory_digest_version` v1) is
`sha256(canonicalJsonV1(items sorted by artifactKey))` over
`{artifactKey, sha256, descriptorSha256}` and is unchanged.

## What is hashed

Every key of `ArtifactRequest` is hash-relevant. `normalizeDescriptorV1`
produces:

```text
{ ...every scalar key as given,
  fetchUnitId, pageGroupId, pageIndex          (undefined → null),
  origins: { http, storage, file, email }      (undefined → null; storage rebuilt),
  ranges, transformSteps, relations }          (undefined → [])
```

and `encodeDescriptorV1` writes sorted-key JSON (binary key order at every
depth, array order preserved, `JSON.stringify` string escaping, no Unicode
normalization, safe integers only, `undefined` properties dropped, `null`
written) as UTF-8. Not hashed: run and session identifiers, client identity,
`recorded_at_ms`, reports, attempts, inventory metadata.

### Fixed v1 rules

| Rule                                                        | Client normalizer                    | Server parser                                          |
| ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Unknown top-level key                                       | spread into the hash                 | rejected `unknown_field`                               |
| Unknown key inside `storage`                                | dropped (ten known keys rebuilt)     | rejected                                               |
| `fetchUnitId`/`pageGroupId`/`pageIndex` omitted             | `null`                               | `null`                                                 |
| `ranges`/`transformSteps`/`relations` omitted               | `[]`                                 | `[]`                                                   |
| `http`/`file`/`email` omitted                               | `null`; present objects pass through | `null`; present objects validated and every key filled |
| other optional scalars omitted (`dataset`, `sequence`, ...) | key absent                           | `null`                                                 |
| `containerKind` omitted                                     | key absent                           | `"single"`                                             |
| `declaredMediaType` case                                    | as given                             | lower-cased                                            |
| `http.host` case, `queryNames` order/duplicates             | as given                             | lower-cased, unique, sorted                            |
| `ranges` order, inclusive flags                             | as given                             | sorted by `rangeKey`, `true/false` → `1/0`             |
| `transformSteps` / `relations` order                        | as given                             | sorted; `parentRunId` defaults to the run              |
| Non-safe integer or float                                   | `TypeError`                          | `invalid_<field>`                                      |
| Negative integer                                            | hashed                               | `invalid_<field>`                                      |
| Unicode                                                     | raw UTF-8, NFC and NFD differ        | same                                                   |

Where the two columns differ, a client that sends the non-canonical form gets
a digest that does not match the server's and fails closed. Importers already
send the canonical form (explicit nulls, explicit arrays, sorted steps); the
golden vectors record both digests for every case.

## Golden vectors

`packages/evidence-contract/fixtures/golden-vectors.json` holds 34 vectors:
input, client-normalized JSON, exact canonical bytes (as a UTF-8 string) and
SHA-256 for the client path, and the same for the server path (or the
rejection code). The values were produced by running the **pre-refactor**
implementations at commit `130912af` (`central.ts` `centralDescriptorSha256`,
`store.ts` `parseArtifact` with `canonical.ts`) over the inputs; the tests
compare the shared package, the importer's `CentralClient` path, and the
raw-evidence Worker over HTTP against those recorded values.

Policy:

- Never regenerate the fixture from the current code. A failing vector means a
  persisted digest would move; fix the code, or introduce a new contract
  version (below).
- Add a vector whenever a new input shape matters (append; existing entries
  stay byte-identical). New v1 vectors must be computed with the frozen v1
  functions.
- A pull request that changes any byte of the fixture is a contract change and
  must say so in its description.

Tests:

- `packages/evidence-contract/test/golden-vectors.test.ts`: package-level, all
  vectors, both paths, equivalence links, Unicode and array-order properties.
- `services/collector-r2-importer/test/evidence-contract-golden.test.ts`: every
  vector through `CentralClient.addArtifact` against a server-path fake and
  through `centralDescriptorSha256`.
- `services/raw-evidence/test/evidence-contract.test.ts`: postable vectors
  through the Worker (D1 + R2), replay of the same descriptor, tampered client
  hashes rejected in staged inventories and direct seals, unknown fields
  rejected on every endpoint.
- Existing suites (`services/collector-r2-importer/test/*.test.ts`,
  `services/raw-evidence/test/api.test.ts`, `source-usecases.test.ts`, and the
  `verify-*-route.test.sh` scripts) pass unchanged; they cover resend, mid-run
  resume in chunks, and seal for every source.

## Adding or changing a field

1. Decide whether the field is hash-relevant. A field that describes the
   acquired bytes or their origin is; operational state is not.
2. **Not hash-relevant**: do not add it to `ArtifactRequest`. Put it on a
   separate endpoint or table with its own request type and parser.
3. **Hash-relevant**: v1 is frozen. Add `descriptor-v2`: a new request type,
   `normalizeDescriptorV2`, its own golden vectors, a new
   `descriptor_version` value, and a compatibility path that maps every v1
   input (including the wire form old collectors still send mid-run) to the
   same v1 canonical bytes. Never add a version field to the v1 hash input,
   never re-hash stored v1 descriptors with the new definition, and never
   overwrite a stored digest. If the new definition describes the same bytes
   differently, record it as a separate descriptor or versioned relation.
4. Enumerations (`artifactRole`, `payloadFidelity`, origin bases, ...) live in
   the package and in the D1 `CHECK` constraints; extend both in one change.

## Deploy order and rollback

No migration and no feature flag. The package is bundled into each Worker at
deploy time, so deploy `services/raw-evidence` (schema unchanged, digests
unchanged) and `services/collector-r2-importer` in either order; an old
importer talking to the new server, or the reverse, computes the same v1
bytes. Rollback target: the previous deployment of either Worker; the same v1
inputs hash the same on both sides.

## Normalization sites (before and after A02)

| Site                                                                                                                              | Before                                                                                                                  | After                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `raw-evidence/src/store.ts` `parseArtifact`                                                                                       | inline validation, defaults, sorting                                                                                    | `parseArtifactRequest` in the package                                                            |
| `raw-evidence/src/store.ts` `mediaTypeValue`                                                                                      | lower-cases media type                                                                                                  | package                                                                                          |
| `raw-evidence/src/store.ts` `addArtifact` digest                                                                                  | `sha256Hex(canonicalJson(input))`                                                                                       | `descriptorContractV1` digest of the normalized parse                                            |
| `raw-evidence/src/origins.ts` `parseOrigins` and four origin parsers                                                              | server only                                                                                                             | package; server keeps scope and policy checks                                                    |
| `raw-evidence/src/structure.ts` `parseRangeFields`, `boolInteger`                                                                 | server only                                                                                                             | package                                                                                          |
| `raw-evidence/src/canonical.ts`                                                                                                   | server copy of sorted-key JSON                                                                                          | re-export of `canonicalJsonV1`                                                                   |
| `raw-evidence/src/http.ts` validation primitives                                                                                  | server only                                                                                                             | package (`validate.ts`)                                                                          |
| `raw-evidence/src/store.ts` `createRun`, reports, inventories, seals, attempts                                                    | inline validation                                                                                                       | package parsers; SQL unchanged                                                                   |
| `collector-r2-importer/src/central.ts` `centralDescriptorSha256`, `normalizedStorageOrigin`, `canonicalJson`                      | client copy                                                                                                             | `normalizeDescriptorV1`, `normalizeStorageOriginV1`, `encodeCanonicalV1` in the package          |
| `global-pass.ts`, `moneyforward.ts`, `myjcb.ts`, `sony.ts`, `smbc-direct.ts` local `descriptorSha256`                             | per-source minimal normalization                                                                                        | delegate to `centralDescriptorSha256` (existing tests prove identical digests on their fixtures) |
| `global-pass.ts`, `moneyforward.ts`, `myjcb.ts`, `sony.ts`, `sbi-vc.ts`, `v-point.ts` local `canonicalJson`/`canonical`           | byte-identical copies                                                                                                   | `canonicalJsonV1` (inventory and state hashes unchanged)                                         |
| `mobile-suica.ts`, `sbi-shinsei.ts` `canonical`, `smbc-direct.ts`, `v-point-pay-email.ts` `canonicalJson`, `vpass.ts` `canonical` | string-builder variants (no safe-integer check, `undefined` rendered, vpass appends a newline and allows finite floats) | left in place: not byte-identical, used for state and inventory hashes or equality checks only   |
