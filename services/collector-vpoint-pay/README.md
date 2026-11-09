# V Point Pay Worker PoC

This independent PoC captures `VポイントPay` (V Point Pay) prepaid balances and usage details for every available month from the official Android app's first-party JSON API, storing raw responses and a manifest in private R2. The `Vポイント` (V Point)/`Vマネー` (V Money) Web ledger belongs to `services/collector-vpoint/`, and `三井住友カード` (Sumitomo Mitsui Card) billing statements belong to the Vpass collector; they are not mixed.

<a id="静的解析で確認したread-surface"></a>

## Read surface confirmed by static analysis

The following were confirmed from the Retrofit definitions and decrypted protected DEX of APK candidate `com.smbc_card.vpoint` 2.5.0. Binaries, ordinary decompiler output and decrypted DEX stay only in the private Android archive; this repository contains only sanitized specifications and implementation.

- `POST /vpoint/api/v2/token`: authorization-code or refresh-token grant.
- `GET /vpoint/api/v2/prepaid/balance`: JPY balance, top-up limit and `inquiry_period`.
- `GET /vpoint/api/v1/prepaid/transaction?target_month=yyyyMM`: monthly usage details.
- `X-Vapp-Access-Token`, app/OS/User-Agent and time-dependent `device_id` headers.

The detail schema includes usage date, description, original currency/amount, billing currency/amount, fees, exchange rate, confirmation state, authorization number, remarks, activity type and transaction type. Raw snapshots retain authorization, settlement, refund and charge as distinct states.

The app uses balance-response `inquiry_period` as its earliest selectable month. This PoC likewise scans inclusively from that value through the current JST month, with a 120-month safety limit for unexpected responses.

<a id="停止状態"></a>

## Disabled state

The app API collector is stopped. It has no Cron; manual `/trigger`, `/probe` and `/reset-credentials` return HTTP 410. Delayed scheduled events do not collect either. `/health` returns `collectionEnabled: false` and `status: "disabled"`. The Durable Object and app credential secrets are retained; only the admin token is being retired. Original R2 objects in the old dedicated source bucket were copied to central DATA, verified and then deleted on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)). V Point Pay notification emails continue to be collected by `services/collector-vpoint/`. The authentication/deployment explanations below are research records.

Central V Point Pay evidence consists only of `v-point-pay-email` runs saved to shared DATA by `services/collector-vpoint` (the old dedicated Importer was retired on 2026-09-13). App snapshots and disabled endpoints are excluded. The email source, app API source and reconciliation generated from V Point itself are separate boundaries. Enabling this Worker's Cron or polling requires separate live-contract verification first.

Reaching the unauthenticated `/probe` does not mean balance/detail capture succeeded. API authentication needs a real UUID and refresh token from the same session; a placeholder UUID is not a substitute. Concurrent use with the device app and token-refresh races are unverified; no automatic re-registration or device migration is performed.

Public `/credential-status` is retired (404) and reads neither state nor credentials. Disabled `/trigger`, `/probe` and `/reset-credentials` remain 410, without changing the DO or app credentials themselves.

<a id="認証とworker化"></a>

## Authentication and Worker execution

Initial setup alone uses the official app's phone number/SMS/6-digit app passcode. Copy its refresh token and the random device UUID stored in Realm into Worker secrets once. Protected-DEX `EncryptDevice` generates `device_id` from only the UUID and current epoch seconds, without Android Keystore or hardware attestation, so it can be reproduced in a Worker.

Each run first performs a refresh-token grant. The rotated refresh token in the response is saved immediately in a single SQLite Durable Object and used thereafter. Tokens, UUID and access tokens appear in neither R2, manifests, logs nor HTTP responses.
After a secret update, the Durable Object used to be reseeded through the
admin-token `POST /reset-credentials`. That route now answers 410 (`src/worker.ts`), so there is no reseed path while the app collector is stopped.

Static analysis found no OkHttp `CertificatePinner`; network security configuration only prohibited cleartext. This strongly suggests standard Workers `fetch()` may work, but refresh-token lifetime, device revocation and actual enum values await live verification with the owner's account.

## R2 layout

If re-enabled, runs save the following artifacts as `objects/<2 hex>/<sha256>` in shared DATA, then write terminal `runs/v-point-pay/<run-id>/terminal.json` last.

```text
balance.json
transactions-YYYYMM.json
...
collection-summary.json
```

<a id="開発とデプロイ"></a>

## Development and deployment

```bash
mise run install                                  # from the repository root
mise run //services/collector-vpoint-pay:test
mise run //services/collector-vpoint-pay:ci
mise run //services/collector-vpoint-pay:dry-run
```

Required resources/secrets:

- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; the old dedicated source bucket was deleted on 2026-09-13)
- SQLite Durable Object: `VPointPayCredentialState`
- secret: `VPOINT_PAY_REFRESH_TOKEN`
- secret: `VPOINT_PAY_DEVICE_UUID`
- Cron: none (app API collector stopped)

There is no public manual collection. `GET /health` returns only the disabled state. The Worker has no `ScheduledCollection` entrypoint and no job in `config/alarm-jobs.json` serves it (the `vpoint-pay` job there is `supported: false`, with no workspace).

When removing the verification environment, remove the following as a unit.

1. Worker `kogane-vpoint-pay-collector-poc` (including secrets and Durable Object).

Keep shared DATA because other collectors and the Processor also use it.

## 2026-08-31 deployment checkpoint

The Worker and R2 bucket were actually created, and `GET /health` was confirmed to return HTTP 200. Next, `POST /probe`, calling unauthenticated `/vpoint/api/v2/common_settings` through standard Worker `fetch()`, also returned HTTP 200. Thus Cloudflare edge IP, the Worker TLS stack and browser absence alone did not cause rejection by the app origin.

App credential secrets were placeholders because owner app bootstrap had not happened. Real-account `/trigger` success, R2 raw data, enums and the earliest month were unconfirmed. Created resources and removal steps were recorded in `RESOURCE_INVENTORY.md`.
