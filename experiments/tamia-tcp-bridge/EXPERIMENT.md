# Experiment: TAMIA raw TCP bridge

| field    | value                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner    | risu729                                                                                                                                                                                  |
| Started  | 2026-08-25                                                                                                                                                                               |
| Expires  | **2026-12-31**                                                                                                                                                                           |
| Status   | Continuing as a contingency mechanism. Nothing is deployed: the Worker and its token were deleted on 2026-08-26.                                                                         |
| Question | When a collector needs the Japanese home egress _and_ its own TLS/HTTP2 fingerprint, does an authenticated WebSocket to `TAMIA.connect()` give it both without becoming a general proxy? |

## Why it is still here, and why it is not a service

The plan's row was `promote-service-if-used`, decided by whether a collector
depends on it. **None does**, and the evidence is specific:

- the deployed Workers bind the `tamia` Tunnel _directly_. PRESTIA GLOBAL PASS
  declares `vpc_networks` with `tunnel_id 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`
  and relays through its own Worker's `/tcp` endpoint (`RELAY_PUBLIC_URL`), not
  through this bridge;
- no source file, service binding, var, secret name, wrangler config or task in
  this repository names `kogane-tamia-tcp-bridge-20260825`;
- the Worker is not in the account inventory. It and its `BRIDGE_TOKEN` were
  deleted on 2026-08-26 and re-verified (`RESOURCE_INVENTORY.md`, and the
  account-level check in
  [`../../docs/research/vpass-probe-cleanup-2026-08-26.md`](../../docs/research/vpass-probe-cleanup-2026-08-26.md)).

So it is not promoted. It is also not retired, because unlike the Camoufox,
Kameleo and OCI probes — which answered _no_ — this one answered **yes** about
its own mechanism: through the bridge, Cloudflare trace and an independent IP
echo returned the same stable hash with `loc=JP`, `warp=off`, `gateway=off`,
and both `curl_cffi` profiles kept their normalized JA4 and Akamai HTTP/2
fingerprint identical with and without it. The bridge preserves the client's
inner TLS identity instead of replacing it with the Worker's.

That is a working, bounded component for a contingency the product design
explicitly keeps open: `docs/authenticated-collectors.md` still carries the
unchecked gate "implement the allowlisted WebSocket/raw-TCP bridge only if
direct egress is rejected", and GLOBAL PASS is still running direct-egress
versus TAMIA A/B comparisons. Deleting proven infrastructure while its
triggering condition is under active measurement is what 07 §6 warns against.

What it did **not** solve is equally recorded: one bounded credential login
through the verified Japanese route returned Akamai 403, as did a later
`curl_cffi` Chrome 150 attempt. Selective home egress plus transport
impersonation is not enough on its own — see `RESULTS.md`. A production
collector must not add repeated ID/password attempts to this profile.

## Stop condition

Retire this experiment — fold `RESULTS.md` into
`docs/research/tamia-tcp-bridge.md` and delete the code — when **any** of these
becomes true:

1. the GLOBAL PASS egress question is settled either way: direct Container
   egress is accepted, or the collector commits to the direct `vpc_networks`
   binding permanently, so no collector can need a separate bridge;
2. Cloudflare gives Workers a supported way to pin a Container's egress to a
   Tunnel, which would replace this mechanism rather than extend it;
3. the expiry date passes without either of the above. Extending means editing
   this file with a new date and a reason, not letting it lapse silently.

Promote it to `services/tamia-tcp-bridge` instead — its original plan row — the
moment a collector actually routes through it. That is a deployment decision
with a Worker name, a token and an allowlist, and it does not happen by a
directory move.

## Safety boundaries that must not be relaxed

These are the reason this is a diagnostic and not a proxy, and they survive any
future promotion:

- the local adapter accepts HTTP CONNECT only on `127.0.0.1:18787`; the client
  cannot choose an arbitrary destination or port — the Worker maps four fixed
  paths to four fixed hosts;
- the Worker requires a random, temporary `BRIDGE_TOKEN` that the adapter
  installs at startup and deletes on shutdown;
- 16 MiB per direction, 512 KiB of queued client data, 90 seconds per
  connection;
- the public root reports only enabled/disabled state and the fixed destination
  names; the Worker stores no traffic and no credentials, and never terminates
  the inner TLS session;
- `tamia` is referenced infrastructure. Deleting the Tunnel, its VPC network or
  its routes as cleanup for this experiment is forbidden: GLOBAL PASS runs
  through it.

## What it costs while open

`mise run ci:tamia-tcp-bridge` (type-check) and a `wrangler deploy --dry-run` of
both configs. The Worker name `kogane-tamia-tcp-bridge-20260825` stays in the
configs so a redeploy reuses the same identity instead of creating a second one.
