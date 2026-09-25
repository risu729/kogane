# Sony銀行 read-only Worker PoC

Sony銀行の現行Web BFFへ毎回新規ログインし、総残高、円・外貨普通預金取引履歴、公式CSV、Sony Bank WALLETの直近15か月明細を共有DATA bucket（`kogane-raw-evidence`）へ保存する独立Workerである。Chrome、Browser Rendering、Container、TLS impersonation、Akamai対策は使用しない。

## Runtime profile

- **Browser: なし。** 認証、Web BFF、WALLET SSO、月切替、HTML/CSV取得をすべてWorker `fetch`で実行する。
- WALLETのserver-rendered HTMLもHTTP responseとしてparseし、JavaScript navigationやbrowser cookie jarを必要としない。
- 調査時のChrome captureやbrowser用scriptの存在は、collector runtime依存ではない。

## 検証済みの認証経路

2026-08-30に本人の実口座で、ChromeのCookieを流用しない新規`.NET HttpClient`から次を確認した。

1. login pageをGETすると200。
2. `POST /custom-web00/dbca/csrf-token/get`で`BFF-CSRF`と`FSID`を取得。
3. `FBaaS-Provider-Key: CustomAuth`、画面/event header、店番号、口座番号、login passwordで`POST /custom-web00/dbca/cust-web/to-customers/login`が200、business error 0。
4. 同じ新規sessionで総残高APIが200。
5. 認証済みsessionの残高、履歴、CSVはUA、`sec-*`、Origin、Refererなしの通常HTTPでも200。

`CustomAuth`は公開`core.js`の静的値で、browser fingerprintではない。現行経路ではCloudFrontを観測し、AkamaiのDNS、header、script、cookieは観測していない。Caulis/PhishWall scriptは公開Webに存在するが、上記のread-only loginには必要なかった。

## 収集対象

- `gross-balance.json`: 総残高BFFのraw JSON
- `yen-history-page-NNNN.json`: 指定期間の円普通預金履歴raw JSON。3件単位のpagerを最後まで走査
- `yen-history.csv`: 同じ期間の公式CSV bytes
- `foreign-history-<ccy>-page-NNNN.json`: USD/EUR/GBP/AUD/NZD/CAD/CHF/HKD/ZAR/SEKの通貨別raw JSON
- `foreign-history-<ccy>.csv`: 同じ期間・通貨の公式CSV bytes。取引0件なら生成APIを呼ばない
- `wallet-history-YYYY-MM.html`: Sony Bank WALLETの月別利用明細。直近15か月を10秒間隔で走査
- `collection-summary.json`: 期間、page数、件数、Cookie名だけを持つ非機密summary
- `manifest.json`: artifactごとのR2 key、SHA-256、bytes、成功/失敗

日次Cronは21:00 UTC（日本時間06:00）に当月1日から実行日までを収集する。手動`POST /trigger?from=YYYY-MM-DD&to=YYYY-MM-DD`は最大366日で、Bearer認証が必要である。

収集後、runは`packages/collection`で共有DATA bucketへ書く。上記の各artifactは`objects/<2 hex>/<sha256>`へcontent-addressedで保存し、すべてのobjectの後にterminal manifestを書く。objectとterminalはimmutable conditional putとR2 native SHA-256付きで書き、terminalのないrunは保存完了として扱わない。ProcessorがDATAのterminalをin-processで登録する（[processor.md](../../docs/processor.md)）。source専用bucket、中央raw-evidence importerへのService Binding、`deferred`応答と`scripts/backfill-raw-evidence.sh`は2026-09-13に廃止した（[legacy-retirement.md](../../docs/legacy-retirement.md)）。

```text
objects/<2 hex>/<sha256>                 gross-balance.json、yen-history.csv、wallet-history-YYYY-MM.html、manifest.jsonなど各artifact
runs/sony-bank/<run-id>/terminal.json    最後に書くrunの完了記録（artifact keyとobjectの対応を持つ）
```

login response、氏名、Cookie値、CSRF、password、WALLETの一時SSO値、JSESSIONID、hidden form値はR2へ保存しない。WALLET HTMLは保存直前にこれらを除去する。取得した残高・履歴には個人金融情報が含まれるため、bucketをpublicにしない。

WALLETは銀行BFFの`/jada/debit-sso/login-usage-dtl-inq`から毎回一時SSO値を発行し、
`igw.sonybank.jp`を経由して`dc.sonybank.jp`の月別一覧へ通常HTTPで接続する。明細項目は一覧に
すべて含まれ、別detail endpointはない。月切替は`RW1313010201`、PDF入口は
`RW1313010301`である。公式JavaScriptが10秒以内の連続月切替を拒否するため、Workerも
10.25秒間隔を守る。PDFは現PoCでは保存しない。

2026-08-31のCloudflare本番検証では、2025-09-01〜2026-08-31について円10件、外貨6件・
11ページ、WALLET 15か月を含む34 artifactを保存し、failure 0だった。取引0件の外貨で
公式CSVを要求するとSony側がCloudflare egressに500を返す場合があるため、JSONの件数が0なら
情報量のない空CSVを省略する。残高と0件の履歴JSONは保存する。

