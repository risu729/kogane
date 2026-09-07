# Production evidence browser

The read-only Worker in `services/evidence-browser` serves the existing React
frontend in evidence mode and reads the central raw-evidence D1/R2 store. The
first enabled source is `sony-bank`. It introduces no migrations, parsed
observations, collector calls, or writes to the evidence store.

The production screen follows a sealed collection run to its paginated artifact
list, artifact details, and original stored bytes. A seal means the declared
inventory passed storage validation. It does not mean collection succeeded:
partial and failed results remain visible, with their original outcome and
timestamp basis. Synthetic and excluded runs, and runs without a seal, are
outside this view. An unavailable API is an error, never an empty balance.

## Versioned read contract

`poc/observation-pipeline/shared/evidence-contract.ts` defines `evidence-v1`.
Its prefixed identifiers and cursors are opaque to clients. The local PoC's
numeric identifiers, parsed-observation API, and hash-only raw URLs retain
their existing meanings and are not used by this Worker.

| GET endpoint under `/api/evidence/v1`    | Result                                     |
| ---------------------------------------- | ------------------------------------------ |
| `/meta`                                  | Source and explicit read-only capabilities |
| `/sources/:sourceId/runs?cursor=...`     | Up to 50 sealed runs                       |
| `/runs/:runId/artifacts?cursor=...`      | Up to 50 artifacts from an authorized run  |
| `/runs/:runId/artifacts/:artifactId`     | Descriptor metadata and collection context |
| `/runs/:runId/artifacts/:artifactId/raw` | Protected attachment of the stored bytes   |

The browser validates nested responses and their relationship to requested
identifiers. Raw downloads resolve the artifact's run and source before reading
R2, and verify the object's size and checksum metadata. Provider HTML is never
rendered inline. Raw responses use an attachment disposition, `nosniff`, sandbox
policy, and no-store caching.

## Authentication and operation

Cloudflare Access must protect every route of this Worker. Configure a policy
for the intended operator and set `ACCESS_ISSUER` and `ACCESS_AUDIENCE` to that
application's values. The Worker independently verifies the signed Access JWT
before serving either assets or data. Missing configuration denies access.
No ingest/admin token is accepted by the browser or embedded in its bundle.

The committed configuration has `workers_dev` and preview URLs disabled, with
empty Access settings. Public routing is enabled only after the Access policy
is configured and verified. Preserve these settings in deployment automation;
do not deploy an unprotected route as a temporary login workaround.

Assets run through the Worker first, so authentication applies and direct raw
navigation cannot become the SPA fallback. Access identity via `ctx.access` is
not available through Cloudflare's Static Assets router. This service verifies
`Cf-Access-Jwt-Assertion` against the fixed issuer and audience instead. See
[Cloudflare's Access documentation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

Structured request logs include a request ID, fixed route name, duration,
status, and typed error code. Tokens, provider content, full URLs, account
identity, and arbitrary exception messages are excluded. Invocation URL logging
is disabled; detailed application events remain enabled.

## Build and verification

```sh
mise run ci:package poc/observation-pipeline
mise run ci:package services/evidence-browser
mise run check --lint
```

The frontend job builds both modes and exercises synthetic browser responses.
The Worker job builds the production assets and tests local D1/R2 plus signed
synthetic JWTs. It does not query production or change Access configuration.
The regular `bun run preview` remains the isolated local synthetic browser.

Transactions and balances can be connected only when a production observation
store and its provenance contract exist. Raw artifacts are not substituted for
parsed records; the production screen states that those capabilities are
not available.
