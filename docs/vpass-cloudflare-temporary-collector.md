# Temporary Cloudflare collector

This PoC is temporarily deployed as a plain Cloudflare Worker. It authenticates
through the Vpass Android API once per day and writes the sanitized statement
JSON responses, one run per card, into the shared `DATA` bucket
(`kogane-raw-evidence`). It does not require Browser Rendering,
Containers, `impit`, a home exit IP, or a long-lived browser cookie.

## Temporary resources

All disposable resources use the same prefix:

- Worker: `kogane-vpass-collector-poc`
- R2 binding: `DATA` → `kogane-raw-evidence`, shared by every collector (the
  per-source bucket `kogane-vpass-collector-poc` was deleted on 2026-09-13;
  see [legacy-retirement.md](legacy-retirement.md))
- Cron: `0 21 * * *` (daily at 21:00 UTC / 06:00 JST)
- Worker secrets: `VPASS_ID`, `VPASS_PASSWORD`, `VPASS_DEVICE_ID`,
  `VPASS_AUTH_PUBLIC_KEY_B64`, `VPASS_CONFIG_PUBLIC_KEY_B64`, and
  `ADMIN_TRIGGER_TOKEN`

The bucket is private. Worker logs contain only counts and timestamps. Vpass
responses, which include sensitive financial data, are stored only in R2.

## Object layout

```text
objects/<first two hex>/<sha256>                 each sanitized artifact of a card run
runs/vpass/<session run id>-card-NNN/terminal.json  written last, one per card
```

A card run's artifacts are `card-list.json`, `select-card.json`,
`web-meisai-top.json`, `months/<yyyymm>/<top|answer>-NNN.json` and
`manifest.json`, sanitized by `vpass-json-sanitizer` v1 before anything is
stored ([collection.md](collection.md#vpass-servicescollector-vpass-kogane-vpass-collector-poc)).
The daily Cloudflare Cron Trigger opens one authenticated session, enumerates
the cards returned by Vpass, and captures them sequentially in the same
`scheduled()` invocation. All card runs of a daily session carry the session
run id as `acquisitionSessionRef`. A card that collected nothing writes a
`failed` terminal with no artifact; the handler still attempts the remaining
cards and reports the Cron invocation as failed after it has written all
available evidence.

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

Run from `services/collector-vpass` in WSL. Secrets must be supplied through
`wrangler secret put`; never place them in `.dev.vars`, shell history, or this
repository. The two public-key secrets are base64 encodings of the exact APK
assets so that line-ending normalization cannot change their pinned SHA-256
hashes.

```sh
bun install
mise run //services/collector-vpass:types
./node_modules/.bin/wrangler deploy
```

Fetch a card run's terminal with
`npx wrangler r2 object get kogane-raw-evidence/runs/vpass/<run id>/terminal.json --remote --pipe`;
its `artifacts[]` names the content-addressed key of every stored object.

`POST /__collect-all` and `POST /__collect?card=N` exist only for protected
first-run/diagnostic collection and require
`Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`.
`GET /health` does not initiate a login. The scheduled handler is the ordinary
execution path; the all-card endpoint is not an external scheduler.

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

```sh
npx wrangler delete --name kogane-vpass-collector-poc
```

The Worker deletion removes its Cron Trigger and secrets with the Worker. Do
not delete the shared `DATA` bucket: every collector and the Processor use it.
If the legacy Free-plan Queue still exists, remove it separately with
`npx wrangler queues delete kogane-vpass-collector-poc`.

## 共通 DATA R2 への切替 (U09)

Collector は常に共通 bucket `kogane-raw-evidence` へ書く。`src/sanitize.ts`
（旧 importer と同じ `vpass-json-sanitizer` v1）で sanitize した bytes を
content-addressed に保存し、terminal manifest を最後に書く。card ごとに 1 run
（`<runId>-card-NNN`、`acquisitionSessionRef` は session の runId）で、raw
envelope・cookie・card identify key は保存しない。`COLLECTION_TARGET` の切替、
per-source bucket、importer による中央転送は 2026-09-13 に廃止した
（[legacy-retirement.md](legacy-retirement.md)）。artifact と role の対応と deploy
順は `docs/collection.md` の該当節を参照。
