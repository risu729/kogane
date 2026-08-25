# Vpass JSON client PoC

An intentionally small, local-only proof of concept for collecting SMCC Vpass
card statements without Chrome and without reusing an existing browser cookie
jar. It authenticates from a Vpass ID/password, calls Vpass's private JSON API,
and preserves each JSON response as raw evidence.

This is not an official SMCC integration. Endpoint and anti-bot behavior can
change without notice. Do not turn this into a hosted service or send Vpass
credentials, cookies, or card identifiers to a third party.

Before maintaining a private Vpass client, see the
[aggregator alternatives](../../docs/vpass-aggregators.md). In particular,
freee offers a self-service official JSON API for synchronized credit-card
statements, and Zaim has a cheap validation path whose one remaining question
is whether its public API exposes auto-imported rows.

## What it does

1. Creates a fresh in-memory cookie jar and uses `impit`'s Chrome TLS/HTTP
   fingerprint.
2. Bootstraps the Vpass device/API session and submits the login form.
3. Calls `dropdownlist_init/v1` to enumerate cards.
4. Calls `operation_card_update/v1` to select each card in the server-side
   session.
5. Calls `web_meisai_top/v1` with an empty content object. The response's
   `seikyuYMList` / `comSeikyuYMList` is the authoritative list of available
   months; the client does not probe a guessed date range.
6. Calls `web_meisai_top/v1` with `{ "p01": "YYYYMM" }` for each returned
   month and follows either response family:
   - `WebMeisaiTopDisplayServiceBean`: `p03` cursor pagination.
   - `CustomizedMeisaiAnsDisplayServiceBean`: `meisai_ans/v1`
     `start`/`end` pagination using the returned `total` and `pageSize`.
7. Writes the original JSON bytes page by page plus a small `manifest.json`.

The PoC deliberately does not turn the provider JSON into final ledger rows.
That parsing belongs to Kogane's deterministic observation layer; keeping the
responses intact makes it possible to re-parse them later.

## Run

Requires Bun 1.3 or later.

```powershell
cd poc/vpass-json
bun install
bun run scrape
```

The password prompt is masked. Credentials and cookies are neither printed nor
written to disk. To choose an output directory:

```powershell
bun run scrape -- --output "D:\private\kogane-vpass"
```

The default is a timestamped directory below `poc/vpass-json/output/`, which is
gitignored. Output contains full financial data and must be treated as
sensitive.

```text
output/<timestamp>/
├── manifest.json
├── session/card-list.json
└── card-01/
    ├── select-card.json
    ├── available-months.json
    └── 202608/
        ├── top-000.json
        └── answer-001.json
```

## Known limitations

- The pre-authentication flow has been verified with multiple fresh sessions;
  a real credential login and post-login collection still need live validation.
- Accounts that require an additional authentication interaction are not
  supported.
- The normal `WebMeisaiTopDisplayServiceBean.meisaiList` uses positional
  `rowType`/`data` arrays. This PoC saves those arrays losslessly instead of
  guessing their meaning.
- On HTTP 401/403 the client stops without retrying. This avoids login loops and
  account lockout when Akamai or Vpass behavior changes.
