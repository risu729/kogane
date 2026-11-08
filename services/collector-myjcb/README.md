# MyJCB read-only Worker PoC

This independent PoC reads the official MyJCB Web through a Cloudflare Worker (the Processor alarm calls its `ScheduledCollection` RPC entrypoint, `src/schedule-entrypoint.ts`) and appends captured official HTML and a capture manifest to shared DATA (`kogane-raw-evidence`). It uses neither `mnie` nor code imported from Okura.

The Worker PoC was deployed on 2026-08-31 and completed a real authentication test with the first MyJCB ID. Only one Bitwarden item was synchronized locally. A temporary Browser Run virtual authenticator generated a passkey assertion and reached mypage, then handed cookies and User-Agent to ordinary Worker `fetch`. Available-month enumeration through past-month JSON, credit-detail capture and private-R2 storage of 20 artifacts plus a manifest succeeded in 1 run with failure 0. Raw credentials, WebAuthn assertions, cookies, detail values and file hashes were neither committed nor logged.

## Runtime profile

- **Browser: login only.** The Cloudflare Browser Run binding opens the official login page and runs dynamic login-protection scripts and the NNL Apps SDK WebAuthn flow.
- Passkey mode injects the Bitwarden credential into a temporary CDP virtual authenticator. Password mode also lets the browser generate the official page's dynamic fields/cookies. This bootstraps sessions rather than rendering details.
- After reaching mypage, the complete cookie jar and User-Agent move to ordinary Worker `fetch`, and Browser Run closes. Menus, month-enumeration JSON, detail HTML, CSV/PDF/OFX and R2 storage do not use a browser.

<a id="なぜbrowser-runを使うか"></a>

## Why Browser Run is used

On every load, `/Login` reads `/apl/login-prot.js?init` and `?async` with an ephemeral seed; official JavaScript adds dynamic fields/cookies to the login form. Workers cannot execute arbitrary fetched JavaScript through `eval`/`new Function`; manually reimplementing the protection script would worsen maintainability and the safety boundary. This PoC starts Cloudflare Browser Run only in `src/login-protection.ts`, executing official scripts unchanged in the official page.

After successful login, browser cookies and User-Agent move into `CookieJar`. Ordinary Worker `fetch` captures only GETs and past-month enumeration JSON-RPC POSTs allowed by the method/origin/path/query allowlist in `src/policy.ts`. The browser closes in each connection's `finally`. Dynamic script source, credentials, protected login POST bodies, cookie values and mypage HTML are not stored in R2.

<a id="browser-runを外せるか"></a>

### Can Browser Run be removed?

The sanitized network shape of a successful passkey login confirmed this same-origin order. Query/header/cookie/request-body/response-body values, challenges, assertions and `result` values were not stored.

1. `POST /iss-pc/member/user_manage/PasskeyLogin`
2. `POST /iss-pc/member/user_manage/userLoginPasskeyServiceStatusCommunication.html` (field name: `loginRouteId`)
3. Fetch NNL Apps SDK 9.2.0 UI resources.
4. `POST /iss-pc/member/user_manage/userLoginPasskeyAuthCheckCommunication.html` (field name: `result`)
5. `GET /iss-pc/member/mypage/mypage.html`

This is not a contract for sending a standard WebAuthn assertion directly to a single JSON endpoint: the official NNL SDK assembles the challenge/assertion into opaque `result`. Workers Web Crypto can generate P-256 signatures, but the NNL `result` contract still needs observation, reimplementation and maintenance. The current working implementation therefore uses Browser Run only for login bootstrap. Browser Run has not been proved inherently necessary; a direct passkey client remains a separate investigation for possible future cost optimization. Live execution confirmed that post-login menus, past-month JSON, details, exports and R2 storage do not use Browser Run.

<a id="browserless-passkey-clientの実装計画"></a>

### Browserless passkey client implementation plan

Browserless execution replaces only `loginWithBitwardenPasskey` with direct bootstrap, without rewriting the detail client. Reuse the existing cookie jar, strict read allowlist, parser and R2 storage. Actual `result` values have not been stored, so do not skip this sequence and implement signatures alone.

