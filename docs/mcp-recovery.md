# Recovering an existing Kogane MCP connection

Type: operational runbook. Checked: 2026-11-04 against main `033d3ce`.
Related: [#684](https://github.com/risu729/kogane/issues/684),
[#559](https://github.com/risu729/kogane/issues/559),
[client connection design](agent-api.md#connecting-an-mcp-client).

## Identify the failing layer

Tool definitions in a chat may be cached. Their presence does not prove a live
`tools/list`, successful authentication or Worker health. The host error
`UNAUTHORIZED` with “This app connection requires reauthentication. Reconnect
the app and try again.” means the stored app connection needs attention. The
older #684 observation also carried `oauth_token_invalid_grant` and
`TRIGGER_REAUTHENTICATION`; those fields were absent from this check. Neither
response identifies the token failure's cause or proves a Kogane outage.

On 2026-11-04, the portal server-list call and `kogane.context.open` with
`{"query":{"intent":"coverage","limit":1}}` each returned that host error.
After the owner reported reconnection, one ordered retry of those same two
calls still returned it in the active chat. No authenticated financial payload
was obtained; no delegated write was attempted. It is unknown whether the active chat retained
old connection state, another connection was refreshed, or refresh still failed.

An unauthenticated POST to `https://kogane-mcp.takuk.me/mcp` at 11:20 UTC
returned HTTP 401 and a `WWW-Authenticate` challenge naming
`https://kogane-mcp.takuk.me/.well-known/cloudflare-access-protected-resource/mcp`.
That public metadata returned the exact `/mcp` resource and a Cloudflare Access
authorization server. Its authorization metadata advertised authorization-code
and refresh grants, dynamic client registration and PKCE `S256`. This proves
public discovery was reachable at that time; it does not prove the Worker,
an authenticated client, token refresh or the granted data path worked.

An earlier [read-only client record](https://github.com/risu729/kogane/issues/560#issuecomment-6092608233)
reported successful capabilities, context and coverage calls on 2026-10-10.
That dated success does not establish the current stored connection, refresh
or any delegated operation. Preserve both records rather than treating the
current failure as evidence that MCP has never worked.

## Reconnect the same client connection

For the installed ChatGPT/Codex **plugin**, use the host's existing connection
flow. In the same account and workspace, open **Plugins** (or **Apps** where
that label is shown), open Kogane's details, review its **Apps** section and
select the affected connected account. Follow the displayed Connect/Reconnect
or expired-connection prompt. The owner completes Cloudflare authentication
and any required identity or posture check. If no recovery action is shown,
record that fact and the host version; do not invent a reconnect URL or remove
the plugin to force a new grant.

The current [OpenAI plugin guide](https://learn.chatgpt.com/docs/plugins) and
[app discovery guidance](https://learn.chatgpt.com/docs/build-plugins) describe
the plugin details, Apps section and connection prompts. They do not establish
an exact Reconnect menu location for every desktop version. The error itself
provides no handoff URL. Do not treat a CLI server login as a repair of this
plugin's separate stored connection.

For a **directly configured Codex MCP server**, use that client's normal OAuth
login for its existing server entry, as described in the
[connection table](agent-api.md#which-client-connects-and-how). This is a
separate client path and requires owner authentication. Do not create new
Access resources, change grant/delegation configuration, relax posture checks,
copy browser cookies or inspect stored credentials as a reconnect shortcut.

## Verify recovery in order

1. After the owner completes the host flow, retry the portal server list once,
   then `kogane.context.open` with coverage and `limit: 1`. If both still report
   reauthentication, stop repeated calls and use a fresh chat with the same
   installed connection. A new chat is a diagnostic, not evidence of recovery.
2. Verify live `tools/list` in the client when it exposes that diagnostic;
   cached schemas and portal status are not substitutes. Record explicitly
   when this check is unavailable.
3. Call `kogane.capabilities` and the small coverage read. Inspect the expected
   principal, capabilities, scope and budget privately, recording only the
   match status, shape, counts, completeness and closed reasons. Keep tokens,
   principal/source/account identifiers and financial values out of records.
4. Check a new client session and subsequent normal OAuth refresh separately.
   One successful call does not prove refresh or future sessions.
5. Preserve any partial/unavailable coverage and its reasons. Read success
   does not prove complete collection, accurate financial state, hosted
   delegated execution or a permitted write. #559/#560 remain separate gates.

If recovery fails, distinguish host connection state, upstream portal OAuth,
Access authorization and Kogane grant refusals. Worker refusals such as
`authentication_required`, `agent_api_not_configured`, `source_not_granted` or
`delegation_not_configured` require their own evidence; they are not equivalent
to the host's `UNAUTHORIZED` error. Gather only timestamps, HTTP/closed codes
and whether discovery or a live tool call succeeded before changing anything.
