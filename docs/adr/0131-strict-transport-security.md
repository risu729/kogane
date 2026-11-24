# ADR 0131: Every App answer tells the browser to use only HTTPS for its host

- Status: accepted (merged 2026-11-22 in [#1558](https://github.com/risu729/kogane/pull/1558)).
  A change to the App Worker's response header policy: the owner's decision
  was needed before merge on whether the Worker should send the header
  itself, and on its lifetime (below).
- Date: 2026-11-21
- Related: [production evidence browser: response headers](../production-evidence-browser.md#response-headers),
  [ADR 0047](0047-mcp-client-connection.md) (what Access serves, not this
  Worker)

## Context

`secureResponse` in `services/app/src/http.ts` puts one fixed set of headers
on every answer of the App Worker: `no-store`, `nosniff`, `no-referrer`,
`DENY`, both cross-origin policies, a request id, and a default
`Content-Security-Policy`. It sets no `Strict-Transport-Security`, and
nothing else in the repository does: neither Worker config
(`wrangler.jsonc`, `cloudflare.config.ts`) nor the built client
(`apps/web/dist-production`, which has no `_headers` file). A synthetic
request to the shell, its `304` revalidation, a `HEAD`, a read, a `404`, a
`401`, a `405` and the raw download all answered without it
(`test/api.test.ts`, before this change).

The Worker serves the owner's whole financial dataset and the operator
write paths on a custom domain. Without the header, a browser that is given
an `http://` link to that host, or the bare hostname typed into the address
bar, first sends a plain-HTTP request; whoever sits on the network path can
answer it instead of the Worker (a look-alike login page, or a page that
keeps the user on HTTP). Cloudflare Access still guards the data, so the
risk is phishing of the Access login and of the page itself, not a direct
read of the API.

Whether the Cloudflare zone adds the header at its edge is a dashboard
setting that the repository does not record, and agents do not read
Cloudflare configuration. The `workers.dev` hostname is under a top-level
domain that browsers already force to HTTPS; the custom domain is not.

## Options considered

1. **Leave it to the zone.** Nothing changes in code. The policy then lives
   outside the repository, cannot be tested, and silently disappears if the
   Worker moves to another zone or the setting is turned off.
2. **Send it from `secureResponse`, this host only, one year, not preloaded
   (chosen).** One line beside the other fixed headers, so every answer
   carries it, the error formatter's refusals included, and the suite pins it.
3. **Add `includeSubDomains` and `preload`.** Preload is a commitment to the
   browsers' built-in list for the parent domain, which the Worker does not
   own alone, and is slow to undo. `includeSubDomains` would reach only names
   below the Worker's own host, which serve nothing; it adds no protection.

## Decision

`secureResponse` sets `Strict-Transport-Security: max-age=31536000` on every
answer. A browser ignores the header on a plain-HTTP answer (RFC 6797 §8.1),
so a local `http://` run of the Worker is unaffected. If the zone also sends
the header, the browser keeps the first one it parses, and both name HTTPS
only.

## Consequences

- After one HTTPS answer, a browser rewrites every request to the host to
  HTTPS for a year, before any packet leaves it.
- Serving the host over plain HTTP again is not possible for a browser that
  saw the header within the year. Nothing in the repository serves the host
  over plain HTTP on purpose.
- The local experiment server (`experiments/observation-pipeline-local`) is
  loopback-only HTTP and does not send it; that is unchanged.

## Verification

`services/app/test/api.test.ts` asserts the header on the shell, its `304`
revalidation, a `HEAD`, a read, a `404`, a `401`, a `405` and the raw
download; the new case fails without the line in `secureResponse`.