1. Privately capture several successful logins with the owner's own account. Within each run, correlate NNL SDK resource version/hash, `PublicKeyCredentialRequestOptions` passed to `navigator.credentials.get()`, the returned `PublicKeyCredential`, the immediately following `result`, cookie rotation and relays. Keep challenge/assertion/cookie/`result` values out of the public repository, Worker logs and R2; treat them as private evidence only during necessary analysis.
2. Compare at least two fresh challenges to determine whether `result` is plain JSON/Base64 or includes an SDK-specific envelope, MAC/encryption, transaction ID, SDK metadata or risk/device signals. Do not infer fixed fields from one sample; handle NNL asset-version changes as separate cases.
3. Generate the standard WebAuthn portion with Workers Web Crypto. Inputs are credential ID, P-256 private key, RP ID, user handle and server challenge. Create byte-level test vectors for `clientDataJSON` origin/type/challenge; `authenticatorData` RP ID hash, UP/UV, BE/BS, counter and extensions; ES256 signatures over `authenticatorData || SHA-256(clientDataJSON)`; and any conversion from Web Crypto output to WebAuthn signature representation.
4. Implement only observed NNL/JCB serialization in a separate adapter. Treat `PasskeyLogin`, service-status, auth-check and relay method/origin/path, CSRF or dynamic fields and the complete cookie jar as a state machine. Stop on unknown redirects, SDK versions, response shapes or additional authentication. Do not substitute `eval`/`new Function` execution of fetched SDK code inside the Worker.
5. Introduce it separately from the browser version, for example as `bootstrapMode: "passkey-direct"`. Verify single use of fresh challenges, replay refusal, RP ID/origin mismatch refusal, consecutive runs, Cron execution origin, session expiry and NNL version drift. After reaching mypage, hand off to the existing fetch client and compare card/period/artifact types with the browser version for the same account and time. Keep secrets, detail values and assertions out of difference logs.
6. Keep the browser version as default until the direct version passes several live runs and version-drift stopping tests. Do not automatically fall back to the browser in the same failed run and send authentication twice; the next run uses only its explicitly configured bootstrap.

Completion means passing auth-check and relays from fresh server state, obtaining a mypage session, capturing an equivalent scope through existing read-only collection, and failing closed on old challenges/unknown SDKs, rather than merely generating a signature. Browser Run and binding removal are separate changes after these conditions are met.

No Container is added at this stage: Browser Run executes official scripts in a real browser while R2/Cron/read clients remain in the Worker. Only if a sanitized live test later shows that environmental factors reject password login through Browser Run while Container Chrome reproducibly succeeds with the same script/profile should login bootstrap alone move to a minimal Container.

<a id="認証とsecret"></a>

## Authentication and secrets

This small PoC can place 1–16 connections in Worker secret `MYJCB_CONNECTIONS_JSON`.

```json
[
  {
    "connectionId": "jcb-w",
    "bootstrapMode": "password",
    "userId": "<MyJCB ID>",
    "password": "<login password>"
  },
  {
    "connectionId": "another-independent-id",
    "bootstrapMode": "session",
    "userAgent": "<the exact bootstrap browser User-Agent>",
    "cookies": [
      {
        "name": "<cookie name>",
        "value": "<cookie value>",
        "domain": "my.jcb.co.jp",
        "path": "/",
        "secure": true
      }
    ]
  }
]
```

Each array element is an independent MyJCB ID/session/R2 namespace. Do not assume the first ID or one consolidated login covers other IDs. `connectionId` is a user-defined R2-key pseudonym; use neither MyJCB ID, card number nor personal name. Public `POST /trigger` is retired (404).

`bootstrapMode=password` executes the official password form and login-protection script through Browser Run. `bootstrapMode=passkey` synchronizes the P-256 PKCS#8 key, credential ID and user handle from a single Bitwarden JSON `fido2Credentials` entry into one secret per connection, temporarily injects it into Browser Run's CDP virtual authenticator and invokes official `パスキーでログイン` ("log in with a passkey"). Closing the browser removes the virtual authenticator; keys, assertions and cookies are stored in neither R2 nor manifests. `bootstrapMode=session` takes short-lived cookies plus the same User-Agent as secrets after the owner successfully logs in through another browser, validates mypage, then performs read-only replay.

