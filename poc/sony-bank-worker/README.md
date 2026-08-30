# Sony銀行 read-only Worker PoC

Sony銀行の現行Web BFFへ毎回新規ログインし、総残高、円普通預金取引履歴、公式CSVをprivate R2へ保存する独立Workerである。Chrome、Browser Rendering、Container、TLS impersonation、Akamai対策は使用しない。

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
- `collection-summary.json`: 期間、page数、件数、Cookie名だけを持つ非機密summary
- `manifest.json`: artifactごとのR2 key、SHA-256、bytes、成功/失敗

日次Cronは21:00 UTC（日本時間06:00）に当月1日から実行日までを収集する。手動`POST /trigger?from=YYYY-MM-DD&to=YYYY-MM-DD`は最大366日で、Bearer認証が必要である。

```text
raw/sony-bank/YYYY/MM/DD/<run-id>/gross-balance.json
raw/sony-bank/YYYY/MM/DD/<run-id>/yen-history-page-0001.json
raw/sony-bank/YYYY/MM/DD/<run-id>/yen-history.csv
raw/sony-bank/YYYY/MM/DD/<run-id>/collection-summary.json
raw/sony-bank/YYYY/MM/DD/<run-id>/manifest.json
```

login response、氏名、Cookie値、CSRF、passwordはR2へ保存しない。取得した残高・履歴には個人金融情報が含まれるため、bucketをpublicにしない。

Sony Bank WALLETのVisa debit専用明細はこのPoCに含めない。銀行BFFの
`/jada/debit-sso/login-usage-dtl-inq`が返す一時SSO dataを
`https://igw.sonybank.jp/vcfb/vcfb02001`へhidden form POSTする別系統であり、SSO後の
card基盤read APIをまだlive captureしていないためである。SSO dataをR2へ保存しない。

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
