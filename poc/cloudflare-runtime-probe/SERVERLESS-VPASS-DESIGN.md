# Serverless Vpass collector design

Updated on 2026-08-26. This is a split authentication/collection design. Linux
Chrome has passed authenticated-session consumption but not password login.

## Recommendation

Use a Worker or scheduled Workflow only as the orchestrator. Run full headed
Chrome inside one named Cloudflare Container, import a newly validated session
from an established Windows authentication runner, and perform Vpass API calls
with same-origin `fetch()` inside that Chrome page.

```text
Workflow schedule
  -> named Container instance (max one active collector)
      -> start an isolated Chrome context
      -> import newest encrypted session generation before navigation
      -> Chrome + Xvfb + Japanese fonts + passive CDP/Kuebiko capture
      -> read-only existing-session validation; no password login
      -> page-local internal JSON fetches, serially per card
      -> normalized results to D1/R2
      -> encrypt and publish any valid rotated session generation
      -> discard the local Chrome context before shutdown

on-demand persistent Windows authentication runner
  -> validate established Windows profile
  -> perform at most one password login when required
  -> publish a new source-scoped encrypted session generation
```

Do not use Worker `fetch()`, a VPC `fetch()` binding, or an HTTPS-intercepting
outbound handler for Vpass. Prior probes show that these re-originate HTTP/TLS
with a different fingerprint. A Container must let Chrome create the direct
TLS connection. If egress must later use a selected home Tunnel, it needs a
transparent layer-4 path that preserves Chrome's TLS rather than an HTTP
proxy/MITM.

## Why a Container instead of Browser Run

Browser Run successfully loaded the login form only after changing its network
User-Agent, but JavaScript still observed `Cloudflare-Workers`, Linux, and
`navigator.webdriver=true`; the login POST was rejected. Browser sessions also
have a short keep-alive limit and are not a durable profile store.

A Container can package official Chrome, Xvfb, fonts, Kuebiko, and the collector
service. It is still Linux, so it does not inherit the successful Windows
fingerprint. Existing OCI and WSL headed Linux Chrome probes were rejected.
Later trials showed that both live and closed-capture sessions could be consumed
by Linux Chrome on WSL and OCI. Containerization is therefore a viable session
consumer candidate, not a known password-login fix.

## Container lifecycle and state

Use one stable container name, one active job, and a Durable Object/Workflow
lease so two runs cannot mutate the same profile. Container disk is fresh after
the instance sleeps and the platform may stop or relocate an instance, so
local profile continuity alone is not durable.

Checkpoint only the minimal source-scoped session envelope as an encrypted
object in R2. The transfer trials passed in fresh profiles, so persisting a full
Linux browser profile is not currently justified. Store only metadata such as
envelope version, auth generation, ETag, last successful validation, and lease
state in Durable Object storage. Treat the encrypted object as account
credentials: never log it, expose it through a public Worker route, or include
it in build artifacts.

Use an envelope key from Worker Secrets or Secrets Store and pass it only to
the job that restores/checkpoints the archive. The application should handle
SIGTERM and checkpoint early; shutdown grace is not a substitute for periodic
checkpoints.

## Credentials

Do not run `bw serve` in Cloudflare and do not store a Bitwarden master
password. Keep Bitwarden as the source of truth for the persistent Windows
authentication runner. After a password change, sync only the selected Vpass
fields to that runner's protected credential store. Do not copy the ID/password
to Cloudflare while Linux password login remains rejected.

The Windows runner publishes only a newly validated, encrypted, source-scoped
session envelope. Cloudflare receives that envelope and its generation metadata,
not a Bitwarden vault export, master password, unlock session, or broad cache.

## Go/no-go rollout

1. Prepare a Windows session-export command that validates the source immediately
   before and after capture, encrypts for one collector, and publishes a monotonic
   auth generation without logging cookie values.
2. Enable Workers Paid; remote Container creation is unavailable on Workers
   Free.
3. Deploy a non-password Container probe with official Chrome, headed Xvfb, a
   normal viewport, fonts, `webdriver=false`, and passive Kuebiko capture.
4. Import one newly validated session generation before first navigation and
   confirm My Page plus page-local JSON access through direct Container egress.
5. Validate encrypted session-envelope checkpoint/restore across Container
   sleep, single-run leasing, and source-session rotation behavior.
6. Measure session lifetime under the intended schedule. Redirect, 401, or 403
   stops the run and requests a Windows refresh; the Container never submits the
   password.
7. Only then add a Workflow schedule, failure notification, and normalized
   statement persistence.

Cloudflare may place a newly restarted Container in a different location. Do
not assume a fixed Sydney IP or colo. Existing Windows success over Cloudflare
Sydney egress shows that a Japanese residential IP is not a demonstrated
requirement, so the first Container probe should use direct Cloudflare egress.

## References

- <https://developers.cloudflare.com/containers/>
- <https://developers.cloudflare.com/containers/get-started/>
- <https://developers.cloudflare.com/containers/platform-details/architecture/>
- <https://developers.cloudflare.com/containers/examples/cron/>
- <https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/>
- <https://developers.cloudflare.com/containers/pricing/>
- <https://developers.cloudflare.com/browser-run/limits/>
