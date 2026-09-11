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

`packages/observation-shared/src/evidence-contract.ts` defines `evidence-v1`.
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

Cloudflare Access protects every route of this Worker through its Worker-scoped
application. The committed `ACCESS_ISSUER` and `ACCESS_AUDIENCE` match that
application. The Worker independently verifies the signed Access JWT
before serving either assets or data. Missing configuration denies access.
No ingest/admin token is accepted by the browser or embedded in its bundle.

The change lifecycle adds one authenticated POST path set,
`POST /api/command/v1/*` ([change-lifecycle.md](change-lifecycle.md)). It is
closed unless `COMMANDS_ENABLED` is exactly `"true"`, which the committed
configuration does not set; every other request that is not `GET` or `HEAD`
still gets 405. `AGENT_GRANTS` (a JSON array of verified Access subjects) marks
subjects that may plan and simulate but never approve or commit; it is empty in
the committed configuration. The Worker itself writes nothing: it forwards the
verified subject to `kogane-observation-pipeline` through the `PIPELINE`
service binding, which stays the only writer of the decision, approval, receipt
and outbox tables.

The committed configuration enables the production `workers.dev` route and
keeps preview URLs disabled. Preserve these settings and the Access application
in deployment automation; do not deploy an unprotected route as a temporary
login workaround.

The application reuses the existing `default` Allow policy: an identity ending
in `@risunosu.com` and a Gateway connection are both required. Authentication
with the Cloudflare One Client (WARP) is enabled. The application session is
24 hours; the existing global WARP authentication session is 8 hours. This uses
the enrolled client identity, not the Cloudflare management account's email.
See [Cloudflare client sessions](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/client-sessions/).

### Deployment verification status

On 2026-09-07, the PR #81 implementation was deployed to
<https://kogane-evidence-browser.takuanimal.workers.dev> as Worker version
`f1707cdf-8054-4d7b-a924-8dd05193a277`. The saved Access application covers the
Worker's production and preview destinations, although preview URLs remain
disabled. Requests without an authenticated session redirect to Access.

Authenticated browser verification of the screen and production data remains
pending: the current browser reaches the Access sign-in screen despite a
healthy WARP connection. The cause has not yet been established.
The successful deployment and Access redirect do not establish that the live
data flow has passed verification. After completing Access sign-in, verify the screen,
`/api/evidence/v1/meta`, and the run/artifact navigation through the protected
application before declaring live verification complete.

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
mise run ci:web
mise run ci:app
mise run check --lint
```

The frontend job builds both modes and exercises synthetic browser responses.
The Worker job builds the production assets and tests local D1/R2 plus signed
synthetic JWTs. It does not query production or change Access configuration.
The regular `mise run web:build && bun src/serve.ts --demo` remains the isolated local synthetic browser.

Transactions and balances can be connected only when a production observation
store and its provenance contract exist. Raw artifacts are not substituted for
parsed records; the production screen states that those capabilities are
not available.
