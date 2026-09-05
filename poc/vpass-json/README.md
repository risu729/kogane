# Vpass JSON client PoC

An intentionally small proof of concept for collecting SMCC Vpass
card statements without Chrome and without reusing an existing browser cookie
jar. It authenticates from a Vpass ID/password, calls Vpass's private JSON API,
and preserves each JSON response as raw evidence.

This is not an official SMCC integration. Endpoint and anti-bot behavior can
change without notice. Do not turn this into a hosted service or send Vpass
credentials, cookies, or card identifiers to a third party.

## Runtime profile

- **Browser: なし。** Cloudflare Browser Run、Container Chrome/Chromium、外部browser sessionを使用しない。
- Worker `fetch`でVpass Androidの認証・card/月列挙・明細JSON protocolを直接実行する。既存browser cookie、JavaScript実行、TLS impersonationも不要である。
- 調査・検証にbrowserを使った履歴があっても、現在のcollector runtime依存ではない。

Before maintaining a private Vpass client, see the
[aggregator alternatives](../../docs/vpass-aggregators.md). In particular,
freee offers a self-service official JSON API for synchronized credit-card
statements, and Zaim has a cheap validation path whose one remaining question
is whether its public API exposes auto-imported rows.

## What it does

1. Creates a fresh in-memory cookie jar and reproduces the Vpass Android 5.12.0
   `Config` / `Fauth` protocol with a stable generated device ID.
2. Authenticates directly from the Vpass ID/password; no browser cookie or TLS
   impersonation is required for this path.
3. Calls `dropdownlist_init/v1` to enumerate cards.
4. Calls `operation_card_update/v1` to select each card in the server-side
   session.
5. Calls `web_meisai_top/v1` with an empty content object. The response's
   `seikyuYMList` / `comSeikyuYMList` is the authoritative list of available
   months; the client does not probe a guessed date range.
6. Calls `web_meisai_top/v1` with `{ "p01": "YYYYMM", "p03": "1" }` for each returned
   month and follows either response family:
   - `WebMeisaiTopDisplayServiceBean`: `p03`/`nextPageRow` pagination.
   - `CustomizedMeisaiAnsDisplayServiceBean`: `meisai_ans/v1`
     `{ seikyuYM, start, end }` pagination. The indices are encoded as strings,
     matching `CardUseDetailRequest` in the Android app.
7. Writes the original JSON bytes page by page plus a small `manifest.json`.

The hosted Worker writes a card-scoped immutable snapshot followed by its
success manifest. A provider failure is represented by an error-only prefix.
After the terminal record is written, the collector durably enqueues its key.
A single-message Queue consumer calls the private importer Service Binding for
one bounded chunk. A `deferred` response is acknowledged only after its signed
continuation has been put back on the Queue; the next delivery repeats this
until the importer returns `sealed`. Importer errors and invalid responses fail
the delivery and are retried, then retained in a dead-letter queue rather than
being reported as a completed import. The importer sanitizes authentication,
session, and card-reference fields before central storage; it never writes to
or deletes from the source R2 bucket.

Before deploying this collector binding for the first time, create the two
private queues named by `wrangler.jsonc`:

```sh
bunx wrangler queues create kogane-vpass-raw-evidence-import
bunx wrangler queues create kogane-vpass-raw-evidence-import-dlq
```

Queue creation and collector deployment happen only after the central route and
importer are healthy. This repository change does not create queues or deploy.

Historical records are resumed one object at a time with:

```sh
bun run backfill:raw-evidence
```

The script reads the collector admin token from a user-owned mode-0600 file,
stores only an opaque signed cursor locally, treats staged chunks as progress,
and stops without advancing past a record that fails validation. It emits only
aggregate counts and safe error codes. No GitHub Actions schedule is used; the
existing Worker cron remains the sole scheduled trigger.

The PoC deliberately does not turn the provider JSON into final ledger rows.
That parsing belongs to Kogane's deterministic observation layer; keeping the
responses intact makes it possible to re-parse them later.

The temporary daily Cloudflare deployment is documented in
[`../../docs/vpass-cloudflare-temporary-collector.md`](../../docs/vpass-cloudflare-temporary-collector.md).

## Run

Requires Bun 1.3 or later and the two exact public-key assets recovered from the
APK as described in
[`../../docs/vpass-android-reproduction.md`](../../docs/vpass-android-reproduction.md).

```powershell
cd poc/vpass-json
bun install
bun run scrape:mobile -- --auth-key /private/f2hKiZCtFQdbfuiVGduZ.pem --config-key /private/pubkey_relese.pem
```

The password prompt is masked. Credentials and cookies are neither printed nor
written to disk. To choose an output directory, add `--output`. The older
browser-shaped `impit` experiment remains available as `bun run scrape`.

```powershell
bun run scrape:mobile -- --auth-key /private/auth.pem --config-key /private/config.pem --output "D:\private\kogane-vpass"
```

The default is a timestamped directory below `poc/vpass-json/output/`, which is
gitignored. Output contains full financial data and must be treated as
sensitive.

```text
output/<timestamp>/
├── manifest.json
├── session/card-list.json
└── card-001/
    ├── select-card.json
    ├── web-meisai-top.json
    └── months/202608/
        ├── top-000.json
        └── answer-001.json
```

## Known limitations

- The Android API authentication, all-card selection, available-month discovery,
  finalized statements, and unsettled statements were live validated with a
  fresh session. Account-specific response data and counts are not committed.
  The hosted collector remains an intentionally disposable experiment, not a
  stable provider integration.
- Accounts that require an additional authentication interaction are not
  supported.
- The normal `WebMeisaiTopDisplayServiceBean.meisaiList` uses positional
  `rowType`/`data` arrays. This PoC saves those arrays losslessly instead of
  guessing their meaning.
- On HTTP 401/403 the client stops without retrying. This avoids login loops and
  account lockout when Akamai or Vpass behavior changes.