Bitwarden's implementation treats `keyValue` as base64url PKCS#8 and credential IDs as UUID or `b64.` format. Chrome CDP requires PKCS#8 and raw credential IDs in standard base64, so the PoC performs only local conversion, without regenerating private keys. A nonzero signature counter in a Bitwarden export is refused because it could disrupt server counter synchronization. MyJCB passwordless login requires a discoverable credential; other credentials and RP IDs outside `my.jcb.co.jp`/`jcb.co.jp` are also refused.

No full-vault export is created. Fetch and inspect only the first item in an unlocked WSL terminal. The default is check-only, without secrets on stdout. Only `--put` sends generated JSON through stdin to Wrangler.

```sh
bun scripts/sync-bitwarden-passkey.ts -- \
  --item-id '<Bitwarden item UUID>' \
  --connection-id first-card \
  --secret-name MYJCB_ACCOUNT_FIRST_JSON

bun scripts/sync-bitwarden-passkey.ts -- \
  --item-id '<Bitwarden item UUID>' \
  --connection-id first-card \
  --secret-name MYJCB_ACCOUNT_FIRST_JSON \
  --put
```

```sh
wrangler secret put MYJCB_CONNECTIONS_JSON
```

Cloudflare Workers environment variables/secrets have a 5 KB limit per 1 value. Combining multiple IDs or complete cookie jars into one JSON can exceed it, so the implementation also supports comma-separated secret binding names in `MYJCB_CONNECTION_SECRET_NAMES`, splitting connections individually into `MYJCB_ACCOUNT_<NAME>_JSON`.

```sh
wrangler secret put MYJCB_CONNECTION_SECRET_NAMES
wrangler secret put MYJCB_ACCOUNT_JCB_W_JSON
wrangler secret put MYJCB_ACCOUNT_RECRUIT_JSON
```

Even one connection's passkey-session cookie jar may exceed 5 KB. Current `session` mode is only a PoC for complete JSON within 5 KB; reliable operation is not claimed. A practical proposal is for the local synchronization CLI to encrypt a cookie envelope client-side with AES-GCM in private R2, keeping only a small wrapping key in Worker secrets. This PR includes neither the encrypted-envelope implementation nor key rotation; sessions exceeding 5 KB stop as blockers.

Keep secrets out of source, `wrangler.jsonc`, committed `.dev.vars`, shell arguments, stdout and manifests. Official specifications prohibit ID/password login for passkey-registered IDs, so do not try `bootstrapMode=password`. Use `passkey` first; downgrade to owner-bootstrapped `session` only if the exported credential is non-discoverable, has a nonzero counter or mismatched RP, or is refused by MyJCB/Browser Run. Android APIs are fallback only when Web passkey and session modes both fail.

## read-only policy

The active allowlist contains only these operations.

| operation          | method        | path/query                                                                           | Purpose                                                       |
| ------------------ | ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| login page         | GET           | `/Login`                                                                             | Official login-page bootstrap including protection scripts    |
| login submit       | POST          | `/iss-pc/member/user_manage/Login`                                                   | Validate the form action and submit once inside the browser   |
| mypage             | GET           | `/iss-pc/member/mypage/mypage.html`                                                  | Login landing/session check                                   |
| credit menu        | GET           | `/iss-pc/member/details_inquiry/detailMenu.html?link_id=<observed>`                  | Initial `detailMonth` enumeration                             |
| credit detail      | GET           | `/iss-pc/member/details_inquiry/detail.html?detailMonth=0..17&output=web`            | Confirmed/unconfirmed HTML snapshots                          |
| older availability | POST JSON-RPC | `/iss-pc/general_json/member/details_inquiry/detailPastJson.json`                    | Enumerate only available months with the hidden discriminator |
| credit CSV/OFX     | GET           | `detail.html?detailMonth=N&output=csv                                                | money`                                                        | Official exports for confirmed months |
| credit PDF         | GET           | `detailDbPdf.html?detailMonth=N&output=pdf`                                          | Official statement PDFs for confirmed months                  |
| debit menu         | GET           | `/iss-pc/member/debit/details/debitDetailMenu.html?link_id=myj_main_debitDetailMenu` | Period enumeration                                            |
| debit detail       | GET           | `/iss-pc/member/debit/details/debitDetail.html?seq=0..14`                            | Ordinary/difference details                                   |

These read candidates remain **disabled**.

