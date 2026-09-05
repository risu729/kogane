# Credential Delivery

Vpass now has two different secret boundaries. The accepted browser issuer
needs the Vpass ID/password when a login or refresh is required. A cloud replay
collector needs only a currently valid authenticated session and must not
receive the ID/password. Kogane must not place a Bitwarden master password,
session key, personal API key, or whole vault cache in Cloudflare.

## Decision

Use a local, explicit sync command to copy only the two Vpass fields from an
already-unlocked Bitwarden CLI into the browser issuer's source-scoped secret
store. After the issuer authenticates and validates My Page, publish only an
encrypted session envelope for the Linux/cloud consumer:

```text
Bitwarden Password Manager
  -> local `bw` (interactive unlock; no stored master password)
  -> `kogane credentials sync vpass`
  -> VPASS_ID + VPASS_PASSWORD for the accepted persistent issuer only
  -> established Chrome profile authenticates and validates the session
  -> encrypted, source-scoped session envelope
  -> short-lived Linux/Cloudflare consumer (no password-login capability)
```

Run the command after changing the Vpass login item in Bitwarden. This is
deliberately push-on-change rather than a cloud process that can continuously
decrypt the personal vault. Visible Windows Chrome has produced the only
observed successful bootstraps, in both established and fresh profiles, but it
has also produced fresh-profile failures under closely related conditions and
is not yet a repeatable baseline. The physical Windows machine is not the
intended deployment dependency. The eventual issuer may be a coherent
Windows/macOS browser implementation in a Cloudflare Container, or a real
non-Windows platform, but no candidate receives credentials until it passes the
bootstrap gate repeatedly.

Do not sync `VPASS_ID` or `VPASS_PASSWORD` to Worker secrets while the Linux
bootstrap gate is failing. If a future cloud runtime independently passes that
gate, per-Worker secrets can be reconsidered; that is not the current design.

## Browser issuer sync contract

The implementation should:

1. Require pinned, locally installed `bw` and issuer-helper versions plus the
   Kogane issuer config. The command must never download or execute a package
   after secret material enters the pipeline.
2. Run `bw status` and refuse `unauthenticated`. If it is locked, invoke
   `bw unlock --raw` so `bw` prompts interactively; Kogane must not accept or
   store the master password. Keep `BW_SESSION` only for the command's
   lifetime.
3. Run `bw sync`, then retrieve one item by a fixed UUID. Do not select an item
   by a human-readable search string.
4. Validate the item type, non-empty username/password, and an allowlisted
   Vpass URI before extracting anything.
5. Transfer both fields over a local authenticated IPC channel into the
   source-scoped browser issuer secret store. Never use command-line values, a
   temporary `.env`/JSON file, shell tracing, or stdout logging. If the chosen
   Windows secret store cannot atomically update both fields, keep the previous
   generation active until the new pair has been validated.
6. Record only non-secret sync metadata locally: Bitwarden item UUID,
   `revisionDate`, target issuer/environment, time, and success/failure. This
   allows `credentials status vpass` to warn that Bitwarden changed after the
   last successful push.
7. Drop references to the item JSON and secret strings immediately after the
   subprocesses finish. Lock the CLI vault on exit only if this command created
   its unlock session; do not invalidate a session it inherited from the
   user's terminal.

Non-secret configuration may name the mapping:

```text
source: vpass
bitwarden_item_id: <fixed UUID, local config only>
target_issuer: kogane-session-issuer-vpass
fields:
  login.username -> VPASS_ID
  login.password -> VPASS_PASSWORD
```

The item UUID is not a credential, but keeping it in a local config rather
than the public repository avoids leaking vault organization details. The
real CLI should spawn programs directly, validate the allowlisted URI before
extracting fields, and lock Bitwarden on exit only when it created the unlock
session itself.

## Authenticated session handoff

The session envelope is a bearer credential even though it does not contain
the password. It must contain only what the Vpass consumer needs, for example:

```text
source = vpass
generation_id = random unique value
issued_at / observed_cookie_expiry
cookie records scoped by domain, path, Secure, HttpOnly, SameSite, expiry
optional non-secret browser compatibility metadata
authenticated_health_check = endpoint + validation rule, not response data
```

The issuer encrypts the envelope to a consumer-specific key before it leaves
the issuer. Store the ciphertext in private object storage only if needed for
handoff; keep the decryption key in a source-specific Worker/Container secret.
Never put plaintext cookies in D1, KV, R2, Durable Object state, build layers,
environment dumps, logs, or crash reports. Do not reuse one envelope across
unrelated scrapers or concurrent runs.

The consumer imports one generation immediately before navigation, validates
an authenticated page, performs the read-only JSON calls, and discards its
local profile/cookie jar. A login redirect, 401, or 403 marks the generation
unusable and asks the issuer for refresh; the consumer never falls back to
password login. Cookie expiry is only a hint, so every run needs the health
check. Idle keep-alive may extend a session, but absolute lifetime remains
unmeasured and must not be assumed.

