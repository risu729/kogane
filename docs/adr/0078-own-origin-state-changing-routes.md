# ADR 0078: Refuse another site's Origin on the command and operations routes

- Status: accepted (merged 2026-11-08 in [#1071](https://github.com/risu729/kogane/pull/1071))
- Date: 2026-11-06 (rebased onto main 2026-11-07)
- Related: [ADR 0047](0047-mcp-client-connection.md) (the own-origin rule on
  every agent path), [ADR 0039](0039-alarm-schedule-management.md) (same-origin
  JSON and `x-kogane-settings` on the schedule settings writes),
  [change lifecycle](../change-lifecycle.md#http-contract),
  [operations API](../ops-api.md#authorization).

## Context

The App Worker has four state-changing surfaces reached by a browser session
of its own Access application:

| Surface                                                                            | Cross-site check before this ADR                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/mcp`, `/api/agent/v1/*`                                                          | `Origin` present and foreign → `403 origin_not_allowed` (0047)                              |
| `POST /api/ops/v1/schedules/*` (settings)                                          | `Origin` must equal the Worker's, plus `x-kogane-settings: 1` and `application/json` (0039) |
| `POST /api/command/v1/*` (plan … commit)                                           | none                                                                                        |
| `POST /api/ops/v1/*` (collections, replays, projections, imports, session refresh) | none                                                                                        |

The Worker trusts the `cf-access-jwt-assertion` header, which Cloudflare
Access derives from the browser's `CF_Authorization` cookie. Whether a
browser attaches that cookie to a request another site starts depends on the
cookie's `SameSite` attribute, an Access application setting that lives
outside this repository and that this repository does not check. The command
routes parse any body as JSON whatever its `Content-Type`, and the operations
routes do too, so a cross-site `<form method="post" enctype="text/plain">` —
a simple request with no CORS preflight — reaches them with a parseable body.
`approve` and `commit` accept a judgement; the operations routes start real
provider sessions. A security review found the gap; the tests added with this
ADR failed before the change (a cross-site `text/plain` commit was forwarded
to the Processor, a cross-site collection request was stored).

## Options considered

1. **Leave it to the Access cookie.** Rejected: the protection would depend on
   a dashboard setting nobody verifies here, and the agent and schedule routes
   already decided not to rely on it.
2. **Adopt the schedule rule (required same `Origin`, custom header, JSON
   media type).** Rejected for these routes: an operator's `curl` and the
   existing tests send no `Origin` and, for the operations routes, no
   `Content-Type`; requiring them would change a documented contract for
   non-browser callers without adding protection against a browser, which
   always sends `Origin` on a POST.
3. **Extend ADR 0047's own-origin rule.** An `Origin` that is present and not
   the Worker's own is `403 origin_not_allowed`. Every browser sends `Origin`
   on a POST, as `null` when the page withholds it (for example under
   `Referrer-Policy: no-referrer`) or from a sandboxed document, so another
   site cannot pass; a client that sends none is unaffected.

## Decision

Option 3. One function, `assertOwnOrigin` in `services/app/src/http.ts`, is
the rule on every agent path (unchanged behaviour), on every
`/api/command/v1/*` POST after the method and query checks and before the
flag, the grant and the body, and on every `/api/ops/v1/*` POST after the
query check and before the grant, the schema and the store. The refusal on a
catalogued command or operations route is recorded like any other refusal
(ADR 0064). The schedule settings writes keep their stricter rule. `GET`
routes are reads and are not changed.

## Consequences

- A cross-site page can no longer plan, approve, commit or request an
  operation through a signed-in browser, whatever the Access cookie's
  `SameSite` setting.
- The web client is unaffected: its requests are same-origin, so their
  `Origin` is the Worker's own.
- Non-browser callers (an operator's `curl`, tests) are unaffected because
  they send no `Origin`.
- Limit: a browser that sent no `Origin` on a cross-site POST would not be
  stopped by this rule. No current browser does; the media type is still not
  required on these routes.
- The rule protects a browser session only. An MCP client, which since
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) applies
  operations on `/mcp` as itself, already met the agent paths' rule there
  and sends no `Origin`; nothing about it changes.
- The bodies these routes read stay bounded in bytes before parsing
  (`boundedText`, `services/app/src/http.ts`); the origin check runs before
  that read on the command routes, and before the operations app reads its
  body.

## Verification

- `services/app/test/command-api.test.ts`: a foreign, `null` and look-alike
  `Origin` is `403 origin_not_allowed` on all five command paths with a
  `text/plain` body and nothing is forwarded; the Worker's own `Origin` and no
  `Origin` are forwarded.
- `services/app/test/ops-api.test.ts`: the same origins are refused on the
  collection, projection and session refresh routes and no `ops_requests` row
  is written; the Worker's own `Origin` is accepted.
- `services/app/test/audit.test.ts`: a foreign `Origin` on a command and an
  operations route is one `refused` record with the closed code
  `origin_not_allowed` under the catalogued operation, and nothing reaches
  the Processor or `ops_requests`.
- `services/app/test/mcp-client.test.ts` and `services/app/test/audit.test.ts`
  keep proving the agent paths' unchanged rule.
