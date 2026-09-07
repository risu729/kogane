# V Point Pay app API implementation note

調査日: 2026-08-31

VポイントPayは、Vポイント/VマネーMy PageやVpassとは別のプリペイド台帳である。
公式Google Play packageは`com.smbc_card.vpoint`。候補APK 2.5.0をWSL上でJADX
1.5.6とapktool 3.0.3により解析し、通常DEXのloaderを再現して8,300-byteの保護DEXを
復号した。binaryと全解析出力はprivate archiveに置き、Koganeには秘密値・実データ・
復号鍵・アプリ配布物を含めない。

## 結論

ブラウザやAndroidを毎回動かす必要はない。初回の正規アプリ登録からrefresh tokenと
random device UUIDを安全に引き継げれば、標準Cloudflare Workers `fetch()`でtoken更新、
残高取得、全利用可能月の明細取得を行える構造である。PoCは
`poc/vpoint-pay-worker/`に実装した。

確認したAPI:

| Method | Path                                                     | 用途                                     |
| ------ | -------------------------------------------------------- | ---------------------------------------- |
| POST   | `/vpoint/api/v2/token`                                   | authorization code / refresh token grant |
| GET    | `/vpoint/api/v2/prepaid/balance`                         | currency、残高、charge limit、最古照会月 |
| GET    | `/vpoint/api/v1/prepaid/transaction?target_month=yyyyMM` | 月別明細                                 |

token応答はaccess token、生成時刻、有効秒数、rotated refresh tokenを含む。認証readは
`X-Vapp-Access-Token`を使う。共通headerはアプリversion、Android OS、WebView系
User-Agent、no-cache、`device_id`である。

月別明細は、利用日、説明、元通貨/金額、請求通貨/金額、transaction/ATM/exchange
fee、為替レート、settlement status、承認番号、remarks、activity type、transaction typeを
持つ。実際のenum値と原取引・返金のlinkageはlive responseで確認するまで推測しない。

## 保護DEXとdevice header

APK asset `assets/nhnltyyy`は、asset名のJava hashをmaskにしたAES-128-CBCで暗号化
されていた。loader内の二つの16-byte arrayを復元し、mask XOR後の第二配列をkey、
第一配列をIVとしてPKCS#7 paddingを除去するとDalvik DEX 037が得られた。再現script、
hash、tool version、JADX/apktool outputはprivate archiveに保存した。

復号DEXの`EncryptDevice`は、UUIDのhex値、現在epoch秒、重み付きchecksumを用いる
deterministic変換である。Android Keystore、hardware key、Play Integrity、端末固有の
署名処理はこのheader生成に使われない。よってUUIDをsecretとして持てばWorkerへ移植できる。

通常Retrofit clientにはcertificate pinningが見つからず、network security configも
cleartext禁止だけである。ただし、静的解析はproductionでのacceptanceを証明しない。

## 取得と保存方針

残高応答の`inquiry_period`を最古月としてJST当月まで走査する。公開FAQから固定保持期間を
推測した月数は使わない。raw応答を月単位でprivate R2へ保存し、authorizationからsettlement、
取消、返金による後日変更をsnapshot差分として保持する。

refresh tokenはrotationされるため、初期値だけWorker secretに置き、実行後の値は単一
Durable Objectへ保存する。token/UUID/access tokenをR2やログへ出さない。401等でrefreshが
拒否された場合は繰り返さず、正規アプリで再認証してsecretを更新する。

## 未完了のlive確認

- owner accountでの既存ユーザー登録（電話番号、SMS、6桁app passcode）
- refresh tokenとRealm device UUIDの安全な一回限りの抽出
- Workersからのrefresh、balance、全月transaction取得
- `inquiry_period`の実値、明細enum、空月挙動、refresh token寿命、device revoke挙動

支払、チャージ、ポイント移行、カード設定その他のwrite APIは実装対象外である。

## Cloudflare live probe

2026-08-31に専用Worker/R2をdeployした。Workerの標準`fetch()`から認証不要の
`/vpoint/api/v2/common_settings`へ、静的解析と同じapp/OS/User-Agent/device headerを
付けて到達し、HTTP 200 JSONを確認した。応答本文は口座データではなくR2にも保存しない。

この結果はCloudflare edge IPやTLS fingerprintだけでは拒否されないことを示す。一方、
認証済みAPIのtoken/device bindingを証明しないため、owner app bootstrap後にrefresh、
balance、transactionを個別に検証する。

## 通知メールによる補助台帳

