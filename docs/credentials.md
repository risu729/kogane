# Credential Delivery

Authenticated collectors need a Vpass ID/password at runtime. Kogane should
not place a Bitwarden master password, session key, personal API key, whole
vault cache, or long-lived browser cookie jar in Cloudflare.

## Decision

Use a local, explicit sync command to copy only the fields required by one
collector from an already-unlocked Bitwarden CLI into Cloudflare Worker
secrets:

```text
Bitwarden Password Manager
  -> local `bw` (interactive unlock; no stored master password)
  -> `kogane credentials sync vpass`
  -> VPASS_ID + VPASS_PASSWORD Worker secrets
  -> passed to one short-lived collector Container at start
```

Run the command after changing the Vpass login item in Bitwarden. This is
deliberately push-on-change rather than a cloud process that can continuously
decrypt the personal vault.

Use per-Worker secrets first. They are stable, scoped to the collector, and do
not expose the credentials to unrelated Workers. Cloudflare
[Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/)
is a reasonable later move when several deployed components need the same
secret, but it is account-level and currently beta. Both can be passed to a
[Container as environment variables](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).

## Local sync command contract

The implementation should:

1. Require pinned, locally installed `bw`, `jq`, and `wrangler` versions plus
   the Kogane deployment config. The command must never download or execute a
   package after secret material enters the pipeline.
2. Run `bw status` and refuse `unauthenticated`. If it is locked, invoke
   `bw unlock --raw` so `bw` prompts interactively; Kogane must not accept or
   store the master password. Keep `BW_SESSION` only for the command's
   lifetime.
3. Run `bw sync`, then retrieve one item by a fixed UUID. Do not select an item
   by a human-readable search string.
4. Validate the item type, non-empty username/password, and an allowlisted
   Vpass URI before extracting anything.
5. Build a two-key JSON object in process memory and send it to
   `wrangler secret bulk` through stdin. This updates both fields in one
   request. Never use a command-line `--value`, a temporary `.env`/JSON file,
   shell tracing, or stdout logging.
6. Record only non-secret sync metadata locally: Bitwarden item UUID,
   `revisionDate`, target Worker/environment, time, and success/failure. This
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
target_worker: kogane-collector-vpass
fields:
  login.username -> VPASS_ID
  login.password -> VPASS_PASSWORD
```

The item UUID is not a credential, but keeping it in a local config rather
than the public repository avoids leaking vault organization details. The
Cloudflare account ID, store ID, and secret IDs are also identifiers rather
than secret values; they may be configuration, although there is no need to
commit personal deployment identifiers for the PoC.

An equivalent one-shot shell prototype is shown below. The real CLI should
spawn these programs directly and perform the same validation without a
shell. It should lock Bitwarden on exit only when it created the unlock
session itself.

```bash
(
  set -euo pipefail
  set +x
  umask 077

  export BW_SESSION
  BW_SESSION="$(bw unlock --raw)"
  trap 'bw lock >/dev/null 2>&1 || true; unset BW_SESSION' EXIT

  bw sync
  bw get item "$VPASS_BW_ITEM_ID" --session "$BW_SESSION" |
    jq -ce '
      if (.login.username | type) != "string"
         or (.login.password | type) != "string"
      then error("Bitwarden item has no login credentials")
      else {
        VPASS_ID: .login.username,
        VPASS_PASSWORD: .login.password
      }
      end
    ' |
    wrangler secret bulk --name kogane-collector-vpass
)
```

The production wrapper must additionally validate the item's allowlisted URI
before sending the JSON. `secret bulk` reads stdin and updates both fields in
a single request, avoiding the inconsistent state caused by two sequential
`secret put` deployments. Install and pin Wrangler before running the
prototype; do not replace this command with an unpinned `npx wrangler` at the
secret-bearing end of the pipe.

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

| Option | Cloud credential | Scope | Decision |
| --- | --- | --- | --- |
| Local `bw` -> Worker secrets | Only Vpass ID/password | One Worker | **Use now.** Smallest blast radius and no stored master password. |
| Local `bw` -> Secrets Store | Only selected fields | Account-level bindings | Use when multiple Workers need the same value; beta today. |
| Bitwarden Secrets Manager | Machine access token | Selected Secrets Manager project | Revisit for project-scoped runtime reads, revocation, or multiple consumers; Password Manager values still need a separate sync. |
| Password Manager API key + unlock | API key plus master/decryption secret | Personal vault | Reject for runtime use. |
| Copied `data.json` / encrypted export | Master/export password or equivalent | Whole vault | Reject. |
| `bw serve` behind Tunnel | Long-lived unlocked session | Most CLI/vault actions | Reject. |

Bitwarden Secrets Manager is materially safer than exposing Password Manager:
a machine account can be limited to one project and its token can read only
assigned secrets. It is still unnecessary for manual push-on-change, and its
access token becomes the persistent secret that must be protected and
rotated. It does not automatically copy a Password Manager item or rotate the
Vpass password. Adopt it only when project-scoped retrieval, token expiry and
revocation, or secret updates without a Cloudflare deployment justify a
Kogane-owned publisher/sync step.

## Runtime rules

- The coordinator reads only `VPASS_ID` and `VPASS_PASSWORD` and passes
  them only to the named Vpass Container instance.
- Do not store credentials in D1, KV, R2, Durable Object state, build arguments,
  images, artifacts, or logs.
- Keep cookies in memory for one run; never log `Cookie`, `Set-Cookie`, card
  identifiers, request bodies, or authentication responses.
- Before normal ingestion, scan response classes known to contain
  authentication material. If a response unexpectedly contains a credential
  or session token, refuse normal ingestion and record only non-sensitive run
  metadata plus a hash for investigation. Never redact a payload and label the
  result as byte-exact raw evidence.
- On 401/403, stop without retrying and alert for a manual credential/status
  check.
- After a credential sync, run one read-only smoke collection before enabling
  or resuming Cron.

## References

- [Bitwarden Password Manager CLI](https://bitwarden.com/help/cli/)
- [Bitwarden local data storage](https://bitwarden.com/help/data-storage/)
- [Bitwarden encrypted exports](https://bitwarden.com/help/encrypted-export/)
- [Bitwarden Secrets Manager access tokens](https://bitwarden.com/help/access-tokens/)
- [Bitwarden Secrets Manager machine accounts](https://bitwarden.com/help/machine-accounts/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler `secret bulk`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk)
- [Cloudflare Secrets Store Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)
