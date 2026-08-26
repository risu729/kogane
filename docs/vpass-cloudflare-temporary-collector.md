# Temporary Cloudflare collector

This PoC is temporarily deployed as a plain Cloudflare Worker. It authenticates
through the Vpass Android API once per day and writes the unmodified statement
JSON responses to a private R2 bucket. It does not require Browser Rendering,
Containers, `impit`, a home exit IP, or a long-lived browser cookie.

## Temporary resources

All disposable resources use the same prefix:

- Worker: `kogane-vpass-collector-poc`
- R2 bucket: `kogane-vpass-collector-poc`
- Cron: `0 21 * * *` (daily at 21:00 UTC / 06:00 JST)
- Worker secrets: `VPASS_ID`, `VPASS_PASSWORD`, `VPASS_DEVICE_ID`,
  `VPASS_AUTH_PUBLIC_KEY_B64`, `VPASS_CONFIG_PUBLIC_KEY_B64`, and
  `ADMIN_TRIGGER_TOKEN`

The R2 bucket is private. Worker logs contain only counts and timestamps. Raw
Vpass responses, which include sensitive financial data, are stored only in R2.

## Object layout

```text
vpass/YYYY/MM/DD/<run-id>/card-NNN/
├── snapshot.json
└── manifest.json
```

`snapshot.json` contains the exact raw JSON text for the card list, card
selection, month list, and all statement pages. Keeping one card in one Worker
run and bundling its raw responses into one R2 object keeps memory bounded. The
daily Cloudflare Cron Trigger opens one authenticated session, enumerates the
cards returned by Vpass, and captures them sequentially in the same
`scheduled()` invocation. All cards in a daily run therefore share one
`<run-id>` directory. An interrupted card has `error.json` instead of the two
success objects; the handler still attempts the remaining cards and reports the
Cron invocation as failed after it has written all available evidence.

This deliberately targets Workers Paid. The previous Queue fan-out existed to
stay below the Workers Free limit of 50 external subrequests per invocation. A
Paid Worker now receives 10,000 subrequests by default, while a daily Cron
Trigger has a 15-minute execution window. The live six-card capture was measured
well below both limits, so Queue fan-out and six independent logins add cost and
failure surface without providing useful isolation. See Cloudflare's current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Cron Trigger documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Cloudflare Cron Trigger is the only periodic scheduler. Do not add a scheduled
GitHub Actions workflow for this collector.

## Deploy and inspect

Run from `poc/vpass-json` in WSL. Secrets must be supplied through
`wrangler secret put`; never place them in `.dev.vars`, shell history, or this
repository. The two public-key secrets are base64 encodings of the exact APK
assets so that line-ending normalization cannot change their pinned SHA-256
hashes.

```sh
bun install
bun run cf:types
bun run cf:deploy
```

Inspect objects in the private R2 dashboard, or fetch a known manifest key with
`npx wrangler r2 object get <bucket>/<key> --remote --pipe`.

`POST /__collect?card=N` exists only for protected first-run/diagnostic
collection and requires
`Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`.
`GET /health` does not initiate a login. The scheduled handler is the ordinary
execution path.

## Live verification

The complete path was verified on 2026-08-26:

1. The local Android client authenticated from a fresh cookie jar, enumerated
   all cards and all server-advertised months, and saved non-empty statement
   rows from both response families.
2. A direct Worker card invocation produced the same page and row counts as the
   local run, then its R2 manifest was read back and compared.
3. The protected enqueue endpoint then published one job per card and every
   Queue consumer stored its two R2 objects. That Free-plan validation is the
   historical baseline; the Paid-plan code removes the Queue and processes the
   same card sequence directly from `scheduled()`.

Only structural counts were logged during verification. Credentials, cookies,
card identifiers, public-key bodies, and financial response bodies were not
printed or committed.

## Paid-plan migration

The repository change does not mutate the live deployment. Deploy the updated
Worker first, verify one complete Cron run in R2, and only then delete the
legacy `kogane-vpass-collector-poc` Queue. Removing the Queue before deploying
would break the currently deployed Free-plan version.

## Remove everything

First download anything that should be retained. Deleting the bucket also
deletes all collected statement data.

```sh
npx wrangler delete --name kogane-vpass-collector-poc
npx wrangler r2 bucket delete kogane-vpass-collector-poc
```

The Worker deletion removes its Cron Trigger and secrets with the Worker. The
R2 deletion is intentionally separate and destructive. If the legacy Free-plan
Queue still exists, remove it separately with
`npx wrangler queues delete kogane-vpass-collector-poc`.
