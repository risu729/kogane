# V Point Pay Worker PoC

VポイントPayのプリペイド残高と取得可能な全月の利用明細を、公式Android
アプリのfirst-party JSON APIから取得し、raw responseとmanifestをprivate R2へ
保存する独立PoCである。Vポイント/VマネーのWeb台帳は`poc/vpoint-worker/`、
三井住友カード請求明細はVpass collectorであり、相互に混ぜない。

## 静的解析で確認したread surface

APK candidate `com.smbc_card.vpoint` 2.5.0のRetrofit定義と復号済み保護DEXから、
次を確認した。binary、通常のdecompiler output、復号DEXはprivate Android archive
だけに保存し、このrepositoryにはsanitize済み仕様と実装だけを置く。

- `POST /vpoint/api/v2/token`: authorization codeまたはrefresh token grant
- `GET /vpoint/api/v2/prepaid/balance`: JPY残高、チャージ上限、`inquiry_period`
- `GET /vpoint/api/v1/prepaid/transaction?target_month=yyyyMM`: 月別利用明細
- `X-Vapp-Access-Token`、アプリ/OS/User-Agent、時刻依存`device_id` header

明細schemaには利用日、説明、元通貨/金額、請求通貨/金額、各種手数料、為替
レート、確定状態、承認番号、remarks、activity type、transaction typeがある。
authorization、settlement、refund、chargeを同一状態として潰さずraw snapshotを残す。

残高応答の`inquiry_period`はアプリが月選択肢の最古月として使う。PoCもこの値から
JST当月までをinclusiveに走査し、想定外応答に対して120か月の安全上限を置く。

## 停止状態

app API collectorは停止している。Cronはなく、手動の`/trigger`、`/probe`、
`/reset-credentials`はHTTP 410を返す。遅延配送されたscheduled eventも収集しない。
`/health`は`collectionEnabled: false`と`status: "disabled"`を返す。
R2原本、Durable Object、既存secretsは保持する。VポイントPay通知メールは
`poc/vpoint-worker/`で引き続き収集する。以下の認証・デプロイ説明は研究記録である。

認証不要の`/probe`による到達確認は、残高・明細取得の成功を意味しない。
APIの認証には同じセッション由来の実UUIDとrefresh tokenが必要で、仮UUIDでは代用しない。
端末アプリとの同時利用やtoken更新の競合は未検証であり、自動的な再登録・端末移行は行わない。

管理token付き`POST /credential-status`は、実行時に選ばれる認証元、欠けた項目、
UUID形式の不備だけを返す。値は返さず、Durable Objectへの書き込みやAPI呼び出し、
token更新も行わない。`structurallyReady: true`は形式確認だけで、認証成功を意味しない。
停止中の`/trigger`は認証状態によらずHTTP 410で拒否する。

## 認証とWorker化

初回だけ正規アプリの電話番号/SMS/6桁app passcodeを使う。アプリが得たrefresh
tokenと、Realmに保存されたrandom device UUIDをWorker secretへ一度コピーする。
保護DEXの`EncryptDevice`はUUIDと現在epoch秒だけで`device_id`を生成し、Android
Keystoreやhardware attestationを使わないため、Workerで再現できる。

各runはまずrefresh token grantを行う。応答のrotated refresh tokenは単一SQLite
Durable Objectへ即時保存し、以後それを使う。token、UUID、access tokenはR2、manifest、
log、HTTP応答へ出さない。secretを更新した場合は、管理token付き
`POST /reset-credentials`でDurable Objectを再seedする。

静的解析ではOkHttp `CertificatePinner`を確認できず、network security configは
cleartextを禁止するだけだった。これは標準Workers `fetch()`で動く可能性を強く示すが、
refresh token寿命、端末revoke、実enum値はowner accountでのlive検証前である。

## R2 layout

```text
raw/v-point-pay/YYYY/MM/DD/<run-id>/
  balance.json
  transactions-YYYYMM.json
  ...
  collection-summary.json
  manifest.json
```

## 開発とデプロイ

```bash
bun install
bun test
bun run typecheck
bun run cf:check
```

必要なresources/secrets:

- R2 bucket: `kogane-vpoint-pay-collector-poc`
- SQLite Durable Object: `VPointPayCredentialState`
- secret: `VPOINT_PAY_REFRESH_TOKEN`
- secret: `VPOINT_PAY_DEVICE_UUID`
- secret: `ADMIN_TRIGGER_TOKEN`
- Cron: `30 21 * * *`（毎日06:30 JST）

manual collectionは`POST /trigger`。`GET /health`は秘密値・口座データを返さない。
管理token付き`POST /probe`は、認証不要の`common_settings`だけを呼び、標準Workers
`fetch()`からfirst-party app originへ到達できるかを応答内容を返さず確認する。

検証環境を削除するときは次を一組で削除する。

1. Worker `kogane-vpoint-pay-collector-poc`（Cron、secrets、Durable Objectを含む）
2. R2 bucket `kogane-vpoint-pay-collector-poc`

## 2026-08-31 deployment checkpoint

WorkerとR2 bucketを実際に作成し、`GET /health`がHTTP 200となることを確認した。
続いてWorkerの標準`fetch()`から認証不要の`/vpoint/api/v2/common_settings`を呼ぶ
`POST /probe`もHTTP 200となった。したがって、Cloudflare edge IP、WorkerのTLS stack、
ブラウザ不在という条件だけではapp originに拒否されない。

owner app bootstrap前なので、app credential secretsはplaceholderである。`/trigger`の
実口座成功、R2 raw data、enum、最古月は未確認。作成物と削除手順は
`RESOURCE_INVENTORY.md`に固定した。