## Why not copy `data.json`

Bitwarden CLI stores encrypted vault state in `data.json` under its app-data
directory. Bitwarden documents that encrypted data is persistent locally and
decrypted data exists only in memory while unlocked. Copying this file to
Cloudflare would still require a master password or equivalent decryption
material in Cloudflare, and would expand compromise from two Vpass fields to
the entire personal vault.

An encrypted Bitwarden export has the same shape problem. An account-bound
export carries the whole vault and depends on that account's encryption key;
a password-protected export introduces another long-lived password that the
cloud runtime must store. A custom encrypted credential blob merely moves the
key-management problem: if the decryption key sits beside the blob, it is no
safer and is harder to rotate/audit than a native secret binding.

## Why not `bw serve`

`bw serve` exposes all CLI actions over a local Express HTTP API. Its safe
default is localhost and it blocks requests with an `Origin` header. Running
it as a long-lived cloud or Tunnel service would require keeping a personal
vault session unlocked and would expose a broad vault API across a network
boundary. It is the wrong privilege and lifetime for a collector that needs
only two values a few times per month.

The personal Bitwarden API key does not fix this. Bitwarden documents that API
key login authenticates the CLI but does not replace the master password:
vault-reading commands still require `bw unlock` and a decryption session.

## Alternatives

| Option                                           | Cloud credential                      | Scope                            | Decision                                                                                                                         |
| ------------------------------------------------ | ------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Local `bw` -> accepted persistent browser issuer | Only Vpass ID/password                | One source issuer                | Use only after the selected issuer passes repeated bootstrap; store no master password.                                          |
| Encrypted issuer -> consumer envelope            | One Vpass bearer session              | One source and generation        | **Use for replay PoC.** Rotate on refresh and validate before every run.                                                         |
| Local `bw` -> Worker secrets                     | Only Vpass ID/password                | One Worker                       | Do not use now; reconsider only if a cloud password bootstrap passes independently.                                              |
| Local `bw` -> Secrets Store                      | Only selected fields                  | Account-level bindings           | Same bootstrap gate applies; beta today.                                                                                         |
| Bitwarden Secrets Manager                        | Machine access token                  | Selected Secrets Manager project | Revisit for project-scoped runtime reads, revocation, or multiple consumers; Password Manager values still need a separate sync. |
| Password Manager API key + unlock                | API key plus master/decryption secret | Personal vault                   | Reject for runtime use.                                                                                                          |
| Copied `data.json` / encrypted export            | Master/export password or equivalent  | Whole vault                      | Reject.                                                                                                                          |
| `bw serve` behind Tunnel                         | Long-lived unlocked session           | Most CLI/vault actions           | Reject.                                                                                                                          |

Bitwarden Secrets Manager is materially safer than exposing Password Manager:
a machine account can be limited to one project and its token can read only
assigned secrets. It is still unnecessary for manual push-on-change, and its
access token becomes the persistent secret that must be protected and
rotated. It does not automatically copy a Password Manager item or rotate the
Vpass password. Adopt it only when project-scoped retrieval, token expiry and
revocation, or secret updates without a Cloudflare deployment justify a
Kogane-owned publisher/sync step.

## Runtime rules

- Only the accepted browser issuer may read `VPASS_ID` and `VPASS_PASSWORD`. The
  coordinator and consumer must not receive them.
- Do not store credentials or plaintext session envelopes in D1, KV, R2,
  Durable Object state, build arguments, images, artifacts, or logs.
- Never log `Cookie`, `Set-Cookie`, card identifiers, authentication request
  bodies, or authentication responses. Captured Akamai/sensor payloads are
  diagnostics, not financial evidence, and must not enter normal ingestion.
- Before normal ingestion, scan response classes known to contain
  authentication material. If a response unexpectedly contains a credential
  or session token, refuse normal ingestion and record only non-sensitive run
  metadata plus a hash for investigation. Never redact a payload and label the
  result as byte-exact raw evidence.
- On a login redirect or 401/403, stop without retrying and request an issuer
  refresh/manual status check.
- After a credential sync or session refresh, run one read-only replay smoke
  collection before enabling or resuming Cron.

## References

- [Bitwarden Password Manager CLI](https://bitwarden.com/help/cli/)
- [Bitwarden local data storage](https://bitwarden.com/help/data-storage/)
- [Bitwarden encrypted exports](https://bitwarden.com/help/encrypted-export/)
- [Bitwarden Secrets Manager access tokens](https://bitwarden.com/help/access-tokens/)
- [Bitwarden Secrets Manager machine accounts](https://bitwarden.com/help/machine-accounts/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler `secret bulk`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk)
- [Cloudflare Secrets Store Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)
