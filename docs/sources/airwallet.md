# AirWallet / COIN+ source research

調査日: 2026-08-26（公開情報）、認証済み live 検証は未実施

## 1. 対象範囲と安全境界

この記録の対象は、株式会社リクルートMUFGビジネスが提供する **AirWallet アプリ**と、
同アプリが利用する個人向け **COIN+ アカウント/残高**である。Airペイ加盟店台帳、
リクルートID/リクルートポイント/Pontaポイント、連携銀行の預金台帳、AirWallet クイックローン、
Airワーク給与支払は別 source とする。

許可するのは、既存の残高、登録済み金融機関の表示、既存の利用履歴/取引レポート、既存の
COIN+ QR/Visa支払い履歴を本人操作で読むことと、その read path の静的解析・動的観測である。
支払い、送金、受取依頼、チャージ、出金、銀行口座追加/削除、Visaカード発行/停止、借入、
キャンペーン参加、リクルートID連携/解除、本人確認、暗証番号/通知等の設定変更は行わない。
電話番号、氏名、銀行/口座番号、相手ユーザー、加盟店実値、実残高/実額、password、SMS code、
4桁暗証番号、Cookie/token/device identifier を取得物、ログ、HAR、スクリーンショット、commitに
残さない。security controlの回避、負荷/レート上限探索、検証目的の少額取引も行わない。

## 2. 調査方法と証拠の強さ

