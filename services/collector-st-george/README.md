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
It is not a general proxy. A refused CONNECT is answered 403 and drained, and
every local CONNECT socket keeps an `error` listener, so Chrome resetting a
tunnel never ends the Container process (before 2026-11-08 a reset on a refused
CONNECT was an unhandled `read ECONNRESET`). On shutdown the proxy logs one
`st-george-container-relay-summary` line with CONNECT requests by outcome (`refused`,
`established`, `upstreamFailed`, `upstreamTimeout`, …) and `socketErrors` by
closed code, never a host. There is no automatic network switch or second login
attempt after a rejection. The shared Tamia tunnel and the user's WARP settings
are not reconfigured.

The container is destroyed in a `finally` block and has a 30-second idle sleep
fallback. A Durable Object serializes collection, records interrupted attempts,
and retains only a validated financial snapshot while its storage is incomplete.
A later trigger retries storing that same snapshot rather than logging in again.

A failed run keeps what the browser saw in its R2 manifest (`failures[0].diagnostic`,
2026-11-08 UTC), because Worker logs last only 7 days: the closed `stage`,
`errorType` and `refusal` labels, `loginPostCount`, `durationMs`, and `notices`,
the visible text of up to four alerts and headings (`[role=alert]`, `.error`,
then `h1`, `h2`) on the bank's page when the run stopped. Before a login is
submitted any page on the bank's origin is read, since nobody is logged in yet;
after a submit only the login page is read, because any other page may greet
the customer by name. The page itself is checked again inside the browser, so
a navigation in between cannot hand over another page. Each notice is bounded
to 160 characters, every run of numbers (any script, with spaces, dots,
slashes or hyphens between) becomes one `#`, and email-shaped words become
`[email]`; the container and the Worker both apply this, and the Worker drops
a diagnostic outside the closed shape (including a longer notice) without
failing the run. Form values are never read. The manifest keeps its
`collector_manifest` role, which the evidence registry treats as generated,
not provider content: a failed run has no provider artifact and is not
registered, so this text stays in the run's R2 objects. Exposing or sealing a
failed run's manifest must account for it.

When a collection failure is caught, the container attempts to emit one `st-george-runtime-failure` event with
`stage`, `errorType`, `refusal`, `loginPostCount`, `durationMs` and `noticeCount` (never the notice text). Stage and exception type
are closed labels; exception messages, stacks, URLs, provider text and credentials
are excluded. `loginPostCount` observes browser-issued requests to the known login
POST route: 0 means none observed, 1 means one, and 2 means two or more. It does not
prove bank receipt or acceptance. Logging failure cannot replace the collection
result or prevent cleanup. Public failure codes and the single-login policy are
unchanged; diagnostics do not clear a blocked run or authorize another attempt.
After reaching the known portfolio route, the collector allows up to 10 seconds
for visible account cards to render. Every observation retains the existing
route and challenge checks; this wait does not navigate or submit another login.
The closed `refusal` label distinguishes response inspection, unrecognized route
components, a route changing during inspection, a non-portfolio landing route,
and absent portfolio markers. The known login POST destination is labeled but
remains disallowed as a landing/read route. Other failures use `unknown`. No
rejected URL or provider text is emitted, and a route refusal alone does not
establish whether authentication succeeded or a challenge was displayed.

## Configuration and operations

Wrangler generates binding types. Secret names are declared in `env.d.ts`:

- `ST_GEORGE_CREDENTIAL_JSON`: JSON containing `userId`, `securityNumber` and
  `password`. Provision through the existing secret-management workflow; never
  place credentials in the repository, terminal arguments, reports or logs.
- `RELAY_TOKEN`: separate bearer token of at least 32 characters for the constrained TCP relay.

Non-secret settings are `COLLECTOR_SCHEMA_VERSION`, `EGRESS_MODE` and
`RELAY_PUBLIC_URL`. The configured daily schedule is 06:35 JST (`35 21 * * *`
in UTC), with platform retries disabled. The same durable coordinator serializes
manual and scheduled collection.

A refused, challenged or unrecognised login (`login-rejected`,
`authentication-challenge`, `human-required`, and `http-denied`,
`bank-request-error` and `unexpected-route`, none observed yet and each
possibly the bank's answer to a wrong password) **pauses** later logins,
because another unattended login could lock the account. There is no resume
step ([ADR 0069 amendment](../../docs/adr/0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08),
owner, 2026-11-08 03:57 UTC). The pause ends by itself in either case:

- the credential changed: the pause keeps a salted PBKDF2 digest of the parsed
  credential that was refused (never the credential), and the next alarm after
  `ST_GEORGE_CREDENTIAL_JSON` is updated logs in again;
- a collection is requested through the operations API
  (`POST /api/ops/v1/collections` or MCP `kogane.ops.collection.request`,
  source `st-george`): one login, at most once per 24 hours whoever asks. A
  second refusal pauses again.

An alarm skipped during a pause contacts nobody, reports no run and records
`st_george_paused_<reason>`. Every other failure (a browser or container
crash, a network error, a deadline) is a failed run and the next alarm tries
again. A block stored before 2026-11-08 is read as a pause without a digest; one
whose reason no longer pauses is lifted on the next run. A lease held by
another execution answers `busy` and records no run. An in-flight marker from
an object reset mid-attempt does not block: the lease outlives that attempt.

The Worker log records `st-george-collection-paused` (reason, run id,
`pausedSince`), `st-george-collection-skipped-paused` for each skipped alarm,
and `st-george-pause-lifted` with its `cause` (`credential-changed`,
`requested-collection` or `not-a-login-refusal`).

Enable this schedule only after authenticated cloud collection and downstream
publication have been verified.

`GET /health` reports service configuration without contacting the bank. It and
the relay's `/tcp` are the only public routes. Collection runs only from the
alarm and from operations-API requests, both over the private
`ScheduledCollection` binding under the same lease. The bearer routes
`POST /trigger` and `POST /resume` and their `ADMIN_TRIGGER_TOKEN` were removed
on 2026-11-08.

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
