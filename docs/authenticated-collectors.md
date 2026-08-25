# Authenticated Collectors

This document records the execution and network design for sources that can
be collected without a browser but cannot run in a normal Worker. Vpass is the
first example: its private JSON API can be replayed from an ID/password and a
fresh cookie jar, while its Akamai edge may reject a generic TLS/HTTP client.

This is a design and proof-of-concept track, not a promise that an unofficial
provider API will remain stable. A collector must stop on authentication or
anti-bot errors and must never retry a login rapidly.

## Vpass baseline

The browserless JSON PoC is tracked in
[PR #3](https://github.com/risu729/kogane/pull/3). Its intended flow is:

1. Create a fresh, in-memory cookie jar and an `impit` client using a Chrome
   TLS/HTTP profile.
2. Bootstrap the Vpass session, then authenticate with Vpass ID/password.
3. Enumerate cards with `dropdownlist_init/v1` and select one with
   `operation_card_update/v1`.
4. Call `web_meisai_top/v1` with empty content and read
   `seikyuYMList` / `comSeikyuYMList`. These are the available months; do not
   probe a guessed range.
5. Call `web_meisai_top/v1` for every returned month, following the pagination
   family returned by the API, and retain every original JSON response as raw
   evidence.

Live validation on 2026-08-25 did not pass the authentication gate. A saved
Chrome 153 session logged in successfully, while `impit@0.14.3` with its newest
`chrome142` profile received an Akamai HTTP 403 before Vpass returned
`x-loginresult`. Windows Chrome and WSL had the same public egress IP at the
time, so changing only the source IP does not explain or fix this result. The
PoC remains useful as a JSON contract and parser, but is not eligible for
scheduling with this impersonation profile.

`impit` is a native Node addon backed by Rust. It cannot run inside the
Workers JavaScript isolate, but it can run in a Linux
[Cloudflare Container](https://developers.cloudflare.com/containers/).

Passing a public-page GET is not the success condition. A source is eligible
for scheduled collection only after login and authenticated JSON requests
succeed repeatedly from fresh sessions. A 401/403 stops the run without a
login retry.

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

If a browserless client passes the authentication gate, start the source
collector in a short-lived Container from a Cron-triggered Worker. Pass only
that source's credentials into the new Container instance, collect the
provider's raw response bytes, ingest them, and let the instance sleep/exit.
The Worker remains the scheduler and policy boundary; native network code
stays in the Container.

The current `risu` account is on Workers Free. Wrangler can build the image and
upload the Worker, but Cloudflare refuses to create the remote Container
application because Containers require Workers Paid. The exact image runs in
local Docker and reproduced the same Vpass 403. Do not change the plan merely
to repeat the same `impit@0.14.3` login.

```text
Cron Trigger
    |
    v
Worker coordinator -- read source-scoped secrets
    |
    v
short-lived Container -- impit + cookie jar + Vpass JSON client
    |
    +-- direct Internet first
    |
    +-- optional opaque byte bridge to tamia when home egress is required
    |
    v
R2 raw evidence + D1 fetch metadata
```

The first deployment gate is a direct-Internet Container run. This separates
two possible rejection causes:

- If `impit` succeeds from a Cloudflare address, no Hiroshima dependency is
  needed.
- If the TLS/HTTP fingerprint is accepted but the Cloudflare address is not,
  add the opaque tunnel path below.
- If authenticated requests still fail from both networks, JavaScript
  telemetry or another browser-only signal may be required. Keep that source
  manual rather than adding blind retries or third-party anti-bot services.

### One source, one active run

Cron, a manual smoke test, and a delayed previous invocation must not log into
the same source concurrently. Route every start request through one Durable
Object named for the source. It owns a durable lease and a unique run ID,
starts the correspondingly named Container instance, and rejects a start while
the lease is active. Evidence writes use the run ID and content hash so that
delivery remains idempotent.

A timeout, Container failure, WebSocket close, or raw-socket error ends the run
as failed and destroys the cookie jar. It must not reconnect, resume, or log in
again automatically. A later scheduled or explicit manual run may start only
after the failed run has been reconciled and its cooldown has elapsed.

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

For a public destination, announce the required public hostname or domain as a
hostname route on `tamia`. Cloudflare documents public hostname routes as
egressing through the selected Tunnel with the connector host's public source
IP. A domain route such as `*.example.com` covers its subdomains; add the apex
separately when it is also used. Do not add a catch-all route. Discover the
actual Vpass dependency hosts from a successful browser capture, register only
those routes, and repeat that same finite set in the Worker allowlist.

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
2. Add an allowlisted public-hostname route for a diagnostic endpoint, carry a
   Chrome or `impit` TLS stream through it, and confirm both the tamia source IP
   and the original client TLS fingerprint at the endpoint.
3. Test repeated authenticated collection from a fresh session before
   scheduling it.

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

No Kogane-specific process is required on the Hiroshima mini PC for the
public-hostname-route design: the existing `cloudflared` connector performs
the public egress. A localhost-only CONNECT/SOCKS service on that host remains
a fallback only if the documented hostname-route path cannot carry the raw
VPC socket as expected.

## Rejected paths

| Path | Reason |
| --- | --- |
| Normal Worker `fetch()` | Cannot run native `impit`; the provider sees Cloudflare's TLS/HTTP behavior. |
| Container `interceptHttps` | Re-terminates TLS and replaces the `impit` fingerprint. |
| VPC binding `fetch()` | Selects a network path but still acts as an HTTP semantic proxy. |
| Calling `TAMIA.connect()` inside the Container | VPC bindings are Worker bindings and are not injected into the Container process. |
| Treating `TAMIA.connect()` as the Container default route | It affects only explicitly bridged TCP flows, not the Container network namespace. |
| Laptop/local scheduled job | Conflicts with the always-on requirement. |
| General open proxy on the mini PC | Unnecessary attack surface; any fallback is localhost-only and destination-allowlisted. |

## Implementation gates

- [x] Live-validate the browserless Vpass JSON PoC: rejected by Akamai 403 with
      `impit@0.14.3`; authenticated JSON collection remains unvalidated.
- [x] Run the same client in the Wrangler-built image locally: same 403.
- [ ] Run it in a remote Cloudflare Container only after a materially newer
      client profile is available and Workers Paid is otherwise justified.
- [x] Verify `tunnel_id` raw public egress with an IP-echo endpoint: three
      successful `connect()` calls with a stable IP hash.
- [ ] Add only the captured Vpass public-hostname/domain routes to `tamia` and
      mirror the resulting host set in the Worker allowlist.
- [ ] Verify that the allowlisted SOCKS5/WebSocket/raw-TCP bridge carries a
      Chrome or `impit` TLS stream with both the tamia IP and the original
      client fingerprint; the IP-echo test used plaintext HTTP only.
- [ ] Add the per-source Durable Object lease, unique run IDs, and cooldown
      before any scheduled or manual cloud login.
- [ ] Implement the allowlisted WebSocket/raw-TCP bridge only if direct egress
      is rejected, including one-run authorization and bounded flow control.
- [ ] Add a mini-PC proxy only if the public-hostname-route experiment fails.
- [ ] Deliver credentials according to `docs/credentials.md` before enabling
      Cron.

## References

- [Workers VPC network bindings](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)
- [Workers VPC tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)
- [Workers VPC binding API](https://developers.cloudflare.com/workers-vpc/api/)
- [Tunnel hostname routes](https://developers.cloudflare.com/cloudflare-one/networks/routes/add-routes/)
- [Cloudflared source-IP anchoring](https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/egress-cloudflared/)
- [Container outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)
- [Container Cron example](https://developers.cloudflare.com/containers/examples/cron/)
- [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Container-to-Worker connections](https://developers.cloudflare.com/containers/platform-details/workers-connections/)
- [Akamai SIEM fields](https://techdocs.akamai.com/siem-integration/docs/siem-splunk-connector)
- [Akamai protection operation purposes](https://techdocs.akamai.com/api-definitions/reference/operation-purposes)
