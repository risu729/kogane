# Cloudflare Browser Run Vpass probe

This PoC tests a technically different client from transport impersonation:
Cloudflare Browser Run (formerly Browser Rendering) executes a real remote
Chromium instance and lets Vpass JavaScript run.

It is a bounded diagnostic, not a collector. The deployed Worker accepts only
authenticated POST requests to the fixed `/inspect` and `/login` actions. Vpass
credentials and the probe bearer token are Worker secrets, never request
parameters, source code, logs, or files.

## Important network limitation

Browser Run traffic originates from Cloudflare IP ranges and includes
Cloudflare browser-identification headers. It cannot use the local
`TAMIA.connect()` adapter in this PoC, so this test does not combine Browser Run
with the Japanese home IP.

## Build and inspect

```bash
bun install
bun run typegen
bun run typecheck
bun run deploy:dry
bun run deploy:bootstrap
```

Set secrets interactively only after the disabled bootstrap Worker exists:

```bash
bunx wrangler secret put VPASS_ID --name kogane-vpass-browser-run-20260825
bunx wrangler secret put VPASS_PASSWORD --name kogane-vpass-browser-run-20260825
```

The one-shot runner creates a random `PROBE_TOKEN`, deploys the final Worker,
calls exactly one action, and deletes the token in `finally`:

```bash
python -m pip install -r requirements.txt
python scripts/run_once.py inspect
```

Do not run `login` repeatedly against a real account. It fills the actual Vpass
form and clicks its submit control once:

```bash
python scripts/run_once.py login
```

After any live test, delete both Vpass secrets and return the Worker to its
disabled bootstrap version. The exact commands and retained-resource status are
in `RESOURCE_INVENTORY.md`.
