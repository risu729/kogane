# Authenticated Collectors

This document records the execution and network design for sources whose
authenticated JSON APIs can be replayed without rendering their UI. Vpass is
the first example. Its login bootstrap and its post-login JSON collection are
separate capabilities: the former currently requires an established Windows
Chrome profile, while the latter has been replayed successfully from Linux
Chrome after importing a valid session.

This is a design and proof-of-concept track, not a promise that an unofficial
provider API will remain stable. A collector must stop on authentication or
anti-bot errors and must never retry a login rapidly.

## Vpass baseline

The JSON PoC and the full 2026-08-26 experiment matrix are tracked in
[PR #3](https://github.com/risu729/kogane/pull/3). Once an authenticated
session exists, the collection flow is:

1. Import and validate a source-scoped session envelope.
2. Enumerate cards with `dropdownlist_init/v1` and select one with
   `operation_card_update/v1`.
3. Call `web_meisai_top/v1` with empty content and read
   `seikyuYMList` / `comSeikyuYMList`. These are the available months; do not
   probe a guessed range.
4. Call `web_meisai_top/v1` for every returned month, following the pagination
   family returned by the API, and retain every original JSON response as raw
   evidence.

Live validation on 2026-08-25 and 2026-08-26 established the following:

| Test | Result |
| --- | --- |
| Established Windows Kuebiko profile, password login | Passed, including re-login after its previous Vpass session expired. |
| Fresh Windows Kuebiko profiles | Reached login, but password submission returned to the login form; no reliable fresh-profile bootstrap was established. |
| Fresh WSL official Chrome 151, with or without copied Akamai-only cookies | Akamai Access Denied at `xt_login/agree/v1`. |
| Previously session-seeded persistent WSL profile, after expiry | Password re-login still received Access Denied. |
| `impit@0.14.3` and `curl_cffi`-style impersonation | Did not establish a Vpass login session. |
| Valid Windows session imported into fresh Windows Chrome | Authenticated My Page passed. |
| Same valid session imported into WSL Chrome 151 | Authenticated My Page passed. |
| Same valid session imported into OCI ARM64 Linux Chrome 151 | Authenticated My Page passed. |
| Cookies captured when the Kuebiko browser closed, then imported into OCI | Passed; closing the source browser did not itself kill the server session. |
| Two different imported sessions used concurrently | Both passed; a later login did not immediately revoke the older session. |
| Expired session imported into OCI | Returned to login, matching the expired source profile. |

These results split the source into two explicit gates:

- **Bootstrap gate:** create or refresh a Vpass session from ID/password. This
  currently passes only in the established Windows browser profile.
- **Replay gate:** import a valid session and call authenticated pages/APIs.
  This is proven on Windows, WSL Linux, and OCI Linux, but has not yet been
  tested in a deployed Cloudflare Container.

IP alone was not the observed deciding factor. Successful browser operations
used Cloudflare Sydney/Australian egress, while failures also occurred with
browser-like clients. Akamai cookies without the authenticated Vpass session
were insufficient, and having once imported a good session did not make later
Linux password login pass.

`impit` is a native Node addon backed by Rust. It cannot run inside the
Workers JavaScript isolate, but it can run in a Linux
[Cloudflare Container](https://developers.cloudflare.com/containers/).

Passing a public-page GET is not the success condition. Bootstrap is eligible
only where password login succeeds repeatedly; replay is eligible only where
an imported session and authenticated JSON requests succeed. A redirect to
login or a 401/403 stops the consumer without a password-login retry.

### Akamai is more than a TLS fingerprint

Akamai's published Bot Manager telemetry includes web-client signals, JA4,
and Akamai TLS fingerprint versions in addition to bot scores. Transactional
endpoints such as login can be protected separately. A browser-like TLS/HTTP2
profile is therefore a possible prerequisite, not proof that the client is
accepted.

An HTTP cookie jar only retains `Set-Cookie` values. It cannot execute the
page JavaScript that may produce or refresh web telemetry. If a fresh `impit`
session can load public pages but authenticated POSTs repeatedly fail, do not
try to synthesize Akamai cookies or buy tokens from a third party. Record the
failure as evidence that this source needs a browser bootstrap or must remain
manual.

## Execution decision

Use an established persistent Windows Chrome profile as the session issuer.
It logs in or refreshes only when needed, validates an authenticated page, and
publishes an encrypted, source-scoped session envelope with a generation ID
and expiry metadata. A short-lived Linux collector imports that envelope,
validates it, calls the authenticated JSON APIs, stores raw evidence, and
exits. It never receives the Vpass ID/password and never attempts login.

The issuer currently proven by testing is the existing Windows profile. If a
personal laptop or Hiroshima mini PC must not run scheduled work, the
deployment candidate is an on-demand remote Windows VM with an encrypted
persistent profile disk. An ephemeral CI runner or a newly-created browser
profile is not equivalent to the tested issuer and must pass the bootstrap
gate independently.

The current `risu` account was on Workers Free during the probe. Wrangler could
build the image and upload the Worker, but Cloudflare refused to create the
remote Container application because Containers require Workers Paid. A paid
test is useful only for the replay gate using a known-good session, not for
repeating the already-failing Linux password login.

```text
Bitwarden -- selected ID/password only --> persistent Windows session issuer
                                               |
                                               | encrypted session envelope
                                               v
Cron Trigger --> Worker coordinator --> short-lived Linux consumer
                                         |
                                         +-- validate session, no login
                                         +-- authenticated Vpass JSON calls
                                         v
                                R2 raw evidence + D1 fetch metadata
```

The first deployment gate is a direct-egress Container **replay** using one
newly issued and independently validated session. Try ordinary browser-like
Chrome navigation first and same-origin `fetch` for JSON after validation.
Normal Worker `fetch()` is also worth a separate post-auth replay test because
the evidence does not yet show that native `impit` is required after login.
Only if a valid session works on OCI but fails consistently from Cloudflare
should the source-specific opaque `TAMIA.connect()` route be tested. Do not add
Japanese/home egress pre-emptively.

### One source, one active run

Cron, a manual smoke test, and a delayed previous invocation must not consume
the same session generation concurrently. Route every start request through
one Durable Object named for the source. It owns a durable lease, session
generation, and unique run ID, starts the correspondingly named Container
instance, and rejects a start while the lease is active. Evidence writes use
the run ID and content hash so that delivery remains idempotent.

A timeout, Container failure, WebSocket close, raw-socket error, login redirect,
or 401/403 ends the run as failed and destroys its local cookie jar. It must
not reconnect, resume, or attempt password login. A later run may start only
after the failure has been reconciled and the issuer has supplied a currently
valid generation when necessary.

## Why an HTTPS proxy loses the fingerprint

A TLS fingerprint is made by the client handshake: TLS version and cipher
ordering, extensions, curves, ALPN, and related details. `impit` is useful
because the provider sees a browser-like ClientHello and HTTP behavior.

An HTTPS-intercepting proxy terminates that connection and creates a second
one:

```text
impit -- TLS A --> MITM -- TLS B --> Vpass
```

Vpass sees TLS B, which belongs to the proxy, not TLS A from `impit`.
Cloudflare Container
[`interceptHttps`](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)
and a VPC binding's HTTP `fetch()` path have this property. They may preserve
the source IP choice, but they do not preserve the fingerprint that motivated
using `impit`.

An HTTP `CONNECT` proxy or any other raw TCP relay is different. It forwards
opaque bytes after the tunnel is established, so the inner TLS handshake is
still between `impit` and Vpass. The relay can see destination/traffic shape,
but not the inner plaintext.

## Reusing the `tamia` Tunnel

Workers VPC has three different selectors that must not be conflated:

- `network_id: "cf1:network"` connects to the account-wide Cloudflare One
  network. Public traffic uses Gateway; hostname/subnet routes select the
  configured connector.
- `tunnel_id` binds directly to one Cloudflare Tunnel.
- `service_id` binds to a VPC Service.

For Kogane, configure a dedicated binding with the existing `tamia`
`tunnel_id` and call that binding only for sources that need the Hiroshima
path. This does not require changing the personal ABEMA/TVer hostname routes,
and the same sufficiently recent `cloudflared` process can serve both Zero
Trust and Workers VPC. Workers VPC requires `cloudflared` 2025.7.0 or later
and a QUIC-capable (`auto` or `quic`) tunnel connection.

Workers VPC is currently beta. Creating a direct Tunnel binding requires the
`Connectivity Directory Admin` role, so provisioning uses a separately scoped
deployment identity; the collector runtime receives only the configured
binding and cannot create or edit network resources.

This does not turn the Container's network namespace into a Hiroshima egress
network. Only connections explicitly carried through `TAMIA.connect()` use the
Tunnel path. All other Container traffic keeps its normal Cloudflare egress.

Do not add Vpass public-hostname or domain routes to the account-wide Zero
Trust routing table. Those routes also affect personal devices connected
through WARP, including a laptop used normally while in Japan. Kogane selects
the Hiroshima path only when its Worker calls the VPC binding that is directly
bound to the `tamia` Tunnel; ordinary WARP clients and all other Container
traffic remain unchanged.

Enforce destinations in Worker code with a separate allowlist for each
scraper. The coordinator derives the scraper identity from the active run and
selects its policy server-side. A bridge request may contain a destination
hostname, but the Worker opens it only when the exact hostname and port appear
in that scraper's allowlist. Do not accept a client-provided scraper identity,
share one combined allowlist across collectors, or fall back to an unrestricted
destination.

```ts
const SCRAPER_EGRESS = {
  vpass: {
    binding: "TAMIA",
    port: 443,
    hosts: new Set([/* hosts confirmed by a successful Vpass capture */]),
  },
} as const;
```

The retained 2026-08-25 runtime probe established two narrower facts. Three
`TAMIA.connect()` calls to a plaintext IP-echo endpoint succeeded with the same
observed IP hash, so raw TCP through the selected Tunnel works. Three
`TAMIA.fetch()` calls succeeded but used a different TLS/HTTP fingerprint and
their observed IP hash changed on every request. Thus `fetch()` is not an
opaque substitute for the `impit` transport; use raw `connect()` for the bridge
experiment. Full measurements and the cleanup ledger are in
[PR #3](https://github.com/risu729/kogane/pull/3).

The minimum experiment is:

1. Use the binding's raw
   [`connect()`](https://developers.cloudflare.com/workers-vpc/api/) to send
   plain HTTP to an IP-echo service and compare the reported address with the
   Hiroshima address.
2. Add the diagnostic endpoint only to a test scraper's Worker allowlist,
   carry a Chrome or `impit` TLS stream through the direct `TAMIA.connect()`
   binding, and confirm both the tamia source IP and the original client TLS
   fingerprint at the endpoint.
3. Import a newly issued, independently validated session into the candidate
   consumer and test repeated authenticated JSON collection without password
   login before scheduling it.

The API note that VPC `connect()` currently supports "plaintext TCP only"
means that the binding does not initiate or terminate TLS. It still exposes an
ordered raw TCP byte stream. The bridge therefore must not ask the Worker to
perform TLS: Chrome or `impit` creates the TLS session inside that stream, and
the Worker forwards the resulting opaque bytes. Preserving the ClientHello in
this arrangement is an architectural inference from the raw-stream API and
must be verified by the diagnostic test above.

### Opaque bridge without another mini-PC service

A Container cannot directly use a Worker's VPC binding. The experiment can
bridge bytes as follows:

```text
Chrome or impit
  -> localhost SOCKS5/CONNECT adapter in the Container
  -> run-authenticated WebSocket to the coordinator Worker
  -> env.TAMIA.connect("allowlisted-vpass-host:443")
  -> tamia/cloudflared
  -> Vpass
```

The outer WebSocket TLS terminates at Cloudflare, but the inner provider TLS
bytes are WebSocket payload and remain untouched. The VPC binding exists only
in the Worker runtime, so the Container cannot call `TAMIA.connect()` directly.
Container outbound interception is also HTTP-semantic and cannot substitute
for this byte bridge without replacing the provider-facing TLS handshake.

Prefer the Container's same-machine outbound Worker path so the bridge need
not be a public endpoint; WebSocket upgrade support on that exact path is a
PoC gate. If a public endpoint is required, the coordinator issues a one-run
capability containing the run ID, expiry, and nonce. It is single-use and
bound to the active Durable Object lease. Do not put the destination hostname
in a client-controlled field or add a fixed general proxy secret to the
Container.

The Worker selects fixed Vpass hostnames on port 443 and never becomes a
general-purpose proxy. The bridge also needs explicit stream semantics:

- preserve byte order but never rely on WebSocket message boundaries matching
  TCP reads,
- use application-level credits/acknowledgements and a bounded high-water mark
  because WebSocket `send()` does not provide an awaitable stream writer,
- pause the producing side when the peer has no credit,
- map half-close, error, timeout, and cancellation in both directions, and
- cap per-run bytes and duration; overflow or protocol error fails the run
  without a login retry.

No Kogane-specific process or Vpass hostname route is required on the
Hiroshima mini PC for the direct-Tunnel-binding design: the retained plaintext
probe already showed the existing `cloudflared` connector performing stable
public egress for `TAMIA.connect()`. A localhost-only CONNECT/SOCKS service on
that host remains a fallback only if the same path cannot carry the opaque TLS
stream as expected.

## Rejected paths

| Path | Reason |
| --- | --- |
| Normal Worker password login | Cannot reproduce the established Windows browser/profile context; native `impit` is also unavailable. |
| Normal Worker post-auth replay | **Not rejected yet.** Test it with a valid session; native impersonation may not be required after login. |
| Container `interceptHttps` | Re-terminates TLS and replaces the `impit` fingerprint. |
| VPC binding `fetch()` | Selects a network path but still acts as an HTTP semantic proxy. |
| Calling `TAMIA.connect()` inside the Container | VPC bindings are Worker bindings and are not injected into the Container process. |
| Treating `TAMIA.connect()` as the Container default route | It affects only explicitly bridged TCP flows, not the Container network namespace. |
| Laptop/local scheduled collector | Conflicts with the always-on requirement. A local established profile remains a proven manual issuer until a remote Windows issuer passes. |
| General open proxy on the mini PC | Unnecessary attack surface; any fallback is localhost-only and destination-allowlisted. |

## Implementation gates

- [x] Validate password bootstrap: established Windows profile passes; fresh
      WSL Chrome, Akamai-cookie-only WSL Chrome, a previously seeded WSL
      profile, and `impit@0.14.3` fail at the login gate.
- [x] Validate session replay: a valid Windows session passes in fresh Windows,
      WSL Chrome, and OCI ARM64 Linux Chrome; expired sessions fail normally.
- [x] Run the same client in the Wrangler-built image locally: same 403.
- [ ] Run a valid-session replay in a remote Cloudflare Container after
      Workers Paid is otherwise justified; do not attempt password login.
- [ ] Test post-auth same-origin JSON `fetch` in Chrome and normal Worker
      `fetch()` before requiring native `impit` in the consumer.
- [ ] Implement an issuer that retains the established Windows profile. If it
      is remote, use a persistent encrypted profile disk and validate that its
      password bootstrap passes before enabling automatic refresh.
- [x] Verify `tunnel_id` raw public egress with an IP-echo endpoint: three
      successful `connect()` calls with a stable IP hash.
- [ ] Add separate destination allowlists in Worker code for each scraper;
      derive the scraper from the active run and never create a shared Vpass
      hostname route in the account-wide Zero Trust configuration.
- [ ] Verify that the allowlisted SOCKS5/WebSocket/raw-TCP bridge carries a
      Chrome or `impit` TLS stream with both the tamia IP and the original
      client fingerprint; the IP-echo test used plaintext HTTP only.
- [ ] Add the per-source Durable Object lease, session generation IDs, unique
      run IDs, and cooldown before any scheduled replay.
- [ ] Implement the allowlisted WebSocket/raw-TCP bridge only if direct egress
      is rejected, including one-run authorization and bounded flow control.
- [ ] Add a mini-PC proxy only if the direct-Tunnel raw TLS experiment fails.
- [ ] Deliver credentials to the issuer and encrypted session envelopes to the
      consumer according to `docs/credentials.md` before enabling Cron.

## References

- [Workers VPC network bindings](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)
- [Workers VPC tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)
- [Workers VPC binding API](https://developers.cloudflare.com/workers-vpc/api/)
- [Cloudflared source-IP anchoring](https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/egress-cloudflared/)
- [Container outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)
- [Container Cron example](https://developers.cloudflare.com/containers/examples/cron/)
- [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Container-to-Worker connections](https://developers.cloudflare.com/containers/platform-details/workers-connections/)
- [Akamai SIEM fields](https://techdocs.akamai.com/siem-integration/docs/siem-splunk-connector)
- [Akamai protection operation purposes](https://techdocs.akamai.com/api-definitions/reference/operation-purposes)
