# TAMIA bridge and modern impersonation results

Observed on 2026-08-25. No Vpass credential, cookie, card identifier, response
body, or public IP address was written to this repository or Worker.

## Raw bridge behavior

Cloudflare trace and `api.ipify.org` returned the same SHA-256 IP hash through
the bridge:

`45a9f49cd3d33ca3b2f3a3fec081bda2cf3b5b85acbc53416ace21a701e2eb26`

Cloudflare trace reported `loc=JP`, `warp=off`, and `gateway=off`. This matches
the stable hash previously observed through `TAMIA.connect()` and demonstrates
that this raw path exits from the Japanese `tamia` side rather than a rotating
Cloudflare HTTP egress.

For both `curl_cffi` profiles below, normalized JA4 and the HTTP/2 Akamai
fingerprint hash were identical with and without the bridge. JA3 hashes changed
as expected when randomized extension order/GREASE changed. The bridge therefore
preserves the client's useful inner TLS/HTTP2 identity instead of replacing it
with the Worker or VPC `fetch()` identity.

| Client profile                 | Platform represented | HTTP | JA4                                    | Akamai H2 hash                     | Vpass bootstrap                                               |
| ------------------------------ | -------------------- | ---- | -------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `curl_cffi 0.16.1` `chrome116` | Windows 10           | h2   | `t13d1516h2_8daaf6152771_f37e75b10bcc` | `a345a694846ad9f6c97bcc3c75adbe26` | 200 for top, device API, and login page; direct and JP bridge |
| `curl_cffi 0.16.1` `chrome150` | macOS Tahoe          | h2   | `t13d1516h2_8daaf6152771_806a8c22fdea` | `52d84b11737d980aef856699f885ca86` | 200 for top, device API, and login page; direct and JP bridge |
| upstream `impit` `chrome151`   | Windows, Chrome 151  | h2   | `t13d1516h2_8daaf6152771_806a8c22fdea` | `72bcd337b9239714736fe0ad43766ce7` | 200 through JP bridge                                         |

The published clients did not provide a coherent Chrome 153 Windows profile:
`curl_cffi 0.16.1`'s newest built-in Chrome profile was Chrome 150 on macOS and
its newest built-in Windows Chrome profile was 116; published `impit@0.14.3`
stopped at Chrome 142. Upstream `impit`'s unreleased Chrome 151 Windows profile
was the closest coherent candidate and was built from the pinned commit in the
README.

## Vpass authentication result

Exactly one credential-bearing login POST was sent for this comparison, using
upstream `impit` Chrome 151 through the verified Japanese `tamia` route. The
result was:

- HTTP 403 from the Akamai edge,
- HTML rather than a Vpass JSON/application result,
- no `x-loginresult`, and
- no redirect location.

The test stopped without retry. In a later explicitly requested comparison,
one `curl_cffi 0.16.1` Chrome 150 credential login was sent through the same
verified Japanese route. Its bootstrap succeeded, but the login result was the
same: HTTP 403, HTML, no `x-loginresult`, and no redirect. The attempts were not
looped across the other `curl_cffi` profiles.

This establishes that moving the request to the Japanese home IP is not enough,
even when the native client presents a current Windows Chrome-like TLS and
HTTP/2 profile. A real Chrome 153 session through the same public egress had
previously succeeded. The remaining distinction is therefore above IP and
basic transport impersonation. JavaScript-executed Akamai telemetry, the
resulting cookie state, browser storage/history, request timing, or another
browser-only signal remain plausible; this experiment does not isolate which
one Akamai used.

The follow-up `../cloudflare-browser-run/RESULTS.md` allowed JavaScript to run
in a real remote Chromium instance, but Cloudflare's identifiable automated
browser and Cloudflare egress were also rejected. Taken together, the tests
suggest that a usable design needs both a sufficiently normal browser
environment and the acceptable home egress; neither half passed alone.

## Design implication

`TAMIA.connect()` plus an authenticated WebSocket bridge solves the selective
home-egress and TLS-preservation problem, but it does not solve Akamai's full
browser validation. A production collector should not add repeated
ID/password attempts to this profile. The next technically distinct experiment
would need a minimal real-browser bootstrap that exports only short-lived
session material, not another transport-only impersonation profile.

## References

- [curl_cffi](https://github.com/lexiforest/curl_cffi)
- [impit](https://github.com/apify/impit)
- [Workers VPC socket API](https://developers.cloudflare.com/workers-vpc/api/)
- [Workers WebSockets API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
