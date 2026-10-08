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
2. `ACCESS_MCP_AUDIENCE` names that application's AUD tag. On `/mcp`,
   `agentPrincipal` (`services/app/src/auth.ts`) verifies the assertion
   against the issuer and either audience; one whose `aud` is the MCP
   application's is the principal **`mcp-client:<sub>`**. An assertion for
   the browser application is its subject, exactly as before.
3. Fail-closed rules: `ACCESS_MCP_AUDIENCE` unset or empty means an
   MCP-application assertion is accepted nowhere (`401`); a value equal to
   `ACCESS_AUDIENCE`, longer than 256 characters or padded is
   `503 auth_not_configured` on `/mcp`; an assertion naming both audiences is
   `401`; every other route verifies against `ACCESS_AUDIENCE` only, so an
   MCP-application assertion is `401` there; a browser subject that claims the
   `mcp-client:` namespace is `403 actor_not_supported`; a service token is
   `401` on every agent path.
4. **Agent-only attenuation, server-side.** `mcp-client:<sub>` is graded only
   by its own `AGENT_API_GRANTS` entry — never by the bare subject's entry, as
   a fallback or otherwise. `principalFor` (`services/app/src/grants.ts`), the
   one gate behind `opsContext`, `callOpsTool`, the command routes and the
   operations routes, answers it `403 actor_not_supported` before reading
   `OPERATOR_SUBJECTS` or `AGENT_GRANTS`. The operations tools are neither
   listed nor callable for it (`unknown_tool`). The agent-API capability
   vocabulary has no acceptance, so at most it records an inert proposal
   whose actor is `mcp-client:<sub>`; there is no approve or commit tool.
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
remove the entry (or set `AGENT_API_GRANTS` to `""`), unset
`ACCESS_MCP_AUDIENCE`, or remove the person from the MCP application's policy;
Access re-evaluates the policy at the next token refresh.

## Consequences

- With `ACCESS_MCP_AUDIENCE` unset and the grants empty, which is the
  committed state, the change opens nothing: the browser application, its
  audience and every operator route behave as before.
- Every MCP client a person connects (claude.ai, ChatGPT, Codex) is the same
  principal `mcp-client:<sub>`. Separating them needs separate Access
  identities.
- The operator's existing path — the browser application's audience on
  `/mcp`, with the operations tools — is unchanged. Once the MCP application
  covers `/mcp`, Access routes that path through it, so in practice every
  `/mcp` caller is agent-only.
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
  - whether claude.ai accepts tool names with dots (the 2025-11-25 naming
    guidance allows them).

## Verification

In this repository, with synthetic keys, audiences, principals and store,
over the real Worker under workerd:

- `services/app/test/mcp-client.test.ts` (23 tests): the initialize →
  `notifications/initialized` → `tools/list` → `tools/call` sequence and
  version negotiation through the SDK; `server/discover`, `tools/list` and
  `tools/call` on 2026-07-28 with the same answer as 2025-11-25; GET/DELETE
  `405`; `Origin`; a `tools/call` notification running nothing; the SDK's
  `415`/`406`/`400`/`413`; `-32601`/`-32602`; tool definitions against the
  SEP-986 names and Claude Code's load-time checks; the attenuation under a
  hostile configuration (the same person as operator, with a full grant on
  the bare subject and the agent-only name listed on the command path):
  graded only by its own entry, no fallback, no operations tool listed or
  callable and no `ops_requests` row, `principalFor`, `opsContext` and
  `callOpsTool` each refusing it for three list configurations, `401` on ten
  non-MCP routes, the proposal actor pinned, and the fail-closed audience
  rules; `tools/list` and `tools/call` under each single capability; scope,
  raw-evidence and budget refusals; and the UI's query route, the HTTP agent
  route and MCP in both eras returning deep-equal objects with the same gap
  reasons for four intents, and one refusal object over HTTP and MCP.
- `test/agent-api.test.ts`, `test/ops-api.test.ts`,
  `test/purchases-explain.test.ts` and `test/health.test.ts` pass with MCP
  requests that carry a real client's headers and `initialize` parameters.

Not verified: no Access application, Managed OAuth setting, policy, client
registration or MCP client against a deployment; the gaps above; and the
JSON Schema 2020-12 meta-schema check Claude Code also runs. The owner's
ordered steps and live checks are in
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
