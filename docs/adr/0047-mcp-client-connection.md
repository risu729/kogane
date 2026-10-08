# ADR 0047: Connect MCP clients through Cloudflare Access Managed OAuth, as an agent-only principal

- Status: proposed
- Date: 2026-10-08
- Issue: #559 (part of)

## Context

The agent API (`docs/agent-api.md`) answers query, explain and proposal tools
over HTTP and over `POST /mcp`, and grades every call by an
`AGENT_API_GRANTS` entry for the verified principal. No MCP client has ever
connected. The owner fixed the target clients — **claude.ai custom
connectors** (the same connector serves Claude Desktop and mobile) and
**ChatGPT** apps in developer mode together with the **Codex** MCP client —
and two constraints: authentication is delegated to Cloudflare (no OAuth
server, login, token issuance or key handling in this repository), and a
maintained protocol library is preferred over hand-written protocol code.

What the clients present, from their current documentation (read
2026-10-08):

| Client                                                                                                              | Authentication                                                                                                                        | Client registration                                                                                                        | Redirect URI                                                                                                                                                                  | Other requirements                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude.ai / Claude Desktop custom connector ([authentication][claude-auth], [custom connectors][claude-connectors]) | OAuth 2.0 authorization code with PKCE `S256`; "No sign-in"; static request headers only as a beta for a limited set of organisations | CIMD when the authorization server advertises it, else DCR (`registration_endpoint`), else a client ID entered by the user | `https://claude.ai/api/mcp/auth_callback`                                                                                                                                     | `401` with `WWW-Authenticate: Bearer resource_metadata=…` (or the well-known paths); the metadata's `resource` must equal the URL the user enters; `authorization_servers[0]` is used; no `client_credentials` grant; requests come from `160.79.104.0/21` |
| ChatGPT (developer mode apps) ([authentication][openai-auth])                                                       | OAuth 2.1 authorization code with PKCE `S256`, or no authentication                                                                   | CIMD, DCR (once per connection) or a predefined client                                                                     | `https://chatgpt.com/connector_platform_oauth_redirect` when the authorization server returns `iss` (RFC 9207), otherwise `https://chatgpt.com/connector/oauth/{callback_id}` | sends `resource` on authorization and token requests; `code_challenge_methods_supported` must list `S256`; no machine-to-machine grants                                                                                                                    |
| Codex (CLI, IDE extension, ChatGPT desktop app) ([MCP][codex-mcp])                                                  | OAuth via `codex mcp login`, or a bearer token / static headers from `config.toml`                                                    | CIMD when supported, else DCR, or a configured client ID                                                                   | a local callback listener (`mcp_oauth_callback_port`)                                                                                                                         | streamable HTTP `url`                                                                                                                                                                                                                                      |
| Claude Code ([MCP][cc-mcp])                                                                                         | OAuth, static headers, `headersHelper`                                                                                                | its own CIMD, else DCR                                                                                                     | loopback on any port (`localhost`, `127.0.0.1`)                                                                                                                               | v2 runtime asks HTTP servers for revision 2026-07-28                                                                                                                                                                                                       |

So both target clients need an OAuth 2.1 authorization server with PKCE,
discovery and dynamic (or metadata-document) client registration in front of
`/mcp`, and neither can use a machine credential.

Cloudflare Access offers exactly that as **Managed OAuth**
([Managed OAuth][cf-managed-oauth]): on a self-hosted Access application it
answers non-browser requests with `401` and a `WWW-Authenticate` header
pointing at its OAuth discovery metadata (RFC 8414, RFC 9728), runs the
authorization code flow against the configured identity provider under "the
same policies as a browser login", supports DCR with an allow-list of
redirect URIs (`https`, a path may end in `/*`) and toggles for localhost and
loopback clients, needs a client that supports RFC 8707, issues opaque access
tokens (default lifetime 15 minutes, a grant session for refresh), re-evaluates
policies on every refresh, and forwards a signed `Cf-Access-Jwt-Assertion` to
the origin so that "the request looks like a browser-authenticated one". The
MCP server must validate that assertion.

Three facts from this repository and the owner decide how the Worker may
read that assertion:

