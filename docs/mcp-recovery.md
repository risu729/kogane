# Recovering an existing Kogane MCP connection

Type: operational runbook. Checked: 2026-11-04 against main `033d3ce`.
Landed on main on 2026-11-06 from closed
[#887](https://github.com/risu729/kogane/pull/887) without a new connection
check, so every observation below is as of 2026-11-04.
Related: [#684](https://github.com/risu729/kogane/issues/684),
[#559](https://github.com/risu729/kogane/issues/559),
[client connection design](agent-api.md#connecting-an-mcp-client).

## Identify the failing layer

Tool definitions in a chat may be cached. Their presence does not prove a live
`tools/list`, successful authentication or Worker health. The host error
`UNAUTHORIZED` with "This app connection requires reauthentication. Reconnect
the app and try again." means the stored app connection needs attention. The
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

## Portal upstream credential and per-user authentication

An earlier read-only Cloudflare MCP-server readback on 2026-11-04 identified the
Kogane upstream selected by the portal and returned:

| Field                                     | Observed value                                             |
| ----------------------------------------- | ---------------------------------------------------------- |
| Server status / authentication status     | `stale` / `stale`                                          |
| Error                                     | `Authorization failed: needs_reauth`                       |
| Error details                             | `status_code: 401`, `retryable: true`, `is_upstream: true` |
| Cause                                     | `Preemptively needs reauth`                                |
| Last sync (reported timestamp)            | `2026-11-04 11:01:20`                                      |
| Last successful sync (reported timestamp) | `2026-10-10 17:26:41`                                      |

This is evidence of an upstream authorization/synchronization problem. The
preemptive cause does not prove that this failed attempt reached the Kogane
Worker, and the two sync timestamps do not establish when a client last read
data successfully. No credential value or identity is recorded here.

Cloudflare's [portal guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#reauthenticate-the-mcp-server)
provides a separate **administrator credential** recovery route: in the
Cloudflare dashboard, open **Zero Trust > Access controls > MCP Portals**,
then **MCP servers**, find the existing Kogane server and choose its three-dot
menu's **Re-authenticate server** action. The owner completes upstream OAuth;
the account used becomes that server's new admin credential.

Admin synchronization and per-user OAuth are distinct. Cloudflare documents
that a stale admin credential may coexist with working per-user tokens when
**Require user auth** is enabled. Repairing the admin credential therefore
requires a server-state readback and does not prove the active plugin's user
connection works. Recheck both layers: server sync status, then the limited
client calls below. Changing the portal's user-auth mode, policy or grants is
not a substitute for either authentication flow.

## Authorized server reauthentication attempt — 2026-11-04

The owner authorized server reauthentication and checking its email one-time
code. Two attempts used the Cloudflare dashboard's existing server recovery
flow in Chrome. The Access page displayed `Log in to Kogane MCP origin`.
After the authorized policy email was entered and `Send login code` selected,
both attempts immediately showed `Unable to find your Access application!`
with an invalid-URL explanation, before reaching the OTP step. The second
attempt reproduced promptly; expiration of a long-idle page does not explain
that observation. No email address, one-time code, login URL or OAuth state is
recorded here. No completed authentication or new token was confirmed.

At **11:56 UTC** the server readback was `status: waiting`,
`authentication_status: required`, with an empty error field. Its last-sync
and last-successful-sync timestamps were unchanged from the earlier table.
`waiting` is not recovery: authenticated tools and refresh remain unverified.

Read-only configuration checks found the expected self-hosted origin
application/domain/audience, Managed OAuth and DCR enabled, and the current
dashboard callback in the allowed redirect list. The origin owner's policy
still requires the **Gateway** device-posture check. The local One Client was
connected and reported an unstable network. The app's
`allow_authenticate_via_warp` field was absent and the organization setting was
true; Cloudflare's [API contract](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/)
distinguishes this authentication setting from a policy's posture requirement.
These read-only checks changed no policy, posture, redirect, grant or network
setting.

An explicitly authorized, origin-application-only trial set
`allow_authenticate_via_warp: false` at **11:58 UTC**, preserving the existing
owner-email allow rule, required Gateway posture and Managed OAuth settings.
At approximately **12:02 UTC**, selecting `Send login code` again produced
the same Access-application error before the OTP step. This trial did not
complete code verification, token issuance or an authenticated MCP read.

At **12:03:25 UTC**, the original omission of that application property was
restored with an update. A subsequent readback confirmed the property was
absent again, the OAuth configuration was identical, and the owner-email and
Gateway posture requirements were unchanged. The trial's explicit `false` value is no longer configured. The failed trial leaves the proposed WARP/authentication-flow
cause unproven: setting this flag alone did not recover the observed flow.
No successful server reauthentication, code verification or client read is
inferred from completing the configuration rollback.

A later authorized diagnostic briefly disconnected WARP while starting a
fresh dashboard authentication flow, with a timed reconnect safeguard. WARP
was reconnected before selecting `Send login code`. The fresh flow's safe
flags were `is_warp: false`, `is_gateway: false`, with `private_app_flow`
absent. This time the form advanced to code entry instead of the
Access-application error. No new code appeared in the checked inbox after
approximately two minutes, and the queried Access-log window from 12:00 UTC
contained no matching Kogane event. Neither successful code delivery nor
verification was established. A policy-related refusal is a hypothesis, not
an observed cause. WARP was connected afterward; the original application
property omission and the required Gateway policy were preserved.

A separately authorized, bounded policy trial ran from **12:14:28 UTC** to
**12:16:42 UTC** (two minutes, fourteen seconds). It temporarily removed the
origin owner's required Gateway condition while retaining the exact owner
email allow rule. Authentication was started while WARP was disconnected,
and WARP was reconnected before requesting the code. The page reached code
entry, but no new code appeared in the checked inbox; one resend after about
ninety seconds did not establish delivery or authentication success.

The original policy was restored at **12:16:42 UTC**. Readback confirmed the
Gateway requirement and owner-only rule were present, the app's WARP-auth
property was absent, and OAuth configuration was identical. The automatic
rollback safeguard was stopped only after the manual restore succeeded and
was verified. No successful code verification or MCP read resulted. The
required Gateway restriction is present in the restored configuration.

A type-only application trial ran from **12:17:39 UTC** to **12:18:52 UTC**.
The API accepted `type: mcp` on the existing application while retaining its
public hostname-root destination, audience, owner-plus-Gateway policy and
OAuth configuration. A fresh authentication flow with WARP connected still
failed with the same Access-application error. The application was restored
to `self_hosted`; readback confirmed the original audience, property omission,
owner-plus-Gateway policy and OAuth configuration. This experiment supplied
no successful code verification or authenticated MCP read.

At approximately **12:25 UTC**, the preceding 24 hours of receiving email-routing
activity showed only two Cloudflare OTP messages, at 11:20 and 11:21, both
forwarded. No later trial message was found in that routing activity or the
checked Gmail inbox. Routing was ready, catch-all forwarding was configured,
and the queried suppression list was empty. These receiving-side observations
do not identify a sender-side suppression or the precise delivery failure.

The [Mikoto investigation](https://github.com/risu729/mikoto/issues/123)
records a similar Managed OAuth/private-flow failure. Its merged
[PR #143](https://github.com/risu729/mikoto/pull/143) moved the MCP handler to
the hostname root and replaced a path-scoped Protected MCP server record.
Kogane's origin Access destination already covers its hostname root. Mikoto's
later merged [PR #222](https://github.com/risu729/mikoto/pull/222) records that
the WARP-connected login failure persisted with separate hostnames, a root
handler and `allow_authenticate_via_warp: false`; it also removed a redundant
WARP-requiring policy attachment from Mikoto's MCP application. Mikoto's
identity-only MCP policy differs from Kogane's required Gateway policy.
No proven workaround preserving Kogane's policy was found in that evidence.
The current state remains **reauthentication required**, with no successful
end-to-end recovery.

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
`authentication_required`, `delegation_not_mcp_client`,
`delegation_not_configured` or `delegation_misconfigured` (and, before
ADR 0084, `agent_api_not_configured` and `source_not_granted`) require their own evidence; they are not equivalent
to the host's `UNAUTHORIZED` error. Gather only timestamps, HTTP/closed codes
and whether discovery or a live tool call succeeded before changing anything.
