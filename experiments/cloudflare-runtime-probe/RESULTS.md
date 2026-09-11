# Vpass and Cloudflare runtime probe results

Observed on 2026-08-25. No Vpass credential, cookie, card identifier, raw
account JSON, or public IP address was written to this repository or to the
deployed Worker.

## Vpass login result

The saved Kuebiko Chrome capture used Chrome 153 on Windows and recorded a
successful `POST /memapi/jaxrs/xt_login/agree/v1`: HTTP 302,
`x-loginresult: 0`, followed by the Vpass `agreeJudge` API. Windows Chrome and
WSL had the same public egress IP at comparison time (verified by comparing only
SHA-256 hashes).

The browserless client used `impit@0.14.3` with its newest available
`chrome142` profile. One WSL login attempt and one login attempt from the same
Wrangler-built image running in local Docker both stopped without retry at:

- HTTP 403 from the Akamai edge,
- `content-type: text/html`,
- no `x-loginresult`, and
- no redirect location.

Because the real browser succeeded through the same egress IP, the observed
rejection is not explained by source IP. It happens before Vpass returns its
application login result and is consistent with Akamai distinguishing the
browserless TLS/HTTP2/request/telemetry profile. This experiment does not
identify which individual signal triggered the decision.

## TLS and egress comparison

All successful network probes used the same fixed Chrome 142 User-Agent. IP
addresses below were retained only as hashes.

| Path                                    | Runs | Result   | HTTP     | Stable JA4                             | HTTP/2 Akamai hash                 | IP-hash behavior       |
| --------------------------------------- | ---: | -------- | -------- | -------------------------------------- | ---------------------------------- | ---------------------- |
| Worker `fetch()`                        |    3 | 200 each | h2       | `t13d1312h2_a44d0ee8b3cc_485d6013ba69` | `175a6d4585f5a5c52b0f6fcca2977cd0` | changed each request   |
| `TAMIA.fetch()`                         |    3 | 200 each | HTTP/1.1 | `t13d1510_8daaf6152771_78e6aca7449b`   | none                               | changed each request   |
| `TAMIA.connect()` to `api.ipify.org:80` |    3 | 200 each | raw TCP  | not applicable                         | not applicable                     | stable across all runs |
| local Docker native `fetch()`           |    1 | 200      | HTTP/1.1 | `t13d1714h1_5b57614c22b0_6a3d802a7139` | none                               | recorded as hash only  |
| local Docker `impit`                    |    1 | 200      | h2       | `t13d1516h2_8daaf6152771_d8a2da3f94cd` | `948837f50c4abc75e8d2cca62287ad4d` | recorded as hash only  |

The fixed User-Agent did not make any of the TLS/HTTP stacks equivalent.
`TAMIA.fetch()` produced a different fingerprint from both Worker `fetch()` and
`impit`, and its observed IP hash rotated. In contrast, `TAMIA.connect()`
successfully carried plaintext TCP through the selected Tunnel and exposed a
stable egress IP hash.

Therefore a VPC `fetch()` binding is not a transparent transport for an
`impit` fingerprint: the HTTP/TLS connection is re-originated by that path.
Raw `connect()` selects the Tunnel without imposing the `fetch()` fingerprint,
but the current Workers VPC socket API supports plaintext TCP, not wrapping an
arbitrary socket with `impit`'s native TLS implementation.

## Remote Containers result

Wrangler successfully generated types, type-checked both runtimes, built the
Container image, uploaded the Worker, and deployed the VPC-bound Worker. The
Cloudflare Container registry then rejected the image upload with:

`Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.`

Consequently the remote Container and remote Container Vpass login could not be
run on this account without changing its paid plan. The exact image ran locally,
including the TLS probe and the single Vpass login attempt described above.

## Implications for Kogane

1. Moving only the source IP to `tamia` does not reproduce a real Chrome client.
2. Worker `fetch()` and VPC `fetch()` each expose their own non-browser network
   fingerprint, even when the User-Agent string is fixed.
3. A Cloudflare Container could run `impit`, but it is unavailable on the
   current plan and the tested `chrome142` profile was still rejected locally.
4. A follow-up test in `../tamia-tcp-bridge/RESULTS.md` used a verified Japanese
   home egress and an unreleased Windows Chrome 151 `impit` profile. The raw
   bridge preserved its TLS/HTTP2 fingerprint, but Akamai still rejected the
   single login POST before Vpass returned an application login result.

See `RESOURCE_INVENTORY.md` for the retained deployment and exact cleanup scope.

## References

- [Workers VPC API](https://developers.cloudflare.com/workers-vpc/api/)
- [Workers VPC Tunnel binding configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)
- [Cloudflare Containers: Get started](https://developers.cloudflare.com/containers/get-started/)
