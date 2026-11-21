# ADR 0130: Every 405 names what its route serves, and HEAD is GET without its body everywhere

- Status: proposed
- Date: 2026-11-21
- Tracking: the owner's request to "fix needless inconsistencies"
- Related: [ADR 0047](0047-mcp-client-connection.md) (`/mcp` is POST only),
  [ADR 0078](0078-own-origin-state-changing-routes.md) (the state-changing
  routes), [production evidence browser: methods](../production-evidence-browser.md#methods)

## Context

The App Worker (`services/app`) has two kinds of route. Reads answer `GET`;
writes (the change lifecycle, the agent routes and `/mcp`, the operations
requests, the schedules settings writes and the schedule bootstrap) answer
`POST`. Two things about methods were inconsistent:

1. Every `405 method_not_allowed` the Worker answered lacked the `Allow`
   header RFC 9110 §15.5.6 requires ("The origin server MUST generate an
   Allow header field in a 405 response"). `HttpError` carried a status, a
   code, refs and hints, and no header; each route threw
   `new HttpError(405, "method_not_allowed")` on its own. The test-only
   snapshot adapter alone set `Allow: GET, HEAD`, by hand.
2. `HEAD` was not served everywhere `GET` was. The Worker's GET-only
   boundary let `HEAD` through to every read, and `secureResponse` dropped
   the body, but three reads checked `GET` alone: the release postcheck's
   `GET /api/ops/v1/health` answered `HEAD` with 405; the operations API
   (`/api/ops/v1/*`, `OPS_API_ENABLED` on) admitted only `POST` and `GET`, so
   `HEAD /api/ops/v1/operations` was 405; and the schedules page let
   `HEAD /api/ops/v1/schedules` pass the operator check and then answered 405,
   while `HEAD ?detail=full` was `400 invalid_query` because only `GET` read
   the `detail` parameter. No document gave a reason for any of the three:
   the read routes' ADRs say "GET and HEAD only" (ADR 0055, 0058, 0073, 0075,
   0077, 0088), and `docs/evidence-browser.md` says any method other than
   `GET` or `HEAD` is refused.

## Options considered

1. **Set `Allow` at each route.** Each of the twenty-odd sites would write
   its own header into a response it does not build (errors are thrown and
   formatted once in `worker.ts`), and a new route could leave it out again.
2. **One error type that carries the allowed methods, written into the
   header by the one error formatter** (chosen). A route says which methods
   it serves; nothing else can forget the header.
3. **Leave `HEAD` refused on the three reads.** Nothing depends on the
   refusal: the release postcheck and the web client send `GET`, and no
   decision records `HEAD` as unwanted there. The refusal only makes those
   three routes differ from every other read.

## Decision

- `services/app/src/http.ts` defines `READ_METHODS` (`GET`, `HEAD`),
  `WRITE_METHODS` (`POST`), `MethodNotAllowed` (an `HttpError` with status
  405, code `method_not_allowed` and the allowed methods) and
  `assertMethod(request, allowed)`. Every 405 of the Worker is a
  `MethodNotAllowed`. `errorResponse` is the Worker's one error formatter
  (the `worker.ts` catch, and the test-only snapshot adapter's); it writes
  `Allow` from the error, and `secureResponse` keeps it beside the security
  headers.
- `Allow` names what the route serves: `GET, HEAD` on a read and on every
  path the GET-only boundary refuses (an unrouted path included, whose `GET`
  is 404); `POST` on a write and below the schedules page; under
  `/api/ops/v1` with the operations API on, `POST` on an acceptance route,
  `GET, HEAD` on a read, and all three on a path that is neither (each of
  them answers it 404).
- Every route that serves `GET` serves `HEAD` with the `GET`'s status and
  headers and no body: the health route, the operations reads (recorded in
  the audit log as the read they are) and the schedules page, `detail`
  included.
- Nothing else changes. Every other status and code stays: the caller is
  still proved before the method is checked (401 is 401 whatever the
  method), an operations path that does not take `GET` or `POST` is still
  404 for it, `POST` to the schedules page is still 404, and the schedule
  bootstrap keeps its order of checks.
- The local evidence browser (`experiments/observation-pipeline-local`),
  which refuses every method but `GET` and `HEAD` in one middleware, sends
  `Allow: GET, HEAD` on its 405 too.

## Consequences

- A client that receives 405 learns from the answer which method the route
  takes; the closed `{error, requestId}` body is unchanged.
- `HEAD` on the health route runs the same reads as its `GET` (one
  `SELECT 1` per database, one bucket `head`, one service-binding read). Who
  may call it is unchanged.
- Open limits, for the owner: an operations path that does not take a routed
  verb (`GET /api/ops/v1/collections`) and `POST /api/ops/v1/schedules` are
  404, while the change lifecycle and agent paths answer 405 for a verb they
  do not take; an unrouted path refused by a boundary is 405 rather than 404.
  This ADR keeps those statuses and only names the methods.

## Verification

- `services/app/test/method-contract.test.ts`: on every route family (the
  evidence browser, the observation reads, the shell, an unrouted path, the
  shared query, the audit log, the card settlement, purchase, reported and
  reconstructed state, readiness, pending decisions, changes, collection
  quality, identity, reports, rewards and events reads, health for the
  operator and for a probe token, the change lifecycle, the agent routes,
  `/mcp`, the operations acceptance and read routes with the flag on and
  off, an unrouted operations path, the schedules page, a job, maintenance
  and the bootstrap), each refused method is 405 with the exact `Allow` and
  the security headers; no other answer carries `Allow`; an unproved caller
  is 401 with no `Allow`; and on 24 reads (200s, 404s and 400s) `HEAD`
  answers the `GET`'s status and headers with no body. Before this change 43
  of its 61 checks fail.
- `experiments/observation-pipeline-local/test/api.test.ts`: each refused
  write method carries `Allow: GET, HEAD`.