- [AirWallet公式サイト](https://airwallet.jp/)、[COIN+公式サイト](https://coinplus.jp/)、
  [COIN+セキュリティ説明](https://coinplus.jp/security/)、公式FAQ、公式ストア記載を優先した。
- 2026-08-26にログアウト状態の公開URLへHEAD/GETを各少数回行い、HTML/JavaScript、DNS、
  CDN/WAF応答ヘッダーだけを観測した。ログインやchallenge誘発はしていない。
- GitHub code searchでpackage/domainを検索し、公開第三者実装が個人COIN+ transportを実装するか
  確認した。
- 認証済み画面、個人データ、APK、アプリ通信、export実ファイルは取得していない。公式公開資料で
  分からない履歴期間/件数、pending schema、session/tokenは未確認または次実験として記す。

## 3. surface とデータ境界

### 3.1 AirWalletは実質 app-only

- [AirWallet公式サイト](https://airwallet.jp/)は、COIN+を使ったチャージ、支払い、送金、出金を
  **アプリ**の機能として説明する。公開webは商品説明、導入、規約/FAQへの導線で、個人残高や履歴へ
  ログインするweb dashboardは確認できなかった。
- [Google Play](https://play.google.com/store/apps/details?id=jp.coinplus.app)の公式packageは
  `jp.coinplus.app`、提供者は株式会社リクルートMUFGビジネスである。
  [App Store](https://apps.apple.com/jp/app/%E3%82%A8%E3%82%A2%E3%82%A6%E3%82%A9%E3%83%AC%E3%83%83%E3%83%88/id1549123889)
  のApple IDは`1549123889`でiPhone向けである。2026-08-26時点のストア表示はiOS 1.74.0、
  Google Play更新日は2026-07-29である。
- [COIN+公式](https://coinplus.jp/)は、COIN+アカウント、登録金融機関、残高をCOIN+対応の複数
  アプリで共通利用できるとする。ただし、**送金と出金はAirWalletだけ**で使える。したがって
  AirWalletのデータを「アプリ固有残高」とせず、COIN+共通台帳をAirWalletが表示するものとして扱う。

### 3.2 残高、銀行、カード、ポイントを混ぜない

| surface | 正本/範囲 | AirWalletから確認できると公開情報で分かること | 混同してはいけないもの |
| --- | --- | --- | --- |
| COIN+残高 | COIN+共通残高 | 現在残高、チャージ/支払い/送金/受取/出金による増減 | 連携銀行の預金残高 |
| 登録金融機関 | COIN+に登録した本人名義口座 | チャージ元/出金先の選択、複数口座間移動の経路 | 銀行明細、銀行口座の完全な残高/属性 |
| COIN+ QR支払い | COIN+決済台帳 | 支払い先、支払い額を履歴で確認 | Airペイ加盟店の売上台帳 |
| AirWallet Visa | チャージ式Visaカード | Visa支払い先/額、カード画面、支払い管理 | COIN+ QRと同じ承認/取消schemaだという仮定 |
| リクルートID | ID連携/campaign境界 | 一部キャンペーン条件としてCOIN+アカウントへ連携 | COIN+ログインID、ポイント残高 |
| 特典 | 多くはCOIN+残高として加算 | 残高/履歴上の入金候補 | リクルートポイント/Pontaポイント |
| クイックローン | GeNiEの別ローン | 借入金がCOIN+残高へ入ることがある | COIN+通常履歴の自動化対象 |

[AirWallet Visa公式説明](https://airwallet.jp/visa-card/)は、Visa支払い時にCOIN+残高が
Visaカード残高へ自動変換されるとし、支払先/支払額が履歴に残るとする。したがって実装では
`coinplus_balance`、`visa_card_balance`、`conversion`、`visa_payment`を別イベントとして保持し、
残高移動とカード決済を二重計上しない。バーチャル/リアルカード発行と停止はwriteなので対象外である。

[リクルートID・ポイント公式のAirWalletキャンペーン](https://point.recruit.co.jp/recruitid/doc/campaign/aw/airwallet202606_charge/A3hE2/)
は、リクルートID連携を参加条件にしつつ、特典を「COIN+残高」として加算する。これによりID連携と
残高加算の関係は確認できるが、Ponta/リクルートポイントの残高・有効期限・履歴をAirWalletが
提供する根拠にはならない。ポイントは別sourceから読む。

## 4. 残高・履歴・状態・export

### 4.1 公開情報で確認できるread範囲

| データ | 粒度/表示 | 確認事実 | 未確認 |
| --- | --- | --- | --- |
| COIN+残高 | 現在値 | 公式ストア画像/公式説明のトップに表示 | available/heldの内訳、更新timestamp |
| 利用履歴 | イベント行 | 三菱UFJ銀行の[公式campaign FAQ](https://www.bk.mufg.jp/tsukau/lp/coin_202606_2/index.html)も、銀行別チャージ実績をAirWalletの「利用履歴」で確認するよう案内 | 行field、status、pagination、最古日 |
| 取引レポート | 種別別集計 | 公式Google Play画像にチャージ/出金/支払いの回数と合計額、および個別行が表示 | 集計期間選択、送金/受取/Visaの扱い |
| 支払い管理 | 月次集計 | Google Play 2026-07-29更新説明は、今月支払額、予算使用状況graph、過去月の支払い結果を表示 | 遡及月数、QR/Visa区分、budgetが端末内かserverか |
| Visa履歴 | 支払い行 | 公式Visaページは支払先と支払額がすべて履歴に残るとする | 承認/売上/取消/返金、原取引link、foreign currency |
| 出金結果 | 完了画面 | [即時出金公式説明](https://coinplus.jp/realtime-withdraw/)は条件適用結果を出金完了画面で確認するとする | pending/processing/failedのコード、履歴反映時刻 |

[COIN+取扱上限](https://coinplus.jp/terms/limit/)は、本人確認/銀行口座登録済みの
COIN+（スタンダード）だけが銀行出金とアカウント間送金を利用できるとする。ライト/スタンダードは
履歴schemaや取得範囲が異なる可能性があるため、live検証時にaccount classだけ確認し、本人確認を
新規実施してはならない。

### 4.2 pending / settled

公開一次情報は「利用履歴」「取引レポート」「出金完了」を説明するが、全取引共通の
`pending/settled/failed/reversed`定義、stable transaction ID、訂正/返金の原取引linkを公開していない。
よって次を事実と推測に分ける。

- **事実**: 一部銀行かつ10万円以下の出金は即時出金候補、通常出金は翌営業日振込であり、条件を
  満たしていてもmaintenance等で即時にならない。適用結果は完了画面で確認する。
- **事実**: Visa支払いはCOIN+残高からVisaカード残高への変換を伴い、支払い先/額が履歴に残る。
- **未確認**: 出金申請時点をpending行として保持するか、銀行着金をsettledとするか。
- **未確認**: QR支払いの取消/返金が元行更新、別マイナス行、または一時非表示のどれか。
- **未確認**: Visa authorization/clearingの二段階、差額確定、海外為替、取消/返金schema。

collectorは表示消失を削除、残高回復を返金と即断しない。`observed_at`、表示status、種別、匿名化した
source-local keyを保持し、pending/settled対応が実証されるまではsnapshot差分として扱う。

### 4.3 期間・件数・CSV/PDF/export

公式公開資料から確認できたのは「過去月の支払い結果へ遡れる」ことまでで、次は確認できなかった。

- 利用履歴/取引レポート/支払い管理の最古日、保持年数、月選択数
- 一画面/一requestの件数、無限scroll/page/cursor、最大取得件数
- 日付/種別/金額によるfilterやsearchの有無
- 個人向けCSV、PDF、JSON、email statement、データportability export
- exportの列、文字code、単月/期間一括、Visa/送金/出金の包含

公開サイト/FAQ/公式ストアでCSV/PDF/exportを見つけられなかったことは「機能が存在しない」証明では
ないが、少なくともdocumented export APIとしてA評価する根拠はない。現時点の安全なcaptureは、
端末上で実値を外へ出さずschema/件数を数える、または本人が必要行だけredactした画面を手動取得する
方法である。

## 5. 認証、MFA、端末、passkey、Bitwarden

### 5.1 確認事実

- [COIN+セキュリティ説明](https://coinplus.jp/security/)は、登録時にSMS二要素認証でスマートフォンと
  COIN+アカウントを紐づけ、登録後は電話番号+passwordで利用できるとする。未登録スマートフォンから
  ログインするとSMS二要素認証を行う。
- [公式ログイン手順](https://faq.coinplus.jp/hc/ja/articles/4409254965145-%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3%E3%81%99%E3%82%8B)
  は電話番号、password、SMS codeの順を示す。再送には少なくとも約1分の間隔がある。
- COIN+アカウント作成には携帯電話番号、SMS code、カナ氏名、password、4桁暗証番号が必要である。
- チャージ/送金実行と登録個人情報更新は4桁暗証番号必須である。これはread loginとは別のwrite承認
  barrierであるが、同じsessionからwrite UIに進める点は残る。
- 公式は不正login/取引を常時monitoringし、利用端末以外からのaccessをSMS通知すると説明する。

### 5.2 事実ではないもの

- 「紐づけ」は公式用語だが、hardware-backed key、device certificate、Android Keystore、
  installation ID等の暗号学的binding方式は未確認である。
- passkey/WebAuthn/FIDO2対応を示す公式資料は確認できなかった。未発見を非対応の断定に使わない。
- Face ID/Touch ID/Android生体認証がread unlockに使えるか、server authかlocal unlockかは未確認。
- session/cookie/tokenの寿命、refresh、複数端末、同時login、IP/UA bindingは未確認である。

### 5.3 Bitwarden（推測を分離）

Bitwarden/OS autofillは電話番号+password入力を補助できる可能性があるが、COIN+公式連携ではない。
SMS code、端末登録、4桁暗証番号、アプリ内部sessionの再利用を解決しない。4桁暗証番号やSMS codeを
password item/custom fieldへ集約せず、OTPは本人がその場で入力する。passkeyが将来確認された場合も、
Bitwardenで使えるかはplatform/APIとアプリ実装をlive確認するまで未確認とする。

## 6. public web、WAF、anti-bot

2026-08-26のログアウト状態の少数HEAD/GET観測:

| 入口 | 観測 | 言えること / 言えないこと |
| --- | --- | --- |
| `airwallet.jp` | `Server: AmazonS3`, `Via: ...cloudfront.net`, `X-Cache`, `X-Amz-Cf-*` | marketing siteはS3/CloudFront配信。個人APIの構成ではない |
| `coinplus.jp` | 同じくS3/CloudFront | 公開ブランド/規約/store検索の配信。個人APIのWAFは不明 |
| `faq.coinplus.jp` | `Server: cloudflare`, `CF-Ray`; CNAMEはSalesforce Siteforce/Cloudflare | FAQはSalesforce Experience/AuraをCloudflare経由で配信。COIN+ account APIとは別 |

公開HTMLが読む主scriptは`airwallet.jp/assets/js/main.js`、`coinplus.jp/assets/js/main.js`等のmarketing
UIである。FAQはSalesforce Auraのbootstrap/app scriptを読む。公開marketing JSから個人残高login、
account API、token issuanceは確認できなかった。FAQでCloudflareを観測したことを理由に、アプリAPIも
Cloudflare、WAFなし、またはbot対策なしとは判定しない。Akamai固有headerはこの3入口では観測しなかった。

不正利用monitoringが公式に明記されるため、未知のdevice/IP reputation、rate limit、integrity、
gatewayは存在し得る。CAPTCHA/pinning/attestation/anti-tamperの回避、header/device identifier偽装、
challenge誘発は行わない。

## 7. APK、deobfuscation、read-only runtime observation

公式standalone APK配布は確認できなかった。Google Playの正規packageは`jp.coinplus.app`である。
この調査hostにはADB、接続Android端末、jadx/apktoolの既存環境がなく、APK静的解析は未実施である。
第三者APK mirrorを初期取得元にしない。

次段階は、本人管理Android端末へGoogle Playから正規installした同一versionを対象にする。

1. `adb shell pm path jp.coinplus.app`でbase/split APKのpathを列挙し、非rootの`adb pull`が許される
   場合だけ取得する。package/version/signing certificate/digestを確認し、binaryはrepositoryへ置かない。
2. manifest、exported component/deep link、SDK/permission、backup/debuggable、network security config、
   cleartext設定、Play Integrity/SafetyNet候補、certificate pinning候補を静的にinventoryする。
3. jadx/apktoolでhost/path文字列、OkHttp/Retrofit/Ktor/WebView、protobuf/JSON model、session/refresh、
   device registration、CSRF/idempotency、read/write service境界を調べる。R8名を無理に復元せず、control
   flow・型・文字列から仮名を付ける。難読化解除は理解のためのread-only作業で、security controlを
   無効化する作業ではない。
4. 本人操作で残高、履歴、取引レポート、支払い管理を開く1 sessionだけを動的観測する。標準的な
   Android profiler/logcat、OSが許すproxy/Network Inspector、またはread methodのruntime hookで、
   origin、method、path template、status、field **name**だけをsanitized allowlistへ出す。argument/body、
   header、token、device ID、PII、実値はhook/trace時点でdropする。
5. instrumentation/root/debuggerを拒否するintegrity、certificate pinning、anti-tamperに当たった場合は
   bypassせず停止する。Frida等のhookも保護回避なしで通常read pathを観測できる場合に限る。

静的解析で候補が見つかっても、endpointを呼ばずschema候補とする。動的観測後も、read requestを
replayする前にread/write scope、token更新、idempotency、alert/rate responseを確認する。

## 8. 公開第三者実装とtransport/auth

2026-08-26のGitHub code searchで`jp.coinplus.app`、`coinplus.jp`、`airwallet.jp`を検索したが、
現行の個人COIN+残高/履歴、login/session renewalを実装する公開clientは特定できなかった。存在しない
証明ではない。

見つかった[ohru131/coin_plus_map](https://github.com/ohru131/coin_plus_map/tree/fac52f370838de105a228d575687bd9bb2803cfe)
は、公開店舗検索が読む`https://coinplus.jp/assets/csv/storesearch/all_shop_list.js`をHTTP GETし、
店舗名/住所/categoryをCSVとしてparseする実装である。認証なしの加盟店検索transportで、個人残高、
利用履歴、COIN+ authは扱わない。個人sourceのA/B/C根拠やclient code再利用根拠にはならない。

現時点で確認できる個人auth/transportは「公式mobile appがTLS通信を行う」「電話番号+password、
未登録端末のSMS、write時4桁暗証番号」というUI/公式説明までである。API host、REST/GraphQL/gRPC、
request signing、cookie/bearer token、refresh、CSRF、gateway、read-only scopeは未確認である。

## 9. read/write隔離

### allowlist

- 既存session状態確認と通常login（password reset、account作成、端末解除は除外）
- COIN+現在残高、既存登録銀行の匿名表示、利用履歴/取引レポート/支払い管理の表示
- 既存のCOIN+ QR/Visa支払い履歴、既存チャージ/送金/受取/出金履歴の表示
- 公式に既存export controlが見つかった場合のdownload（生成/送信/共有はしない）

### denylist

- 支払い/返金依頼、送金/受取依頼、チャージ、出金、定期送金
- 銀行口座追加/削除、本人確認、COIN+ account class変更
- Visaカード発行/申込、リアルカード申込、停止/解除、card情報表示の自動取得
- クイックローン申込/契約/借入/返済、給与受取設定
- gift code、campaign entry、Recruit ID/point連携/解除、point使用
- password/暗証/電話/氏名/通知/予算/みまもり等の設定変更、logout/reset/解約

内部tokenがread/writeを兼ねる可能性があるため、HTTP methodだけで隔離しない。origin+method+path+
request schemaのallowlist、egress proxy、response type/size上限、dry-run、監査を使う。`POST`でもread
queryの可能性、`GET`でも副作用の可能性があるため、実観測なしにmethodを分類しない。

## 10. runtime適性

| Runtime | 適性 | 理由 |
| --- | --- | --- |
| Cloudflare Workers | 取得済みsanitized export/JSONのparseには適する。直接取得は現状不適 | mobile app bootstrap、SMS、端末binding、未知tokenをisolateだけで扱えない。personal APIがread-only replay可能と実証された後だけ再評価 |
| Cloudflare Browser Run | 公開FAQ調査には使えるが個人データ取得には不適 | [Playwright](https://developers.cloudflare.com/browser-run/playwright/)と[session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)はあるが、個人web dashboardがなくmobile app sessionをbootstrapできない |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/platform-details/architecture/) | parser/secretless replay候補。Android UIには不向き | containerで任意runtime/filesystemは使えるが、Play端末、SMS、hardware-backed state、accelerated Android emulatorは別問題 |
| 一般[OCI container](https://github.com/opencontainers/runtime-spec) | static analysis/parser、実証後のHTTP replayには適する | jadx/apktool/parserを再現可能に固定できる。APK/secret/profileはimageへ含めず短命mountを使う |
| [Kubernetes](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) | 多数sourceのparser/replay orchestrationには適するがAirWallet単体には過大 | CronJob/NetworkPolicy/Secret分離は有用。Android emulator/device routingと人手SMSを解決しない |
| Android emulator | 初期候補だが実機より劣る | 公式Android文書はVM accelerationにhost hypervisor/KVMを要求し、VM内/Docker内のaccelerated emulatorを制限する。Play Integrity/device bindingの挙動も実機と異なり得る |
| 本人管理Android実機 | static artifact取得とlive read観測に最適 | 正規Play install、既存登録端末、本人SMSを使え、secretをcloudへ搬出しない。完全無人化にはならない |

推奨は本人管理実機で1回のread-only schema確認を行い、手動redacted captureをlocal parserへ渡す構成。
API replayが実証される前にWorkers/OCI/Kubernetesへ認証情報を配らない。

## 11. 自動化レベルA-Eとcost

PR #5の共通定義だけを用いる。

- **A**: direct documented/export API suitable for scheduled headless use
- **B**: stable read-only internal API with renewable/reusable session
- **C**: browser/app bootstrap + headless replay plausible
- **D**: full browser/device automation probably required
- **E**: manual capture remains safe default
- costは1（small wrapper）から5（device-bound/adversarial）

| 経路 | Level | Cost | 判定 |
| --- | --- | ---: | --- |
| 本人がAirWalletの残高/履歴/取引レポートを手動captureしredact、parserへ渡す | E | 1-2 | 現時点の安全な既定。公式export未確認で、複数画面/OCRなら2 |
| 公式exportがliveで見つかった場合の手動download+ingest | E | 1 | 公式手動exportだけなら共通rubric上E。現時点では存在自体未確認 |
| app UI/device automation | D | 5 | app-only、SMS/端末紐づけ、write UI同居、session/integrity未確認 |
| 本人端末bootstrap後のsanitized read endpoint replay | C候補 | 4-5 | transport/token renewal/read-write分離が未実証。pinning/integrity bypass不要の場合だけ候補 |
| 安定したread API直接取得 | B候補 | 3-4 | stable endpointと再利用/更新可能sessionを観測していないため現状Bではない |

**総合評価: E、cost 1-2。full automationはD、cost 5。transport実証後のみC候補、cost 4-5。**
documented personal API/export APIがないためAではなく、stable read-only internal APIとsession更新も未観測
なのでBではない。公開店舗CSVは個人データでなく評価対象外である。

## 12. read-only live検証計画

### Phase 0: 本人端末で表示だけ確認

1. 正規Play/App Store版、version、COIN+ライト/スタンダード、既存登録端末かだけ確認する。
2. トップにCOIN+残高とVisaカード残高が別表示されるか、登録銀行は何を表示するかを**field名だけ**
   記録する。銀行預金残高が見えない場合も実値を転記しない。
3. 利用履歴、取引レポート、支払い管理、Visa履歴の入口を開く。支払い/送金/チャージ/出金buttonは
   押さない。

### Phase 1: 履歴schema/期間/export

1. 最古/月最新へscrollし、遡及月数、page/cursor、一回load件数、最大件数を実値なしで数える。
2. チャージ、QR支払い、Visa支払い、送金/受取、出金、特典加算について、表示fieldとstatus候補だけ
   確認する。実在しない種別を作るための取引はしない。
3. 既存履歴に取消/返金/failed/pendingが自然に存在する場合だけ表示schemaを確認する。原取引link、
   transaction ID、timestamp/timezoneを値なしで記録する。
4. filter/search、CSV/PDF/share/export controlの有無、format、範囲をUI上で確認する。share/sendは押さない。
5. 支払い管理の対象月数、QR/Visa包含、transaction reportとの重複規則を確認する。

### Phase 2: static/dynamic transport

1. 正規install artifactをSection 7の手順で取得・署名確認し、manifest/host/schemaをstatic inventoryする。
2. 本人がread画面を開く1 sessionをsanitized traceし、read/write host/path、pagination、status model、
   session/refresh候補をfield名だけで整理する。
3. replay前に、read-only request、credential scope、renewal、device/IP/UA binding、rate responseを確認する。
   最小のread request 1回でも実値を保存せず、残高/件数の整合は本人画面でyes/no確認する。
4. 同じcredentialでwrite可能、refreshにOTP/再登録が必要、または防御回避が必要ならC/Bへ進めない。

## 13. 即時stop条件

- 支払い、送金、受取依頼、チャージ、出金、銀行追加/削除、Visa/loan/本人確認/設定変更画面へ遷移した
- 確認、申込、変更、送る、受け取る、チャージ、出金、借りる等の副作用buttonを押す必要がある
- password、SMS code、4桁暗証番号、token、口座/電話/氏名、実額をlog/HAR/hook outputに残しそう
- login alert、不正検知、CAPTCHA、rate limit、account lock、強制password reset、追加本人確認が出た
- pinning、attestation、root/debugger/anti-tamperを回避しないと観測できない
- endpointのread/write副作用、idempotency、対象accountが判別できない
- pending/settled/返金の判定にtest transactionまたは残高操作が必要
- 取得範囲がQuick Loan、Recruit point/Ponta、銀行預金台帳、他人のCOIN+ accountへ越境する

停止時はrequest再送や別device/IPでの試行を行わず、手動captureのEへ戻る。秘密/PIIを含む一時artifactは
共有・commitせず、本人端末内で削除可能性を確認してから安全に廃棄する。

## 14. 主要一次情報

- [AirWallet公式サイト](https://airwallet.jp/)
- [COIN+公式サイト](https://coinplus.jp/)
- [COIN+セキュリティへの取り組み](https://coinplus.jp/security/)
- [COIN+即時出金](https://coinplus.jp/realtime-withdraw/)
- [COIN+取扱上限/下限](https://coinplus.jp/terms/limit/)
- [AirWallet Visaカード](https://airwallet.jp/visa-card/)
- [Google Play: jp.coinplus.app](https://play.google.com/store/apps/details?id=jp.coinplus.app)
- [App Store: AirWallet](https://apps.apple.com/jp/app/%E3%82%A8%E3%82%A2%E3%82%A6%E3%82%A9%E3%83%AC%E3%83%83%E3%83%88/id1549123889)
- [COIN+ login手順](https://faq.coinplus.jp/hc/ja/articles/4409254965145-%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3%E3%81%99%E3%82%8B)
- [三菱UFJ銀行 campaign FAQ（AirWallet利用履歴確認）](https://www.bk.mufg.jp/tsukau/lp/coin_202606_2/index.html)
- [リクルートID・ポイント公式campaign](https://point.recruit.co.jp/recruitid/doc/campaign/aw/airwallet202606_charge/A3hE2/)
- [Cloudflare Browser Run session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)
- [Android Emulator hardware acceleration](https://developer.android.com/studio/run/emulator-acceleration)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [OCI Runtime Specification](https://github.com/opencontainers/runtime-spec)
