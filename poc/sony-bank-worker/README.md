# Sony銀行 read-only Worker PoC

Sony銀行の現行Web BFFへ毎回新規ログインし、総残高、円・外貨普通預金取引履歴、公式CSV、Sony Bank WALLETの直近15か月明細をprivate R2へ保存する独立Workerである。Chrome、Browser Rendering、Container、TLS impersonation、Akamai対策は使用しない。

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

```text
raw/sony-bank/YYYY/MM/DD/<run-id>/gross-balance.json
raw/sony-bank/YYYY/MM/DD/<run-id>/yen-history-page-0001.json
raw/sony-bank/YYYY/MM/DD/<run-id>/yen-history.csv
raw/sony-bank/YYYY/MM/DD/<run-id>/foreign-history-usd-page-0001.json
raw/sony-bank/YYYY/MM/DD/<run-id>/foreign-history-usd.csv
raw/sony-bank/YYYY/MM/DD/<run-id>/wallet-history-2026-08.html
raw/sony-bank/YYYY/MM/DD/<run-id>/collection-summary.json
raw/sony-bank/YYYY/MM/DD/<run-id>/manifest.json
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

ローカルで実口座を検証する場合は、認証JSONを標準出力やshell引数へ置かず、600相当で保護した
ファイルを`SONY_BANK_CREDENTIAL_FILE`に指定する。

```sh
SONY_BANK_CREDENTIAL_FILE=/secure/path/sony-bank.json \
  bun run smoke:live -- 2025-01-01 2026-08-31
```

## Secret

- `SONY_BANK_CREDENTIAL_JSON`: `branchNum`、`accountNum`、`loginPwd`だけを持つJSON
- `ADMIN_TRIGGER_TOKEN`: 手動triggerのBearer token

Secret値をsource、Wrangler config、shell履歴、標準出力へ置かない。

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
wrangler r2 bucket create kogane-sony-bank-collector-poc
wrangler deploy
wrangler secret put SONY_BANK_CREDENTIAL_JSON
wrangler secret put ADMIN_TRIGGER_TOKEN
```

## 作成するCloudflare resourceとcleanup

- Worker: `kogane-sony-bank-collector-poc`
- R2 bucket: `kogane-sony-bank-collector-poc`
- Cron: `0 21 * * *`
- Worker secrets: 上記2件

PoCを廃棄するときは、R2の必要なraw artifactを退避した後にWorker、bucketの順で削除する。R2 bucketの削除は保存データを回復不能にするため、内容を確認してから行う。
