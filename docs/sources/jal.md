# JAL Pay / JAL Mileage Bank source assessment

調査日: 2026-08-26

## 1. Scopeと境界

本sourceは同じJMB会員関係にある次のread-only ledgerを分離する。

- **JAL Pay**: チャージ残高、JAL Payポイント、決済、チャージ、取消・返金、利用明細
- **JAL Mileage Bank (JMB)**: マイル残高、積算・利用実績、lot別期限、Life Status関連表示
- **JALファミリークラブ / JALカード家族プログラム**: 家族マイル合算制度と個人口座の関係
- **予約・航空券・JALカード請求・JAL Global WALLET外貨/ATM**: 別source/別ledger

支払、チャージ、マイル→JAL Payポイント、特典交換、予約/取消、family登録、profile/認証設定変更を
行わない。JMB番号、wallet/card/device ID、氏名、予約、token、cookie、OTP、passkey material、実残高・
実額を保存せず、security controlを回避しない。

## 2. 調査方法と公式URL

- JAL公式Web/FAQ、JAL Pay/JMB app listing、family制度を一次sourceとして確認。
- 認証不要で公開page/headerを観測。account login、app起動、実データ取得なし。
- GitHubをpackage ID、Global WALLET host、JAL Pay/JMB用語で検索。公開consumer transport実装を調査。
- APK/JS decompileと本人操作中のruntime観測は次実験として具体化。

主要公式URL:

