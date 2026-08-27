# au PAY API family 調査

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: 個人向け au PAY 残高、コード／ネット／プリペイド決済、チャージ、送金・受取・出金の read 表示、および同じ au ID から参照できる au PAY（auかんたん決済）と Ponta ポイントの境界。
- 対象外: au PAY for BIZ、au PAY マーケットの購入台帳、au PAY スマートローン、auじぶん銀行口座、Suica、au PAY カードのクレジット台帳。アプリに表示されても別 source とする。
- 制約: 未ログインの公式公開情報、公開 HTTP レスポンス、公開コードだけを使用した。au ID、電話番号、Ponta 会員 ID、残高、金額、加盟店、送金相手、カード・銀行情報、Cookie、token、OTP 等の実値は取得・保存していない。ログイン後の live 検証は未実施。

## 結論

au PAY は完全な app-only ではない。公式 [au PAY サイト](https://wallet.auone.jp/) は、au／UQ mobile／povo1.0 契約に紐づく利用者に、au PAY 残高と au PAY（auかんたん決済）の月別履歴、詳細、PC での「全てのサービスの明細」ダウンロードを提供する。一方、その条件を満たさない au ID は公式案内上アプリでしか履歴を確認できず、残高内訳、送金・受取・出金、Ponta 表示も app 寄りである。

公式 download は scheduled headless API ではない。拡張子、内部ファイル、列、対象期間、最大件数は公開説明だけでは確定できない。現行 login は au ID の SMS／Eメール二段階認証、WebAuthn/FIDO ベースの指紋・顔認証、KDDI CAPTCHA、端末・回線条件を持つ。全体の安全な既定値は **E、cost 1（手動 download/import）**。Web 対象者の既存 browser session から read/export transport を特定できれば **C candidate、cost 3**、Web 非対象者の app route は **D、cost 4** である。

Ponta と au PAY カードは別台帳に分離する。Ponta はポイント残高・通常／マーケット限定・加算／利用・有効期限の reward ledger、au PAY カードは確定／未確定利用、請求、CSV／PDF の credit ledger。カードから au PAY へのチャージは card 側の出金と wallet 側の入金を reconciliation link で結び、買物として二重計上しない。

## 公式サーフェスと対象範囲

- [公式の履歴確認 FAQ](https://www.au.com/support/faq/details/00/0000/000001/pg00000150/) は、アプリと対象者向け Web の双方で `au PAY 残高` と `au PAY（auかんたん決済）` を月別に切り替え、各行の詳細を表示できるとする。
- [au PAY 特約](https://wallet.auone.jp/contents/lp/terms/aupay.html) は、決済日時、加盟店名・利用店舗名、決済金額、チャージ実績、決済状況を利用履歴として扱う。最低模型は `occurred_at / ledger / type / merchant_label / amount / status / balance_after? / source_reference?`。末尾二項目の実在は live 未確認。
- [残高の公式説明](https://wallet.auone.jp/contents/pc/guide/moneytransfer.html) は、決済用の `au PAY マネーライト` と決済・送金・出金用の `au PAY マネー` を分ける。本人確認後でも通信料金合算、クレジットカード、ギフトカードからのチャージはマネーライトになる。表示される場合は二種類を別 snapshot field とする。
- app の read 候補は残高・残高内訳、コード／ネット／プリペイド利用、チャージ、送金・受取、出金、返金・調整、auかんたん決済。支払、チャージ、送金、出金、受取 QR/URL 作成は write であり実行しない。
- [App Store](https://apps.apple.com/jp/app/id862800897) と [Google Play](https://play.google.com/store/apps/details?id=jp.auone.wallet) は、残高、利用履歴、Ponta、au PAY カード情報、auかんたん決済情報を一つの UI に集約する。Android package は `jp.auone.wallet`。一画面でも backend/ledger が同一とはみなさない。

| 経路 | 確認できた read | 制約・扱い |
|---|---|---|
| au PAY app | 残高、履歴、内訳、ポイント、カード概要、かんたん決済、送金先履歴等 | 機能により本人確認・端末状態。write UI 隣接。Web 非対象者は app-only |
| au PAY Web | wallet/easy-payment の月別履歴・詳細 | au／UQ mobile／povo1.0 契約者のみ。対象者には app-only でない |
| PC download | `全てのサービスの明細` | PC browser。公開説明は Excel 内の希望ファイルを選ぶとだけ記載 |
| au Ponta ポータル | point 残高、期限、加算／利用、通常／限定切替 | wallet export ではなく別 reward ledger |
| au PAY カード会員サイト/app | カード請求・利用明細・利用可能額・PDF/CSV | 別 credit source |

Web 対象判定に電話番号・契約情報を保存しない。公式 Web に既存状態で履歴画面が出るかを boolean capability とし、対象外表示なら app route へ分岐する。

## 明細状態、粒度、期間、件数、export

- 公式 FAQ では加盟店名が一時的に `ブランドプリペイド加盟店` と表示され、決済後約 14 営業日で実店舗名に変わる場合がある。キャンセル時は仮名のまま残り得る。merchant label は不変 ID でなく可変属性として upsert する。
- au PAY（auかんたん決済）の当月明細は請求確定前で実際の請求額と異なり得る。`provisional` snapshot と確定後の `settled` を分ける。
- [プリペイド取消 FAQ](https://www.au.com/support/faq/details/00/0000/000002/pg00000280/) は取消情報到着時の返金と、未到着でも決済日から 45 日後の自動取消・返金を説明する。[二重返金 FAQ](https://www.au.com/support/faq/details/00/0000/000033/pg00003316/) は一時的二重返金と最長 10 日後の再引落しも説明する。refund/adjustment/reversal を独立イベントにする。
- 特約上の決済完了後も merchant enrichment、取消、調整はあり得るため `completed` と `immutable` は同義でない。
- source transaction ID の公開有無は不明。なければ ledger、日時、符号付き金額、type、当月 ordinal の provisional key を使い、merchant label 変更で別行を作らない。曖昧な照合は自動 merge しない。
- アプリは直近 6 カ月に加え `もっと見る` から 6 カ月以上前も表示できるが、最長期間は公開されていない。Web の固定 retention、月最大件数、pagination、rate limit も未確認。
- PC download は公式に存在するが、FAQ は「エクセルファイルの中で希望のファイルを選択」とだけ説明する。CSV/XLSX/ZIP、ファイル数、encoding、列、期間、ゼロ件月、件数上限を断定せず `Excel-compatible download (exact format unknown)` とする。
- 個人 wallet の PDF/OFX は確認できなかった。au PAY カード PDF/CSV と加盟店向け au PAY for BIZ CSV は対象外。
- 月次差分だけでなく直近 45 日を再取得し、merchant enrichment・取消・二重返金調整を反映する。未確定 easy-payment は請求確定後も再取得する。

## Ponta ポイントとの境界

- [Ponta 履歴 FAQ](https://www.au.com/support/faq/details/00/0000/000001/pg00000122/) は app/au Ponta ポータルで加算・利用履歴を表示し、通常 `Pontaポイント` と `Pontaポイント（au PAY マーケット限定）` を切り替える。wallet row に埋めず reward event とする。
- [Ponta 公式説明](https://www.au.com/payment/point/) は通常 Ponta の期限を最後の加算または利用から 1 年とする。[期限 FAQ](https://www.au.com/support/faq/details/00/0000/000001/pg00000198/) はマンスリーポイント等の一部加算で期限が延びない例外を列挙する。event ごとの延長を推測せず、現在期限 snapshot と公式 category rule を分ける。
- マーケット限定ポイントは付与単位で期限が異なり得る。[公式規約](https://www.au.com/payment/point/regulation-point/) も個別通知、通知がない場合は付与月から 12 カ月経過後の月末とする。通常ポイントと合算しない。
- au PAY 支払による獲得、Ponta から wallet への charge は二台帳の対応イベント。Ponta 使用／交換／残高 charge は write なので呼ばない。共通 reference がなければ日時・金額だけで自動結合しない。
- Ponta 履歴の期間、件数、download、wallet PC download への同梱は未確認。

## au PAY カードとの境界

- [公式カード FAQ](https://www.au.com/support/faq/details/00/0000/000026/pg00002672/) は専用サイト/appで過去 14 カ月を確認・download可能とし、[カード FAQ](https://qa.kddi-fs.com/faq/show/20736?category_id=75&site_domain=1) は PC の PDF/CSV を明記する。wallet download とは別仕様。
- au PAY app のカード請求予定／確定額は summary。加盟店明細、pending/settled、分割・リボ、返金、CSV/PDF は card source が正本。
- card→wallet charge は card funding transaction と wallet charge event の reconciliation pair。wallet/card purchase ではない。
- easy-payment の支払元が card でも、商品台帳とカード請求を重複しない。My au/KDDI料金、easy-payment、card請求の reference と請求月ずれを link 可能にする。

## 認証、MFA、端末、passkey、Bitwarden

### 確認済み事実

- [au ID 二段階認証](https://www.au.com/au-id/auth-two-factor/) は ID/password に加え、SMS ワンタイム URL または SMS／Eメール 6 桁コードを状況に応じて適用する。自動取得・転送せず本人 handoff。
- [指紋・顔認証](https://www.au.com/au-id/auth-biometric/) は WebAuthn/FIDO 系で 1 au ID 最大 10 台のスマートフォンを登録可能。設定後は password login が無効となり、他端末は登録済みスマートフォンの QR cross-device login、または本人が password login を一時有効化する。後者は設定変更なので collector は行わない。
- 公式は cross-device flow で Bluetooth を要求し、Apple 環境では credential が別対応端末で使える場合がある。また `利用可能なパスキーがありません` という error を使う。単なる app unlock と扱わず passkey/WebAuthn credential の device/provider 境界を試験する。
- 2026-08-26 の未認証 login HTML は `fidoDeviceEnableFlg`、`fidoAuthDeviceEnableFlg`、WebAuthn check、KDDI CAPTCHA (`kcaptcha-nc.kddi.com`) を含んだ。password form は `connect.auone.jp`。wallet は Laravel CSRF cookie/session を発行し redirect するが、authenticated cookie 名・寿命は不明。
- [app privacy disclosure](https://wallet.auone.jp/contents/sp/aupay/android/privacy_policy.html) は暗号化 au ID、認証 cookie、Android ID、端末固有情報、操作履歴、Ponta ID 等の送信を列挙する。app session を単純 bearer token と仮定しない。

### 事実と推測の分離

- **事実**: KDDI は Bitwarden を対応 provider と明記しない。公式は端末生体、OS/browser、QR、Apple環境での credential 利用可能性を説明する。
- **推測**: password login が有効なら Bitwarden autofill が使える可能性は高いが、MFA、CAPTCHA、端末・回線判定を置換しない。
- **推測**: OS/browser が第三者 passkey provider を許す場合、Bitwarden passkey が働く可能性はある。ただし au ID の端末登録、Wi-Fi off/au回線条件、QR/Bluetooth、app内 browser互換は未確認。対応済みと記録しない。
- passkey/生体の登録・解除、端末登録、password login 一時有効化、MFA送信先変更を行わない。既存認証を bootstrap に使えなければ D/E へ downgrade。

## Edge、WAF、anti-bot、公開 Web/JS

- 2026-08-26 の未認証観測で `wallet.auone.jp` は CloudFront (`Via`, `X-Cache`, `X-Amz-Cf-*`) 背後の Apache/Laravel、`aupay.wallet.auone.jp` は CloudFront/S3、公開店舗検索 API は CloudFront と AWS API Gateway (`x-amz-apigw-id`)。account API の構成証拠ではない。
- `id.auone.jp` は nginx/JSESSIONID。`connect.auone.jp` の login page は password form、WebAuthn/FIDO flag、端末環境収集 JS、KDDI CAPTCHA loader を含む。WAF 製品名や Akamai は確認できず、CloudFront だけで AWS WAF と断定しない。
- `wallet.auone.jp/robots.txt` は全体 disallow を返さなかったが、認証済み自動取得の許可ではない。
- 公開 `api.aupay.wallet.auone.jp/store-search` は加盟店探索用で個人口座 API ではない。A/B 判定に使わない。
- 403/429、CAPTCHA、risk、未知 integrity、端末登録を迂回しない。公開 JS の整形/deobfuscation、form/redirect/cookie属性の静的把握、本人操作の read-only observation は対象。

## 公開 third-party client の transport/auth

### outerguy/ofxproxy（historical evidence）

[outerguy/ofxproxy](https://github.com/outerguy/ofxproxy/blob/89e0d8a08537897d628bc46ddf862452d39ee2df/server/auwallet.inc) は 2014--2017 年の au WALLET Web 向け AGPL-3.0 実装で、該当最終 commit は [2017-11-25](https://github.com/outerguy/ofxproxy/commit/8952173918cbaba941fbe1831061055f46e9e4d0)。現行 client ではないが当時の transport を具体化する。

1. wallet home を HTTP/1.1 GETし、login form hidden input と au ID/password を form POST。
2. redirectを追い、`JSESSIONID`、`BIGipServer...`、`DVCK/DTKT/VTKT/ACST` 等の cookie allowlist を継承。
3. `2段階認証` HTML を検出すると method/URI/body/cookie を一時 session とし、人の追加入力へ返す。`DVCK` を端末/risk token として再利用する optional path もあった。
4. balance/メニュー/プリペイド履歴 HTML を parseし、当月・前月 `download_form` を POST、historical `history_print.html` から CSV を取得。
5. charge history は別 accordion HTMLをparseし買物CSVに結合、third-party側でOFXを生成。公式OFX endpointではない。
6. 最後に logout link を GET。

これは credentials/session cookie を自身で扱い、2017 年以降更新されず、現在の CloudFront/Laravel、WebAuthn、KDDI CAPTCHA、現行 download、送金/Ponta/easy-paymentへの対応を示さない。field/path/cookie名を current contract として再利用しない。現代の公開 account client は見つからなかった。

### APK-derived evidence と public API

- [tabbed-out 公開解析](https://github.com/beerphilipp/tabbed-out/blob/3ada3bb1fc317cdf9a442a52445614ee5a8b7cff/analysis/results/jp.auone.wallet.res.json) は 2024 年の `jp.auone.wallet` multiple APKs に KDDI `OidcCustomTabsHelper` と Custom Tabs launch call があることを示す。OIDC/browser bootstrap候補だが token endpoint/scope/refresh/read host/schema は不明。
- [公開店舗検索実装](https://github.com/STREAM-inc/NetHarvest-Scripts/blob/8c0d021c9ef1720c92960672b7464a63364176a0/sites/service/aupay_japan.py) は public `store-search` を unauthenticated JSON として使うが個人 wallet transportとは別。
- 現行 third-party account client、renew/reuse可能session、read API schemaは未発見。Bの証拠はない。

## 正規 APK/JS 静的解析と read-only 動的観測

今回の host には ADB と管理下 Android 実機がなく、正規 Play split APK は未取得。third-party mirrorで代替せず、manifest/host/pinning/integrityを断定しない。

1. 管理下実機の Google Play で developer/package が KDDI / `jp.auone.wallet` と確認して通常 install/update。
2. `adb shell pm path jp.auone.wallet` で base/split path を列挙して pull。再配布せず SHA-256、version、split名、signing certificate、取得日時だけを evidence manifest に残す。
3. `apksigner`、`apkanalyzer`/`aapt2` で signer、SDK、permission、exported component、deep link、provider/service/receiver、backup/debuggable、`networkSecurityConfig` を確認。
4. `jadx --deobf`、resource/native strings で KDDI OIDC helper、official host、WebView/Custom Tabs、OkHttp/Retrofit等、request/response model、Room/SQLite、wallet/Ponta/card/easy-payment feature split、session renewalを特定。deobfuscation自体は対象。
5. network config、TrustManager/hostname verifier、CertificatePinner、Play Integrity/attestation、root/hook detectionの存在とcall siteを記録。無効化・return値変更はしない。

本人の通常操作による一回限りの read-only tracing も対象:

- profiler/Network Inspector、filtered logcat、attach可能な no-op hook で class/method、host、HTTP method、path template、status、content-type、schema field名のhash、token/cookie属性・寿命だけを観測。
- user-installed CA を app が通常設定で信頼する場合だけ owner-controlled proxy を使う。pinning拒否なら bypassせず DNS/SNI/TLS timing と static call graphへ戻る。
- balance、履歴、内訳、Ponta履歴、送金履歴の通常 read 操作だけ。支払コード、QR scan、charge、send/withdraw、point use、設定へ進まない。
- HAR/pcap/screenshot/raw log/body/header は保存せず、その場で route/schema metadata に redactし破棄。
- Web JS は login→au ID→password/WebAuthn→MFA/risk→wallet return、CSRF/cookie rotation、download method/path/content-typeだけを確認。CAPTCHA token、credential、cookie/body値は取得・再現しない。

## read/write 隔離

read-only allowlist:

- 既存 session validation、残高・内訳 snapshot
- wallet/easy-payment の履歴一覧・詳細
- 既存 charge/send/receive/withdraw/refund/adjustment 履歴表示
- Ponta 残高、期限、通常／限定履歴
- au PAY カードの一般化された請求 summary（正本は別 source）
- 公式 PC download（transport確認後）、logout

禁止操作:

- 支払コード/QR生成・提示、請求書読取、ネット支払、購入
- manual/auto charge、チャージ方法追加、Pontaからのcharge
- send、受取QR/URL作成、withdraw、送り先追加、アドレス帳利用
- Ponta使用・交換・運用、campaign entry
- card支払、分割/リボ等変更
- 本人確認、bank/card link、auto-charge、上限、通知、個人情報、端末、passkey/MFA/password設定変更

HTTP methodだけでread/writeを決めない。login/export POSTはread候補だがorigin/path、field name/type、CSRF/session、expected redirect/content-typeをallowlistし、unexpected redirectを自動followしない。意味未確認のPOST/PUT/PATCH/DELETE、GraphQL mutation、app RPCは拒否。

## 実行環境適性

| 環境 | 適性 | 理由 |
|---|---|---|
| Cloudflare Workers（fetch） | 低〜条件付き | export parser/reconciliation は適するが WebAuthn/MFA/CAPTCHA/device bootstrap不可。cookie/token/PIIをKV/logへ置かない |
| Cloudflare Browser Run | 条件付き | [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/) と [storage state](https://developers.cloudflare.com/browser-run/playwright/) は C候補。ただし公式docs上 bot識別され、CAPTCHA/passkey/QR/端末条件を解決しない |
| Cloudflare Containers | 条件付きで適 | [公式](https://developers.cloudflare.com/containers/platform-details/architecture/) は Linux/amd64 VM。browser/parserを包装できるがMFA/passkey、session永続化、地域/IP変化は別問題 |
| OCI image | 適 | [OCI spec](https://github.com/opencontainers/image-spec/blob/main/spec.md) でdigest pin。secret/sessionをimage/envへ焼かずruntime store、tmpfs、egress allowlist |
| Kubernetes | 過剰だが適 | [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) は重複/欠落し得るためidempotent、`Forbid`、digest pin、read-only FS、NetworkPolicy、1 account/Pod |
| 管理下 Android 実機 | 調査に最適、定常は高コスト | 正規APK、OIDC/host/schema、内訳/送金/Ponta route確認に必要。UI automationは端末、passkey/Integrity、write UI隣接でD/cost4--5 |

## 共通 rubric による評価

PR #5 `docs/source-research.md` の定義をそのまま使用する。

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| 経路 | Level | Cost | 判断 |
|---|---:|---:|---|
| 公式明細をPCで手動downloadしoffline import | **E** | **1** | 最も安全。exact format/retention/schemaはlive確認 |
| Web対象契約の既存sessionから履歴/export replay | C candidate | 3 | bootstrap後readはplausible。MFA/WebAuthn/CAPTCHA、renewal、download transport未確認 |
| Web画面UI automation | D | 4 | DOM/JS/login protection、可変merchant、write UI依存 |
| Web非対象accountのapp read | D | 4 | full device/app transportまたはUI automation必要 |
| au Ponta portal残高/履歴 | C candidate | 3 | Webあり、公式scheduled API/exportなし |
| 公開店舗検索API | 対象外 | 1 | 個人財務台帳を取得しないため評価へ算入しない |
| family安全既定 | **E** | **1** | 確実なのはmanual export。契約別研究候補はC/D |

A は個人 wallet 向け documented scheduled API がなく不適。B は現行 read API、renew/reuse、schema stability の証拠がなく不適。historical ofxproxy/public store-searchを根拠にしない。

## read-only live 検証計画

1. 公式 origin (`wallet.auone.jp` / `aupay.auone.jp` / `connect.auone.jp`) とTLS、Web履歴capabilityだけをbooleanで確認。
2. 本人が既存方式でlogin。SMS URL/code、Eメールcode、passkey/生体/PIN、QR/Bluetooth、CAPTCHA/riskは自動入力せずhandoff。
3. 残高総額/内訳のfield存在だけ確認。額、au ID、電話、KYC、funding detailsは記録しない。
4. wallet/easy-payment tab、month selector、6カ月超、detail field、provisional merchant、refund/adjustment state/typeを型として確認。
5. PC downloadを本人が一回押し、method/path template、content-type/Content-Disposition、拡張子、container file一覧、列名hash/型、encoding、対象期間、zero-rowを確認。tmpfsで即時破棄。
6. Pontaで通常/限定、残高、期限、加算/利用、予定point境界だけ確認。use/exchange/chargeへ進まない。
7. card summaryが別deep link/sessionへ遷移することだけ確認。card明細は別source。
8. 既存send/receive/withdraw historyの入口とread/detail routeだけ確認。新規送り先、QR/URL、金額入力、confirmationへ入らない。
9. DevToolsでlogin redirect、CSRF cookie属性、wallet return、read/detail/downloadのmethod/path/schema metadataだけredact観測。値は保存しない。
10. 短時間の同一browser再接続でvalidation、idle/absolute timeout、cookie rotation、silent renewを観測。失効時にlogin replayしない。
11. 正規APKを得たらsigner/manifest/host/schema/pinning/integrityを静的解析し通常readのno-op tracing。attach/proxy拒否は回避せず停止。
12. 公式logoutし、一時file/profile/session/raw traceを破棄。

### stop 条件

- 支払、charge、send/receive QR、withdraw、Ponta use/exchange、card payment、申込、設定変更の CTA/confirmation
- OTP/SMS URL、passkey/生体/PIN、QR/Bluetooth、CAPTCHA、risk、本人確認、端末/回線登録
- password login一時有効化、passkey/MFA変更、規約同意/KYC更新
- allowlist外POST/PUT/PATCH/DELETE、GraphQL mutation、app RPC、cross-origin redirect、未知download
- 401/403/409/423/429、lock、不正検知、制限警告、連続login failure
- DOM/export/schema/status/ledger境界未知、件数欠落、照合曖昧
- PII、実残高/金額/merchant/送金相手/card/bank、cookie/token/OTPがlog/trace/screenshotへ出る
- root/debuggable/return値改変、pinning/attestation/CAPTCHA/anti-hook/WAF bypassが必要

## 未確認事項

- 実 account のWeb対象可否、Web/appのwallet/easy-payment・内訳・send/receive/withdraw read coverage差。
- wallet downloadのexact format、内部file、列、encoding、期間、件数、pagination、zero-row、Ponta同梱。
- app/Web最長retention、transaction ID、balance-after、status全集合、取消/二重返金調整の実表示。
- authenticated cookie/token、idle/absolute timeout、renew/reuse、UA/device/IP/回線binding、logout invalidation。
- Bitwarden autofill/passkeyのWeb、QR cross-device、app内browser互換。
- account read host/transport/auth scope/CSRF/schema、app/Web共通性。public store-searchは無関係。
- 現行APKのversion/signing certificate、manifest、deep link、network config、host、local schema、pinning/Integrity/anti-hook。
- CloudFront背後のWAF/bot製品。AWS WAF/Akamai等は未確認。
- Pontaのretention/count/export、期限例外category、限定point lot schema。
- card summaryと専用card sourceのdeep link/session境界、同一chargeのpublic reconciliation reference。