- Display-switching POSTs for existing consolidated IDs.
- `detailReplaceJson` (read-like, but unnecessary for ledger capture).
- Notice `detailNewspdf.html` (not a statement PDF).

They are not categorically prohibited just because their HTTP method is POST. Their current origin/path, field names/types, CSRF/session tokens, expected responses, redirects and read semantics have not been verified through sanitized observation of owner actions. Even after verification, add each as a fixed individual operation and stop on unknown fields or redirects.

The collector does not add/remove consolidated-account settings, change initial display or payment methods, perform revolving/installment payments, early repayment or cash advances, change limits/locks/notifications/personal information, apply for/cancel cards, exchange points, register campaigns, register/remove passkeys or reset passwords.

## stop condition

Stop the affected connection immediately without retries when detecting any condition below. A connection stopped before its first credit month stores nothing and records `human-required` or `failed` in the manifest. A connection stopped during month capture, state determination, statement-period determination, ledger or export capture saves earlier months and becomes `partial`. In either case, the manifest and terminal unit record only a closed stop code (`CONNECTION_STOP_CODES`), stopped-month position and saved-month count (the connection-stopping/captured-months section of `docs/sources/myjcb.md`, ADR 0005 amendment).

- Passkey, biometric/PIN, QR, OTP, secret phrase, CAPTCHA or identity verification.
- Access Denied, 401, 403, 429 or account lock/risk warnings.
- Mismatched login-form action, landing origin/path, redirects or response schema.
- Methods/paths/queries outside the allowlist or cross-origin navigation.
- Disabled password login, terms acceptance, registration or device enrollment.
- Response-size limit 8 MiB, unknown charset, out-of-range seq or abnormal cookie domain/count/size.
- Credit-detail `(確定分)` ("confirmed") h1 conflicts with ledger-header state, or a page other than a confirmed statement offers exports (`credit-statement-state`, next section).
- A confirmed statement names no payment month, names two or more, or names a month differing from past-month API `settlementYM` (`credit-statement-period`, next section).
- A month's page has the same redacted bytes as a page saved at an earlier position but a different state or period (`credit-page-repeated`, stop code `credit_page_repeated`; ADR 0005 amendment (h)).
- A state that risks storing tokens/cookies/credentials.

Scheduled runs do not automatically retry the same connection. The next daily run starts with a fresh browser/login.

<a id="cardmonthstateexport模型"></a>

## Card/month/state/export model

`parseCardInventory` normalizes existing card candidates in each independent connection's mypage to local indices such as `card-001` and an allowlist of generic product names, rather than card numbers or names. This PoC does not switch cards, so candidates outside the current root remain discovery candidates. It does not infer identity or consolidated relationships across connections.

Debit enumerates only `seq=0..14` actually present in the menu. Parse failure stops processing rather than blindly scanning 0–14.

The initial credit menu is grouped by the last `h2` or `h3` before each link (ADR 0005 amendment (j)). Under `h2`, `最新のご利用明細` ("latest usage details") and `過去の明細` ("past details") contain months; under `h3`, `ボーナス#回払い・ショッピングスキップ払い` ("bonus # installment / shopping skip payment") contains payment-schedule pages. Other headings (or links preceding any heading) stop with `credit_menu_group_unrecognized`. Payment-schedule pages are captured/saved after months and recorded in manifest `schedulePages`. Only a page with exactly 1 observed h1 `ショッピングスキップ払いご利用明細(未確定分)` ("shopping skip-payment usage details, unconfirmed") is saved as `credit-skip-payment-NN.html`; registration assigns dataset `credit-schedule`, read by `myjcb-skip-payment-schedule` (ADR 0005 amendment (e)). Others, such as bonus-payment pages, are saved unread as `credit-schedule-NN.html`. They do not count toward month coverage (ADR 0005 amendment (c)). Even at a month position, a page with exactly 1 such h1 is likewise saved as `credit-skip-payment-NN.html`, recorded in `schedulePages` and excluded from months (ADR 0005 amendment (h)). A page with exactly 1 h1 `ボーナス#回払いご利用代金明細(未確定分)` ("bonus # installment billing details, unconfirmed") is also saved as `credit-schedule-NN.html` at any position, recorded in `schedulePages` and excluded from months (amendment (j)). Only observed months are captured; among `detailPastJson` candidates 9–17, only `detailAvailableFlag=true` candidates are added. In the example, only 10/13 of the 9 older candidates were available, so offsets are not exhaustively tried. API failure or missing hidden `generalJsonShikibetuId` stops processing. JSON-RPC uses `method=execute`, `params=[{generalJsonShikibetuId}]` and IDs matching official JS: `0301006` plus a 2-digit counter.