1. **An MCP caller could be re-classified as the operator.** `/mcp` →
   `callOpsTool` → `opsContext` → `principalFor` grades the bare subject. If
   the operator's own subject reached `/mcp` with an `AGENT_API_GRANTS` entry,
   the operations tools would act with the operator's capability; listing the
   same subject in `AGENT_GRANTS` as well makes the command lists overlap and
   every command surface answers `503 grants_misconfigured` (owner's audit).
2. Managed OAuth forwards the identity of whoever signed in — in practice the
   owner, who is the operator — in an assertion indistinguishable from a
   browser session's **except by its audience**: each Access application has
   its own AUD tag, carried in the signed `aud` claim.
3. The owner reports the existing browser application requires a device
   posture, has no OAuth configuration and no MCP portal, and that
   `AGENT_API_GRANTS` and `AGENT_GRANTS` are empty. None of this may be
   weakened, and no setting is approved yet.
4. **Context metadata was computed outside the grant.** The independent
   review of an earlier head of this change found that `contextInputs`
   (`services/app/src/agent-service.ts`) built every context from the whole
   store: a grant limited to one source received a context whose
   `sourceSelectionManifestRef` named every source, and whose publication
   and parser digests moved when a source outside the grant published. The
   result data, coverage and gaps were already scoped; the context was not.

The current MCP revision is 2026-07-28 ([versioning][mcp-versioning]),
stateless, with `server/discover` and per-request versions; the clients above
also speak the initialize-based revisions.

## Options considered

Authentication and identity:

1. **An OAuth authorization server in the Worker.** Rejected: the owner's
   constraint, and the whole token lifecycle would become this repository's
   security surface.
2. **Cloudflare MCP server portals** ([portals][cf-portals]). Rejected: a
   portal authenticates the client to itself and reaches the upstream server
   with a portal-held credential or a separate upstream OAuth; the page
   documents no Access assertion or per-user identity forwarded upstream (only
   `X-Forwarded-User-Agent`, "not for authentication or authorization"), so
   the Worker could not grade the caller. It also needs an active Cloudflare
   zone for the portal and does not support device authentication.
3. **An Access service token in two custom headers.** Rejected as the client
   path: a service token carries no `sub` ([application token][cf-app-token]),
   claude.ai's static headers are a limited beta with an allow-listed set of
   header names, ChatGPT has no static-header option, and the owner ruled it
   out. A first pass of this change mapped it to a principal; that commit was
   dropped and a service token is still refused on every agent path.
4. **Managed OAuth on the existing browser application.** Rejected: its
   assertions would carry the browser application's audience, so the Worker
   could not tell an MCP client from the operator's browser; it would change
   the `401` behaviour of the operator's application and require its device
   posture policy to admit requests from the clients' clouds.
5. **Managed OAuth on a dedicated Access application for the MCP endpoint,
   whose audience the Worker binds to an agent-only principal.** Selected.

Protocol library ([Streamable HTTP][mcp-transport]):

1. **Keep the hand-rolled JSON-RPC transport.** Rejected: generic protocol
   code the owner asked to replace, and it could not serve 2026-07-28.
2. **Cloudflare `agents` (`McpAgent`).** Rejected: it serves through a Durable
   Object (a new class and migration for a stateless endpoint), is versioned
   0.x with weekly releases, and lists a large peer set (AI SDKs, React,
   Vite, payment SDKs).
3. **`@modelcontextprotocol/sdk` 1.x.** Rejected: its dependencies are the
   Node stack (Express, `cors`, `raw-body`, `ajv`, `cross-spawn`), and it does
   not serve 2026-07-28.
4. **`@modelcontextprotocol/server` 2.x**, the official TypeScript SDK's
   stable line. Selected: Apache-2.0; dependencies `zod` ^4.2 (already this
   Worker's) and `@modelcontextprotocol/core`; a `workerd` export condition
   that bundles the `@cfworker/json-schema` validator (no `ajv`, no code
   generation); web-standard `Request`/`Response`; one server definition
   serving both eras. Cost: the SDK minifies to about 226 KB (56 KB gzip,
   esbuild with `zod` external), and the App's dry-run bundle is 1842 KiB /
   361 KiB gzip with it. Maintenance risk: 2.0.0 shipped on 2026-07-27 and
   2.3.1 on 2026-10-05, so the line is young and moves fast; it is pinned
   exactly and updated by Renovate.

Tool list: filter `tools/list` by capability, or keep it per deployment.
Kept per deployment: `kogane.capabilities` describes the principal and every
call is graded on its own, with a closed reason.

## Decision

**Cloudflare authenticates; the Worker only verifies and attenuates.**

1. The MCP endpoint gets its own self-hosted Access application (covering
   `/mcp` of the App's hostname, or a dedicated hostname routed to this
   Worker) with Managed OAuth on, an identity-based policy for the people
   allowed to use an MCP client, and DCR redirect URIs for the clients. The
   browser application is not changed.
2. **Two audiences, never crossed.** `ACCESS_MCP_AUDIENCE` names that
   application's AUD tag. `/mcp` accepts only an assertion for it
   (`mcpCaller`, `services/app/src/auth.ts`); an assertion for the browser
   application, one naming both audiences, one without a subject (a service
   token) and one whose subject claims the agent-only namespace are
   `401 authentication_required` there. Every other route accepts only the
   browser application (`accessIdentity`, `authenticate`) and refuses an
   assertion that names the MCP audience. `ACCESS_MCP_AUDIENCE` unset or
   empty — the committed state — means `/mcp` accepts nothing (`401`); a value
   equal to `ACCESS_AUDIENCE`, padded or over 256 characters is
   `503 auth_not_configured` on `/mcp` and is ignored by the browser routes.
3. **An attenuated caller object, decided once.** The boundary builds an
   `AgentCaller`: `{ kind: "mcp-client", principal: "mcp-client:<sub>" }` on
   `/mcp`, `{ kind: "browser", principal: <sub> }` on `/api/agent/v1/*`. That
   object — not the subject it came from — is what `agentApi` grades and
   hands to every tool. Whoever signed in through the MCP application, the
   operator included, is agent-only:
   - its grant is the `AGENT_API_GRANTS` entry for `mcp-client:<sub>`, and
     the bare subject's entry is never a fallback;
   - `callOpsTool` receives the caller object and refuses an `mcp-client`
     caller with `403 actor_not_supported` before `opsContext` or
     `principalFor` runs, and the operations tools are not published on
     `/mcp`; `principalFor` also refuses the `mcp-client:` name as a string,
     whatever `OPERATOR_SUBJECTS` and `AGENT_GRANTS` say;
   - it reaches no route but `/mcp`;
   - the agent-API capability vocabulary has no acceptance, so at most it
     records an inert proposal whose actor is `mcp-client:<sub>`.
     The operations remain the operator's over the browser routes. Requesting
     one over MCP, which an operator subject could do before this change, is no
     longer possible for anyone.
4. **Contexts are built inside the grant.** `contextInputs` restricts the
   visible sources to the granted ones and, for a listed grant, reads the
   publication high-water and the parser builds from the newest visible
   parse runs of those sources only (the read model's `visibleEvidence`
   relation and page limit, filtered by source before it is bounded). A
   whole-store grant — the browser reader's — keeps the overview's window,
   so the UI and agent answers stay identical.
5. The transport is `@modelcontextprotocol/server` 2.3.1: a request of an
   initialize-based revision goes to the SDK's stateless
   `WebStandardStreamableHTTPServerTransport` in JSON mode, a 2026-07-28
   request to `createMcpHandler` in JSON mode, both from one server definition
   that answers `tools/list` and `tools/call` through the existing dispatcher.
   The Worker keeps its own `Origin` rule (`403 origin_not_allowed` on every
   agent path) and the agent API's 64 KiB body bound; GET and DELETE are `405`.

The first grant is `summary.read` on one listed source for
`mcp-client:<owner sub>`; `records.read`, then `interpretation.propose`, one
release at a time; `evidence.read` only by a separate decision. Revocation:
remove the person from the MCP application's policy, unset
`ACCESS_MCP_AUDIENCE`, or remove the grant entry (or set `AGENT_API_GRANTS`
to `""`).

## Consequences

- With `ACCESS_MCP_AUDIENCE` unset and the grants empty, which is the
  committed state, `/mcp` accepts no caller at all and every other route
  behaves as before: the browser application, its audience and the
  operator's routes are unchanged.
- Every MCP client a person connects (claude.ai, ChatGPT, Codex) is the same
  principal `mcp-client:<sub>`. Separating them needs separate Access
  identities.
- The operations MCP tools of [ops-api.md](../ops-api.md#mcp) are no longer
  served to anyone: `/mcp` has no operator caller. Operations are requested
  over the browser routes.
- A listed grant's context costs one more bounded read per tool call (the
  scoped parse-run window). An account-scoped grant still shares its
  sources' publication digest with the accounts it cannot see: parse runs are
  per source, not per account.
- A client of only the 2026-07-28 revision can connect.
- Gaps the documentation does not settle (each is an owner question, not a
  reason for code):
  - whether the protected-resource metadata Access serves names a `resource`
    equal to the MCP URL including its path, which claude.ai requires;
  - whether Access advertises CIMD (if not, both clients fall back to DCR)
    and returns `iss` (if not, ChatGPT uses the per-callback redirect URI,
    which must then be allowed);
  - whether a path-scoped application on the App's hostname can serve the
    Managed OAuth well-known endpoints, or a dedicated hostname is needed;
  - which claims the forwarded assertion carries — the Worker requires `sub`
    and refuses without it;
  - that the MCP application's policy cannot require the browser
    application's device posture, because the clients call from their own
    clouds;
  - whether claude.ai and ChatGPT accept tool names with dots (the
    2025-11-25 naming guidance allows them).

## Verification

In this repository, with synthetic keys, audiences, principals and store,
over the real Worker under workerd. The earlier passing MCP tests were not
evidence of the boundary — they never presented an MCP-audience token, never
had the same person as operator and MCP client, and never inspected context
metadata — so the boundary has its own tests:

- `services/app/test/mcp-client.test.ts`:
  - _the same person_ (matrix 1): the operator, with a full grant on the bare
    subject and the agent-only name even listed in `AGENT_GRANTS`, is
    `mcp-client:<sub>` with only that entry's grant on `/mcp`, keeps the
    operator's answers on the HTTP agent route, the operations route and the
    browser reads, is offered no operations tool and is refused each one
    (`actor_not_supported`, no `ops_requests` row), and `callOpsTool`,
    `opsContext` and `principalFor` refuse it for three list configurations;
  - _no cross-over_ (matrix 2, 3): an MCP-audience token — alone or together
    with the browser audience — is `401` on the command routes (plan,
    approve, commit), the card settlement and card purchase routes, the
    operations routes and health, the browser reads, the shared query, raw
    evidence, the HTTP agent routes and the assets; `/mcp` refuses the
    browser audience, both audiences, another audience, another issuer, an
    expired or forged assertion, a service token through either application,
    an agent-only subject and spoofed identity headers; the audience
    configuration fails closed and never takes the browser routes down;
  - _the grant_ (matrix 4): absent, empty, unparsable, mis-shaped, carrying
    a capability outside the vocabulary, only the bare subject's, or
    another person's — `403 agent_api_not_configured` for list and call;
  - _limits_ (matrix 5): source, account and budget refusals on reads and
    proposals;
  - _metadata_ (matrix 6): for a listed grant, the whole answer of every tool
    — context, manifests, digests, counts, errors — never names the denied
    source, its account or its source account, `sourceSelectionManifestRef`
    is exactly the granted source, a denied source's new publication by a new
    parser build leaves the scoped context identical while the whole-store
    context moves, and the scoped context moves with its own source;
  - _actor and adopted state_ (matrix 7): a body that names an actor is
    refused and writes nothing, an identity header is ignored, the stored
    actor is `mcp-client:<sub>`, and every adopted answer is identical before
    and after a proposal;
  - _unpublished tools_ (matrix 8): `-32602` and nothing written;
  - the connection in both eras, `Origin`, the SDK's refusals, tool
    definitions against the SEP-986 names and Claude Code's load-time checks,
    `tools/list` and `tools/call` under each single capability, and the UI's
    query route, the HTTP agent route and MCP in both eras returning
    deep-equal objects with the same gap reasons.
- `services/app/test/mcp-sdk-client.test.ts` (matrix 9): the official
  `@modelcontextprotocol/client` (2.3.1, a test dependency) connects, lists
  and calls the tools in `legacy` mode (2025-11-25) and in `auto` mode
  (2026-07-28), sees a refusal as a tool error, and cannot connect without a
  grant or with a browser-audience token.
- `test/agent-api.test.ts`, `test/ops-api.test.ts` (whose MCP block now pins
  that no operation is published or accepted on `/mcp` while HTTP still
  serves the operator), `test/purchases-explain.test.ts` and
  `test/health.test.ts` pass with MCP requests signed for the MCP
  application.

Not verified (matrix 10, owner-executed): no Access application, Managed
OAuth setting, policy, client registration or MCP client against a
deployment; the gaps above; and the JSON Schema 2020-12 meta-schema check
Claude Code also runs. The owner's ordered steps, live checks and what
counts as evidence are in
[agent-api.md](../agent-api.md#connecting-an-mcp-client).

[cf-managed-oauth]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
[cf-portals]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
[cf-app-token]: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/
[claude-auth]: https://claude.com/docs/connectors/building/authentication
[claude-connectors]: https://claude.com/docs/connectors/custom/add-unlisted
[openai-auth]: https://developers.openai.com/plugins/build/auth
[codex-mcp]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[cc-mcp]: https://code.claude.com/docs/en/mcp
[mcp-versioning]: https://modelcontextprotocol.io/specification/versioning
[mcp-transport]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
