# TAMIA raw TCP bridge PoC

This PoC tests whether a native browser-impersonation client can keep its own
TLS and HTTP/2 fingerprint while sending only selected destinations through the
pre-existing `tamia` Cloudflare Tunnel. It is deliberately a narrow diagnostic,
not a general-purpose proxy.

The local adapter accepts HTTP CONNECT only on `127.0.0.1:18787`. It converts
the byte stream to an authenticated Worker WebSocket. The Worker selects one of
four fixed path-to-host mappings and opens a raw `env.TAMIA.connect()` socket.
The inner TLS handshake remains between the local client and the destination;
the Worker carries opaque bytes and does not terminate that TLS session.

## Safety boundaries

- The client cannot choose an arbitrary destination or port.
- The Worker requires a random, temporary `BRIDGE_TOKEN` secret.
- The local adapter installs the secret at startup and deletes it on shutdown.
- The Worker limits each direction to 16 MiB, queued client data to 512 KiB,
  and a connection to 90 seconds.
- The public root reports only enabled/disabled state and fixed destination
  names. The Worker stores no traffic or credentials.
- `tamia` is referenced infrastructure and must never be deleted by this PoC.

## Run a non-authentication route probe

Requires Bun, Python, `curl_cffi`, and `websocket-client`.

```bash
bun install
bun run typegen
bun run typecheck
python -m pip install -r requirements.txt curl_cffi==0.16.1
python scripts/bridge_proxy.py
```

In a second terminal:

```bash
python scripts/route_probe.py
python scripts/client_probe.py fingerprint \
  --profile chrome116 \
  --proxy http://127.0.0.1:18787 \
  --label tamia-jp-win116
python scripts/client_probe.py bootstrap \
  --profile chrome116 \
  --proxy http://127.0.0.1:18787 \
  --label tamia-jp-win116
```

`route_probe.py` prints only an IP SHA-256 hash and Cloudflare's country/WARP/
Gateway fields. `client_probe.py` never prints response bodies, cookies, or
credentials. Its `login` mode prompts with echo disabled and performs no retry,
but it should not be used casually against a real account.

## Chrome 151 Windows test client

The Chrome 151 profile was not in the published `impit@0.14.3` package at test
time. It was built from upstream commit
`4fd6c3167c55d9d059a3e5872846e0b5c0a31e3b`:

```bash
git clone https://github.com/apify/impit.git
cd impit
git checkout 4fd6c3167c55d9d059a3e5872846e0b5c0a31e3b
pnpm --dir impit-node install --frozen-lockfile
pnpm --dir impit-node build
```

The relevant client options are:

```ts
new Impit({
  browser: "chrome151",
  proxyUrl: "http://127.0.0.1:18787",
});
```

See `RESULTS.md` for the observed network and Vpass behavior, and
`RESOURCE_INVENTORY.md` before changing or deleting any Cloudflare resource.