`detailMonth=0` is a mutable `unconfirmed` snapshot; its export-free `.detail-list-01` is saved as HTML plus parsed JSON. Confirmed months use the same ledger component. Export links (relative hrefs without `detailMonth` on confirmed months) resolve against the detail page's own URL and count as that month's CSV/PDF/OFX offers; links naming a different `detailMonth` do not count. Notice PDFs are excluded. The Worker does not fetch exports, recording them only in manifest `exportOffers` (the shared bucket refuses export datasets; ADR 0005 amendment (b)). Only `collectCredit` with `exports: "fetch"` captures them; CSV searches for the exact 12-column header after metadata lines and retains CP932 bytes unchanged. If a position has rows under ledger header `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額` ("usage date / merchant etc.; payment date / future payment amount", observed on a shopping skip-payment schedule page; live DOM has 3 cells), save only the page as `unknown` and continue to the next month without reading rows (`scheduled_payments_page`).

Monthly statement state comes from the page itself, rather than export-link presence (`creditStatementState` in `src/parsers.ts`). The investigated connection never yielded export links (a relative-href resolution bug fixed on 2026-09-27), so the old rule, "no exports at `detailMonth<=1` means `unconfirmed`", recorded closed position-1 statements as `unconfirmed`.

- `detailMonth=0`: always `unconfirmed`; stop if an h1 exists.
- Exactly one `<h1>カードご利用代金明細(確定分)</h1>` ("card billing statement, confirmed"), with ledger amount label `今回のお支払い金額` ("this payment amount") or none: `confirmed`.
- No h1, and no ledger or no ledger rows: `unknown` (no ledger artifact).
- No h1 and rows labeled `ご利用金額` ("usage amount"): position 1 is `unconfirmed`; position 2 onward is `unknown`.
- No h1 and rows labeled `今回のお支払い金額` or with no amount label: stop at position 1; position 2 onward is `unknown`.
- Page contradictions stop at `credit-statement-state` at every position: 2 or more h1s, both labels in one header, disagreement between ledgers, or h1 with `ご利用金額`. Export links on a page other than a confirmed statement also stop processing.

Positions 2 onward do not stop because production positions 7 and 8 have ledgers without h1 and with 0 rows (statement-state section of `docs/sources/myjcb.md`). Stop/`unknown` logs (`myjcb-credit-statement-state`/`myjcb-credit-statement-unstated`) contain only h1 count, ledger count, row count and label codes.

A month's period is the statement's own named month (`creditStatementPeriod` in `src/parsers.ts`). The ledger parser includes period in row external IDs, so a statement moving from position 1 to 2 retains row IDs if its period is unchanged.

- A month labeled by the past-month API: record `settlementYM` unchanged. If a confirmed page names a month, it must match or processing stops.
- Other confirmed pages: record the month named by `<h2>YYYY年M月お支払い分のカードご利用明細</h2>` ("card usage details payable in YYYY/M") or `<h2>YYYY年M月D日(曜)お支払い分のカードご利用明細</h2>` ("card usage details payable on YYYY/M/D (weekday)", ADR 0005 amendment (g)) as `YYYY-MM`. Missing or multiple named months stop at `credit-statement-period`.
- Unconfirmed and `unknown` pages: `detailMonth-N` (they name no month).

Stop logs (`myjcb-credit-statement-period`) contain only `detailMonth`, named-month count and API-label presence. See the statement-month section of `docs/sources/myjcb.md`.

