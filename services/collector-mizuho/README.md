# Mizuho direct collector

This collector reads ordinary JPY deposit balances and the first displayed
transaction page directly from Mizuho Direct. An operator supplies an already
authenticated browser session to one collection request. It uses the shared
DATA bucket, terminal-last persistence, registered Mizuho parsers, and the
existing balance/transaction projections. No statement upload is involved.

The service does not log in or renew authentication. There is no cron, stored
bank password, session store or automatic deployment. `infra/deploy-order.json`
keeps deployment disabled until the operator has verified the intended cloud
network path. Local WSL account and history collection has been verified; this does not
establish Cloudflare egress compatibility.

## Operations

- `GET /health` returns source and schema version, without account information.
- `POST /trigger` requires `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>` and
  `Content-Type: application/json`. Its body is a `MizuhoSession` object:
  `origin`, `cookies`, `userAgent`, `referer`, and `form: {name, fields}`.
  `extractMizuhoForm` builds the form state from the current authenticated DOM.
  Keep this material in memory and submit it only to the controlled collector.
  The token is the only configured Worker secret. `.dev.vars.example` is a
  synthetic local value, never a production credential.
- Use a fresh session from the official bank browser after account/history
  navigation. The accepted origin is an HTTPS `web` or `webN` host under
  `ib.mizuhobank.co.jp`; requests can only target the observed account-list
  and ordinary-history read routes. Password fields and other routes are refused.
- A successful response contains a run ID, status, artifact count and
  persistence outcome. It contains no bank data or reusable session material.
  HTTP 207 means incomplete coverage; HTTP 502 means acquisition or persistence
  failure. Reauthentication requires returning to the official bank browser.
  Do not retry a stale session automatically.

The configured Processor route is `mizuho-bank` / `collector-mizuho-bank` in
`config/ingest-clients.json`. The existing idempotent bootstrap must be applied
to CORE as part of operational activation. No database migration is needed:
Mizuho already exists in the source catalog.

## Retained evidence and coverage

Only minimized UTF-8 HTML is retained, using `sanitized_provider_capture` and
explicit redaction provenance. Form tokens, input values, scripts, event
handlers, URLs, cookies and authentication headers are excluded. The storage
boundary verifies that every artifact is already sanitized before writing.
Private source identifiers and financial fields remain in the evidence bucket.

The client refreshes form state after each response, recognizes explicit
HTTPS port 443 as the same origin, follows at most one checked read redirect,
and enforces byte, account and total-time limits. A failed requested account
keeps the acquired evidence but marks acquisition partial, so the existing
Processor gate conservatively withholds publication for that run.

Successful first-page acquisition with additional history available has
`providerOutcome: success` and `coverageStatus: partial`. This permits the
observed facts to publish without asserting complete history. No date-range
coverage is inferred. Unobserved pagination, empty-state layouts, other account
types and refresh challenges fail explicitly. Account numbers are validated
against discovery; repeated responsive balances are deduplicated within rows.
Page-local indices are not transaction identities. Repeated identical rows
remain separate; identity across unobserved pagination is not established.

## Verification

```sh
mise run //services/collector-mizuho:ci
mise run //services/collector-mizuho:dry-run
mise run //packages/parsers:ci
mise exec -- hk check --all --no-fail-fast
```

Tests use synthetic HTML and mocked bank requests. Worker tests run against
Miniflare R2, and Processor tests cover terminal registration through READ
projection, idempotency, route authorization and failed acquisition handling.
The compatibility date matches the newest date accepted by the repository's
pinned test runtime. These tests never contact the bank or deploy resources.