app sessionがない期間も、公式通知メールから利用・チャージ・残高加算・利用不可eventを
取得できる。これはapp API明細の代替正本ではなく、欠落期間を補う独立sourceとして扱う。
`poc/vpoint-worker/`の既存Email Workerへ取り込みを追加し、原本EMLと正規化JSONを
VポイントPay用private R2へ保存する。Gmail転送は原本をinline `message/rfc822`にするため、
外側のGmail送信者ではなく内側の公式送信者を検証する必要がある。

VポイントPay側の登録メールを`vpointpay@takuk.me`へ変更した後は、公式からの直接配送を
保存後にGmailへ転送する。一方、Gmailから`message/rfc822`でbackfillした通知は再転送しない。
transport形状を明示的に区別し、通常通知を失わずに転送loopを防ぐ。

2026-08-31に既存通知85通をbackfillし、85件すべてをhash keyで重複なしに保存した。
Vポイント本体の同時点履歴149件との照合は、明示的なポイント額とJST暦日だけを使った。
比較可能34件のうち11件一致、23件不一致、候補複数0件、比較対象外51件だった。
app APIのlive snapshotは存在しないため、email対app明細は未照合である。

不一致を理由にsource eventを書き換えない。後日app APIが復旧したら、email、app transaction、
Vポイント履歴を三つの独立sourceとして照合し、authorization/settlement/refundによる差を
reportへ追加する。matchできないeventはunknownのまま残す。

## Layer A: 通知メール evidence の中央取り込み

`poc/vpoint-pay-worker`のapp pollingはPR #60で停止済みであり、この取り込みでは再有効化しない。
現存するsourceは`poc/vpoint-worker`が保存した公式通知の二つ組だけである。

- `raw/v-point-pay-email/{date}/{message-sha256}.eml`: 公式送信者のInternet Message Format原本
- `raw/v-point-pay-email/{date}/{message-sha256}.json`: `vpoint-pay-email-event-v1`正規化event

Importerは同じprefixにこの2 objectだけが存在すること、keyの日付とRFC Date、raw bytesの
SHA-256とkey ID、exact custom metadata、media type、公式sender、対象subject、JSONのstrict
schemaを検証する。さらにEMLからeventを独立に再計算し、正規化JSONと
完全一致する場合だけ中央へ複製する。転送メールの外側envelopeは保存時に除かれているため、
中央のemail transportは推測せず`unknown`とする。

既存履歴は保存時にR2 native SHA-256を指定していなかったため、bounded bodyから再計算した
SHA-256をkey・pair・中央object checksumへ厳密に結び付ける。native checksumが存在するobjectは
再計算値との一致も必須とし、新着保存ではraw/JSON両方にnative SHA-256を指定する。監査は
native checksumの有無をaggregate件数だけで報告し、欠落を値の不一致として扱わない。

中央ではexternal source ID `v-point-pay-email`をcanonical `v-point-pay`へ対応させる。
rawは`provider_message / exact`、JSONはrawへのlineageを持つ
`collector_derived / transformed`で、1 message unit・2 artifact・`email_batch` inventoryとして
sealする。`producerVersion`と`sourceRunKey`は固定契約`vpoint-pay-email-r2-v1`に基づくため、
Importerのdeployment revisionが変わっても同一pairを同じrunへ冪等replayできる。

`derived/v-point-pay-email-reconciliation/...`はVポイント本体の履歴との比較から作った別の
collector summaryであり、canonical sourceは`v-point`である。今回のメールImporterはこれを
走査しない。app API snapshotのprefixも対象外であり、emailをapp明細の代替正本とは扱わない。

historical scanはHMAC署名付きopaque cursorを用いてR2 objectを1件ずつ走査し、`.json`ごとに
pairを取り込む。`.eml`は対応JSON側で一緒に検証されるためscan上はskipする。応答とscriptは
件数と固定failure codeだけを出し、source object key、個別hash、本文、値、tokenを出さない。
source R2へのwrite/deleteは行わない。

```sh
cd services/collector-r2-importer
bun run audit:vpoint-pay-email-r2

poc/vpoint-worker/scripts/backfill-vpoint-pay-email-raw-evidence.sh
```

新着メール保存後の中央取り込みはService Bindingの失敗をメール受信・Gmail転送の失敗へ
昇格させず、`waitUntil`で試行する。失敗pairはimmutable source R2に残り、上記backfillで再送する。
GitHub Actions cronは使わず、既存collectorのscheduleと廃止済みapp polling設定は変更しない。