A ledger with rows must display the full state-appropriate header set (`ご利用日` ("usage date"), `ご利用先など` ("merchant etc."), `支払区分` ("payment type"), and `今回のお支払い金額` or `ご利用金額`) in its head (`credit-ledger-headers`). Compare labels after removing every whitespace character from head text: confirmed-month heads split `今回の<br class="pc-none">お支払い金額` ("this payment amount") with `br` (ADR 0005 amendment (f)). Thus ledger JSON `headers` represent facts confirmed on the page. Confirmed ledgers read expanded `ご利用金額`; unconfirmed ledgers read `今回のお支払い金額`. A page showing header `ご利用金額` under `(確定分)` is `confirmed` only if every row is a 1-payment transaction and its sum equals the page's `お支払い金額合計` ("total payment amount"); store the page's displayed header set (`ご利用金額`) in the ledger. Otherwise stop at `credit-statement-state` as before, logging only closed reason code `usageHeader` (ADR 0005 amendment (d), `docs/sources/myjcb.md`). This page shape has not been observed (amendment (f)).

Existing raw evidence and manifests are not rewritten. `myjcb-credit-statement-total@1.1.0` rereads confirmed totals from position-1 pages. Existing position-1 ledger rows remain `unconfirmed` because ledger JSON lacks page evidence. Those rows stop being current after the first successful corrected run. See the statement-state section of `docs/sources/myjcb.md` and release notes in `docs/observations.md`.

## R2 layout

`packages/collection` writes runs to shared DATA. Each artifact is content-addressed at `objects/<2 hex>/<sha256>`, followed last by terminal `runs/myjcb/<run-id>/terminal.json`. Possible collector artifact keys follow this layout; the terminal maps each saved artifact key to its object.

```text
<run>/
  manifest.json
  <connection-id>/
    credit-menu.html
    credit-past-months.json
    credit-detail-00.html
    credit-ledger-00.json
    credit-detail-10.html
    credit-ledger-10.json
    credit-10.csv
    credit-10.pdf
    credit-10.ofx
    debit-menu.html
    debit-detail-00.html
    ...
    debit-detail-14.html
    discovery.json
```

`debit-*` and CSV/PDF/OFX datasets remain unobserved in the central contract. Runs containing them are refused with `artifact_dataset_unobserved`; neither objects nor terminals are written to `DATA`.

Captured HTML source is decoded to UTF-8. Scripts/styles/meta, embedded elements, event/data attributes, navigation URLs, form actions, all value/textarea contents, token/session-like attributes and 16-digit card numbers are deterministically removed/replaced before storage. Login/mypage HTML is not stored. Object R2 metadata contains only `sha256` and `byteSize` written by `packages/collection`. Manifests contain only run/connection/artifact/failure metadata; neither cookie values nor actual detail values enter logs. The bucket must not be public.

## Schedule

The Worker has no Cron Trigger (`triggers.crons` is empty in `wrangler.jsonc`). The Processor's
`ScheduleAlarm` calls `ScheduledCollection.runScheduled` (`src/schedule-entrypoint.ts`) for the
`myjcb` job in [`config/alarm-jobs.json`](../../config/alarm-jobs.json), daily at 06:00 JST
(`0 21 * * *` UTC). GitHub Actions is not used as a scheduler.

Normal runs use the existing fixed-action private RPC/schedule path; public manual triggers return 404. `GET /health` needs no secret and returns only source/schema. The Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). Forwarding to the central Importer, `POST /backfill-raw-evidence` and the dedicated source bucket were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

```sh
mise run install                            # from the repository root
mise run //services/collector-myjcb:test
mise run //services/collector-myjcb:ci
mise run //services/collector-myjcb:dry-run
```

The live PoC deployed with `wrangler deploy`, created private R2, installed secrets and tested the first connection's real credentials. The successful run had 1 connection, 20 artifacts and failure 0: 11 credit details, 6 parsed ledgers, 1 menu, 1 past-month JSON and 1 discovery. No official CSV/PDF/OFX links were found, so export artifacts were 0 (investigation on 2026-09-27 showed confirmed-month links used relative hrefs the collector could not resolve). This connection therefore needs HTML ledgers as actual data sources; optimize confirmed months around CSV only for other IDs where exports exist. Manifests and source-preserving artifacts were saved in private R2, without actual values or secrets in the PR.