2026-09-04に中央raw-evidenceへの既存データ移行を本番確認した。source bucketの全120 listing
pageを走査して11 manifest（旧v1が2、現行v2が9）を取り込み、D1上の11 runはすべてseal済み、
未sealは0だった。同じ全件backfillを先頭から再実行してもrun数は11のままであり、seal済みrunの
exact replayが冪等であることを確認した。さらに旧v1 manifestを1件抽出し、source R2 objectと
中央content-addressed R2 objectのSHA-256およびbyte数が一致することを確認した。確認では本文や
金融値を標準出力・documentationへ記録していない。

このbackfill scriptとsource bucketは2026-09-13に廃止した。source bucketの全objectは中央DATAへ
コピーしてSHA-256を検証した後に削除しており、再送するoutboxはない（[legacy-retirement.md](../../docs/legacy-retirement.md)）。

ローカルで実口座を検証する場合は、認証JSONを標準出力やshell引数へ置かず、600相当で保護した
ファイルを`SONY_BANK_CREDENTIAL_FILE`に指定する。

```sh
SONY_BANK_CREDENTIAL_FILE=/secure/path/sony-bank.json \
  bun scripts/live-smoke.ts -- 2025-01-01 2026-08-31
```

## Secret

- `SONY_BANK_CREDENTIAL_JSON`: `branchNum`、`accountNum`、`loginPwd`だけを持つJSON
- `ADMIN_TRIGGER_TOKEN`: 手動triggerのBearer token

このWorkerは中央credentialを持たない。旧importer用のingest client `collector-r2-sony-bank`は2026-09-13に無効化した。

Secret値をsource、Wrangler config、shell履歴、標準出力へ置かない。

```sh
bun install --frozen-lockfile
bun test
mise run //services/collector-sony-bank:typecheck
mise run //services/collector-sony-bank:dry-run
wrangler deploy
wrangler secret put SONY_BANK_CREDENTIAL_JSON
wrangler secret put ADMIN_TRIGGER_TOKEN
```

## 作成するCloudflare resourceとcleanup

- Worker: `kogane-sony-bank-collector-poc`
- R2 binding: `DATA` → `kogane-raw-evidence`（全collector共有。このWorker専用のbucketはない）
- Cron: `0 21 * * *`
- Worker secrets: 上記2件

PoCを廃棄するときはWorkerだけを削除する。共有DATA bucketは他のcollectorとProcessorも使うため削除しない。旧source専用bucket `kogane-sony-bank-collector-poc`は2026-09-13に削除済み。

### Failure diagnostics

Collection failures emit a structured `*-collection-failure` event before teardown
or the DATA write. Join on `runId`; use `phase` to distinguish collection from
teardown, relay and shared-persist events. The collector manifest stored in DATA
retains the same three failure fields (`operation`, `errorType`, `message`). Its
bounded message includes the safe stage and available HTTP status; structured logs
expose these as `diagnostics` fields. Use that manifest or the Worker logs for
diagnosis.

No exception message, stack, cause, request URL, credential, response body, or
unrecognized provider text is logged. Sony logs only fixed operation IDs/currencies
and the count of provider errors (no provider codes are currently approved for
logging). Shinsei accepts only known browser stages and records whether authentication
was attempted. Its relay events include `runId` and `peerClosed`; compare them with
`*-container-teardown-start` before attributing a connection error to collection.
An unknown stage stays `unknown-browser-stage`; a failed read is separate from
subsequent `NotAttempted` reads. No retries or collection requests are added.

### Empty JPY history and progress logs

JPY now follows the same zero-transaction CSV rule as foreign currencies: after
validating every official history JSON page, request CSV only when the total is
positive. Keep the original zero-row JSON, balance and WALLET evidence; do not
fabricate an empty CSV. A positive-history CSV error still fails collection.
No importer re-checks this any more: the collector itself omits JPY CSV only after
validating zero-row history, and the manifest and collection-summary field shapes
remain unchanged.

This matches Sony's public `eaba0600/search` frontend: its `csvdlBtn` section is
rendered only after a successful history response with `countCnt !== 0`.
Verified on 2026-09-05 in the official
[history page module](https://sonybank.jp/pages/ea/_next/static/chunks/53a82944a612014e935388c108002b83322cace3.58e22f343a3103820839.js).
The prior unconditional JPY CSV request could hit the same HTTP 500 behavior
already observed for empty foreign-currency history.

`sony-bank-progress` records use the run's `runId`, allowlisted stage/event and
currency, page index/count, validated row/transaction counts, HTTP status,
duration, and `zero_transactions` skip reason. `phase=request` records HTTP
transport completion; `phase=collection` records validated collection steps.
Thus HTTP 200 alone does not imply a valid JSON/history response. Validated
counts are logged before requesting CSV, even if a later step fails. No URLs,
credentials, financial bodies or free-text provider errors enter these records.
Log emission is best effort and cannot replace a collection result or failure.

Artifacts are still persisted after full collection returns. A failure midway
does not yet preserve earlier fetched artifacts, so the failure manifest's
default transaction count is not evidence that JPY history was empty; use the
validated progress count instead.
