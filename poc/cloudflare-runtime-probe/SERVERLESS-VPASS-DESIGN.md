# Serverless Vpass collector design

Updated on 2026-08-25. This is a go/no-go design: the Linux Chrome login gate
must pass before profile persistence or scheduled collection is implemented.

## Recommendation

Use a Worker or scheduled Workflow only as the orchestrator. Run full headed
Chrome inside one named Cloudflare Container, and perform Vpass API calls with
same-origin `fetch()` inside that Chrome page.

```text
Workflow schedule
  -> named Container instance (max one active collector)
      -> restore encrypted collector-owned Chrome profile
      -> Chrome + Xvfb + Japanese fonts + passive CDP/Kuebiko capture
      -> bounded login or existing-session validation
      -> page-local internal JSON fetches, serially per card
      -> normalized results to D1/R2
      -> encrypt and checkpoint profile before shutdown
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
Containerization is therefore a testable runtime candidate, not a known fix.

## Container lifecycle and state

Use one stable container name, one active job, and a Durable Object/Workflow
lease so two runs cannot mutate the same profile. Container disk is fresh after
the instance sleeps and the platform may stop or relocate an instance, so
local profile continuity alone is not durable.

Checkpoint the collector-owned profile as an encrypted archive in R2. Store
only metadata such as archive version, ETag, last successful validation, and
lease state in Durable Object storage. Treat the archive as account credentials:
never log it, expose it through a public Worker route, or include it in build
artifacts.

Use an envelope key from Worker Secrets or Secrets Store and pass it only to
the job that restores/checkpoints the archive. The application should handle
SIGTERM and checkpoint early; shutdown grace is not a substitute for periodic
checkpoints.

## Credentials

Do not run `bw serve` in Cloudflare and do not store a Bitwarden master
password. Keep Bitwarden as the source of truth on a trusted local machine.
After a password change, run a small local sync command that reads only the
selected Vpass fields and updates two Cloudflare secrets. The Worker can pass
those secrets to the Container at start. Prefer one-time job delivery over
writing them to disk, and redact process errors and environment dumps.

This intentionally duplicates only the minimum selected credentials into
Cloudflare. It avoids uploading a Bitwarden vault export or keeping an unlocked
vault service online.

## Go/no-go rollout

1. Enable Workers Paid; the same-day remote deployment was rejected because
   Containers were unavailable on the account's Free plan.
2. Deploy a non-credential probe with official Chrome, headed Xvfb, a normal
   viewport, fonts, `webdriver=false`, and passive Kuebiko capture.
3. Run at most three credentialed login trials, each from a fresh Container
   profile, with no blind retry after 403. Use the same bounded capture fields
   as the Windows/OCI probes.
4. If no Linux Container trial succeeds, stop. Pure Cloudflare serverless is
   not supported by the current evidence; the fallback needs a remote Windows
   browser runner, with Cloudflare retaining scheduling and storage only.
5. If a trial succeeds, validate a named persistent profile, same-page JSON
   fetch, encrypted R2 checkpoint/restore, and source-session rotation behavior.
6. Only then add a Workflow schedule, failure notification, and normalized
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