- [JAL Pay](https://www.jal.co.jp/jp/ja/jmb/jalpay/)
- [残高確認](https://www.jal.co.jp/jp/ja/jmb/jalpay/pay/usage/balance-inquiry/)
- [チャージ](https://www.jal.co.jp/jp/ja/jmb/jalpay/pay/usage/charge/)
- [利用履歴FAQ](https://faq-jp.jal.co.jp/ja/s/article/jdsp000000R0000000030482jmb)
- [チャージ残高期限FAQ](https://faq-jp.jal.co.jp/ja/s/article/jdsp000000R0000000030211jmb)
- [JAL Payポイント期限FAQ](https://faq-jp.jal.co.jp/ja/s/article/jdsp000000R0000000030245jmb)
- [JMB利用案内](https://www.jal.co.jp/jp/ja/jmb/index08.html)
- [JMB passkey](https://www.jal.co.jp/jp/ja/jmb/jmb-login/passkey/)
- [JMB one-time password](https://www.jal.co.jp/jp/ja/jmb/jmb-login/otp/)
- [JALファミリークラブ](https://www.jal.co.jp/jp/ja/jalmile/jfc/)
- [JALカード家族プログラム](https://www.jal.co.jp/jp/ja/jalcard/function/jfp.html)
- [JMB/JAL Pay Android app](https://play.google.com/store/apps/details?id=com.jalglobalwallet.jgw&hl=ja)
- [JAL予約app](https://play.google.com/store/apps/details?id=jp.co.jal.dom&hl=ja)

## 3. 公式経路とデータ範囲

| 経路                              | read範囲                                              | 粒度/state                                         | 期間/件数/export                                  | tradeoff                                    |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| JMB app / JAL Pay card面          | charge残高、JAL Payポイント、利用明細、積算マイル     | wallet event。決済/charge/返金/pointを区別する必要 | 公式固定期間・件数は公開確認できず。CSV/PDF未確認 | JAL Payのprimary route、device-bound        |
| JAL Pay「利用明細」               | payment/charge等のdetail                              | JMB app card面から表示。pending/settled名称未確認  | app内。pagination/filter/export未確認             | 正本だがwrite導線隣接                       |
| JMB Web                           | マイルtotal、積算/利用実績、期限別マイル、Life Status | lot/event単位                                      | filter/row上限/CSV/PDFはlive未確認                | browser bootstrap/replay候補                |
| JMB app                           | マイルtotal/期限、会員証、JAL Pay                     | mobile summary/detail                              | export未確認                                      | walletとmileageを同一appで表示、ledgerは別  |
| Family Club / Card Family Program | 特典時に利用可能なfamily pool                         | 個人口座の所有・期限を維持する関係                 | family全履歴exportではない                        | 国内居住/海外居住・card条件を混同しない     |
| Global WALLET member Web          | legacy/関連wallet管理画面                             | JAL Payとの現行範囲は未確認                        | login pageあり                                    | primaryにせず境界をlive確認                 |
| JAL予約app/Web                    | 予約・搭乗・航空券                                    | booking ledger                                     | 別source                                          | マイル積算根拠にはなるがJMB明細正本ではない |
| JALカードmember site              | card未確定/確定明細・請求                             | issuer ledger                                      | 発行会社source                                    | JAL Pay/JMBへ混ぜない                       |

### JAL Pay

公式FAQはJMB app topのJAL Pay card面にある「利用明細」から履歴を確認すると案内する。公開情報では
履歴保持期間、最大件数、pagination、CSV/PDF/printを確認できないため、現行appでschemaとして検証する。

JAL Payには通常のチャージ残高と、マイル交換/campaign等で追加されるJAL Payポイントがあり、期限が異なる。
charge残高は最後に増減した日から5年。マイルcharge由来pointは起算月を含め13か月後月末、campaign等は
付与条件ごとの期限となる。totalだけでなくbucket、増減日、expiry、sourceを分ける。

決済authorization、売上確定、取消、返金、charge成功/失敗の公式state名・timestampは未確認。利用明細と
残高差だけでpending/settledを推測しない。JAL Payから外部wallet等へのchargeは支払/送金相当のwriteであり、
検証のために実行しない。

### JMB / family

JMB通常マイルは搭乗/利用日の36か月後月末が原則だが、JMB elite/elite plus期間中の積算は60か月等の
例外がある。会員属性から一律期限を算出せず、Web/appが示すlot別expiryを正本とする。積算日、利用日、
service/type、増減、残高、expiry、statusを必要schemaとする。

JALファミリークラブとJALカード家族プログラムは対象者・居住/カード条件が異なる。いずれも家族の搭乗分を
一人の個人口座へ恒久移転するものではなく、対象特典の利用時に個人口座を合算する制度。各memberの履歴・
期限・所有を維持し、pool membershipとredemption配分を別relationshipにする。

## 4. 認証、MFA、passkey、Bitwarden

JMBはpassword loginに加え、公式にpasskeyとone-time passwordを提供する。OTP通知先はemail/SMS設定が
関係し、JAL Pay初期設定にもSMS認証がある。exact RP ID、WebAuthn extensions、allowed credential、OTP
trigger、trusted device、app biometric/PIN、session/token寿命はlive未確認。

BitwardenはWebAuthn passkeyを保持し得るが、当該JMB credentialがBitwardenに存在すること、JALのlive RP IDと
一致すること、app/device loginへ利用できることは未確認。vault/password/passkey private key/OTP/device IDを
cloudへ置かない。本人browser/deviceでbootstrapし、source-scoped read sessionだけを暗号化してreplayする。
passkey/OTP/recovery/account lockが出たら自動処理を停止する。認証設定や新passkey登録はしない。

## 5. WAF / JS / APK / deobfuscation

2026-08-26のWSL観測で`www.jal.co.jp`のJAL Pay/passkey公開pageはHTTP 403、`Server: AkamaiGHost`。
JAL FAQはSalesforce Experience/Lightningの公開appで、Global WALLET member WebはF5 BIG-IP cookieを設定して
loginへredirectした。これは各公開pathのedge事実であり、JAL Pay app APIのvendor/policyを証明しない。

認証不要JSはJAL public bundleとSalesforce Aura/Lightningまで確認できる。route/config/XHR/fetch/GraphQL、
source mapを静的解析しても、Bot cookie/fingerprint/challengeを模倣・回避しない。FAQのAura actionをprivate
consumer APIと誤認しない。

JMB/JAL Pay Android packageは`com.jalglobalwallet.jgw`、予約appは`jp.co.jal.dom`。所有端末/正規Playから
base/split APKを取得し、署名/version/hash後にaapt2/apkanalyzer、JADX/apktool、native strings/readelfで
manifest、host/path、JSON/protobuf、token storage、WebView、pinning/attestationを調査する。R8難読化は
resources、Retrofit/OkHttp annotation、call graph、runtime metadataで対応し、mappingを捏造しない。

本人が既存残高/履歴を開く1回だけhost/path/method/status/header名とredacted schemaを観測する。payment、
charge、point conversion、award、booking、family/profile endpointは名前だけdeny分類。pinning/attestationで
見えなければ解除・hookせず観測障壁として記録する。

## 6. third-party transport/auth

GitHubでpackage ID、JAL Pay/API、Global WALLET member hostを検索したが、consumer残高/履歴を取得する公開client、
SDK wrapper、session/login実装は確認できなかった。package ID結果はapp inventory等でtransport evidenceに
ならない。これは検索時点のnegative evidenceであり、非存在の証明ではない。

JAL flight/award search、旅行予約、法人/partner API、card明細clientは別data familyで、JMB個人口座やJAL Pay
consumer APIとして転用しない。具体的transport/authは公式APK静的解析と本人操作のredacted observationで
確定する。公開実装がないため、推測host/pathをprobeしない。

## 7. read/write隔離

- allowlistは観測済みbalance、history list/detail、mileage balance/accrual/redemption readだけ。
- JAL Payのpay/charge/withdraw/point conversion、payment source、card/Google Pay登録をdeny。
- JMB award exchange、booking、cancel、family enrollment、profile/passkey/OTP設定をdeny。
- login bootstrap POSTは本人操作の別境界。collectorに汎用POST/任意URL/write scope tokenを持たせない。
- host/path/query/content-type/schemaを固定。unknown redirect/deep link/intentで停止。
- raw response/token/JMB番号/merchant/booking/実額をlog、trace、crash dump、CIへ出さない。
- 401/403/409/429、Akamai challenge、OTP、schema/version drift、device/integrity要求で停止。

## 8. Runtime適性

| runtime               | 適性              | 判断                                                                 |
| --------------------- | ----------------- | -------------------------------------------------------------------- |
| owner browser/device  | 最適              | passkey/OTP/SMS bootstrap、公式表示、redacted observation            |
| Local WSL             | 適                | APK/JS/DOM parser、sanitized artifact処理                            |
| Cloudflare Workers    | 低〜条件付き      | proven GET/token replayなら可能。Akamai/passkey/device bindingが課題 |
| Cloudflare Containers | 条件付き          | full browser/parserを隔離可能。mobile trustはない                    |
| OCI container         | 条件付き          | digest固定、secret store、read-only FS、egress allowlistでreplay試験 |
| Kubernetes            | 過剰              | CronJob/Secret/NetworkPolicyは可能だが単一会員にcost過大             |
| Android実機           | JAL Pay調査に必須 | 正規app/device state。定常UI automationは更新・write UIで脆い        |

## 9. PR #5共通 A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| route                                    |     Level | Cost | 判定                                       |
| ---------------------------------------- | --------: | ---: | ------------------------------------------ |
| JMB Web/appを人手確認・sanitized capture |         E |  1-2 | 安全。公式export/期間は未確認              |
| JAL Pay app manual capture               |         E |    2 | 残高bucket/履歴を読めるがapp外export未確認 |
| JMB browser bootstrap + read replay      |     C候補 |    4 | passkey/OTP/Akamai/session未確認           |
| JAL Pay app bootstrap + API replay       |     C候補 |    5 | transport/token/device binding未確認       |
| full app UI automation                   |         D |    5 | device/SMS/生体、更新、write UI            |
| documented consumer API                  | A該当なし |    5 | 公開公式APIなし                            |

総合は **D/cost 5**、安全な既定は **E/cost 1-2**。read APIとrenewable scoped sessionが実証されれば
JAL PayをCへ、安定性まで確認できればB候補へ更新する。

## 10. read-only live検証 / stop条件

1. 公式domain/package/version/signer、login/passkey/OTP/SMS triggerだけ確認。秘密は本人入力。
2. JAL Payでcharge残高/point bucket/expiry、history type/status、最古日、件数、pagination、detail、exportを確認。
3. 既存取消/返金/失敗があればstatus名のみ記録。新規決済/charge/交換を作らない。
4. JMB Webでtotal、期限lot、積算/利用列、期間filter、pagination、row上限、CSV/PDF controlを確認。
5. Family Club/Card Family Programはmember count、pool表示、個人口座との関係のみ。登録/特典へ進まない。
6. 正規split APKと公開JSを静的解析し、read/write host/path/tokenを別表化。
7. 本人が既存履歴を開く1回だけredacted network metadataを観測。unknown/write候補で停止。
8. replay候補は同一device→local host→OCI各1回。device/integrity bindingならcloud化を中止しmanual routeへ戻す。

stop: 支払/charge/point conversion/award/booking/cancel/family/profile操作、OTP/recovery、PIN/生体、Bot challenge、
pinning/attestation、未知host/path、POST/PUT/PATCH/DELETE（本人login以外）、401/403/409/429、account lock、
PII redaction失敗、schema drift。security controlを無効化しない。

## 11. 事実・推測・未確認

**確認事実:** JMB app内のJAL Pay利用明細、charge残高5年、マイル由来point13か月後月末、通常JMB36か月と
elite等60か月例外、family合算制度、JMB passkey/OTP・JAL Pay SMS、Akamai/Salesforce/F5公開経路、公開client不在。

**推測:** app内部にはbalance/history read transportとpaginationがあるがhost/path/schema/tokenは未確認。
Family poolは各member eventを二重計上せずrelationshipとして表現すべき。

**未確認:** JAL Pay履歴期間/件数/export、pending/settled全state、API/token renewal/device binding/pinning/
attestation、JMB明細期間/件数/official export、Bitwarden credential適合、family redemption配分、Global WALLET
member Webと現行JAL Payの範囲、Web/app schema一致。