Created persistent resources are Worker `kogane-myjcb-collector-poc` and connection secrets (the schedule is the Processor's `myjcb` alarm job, not a Cron Trigger; the admin routes were retired, #1131). Storage uses shared DATA `kogane-raw-evidence`; the old same-named private R2 bucket was copied to central DATA, verified and deleted on 2026-09-13. Browser Run sessions close after each connection and create no persistent profile. Retirement deletes only the Worker and secrets, retaining shared DATA used by other collectors and the Processor.

Overlapping runs are prevented by the shared execution lease: every collection takes the
`myjcb` row of `collection_execution_leases` through `withCollectionLease`
(`src/worker.ts`, `packages/collection/src/schedule-lease.ts`, binding `SCHEDULE_DB`), and a
second alarm or operations request while it is held is refused with `collection_busy_or_uncertain`
before contacting MyJCB, and its scheduled result carries the failure code `collection_busy`
(`scheduledFailure`, `packages/collection/src/schedule-result.ts`). The lease is per source, not per connection: one run covers every
configured connection in turn.

Processor registration idempotency does not solve overlap. Resending the same run ID and terminal digest converges on the same run, but two collector captures with different UUIDs remain distinct capture facts. Do not collapse runs by content hash; prevent duplicate execution through the collector execution lock. No extra scheduled trigger or GitHub Actions cron is created.

## synthetic test

`test/fixtures` contains handwritten HTML with only fictional merchants, amounts, tokens and card numbers, copied from neither MyJCB nor Okura nor mnie HTML. Tests cover route allowlists, cross-origin/unknown-method refusal, cookie domains/paths, card/month parsers and token/card-number redaction. `test/credit-statement-state.test.ts` uses fictional pages and a fictional `collectCredit` client to check: `(確定分)` pages without export links become `confirmed`; position 0 and unconfirmed-header pages become `unconfirmed`; h1/header conflicts stop at `credit-statement-state`; old pages without h1 become `unknown` without stopping or producing ledgers.

## public prior art boundary

The public AGPL-3.0 implementation [youseiushida/Okura](https://github.com/youseiushida/Okura) is recorded separately at PR #24 investigation commit `afc6057fba78b5bfd6364654548fbfd91c76692a` on 2026-08-26 and PoC implementation commit `bbf11e032aba4a380009508e91954361a3f9d658` on 2026-08-31. The latter was used only to compare current login protection, origins/paths, cookie-plus-User-Agent preservation and 15 debit cycles. Okura's validator requires a logout link plus `toNaviDebitDetailMenu`, so it may reject valid credit-only sessions. Its protection runtime `node:vm` is a [non-functional Cloudflare Workers stub](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules), so it is not ported to plain Workers; Browser Run is used instead. Source, DOM runtime, parsers and test fixtures were not reused. See `THIRD_PARTY_NOTICES.md`.

<a id="未確認事項"></a>

## Unverified matters

- Whether password login completes through Browser Run egress/profiles.
- Whether each actual ID uses password or passkey, and when secret phrases/OTP appear.
- Current mypage card-enumeration DOM and consolidated-account switching contract.
- Whether credit paths, ledger DOM and CSV/PDF/OFX schemas match across real IDs/issuers.
- Zero-row CSV/PDF/OFX responses, card/subcard columns and cancellation/refund representations.
- Debit-menu/detail compatibility across issuers, state labels and 0-record/cancellation/difference representations.
- Session idle/absolute TTL and cookie rotation.
- Whether TLS/connection/egress differences reject replay when Browser Run cookies move to ordinary Worker `fetch`.
- Login-protection vendor and change cadence.
- Encrypted R2 session envelopes, key rotation and overlap locks/Queues.

Update these through one-off Kuebiko/live observations without storing actual values; do not expand unknown implementation by guessing.

<a id="2026-08-31-public-login-observationの反映"></a>

## Incorporating the 2026-08-31 public login observation

The logged-out page in dedicated Kuebiko Chrome had unnamed text/password decoy candidates as well as named `userId`/`password` in `loginForm`. The PoC therefore selects fields by both form and control names, rather than input type or position. Form actions are also checked against the allowlist immediately before submission.

Both password and passkey appear as ordinary choices on the initial screen, so merely seeing `passkey` on the first page does not stop processing. `human-required` is used only if password submission fails to reach known mypage and the destination reveals passkey/OTP/secret-phrase requirements or similar.

The seed in `login-prot.js?async` changes on every load; passkey/NNL SDK assets also have versioned scripts. The PoC hard-codes neither script source/version/seed nor commits raw captures. Observed versions and privacy boundaries are recorded in `docs/sources/myjcb.md`.
