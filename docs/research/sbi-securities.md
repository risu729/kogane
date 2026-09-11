# SBI証券 Bitwarden CLI passkey overlay (retired)

|                               |                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Status                        | **Retired.** Superseded by the SBI Securities collector Worker, which reimplements the read-only paths without `mnie`.              |
| Ran                           | 2026-08-26, against the real account                                                                                                |
| Lived at                      | `poc/sbi-securities`                                                                                                                |
| Last commit carrying the code | `5fb143e0f77a492ae9cfdbe0266fe77774b8bd30` (`Host synthetic observation demo behind WARP Access (#104)`, 2026-09-07)                |
| Live resources                | None. It never had a wrangler config, a Worker, a bucket or a cron; it was a local overlay on a checkout of an external repository. |

## What it was

An overlay on `pnsk-lab/mnie` at commit `c87e65c0a04c03c560962f8ead6e77415fb841f4`
that connected Bitwarden CLI's decrypted login item to `mnie`'s existing SBI
provider and its Bitwarden signing implementation, plus the minimum provider
patch needed for domestic trade history. Four files went into the checkout's
`scripts/`, and a 512-line patch extended `orders.inquiry.tradeRecords` beyond
US markets and exposed `account.positions.foreignCash()`.

It was a feasibility overlay, not a collector: no credential, session, account
number or financial value lived in the directory, and it had to run on a WSL
native filesystem against a manually unlocked vault.

## What it established

Browserless passkey authentication works end to end, and the read-only surface
is wider than expected. On 2026-08-26 the full chain passed on the real
account: login entry 200, FIDO2 challenge 200, assertion from the Bitwarden
ECDSA P-256 credential, assertion POST 302, SSO callback 200, RSA decryption of
the callback token, MTS `ssologingate` 200, and read-only TR code `F2631` 200.
Domestic holdings parsed out of the fixed-width Shift-JIS response matched the
server total. Separate passkey channels reached the foreign-stock app and the
main site; US holdings, US and domestic trade history, USD foreign-currency
deposits, My資産 current valuation and the yen cash-movement statement were all
retrieved read-only. Order methods, the trading password, device registration
and session reuse were never exercised.

Two findings that the collector inherits as policy rather than code:

- **History is walked in windows of 90 days or fewer.** A single request for
  2021-to-present was rejected. US history split into 11 windows from the
  `pastYears=2` the searchable-period query returned: 11/11 succeeded, 7
  records, 0 duplicates, `hasMore` 0. Domestic history from 2024-01-01 to
  2026-08-26 split into 11 windows: 11/11 succeeded, the same 72 records as the
  single search, 0 duplicates, no cap reached. An empty window returns the
  search form without a result table and is a normal zero, not an error.
- **The yen cash-movement statement cannot identify an instrument by code.** All
  five dividend rows carried a description specific enough for a human, but no
  four-digit code; only two matched a currently held instrument by name. Exact
  identification needs My資産's dividend history or the payment notice as a
  second source. This is why the collector must not normalise a dividend row to
  an instrument id from the statement alone.

Market data was inconclusive and stays that way: domestic holdings carried
current prices and per-instrument quotes and daily charts succeeded, while US
holdings returned only the previous close with an empty `last`, and the main
site's USD exchange-rate query failed in the same run. Do not treat that rate
query as a stable source for a display FX rate.

## Why the MTS origin is not in this repository

`mnie`'s repository rule is that a real endpoint origin is never hardcoded
while paths may be. The stock app keeps MTS origins in an environment-selection
table and its passkey login class joins the relative path
`/mtsmobile/ssologingate`. Because the origin can change with an app update or
an environment switch, the overlay took it as a runtime environment variable
rather than copying it into `mnie` or into Kogane.

How the candidate origin was validated, since it came from a non-Play
distribution copy: verify the JAR signature inside the APK, confirm the signer
name is SBI SECURITIES, confirm the MTS host's TLS certificate is issued to SBI
証券, and confirm that the app's environment table and its MTS login class use
the same origin and path. JADX 1.5.6 failed on parts of the decompilation but
recovered the constant table and the login class. The absence of the origin
from source was a deliberate design, never a gap.

The collector Worker later fixed its public endpoints in source, which is a
different decision made against a different threat model: those are the public
hosts an official client uses, and the Worker allowlists host, path, MTS TR
code and GraphQL operation for read-only use.

## The credential-extraction rules, for the record

The overlay's `prepare-sbi-bitwarden-cli-secret.ts` reduced a Bitwarden CLI item
list to the minimum SBI credential. Its rules are the part worth keeping, because
they are what stops a vault export from turning into a cloud secret:

- exactly one item in the list may carry a FIDO2 credential, and it must carry
  exactly one; zero or several is an error, never a guess;
- the password may come from that same item. If it does not, exactly one _other_
  item must both have a password and have a URI whose host equals the passkey's
  RP ID or is a subdomain of it. Zero or several candidates stops the run;
- only HTTPS URIs whose host matches the RP ID survive into the output;
- the output carries the login ID, the login password, those URIs and a single
  passkey credential. Custom fields, notes, the trading password and every other
  service's item are never copied;
- the secret is written to standard output only, for the caller to redirect into
  a file it has already restricted; the surrounding script created the directory
  `0700` and the file `0600`, deleted the temporary file in a `finally`, ran
  `bw lock` on exit, and printed stage and status without any secret value.

The deployed collector needs a narrower thing: a local
`~/.local/share/kogane/secrets/sbi-securities.json` whose shape its README
documents, from which its own `sync-local-secrets.sh` copies only `rpId`,
`origin`, `credentialId`, `keyValue`, the optional `userHandle` and `counter`
into Cloudflare secrets. That file can be produced by hand from `bw get item`
under the rules above. No operational CLI is added to the collector to replace
the overlay, and plaintext local storage of a passkey stays a local-only
convenience: never a repository, container image, CI or artifact.

## Why it stopped

Everything the overlay proved is now implemented directly in the collector
Worker, which does not depend on `mnie` as a runtime, a submodule or a
configuration source, uses no browser, and holds only three Worker secrets.
Keeping the overlay on `main` would keep a second, unreachable copy of the
authentication path plus a patch against an external repository's internals,
which drifts by the day. Its dividend, history-window and origin-validation
findings are recorded above and in `docs/sources/sbi-securities.md`.

## How to reproduce

```sh
git show 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30:poc/sbi-securities/README.md
git restore --source 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30 --worktree -- poc/sbi-securities
```

`README.md` at that commit carries the full step-by-step procedure: clone
`pnsk-lab/mnie` at `c87e65c0a04c03c560962f8ead6e77415fb841f4`, apply
`patches/mnie-sbi-domestic-history.patch`, copy the four `scripts/` files into
the checkout's `scripts/`, and run the verification with the base URLs supplied
at run time. Restore it into a scratch checkout only, and only to re-derive a
finding; the collector, not this overlay, is what collects.
