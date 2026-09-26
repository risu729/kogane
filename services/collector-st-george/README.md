# St.George collector

This service promotes the St.George browser PoC into Kogane's existing collection,
shared DATA storage, and observation-processing path. It reads the authenticated
portfolio and the current history page of each observed account. It does not
import statements.

## Runtime

The Worker starts an isolated Chrome container and submits the normal bank login
form once using the configured credentials. It uses the bank's own field blur and
Logon button handling. Challenges, rejected requests and unfamiliar layouts stop
the run. It follows only the observed portfolio/account-details routes and never
submits payment, dispute, account-setting, export or history-filter forms.

The selected egress is fixed for the run:

- `tamia` (default): Chrome TLS travels through a container-local CONNECT proxy,
  this Worker's authenticated `/tcp` endpoint and the existing Tamia Tunnel.
- `direct`: Chrome uses the container's normal network path.

The relay allows only the bank and its observed login resource hosts on port 443.
It is not a general proxy. There is no automatic network switch or second login
attempt after a rejection. The shared Tamia tunnel and the user's WARP settings
are not reconfigured.

The container is destroyed in a `finally` block and has a 30-second idle sleep
fallback. A Durable Object serializes collection, records interrupted attempts,
and retains only a validated financial snapshot while its storage is incomplete.
A later trigger retries storing that same snapshot rather than logging in again.

## Configuration and operations

Wrangler generates binding types. Secret names are declared in `env.d.ts`:

- `ST_GEORGE_CREDENTIAL_JSON`: JSON containing `userId`, `securityNumber` and
  `password`. Provision through the existing secret-management workflow; never
  place credentials in the repository, terminal arguments, reports or logs.
- `ADMIN_TRIGGER_TOKEN`: bearer token of at least 32 characters for administrative operations.
- `RELAY_TOKEN`: separate bearer token of at least 32 characters for the constrained TCP relay.

Non-secret settings are `COLLECTOR_SCHEMA_VERSION`, `EGRESS_MODE` and
`RELAY_PUBLIC_URL`. The configured daily schedule is 06:35 JST (`35 21 * * *`
in UTC), with platform retries disabled. The same durable coordinator serializes
manual and scheduled collection. An authentication/network failure blocks later
runs until an operator resolves the cause and explicitly resumes collection.
Enable this schedule only after authenticated cloud collection and downstream
publication have been verified.

`GET /health` reports service configuration without contacting the bank.
Authenticated `POST /trigger` starts or resumes a collection/storage attempt.
Authenticated `POST /resume` clears a stopped authentication/network attempt;
it does not start collection or discard a snapshot awaiting storage. Call `/trigger`
after clearing the blocker. Treat resume as an explicit operator
decision after resolving the blocker. Neither route accepts account details or
credentials from a public request.

## Evidence and coverage

A validated `account-snapshot.json` is a minimized projection of provider DOM
fields. It preserves financial text while excluding scripts, URLs, hidden form
state, session cookies and login credentials. BSB/account-number identity is
replaced by a stable source-namespaced hash. The terminal records the sanitization
and extraction, with the original provider DOM unretained for security.

The service uses `packages/collection` to content-address artifacts and write the
terminal last. The existing Processor registers source `st-george` and applies
the versioned St.George parser to produce balance and transaction observations.
Only fixed status codes and counts enter operational responses.

History collection is a bounded snapshot. The canonical `#transaction-all`
table is used once, avoiding duplicate tables for alternate date tabs. Opening
and closing balance summary rows are distinguished from transactions. Debit and
credit direction comes from their respective columns. No provider transaction ID
was observed. The parser identifies repeated captures using a derived row
fingerprint and occurrence number, keeping identical legitimate rows separate.
This is not a provider identifier; changed provider text may produce a different
fingerprint. No pending/posted status is inferred. Populated pending rows,
pagination, custom date filters and complete historical coverage are unverified.
AUD is an explicit source configuration, not a currency label observed in the DOM.

## Validation

From the repository root:

```sh
mise run //services/collector-st-george:ci
mise run //services/collector-st-george:dry-run
```

Tests use synthetic data and local services. The separate PoC performed a real
normal login and guarded portfolio/account-details GETs on 2026-09-13. That
Windows browser succeeded after the user disconnected WARP. Later, with the
user's WARP reconnected, a public login-page GET from Tamia returned HTTP 200 with
the expected login controls. This establishes Tamia reachability; it does not by
itself prove the new Worker relay or cloud-container authentication.

See [source research](../../docs/sources/st-george.md) for the live evidence and
[the experiment](../../experiments/st-george-automation/README.md) for local CDP
diagnostics. Do not enable bank debugging, HAR, screenshots or raw body logging
when handling credentials.
