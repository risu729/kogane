# Mizuho direct collector

This collector reads ordinary JPY deposit balances and the first displayed
transaction page directly from Mizuho Direct. It authenticates with the customer
number and login password provisioned as Worker secrets on each daily run.
An operator can also supply an already authenticated session for one request.
It uses the shared
DATA bucket, terminal-last persistence, registered Mizuho parsers, and the
existing balance/transaction projections. No statement upload is involved.

The daily schedule is `25 21 * * *` UTC (06:25 JST), staggered after the other
daily bank collectors. Each invocation signs in once, collects and persists
sanitized evidence, and discards its session. Additional authentication or an
unrecognized login page stops the run; the Worker neither answers challenges
nor retries password submissions. Scheduled retries are explicitly disabled.
`infra/deploy-order.json` includes the Worker in the normal production release,
with a public health postcheck. Local WSL session-based reads have been verified,
and the daily cron runs (password login and authenticated cloud collection) have
registered in production since 2026-09-24. Health success alone does not
establish successful bank access.

## Operations

- `GET /health` returns source and schema version, without account information.
- `POST /trigger` requires `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>` and
  `Content-Type: application/json`. Send exactly `{}` to sign in using the
  configured Worker secrets. Customer numbers and passwords are never accepted
  in the request body. Alternatively, its body can be a `MizuhoSession` object:
  `origin`, `cookies`, `userAgent`, `referer`, and `form: {name, fields}`.
  `extractMizuhoForm` builds the form state from the current authenticated DOM.
  Keep this material in memory and submit it only to the controlled collector.
  `.dev.vars.example` contains synthetic local values, never production credentials.
  Provision `ADMIN_TRIGGER_TOKEN`, `MIZUHO_CUSTOMER_NUMBER`, and
  `MIZUHO_LOGIN_PASSWORD` out of band before deployment. CI/CD does not
  synchronize collector secrets or hold bank credentials or sessions.
- For explicit-session requests, use a fresh session from the official bank browser after account/history
  navigation. The accepted origin is an HTTPS `web` or `webN` host under
  `ib.mizuhobank.co.jp`; requests can only target the observed account-list
  and ordinary-history read routes. Password fields in supplied session state
  and other collection routes are refused.
- A successful response contains a run ID, status, artifact count and
  persistence outcome. It contains no bank data or reusable session material.
  HTTP 207 means incomplete coverage; HTTP 502 means acquisition or persistence
  failure. A login challenge requires completing the bank's authentication
  separately; an explicit fresh browser session remains available as a fallback.
- Scheduled runs log only a run ID, status, artifact count and persistence
  outcome. A login or storage failure fails the scheduled invocation after
  recording safe acquisition failure evidence where storage is available.

The configured Processor route is `mizuho-bank` / `collector-mizuho-bank` in
`config/ingest-clients.json`. The existing idempotent bootstrap must be applied
to CORE as part of operational activation. No database migration is needed:
Mizuho already exists in the source catalog.

## Retained evidence and coverage

Passwords stay in Worker secrets; active cookies and form tokens remain in
invocation memory. Login response bodies are not evidence artifacts.
Only minimized UTF-8 account/history HTML is retained, using `sanitized_provider_capture` and
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
The latest published complete account list replaces current balance membership;
accounts absent from that list retain their transaction history without retaining
their old balances as current.

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
