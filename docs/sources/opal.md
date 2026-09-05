# Opal / Transport for NSW source assessment

調査日: 2026-08-26

## 1. Scopeとledger境界

本sourceはTransport for NSWの次の2 ledgerを分離して扱う。

- **Opal card/account**: cardごとのstored-value残高、pending balance、tap/trip、top-up、reversal、adjustment、
  balance transfer等のactivity
- **contactless payment activity / Transport Connect**: bank cardまたはApple Pay/Google Pay等のdevice tokenで乗車した
  trip、運賃、benefit/discount、日次のbank card請求

Opal cardを複数枚登録したaccountではcardを列挙できるが、残高とactivityはcard単位である。contactless cardには
Opal stored-value残高がなく、Opal card number/security codeを使う未登録card参照とも別経路である。同じbank cardでも
physical cardとdigital walletは異なるtokenとして扱われ得るため、PAN末尾や時刻だけで自動統合しない。

top-up/auto top-up、card linking/register/activate、block、balance transfer、fare adjustment/refund、nickname/payment/profile/
security設定変更を行わない。card/account/payment/device ID、PAN、security code、CVV、氏名、旅程、場所、token、cookie、
秘密の質問/回答、実残高・実額を保存せず、security controlを回避しない。

## 2. 調査方法と公式URL

- Transport for NSWの公式guide、terms/privacy、official app listingを一次sourceとして確認。
- 認証不要のlogin HTML、公開Angular bundle、response headerをread-onlyで静的観測。
- GitHubを現行host/path、official package ID、legacy Opal clientで検索し、公開third-party実装を照合。
- account login、本人card/app、実データ取得、APK取得・decompile、認証後network observationは未実施。

主要公式URL:

- [Opal card balance and activity](https://transportnsw.info/tickets-fares/opal/manage-your-card/opal-card-balance-activity)
- [Register your Opal card](https://transportnsw.info/tickets-fares/opal/manage-your-card/register-your-opal-card)
- [Manage your Opal card](https://transportnsw.info/tickets-fares/opal/manage-your-card)
- [Opal login](https://transportnsw.info/tickets-fares/opal-login)
- [Top up your Opal card](https://transportnsw.info/tickets-fares/opal/top-up-your-opal-card)
- [Transfer balance and block a card](https://transportnsw.info/tickets-fares/opal/manage-your-card/transfer-balance-block-card)
- [Opal refunds and fare adjustments](https://transportnsw.info/tickets-fares/opal/manage-your-card/opal-refunds-fare-adjustments)
- [Opal terms of use](https://transportnsw.info/tickets-fares/opal/opal-terms-of-use)
- [Opal refund and balance transfer policy](https://transportnsw.info/document/2081/opal-refund-balance-transfer-policy.pdf)
- [Opal Travel app](https://transportnsw.info/plan/transport-apps/opal-travel-app)
- [Opal Travel app terms](https://transportnsw.info/ota-terms)
- [Opal Travel app help centre](https://transportnsw.info/plan-0/instructions-planning-guides/opal-travel-app-help-centre)
- [Official Android app](https://play.google.com/store/apps/details?id=au.com.opal.travel)
- [Protect your personal information](https://transportnsw.info/tickets-fares/opal/protect-your-personal-information)
- [Contactless payments](https://transportnsw.info/tickets-fares/contactless-payments)
- [Contactless payment activity](https://transportnsw.info/tickets-fares/contactless-payments/contactless-payment-activity)
- [Help checking contactless activity](https://transportnsw.info/tickets-fares/contactless-payments/help-checking-your-contactless-activity)
- [Contactless reimbursements](https://transportnsw.info/tickets-opal/opal/contactless-payments/contactless-reimbursements)
- [Opal Privacy Policy](https://transportnsw.info/document/2107/Opal%20Privacy%20Policy_0.pdf)

## 3. 公式経路、列挙範囲、粒度、期間、export

| 経路                         | read範囲                                                                 | 粒度/state                                  | 期間/件数/export                                                     | tradeoff                                                               |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| registered Opal Web          | account内の複数card、card state/nickname、balance/pending、activity      | card単位のtrip/top-up/reversal/adjustment等 | cardごと最大18か月。公式はdownload可能とするが公開pageから形式未確認 | 最も広いofficial Web。write UIが隣接                                   |
| unregistered Opal Web        | 1 cardのbalance/activity                                                 | trip/top-up/reversalの直近event             | 直近10件                                                             | account不要だが16桁card numberと4桁security codeが必要。自動化に不向き |
| Opal Travel app              | linked cards、balance/activity、top-up/auto top-up、contactless activity | card/contactless別のsummary/detail          | 期間・件数・download形式はpublic listingから未確認                   | official mobile front door。write controlが隣接                        |
| Transport Connect            | 登録したphysical/digital payment cardのtrip、運賃、benefit/discount      | contactless trip + payment情報              | 最大18か月、download可能。公開pageからCSV/PDF等の形式未確認          | Opal stored-valueとは別account/ledger                                  |
| unregistered contactless Web | payment cardの最近のtrip                                                 | mode、tap on/off日時、fare                  | 原則直近10件。privacy policyは直近精算日分または10件の多い方と記載   | PAN/expiry/CVVと毎回の$1事前承認がありlive検証対象外                   |
| bank statement               | contactlessのsettled請求                                                 | 4:00から翌3:59までの日次集約                | issuerの保持/exportに依存                                            | 個別tripではなく日次請求。Opal activityの代用にならない                |

### Opal card/account

公式はregistered cardでcardごと最大18か月のtravel/payment historyをview/downloadできるとする。unregistered cardは
直近10 activity（trip、top-up、reversal）だけである。activityにはtrip、top-up、adjustmentが含まれ、balance/activityの
online反映に最大48時間かかることがある。この遅延中を必ずしも失敗やsettled前と解釈しない。

公開Web bundleが示すcard modelには`SmartcardId`、`CardNickName`、`CardTypeDescription`、`CardState`、
`SVBalance`、`SVPending`、`PendingBalanceActivation`、`LastSeenDateTime`、`CardExpiryDate`、auto top-up情報等がある。
account responseの`SmartcardDetails`がcard列挙、detail routeが1 cardの状態を返す。収集時はcard ID/nicknameをraw保存せず、
source内のopaque keyへ変換する。auto top-up設定は表示対象に含み得るが変更しない。

activity itemの公開modelにはamount、start/end日時、transaction type、journey type/mode、origin/destination、activity ID、
full fare/discount、fare cap/off-peak/reward関連flag等がある。Web UIはtrip、top-up、incomplete journeyをfilterする。
確認できたtransaction typeはtrip、manual/auto top-up、reversal、adjustment、balance transfer、OpalPay、card block/
cancel/expiry等である。これは現行bundle内の表示分類であり、全backend enumの仕様保証ではない。

forgotten tapではdefault fareとなりorigin/destinationがunknownになる。`incomplete`を通常tripに補完せず、unknown locationを
欠損のまま保持する。top-upはonline操作後15〜60分程度で準備され、60日以内のtapでcardへ反映する。online残高、
pending balance、card上の実残高、payment authorizationを同一stateに潰さない。reversal、adjustment、refund、balance transferは
元eventを上書きせず別eventとして扱う。

現行Web UIはregistered cardで選択月または直近7日を`nr=500`で要求し、unregistered cardでは広い日付範囲を指定しても
`nr=10`に制限する。500は1 requestのUI上限の観測で、18か月全体の件数上限ではない。responseの`HasMoreResults`と
offset paginationを使う設計だが、live accountで500件超のpagingは未検証。公式downloadのCSV/PDF/print形式、列、件数上限も
未確認で、help centreにdownload案内があることだけからCSVと断定しない。

### Contactless journeyとの境界

Transport Connectは最大18か月のtrip detail（日付、時刻、場所、benefit/discount）とpayment情報を表示/downloadする。
未登録contactless参照は直近10 tripが基本である。未登録formはPAN、expiry、CVVを要求し、accessごとに$1のpending
authorizationが生じ得るためread-only live検証には使わない。

contactless運賃は1日（4:00〜翌3:59）のjourneyをまとめてbank statementへ請求する。trip eventとbankのsettled daily chargeは
1対1でない。fare reimbursementはtrip後に別stateとなり、承認済みcreditが次回fareへ使われる場合や、bank側への返金が
後日行われる場合があり、contactless activityに表示されないこともある。payment card/device token、Opal card、bank statementの
3 ledgerをamount/timeだけで結合しない。

## 4. 認証、MFA、passkey、Bitwarden

2026-08-26に公開loginと現行bundleを確認した事実:

- registered loginはusername/passwordを`POST /api/opal/login`へ送り、成功responseは`access_token`と`expires_in`を含む。
- unregistered card loginはcard number/security codeを`POST /api/opal/opal-login`へ送る。
- frontendはOpal APIへ`Authorization: Bearer ...`を付与し、account/tokenを`sessionStorage`の`opal-account`、expiryを
  `opal-session`へ保持する。logoutは`DELETE /api/opal/logout`である。
- public login bundleは401、account lock相当の423、reCAPTCHA failure等の403を区別する。
- password recoveryはcard/security code、username、secret question/answer、新passwordを扱うwrite/recovery flowである。
- current public bundleで`passkey`、`webauthn`、`PublicKeyCredential`を確認できず、公式公開pageからMFA、passkey、
  trusted-device/device bindingの仕様を確認できなかった。

最後の点は「MFA/passkeyが存在しない」という証明ではない。認証後のrisk challenge、app biometric、device registration、
token refresh/revocation/session寿命は未確認である。login、OTP、recovery、lock、reCAPTCHAが出たら本人browserへ戻し、collectorが
再試行しない。

[Bitwarden公式](https://bitwarden.com/help/auto-fill-browser/)のbrowser autofillはusername/password入力の本人操作を補助できる。
ただし当該credentialの存在や実適合は未確認で、Opal card/security code、secret answer、bearer tokenをvaultからcollectorへ
exportする根拠にはならない。WebAuthnの公式対応が確認されるまでBitwarden passkeyとの関係は「非該当/未確認」とする。

## 5. WAF / CDN / anti-bot / public JS

2026-08-26のanonymous read-only観測では、`transportnsw.info/tickets-fares/opal-login`はHTTP 200、`Server: Apache`、
CloudFrontの`Via`/`X-Cache` headerを返し、frontend bundleは`/opal-view/runtime.js`、`polyfills.js`、`vendor.js`、
`main.js`から配信された。一方、legacy `https://www.opal.com.au/`はHTTP 403、`/_Incapsula_Resource`への参照と
`visid_incap_*`/`incap_ses_*` cookie名を返し、Imperva Incapsulaを確認した。cookie値は記録していない。

これはpublic edgeの観測であり、認証後API、app API、Bot policy全体の保証ではない。public bundleはlogin/payment flowの
reCAPTCHA利用を示す。CloudFront/Imperva/reCAPTCHAのcookie、fingerprint、challengeを模倣・迂回せず、403/423/429、challenge、
unexpected redirectで停止する。Akamaiの具体的証拠は今回確認できず、WAFをAkamaiと推定しない。

公開JSの静的解析はreverse engineering対象である。minified symbolを整形し、route literal、HTTP method、serializer field、
pagination、token storeをcall siteと照合する。ただしsource mapの非公開、難読化、WAFを解析失敗として正確に記録し、
推測endpointを反復probeしない。

## 6. 確認できたWeb transportとread/write隔離

現行public bundleと公開third-party clientを照合して確認したread route:

| method/path                                                                                                       | 目的                         | 確認済みresponse概略                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------- |
| `GET /api/opal/api/customer/smartcards/`                                                                          | account内card列挙            | `SmartcardDetails`                            |
| `GET /api/opal/api/smartcard/details/{cardId}`                                                                    | 1 cardのbalance/state/detail | `SVBalance`、`SVPending`等                    |
| `GET /api/opal/api/smartcard/activity/{cardId}?start={offset}&nr={count}&from=YYYY-MM-DD&to=YYYY-MM-DD&sort=desc` | card activity                | `HasMoreResults`、`SmartcardActivityDetail[]` |

これらはundocumented consumer Web APIで、互換性、利用条件、rate limit、token refreshを公式が保証したものではない。
login POSTは本人bootstrap境界であり、collectorのread allowlistへ汎用POST能力を渡さない。

同じbundleで確認したため明示的にdenyするwrite/control route:

- smartcard top-up、register、activate、hotlist/block、balance transfer、nickname変更
- auto top-up、payment token/BPOINT、profile/security/password/recovery関連
- fare adjustment/refund申請、card linking、その他未知のPOST/PUT/PATCH/DELETE

top-upのavailable amount取得等はGETでもwrite UIに密接なため、最小collectorでは除外する。host、method、path pattern、query、
content type、response schemaを固定し、redirectを許可しない。raw response、card/account/activity ID、location、旅程、実額、tokenを
log/trace/crash dump/CI artifactへ出さない。schema driftや未知fieldは保存せず停止する。

## 7. APK / deobfuscation / read-only runtime observation

official Android packageは`au.com.opal.travel`。APKは未取得で、version/signer、app API host、token store、pinning、device/integrity
metadataは公開listingから推測しない。次段階では本人所有端末の正規Google Play installからbase/splitを取得する。
公式app termsは、適用法で制限が無効となる範囲を除き、decompile/reverse engineering等を制限する。したがって実行前に
適用されるterms、法的例外、本人所有copyへの権限を確認し、許容されるinteroperability/read-only調査だけに限定する。

1. `adb shell pm path au.com.opal.travel`と`adb pull`でbase/splitを取得し、package/version/hash/signerを記録。
2. `apksigner`、`aapt2`/`apkanalyzer`でmanifest、SDK、exported component、deep link、network security configを確認。
3. JADX/apktool、resource/DEX strings、Retrofit/OkHttp annotation、JSON/protobuf model、WebView bridge、native libraryの
   `strings`/`readelf`でread/write host/path、method、pagination、token renewal/store、device/integrity metadataを分類。
4. R8等の難読化はresource ID、call graph、serializer field、runtime stackで追い、symbol復元の確度を記録する。
5. 本人が既存card/activityまたはcontactless activityを開く1回だけ、標準診断または明示proxyでhost/path/method/status/
   header名とredacted key/typeを観測。top-up/auto top-up/card management/refund controlには触れない。
6. certificate pinning、root/jailbreak、Play Integrity、device attestation等で観測不能なら解除/hook/bypassせず障壁として記録。

reverse engineering自体は本sourceの調査対象である。security-control bypassを目的にせず、read routeをwrite routeから機械的に
隔離できる場合だけcollector候補へ進める。

## 8. third-party transport/auth

具体的な現行系実装として[wallarug/opal-exporter](https://github.com/wallarug/opal-exporter/blob/a9a1797a7f9abf5aa005c3001fbd120ba03983fa/py/export.py)
を確認した。browserで得たbearer tokenを手動設定し、`transportnsw.info/api/opal/api/customer/smartcards/`と
card activity endpointをHTTPS GET、月ごとに`nr=500`で取得してCSVへ書く。現行routeとpaginationの独立証拠になるが、token
renewal/login実装はなく、CSVへcard number/status/nickname等を出すため、そのまま採用しない。
repository metadata上のlicenseは`NOASSERTION`で、2024-04-20が最終pushである。transport evidenceとして読むだけに留め、
license fileと利用許諾を確認できないcodeを取り込まない。

[cyclotron3k/opal_card_api](https://github.com/cyclotron3k/opal_card_api)、
[dsymonds/opal](https://github.com/dsymonds/opal)、[tbasse/opaler](https://github.com/tbasse/opaler)はlegacy
`www.opal.com.au`へusername/passwordをform POSTし、cookie jarで`/registered/...` HTML/JSON routeを読む。
現在のofficial frontendはbearer APIで、legacy hostはanonymous accessでImperva 403となるため、stale evidenceとしてのみ扱う。
password/cookieを直接保持し、Transport for NSWがapproved site/app以外へpersonal informationを渡さないよう警告している点からも
deployment候補にしない。

repository metadataでは`opal_card_api`はMIT（最終push 2020-03-09）、`dsymonds/opal`はApache-2.0（2015-10-02）、
`opaler`はMIT（2023-01-06）である。licenseが利用可能でもprotocolの現行性・安全性を保証しない。

official package IDの一般的なapp inventoryやphysical-card readerはonline account transportの証拠にしない。現時点で公式public
consumer API/SDK、OAuth delegation、scoped read token、token renewalを備えた公開clientは確認できなかった。

## 9. Runtime適性

| runtime               | 適性        | 判断                                                                              |
| --------------------- | ----------- | --------------------------------------------------------------------------------- |
| owner browser/device  | 最適        | official UI/download、本人bootstrap、redacted network観測                         |
| Local WSL             | 適          | public JS/APK static analysis、sanitized parser、manual export import             |
| Cloudflare Workers    | 条件付き    | proven bearer GET replayなら軽量だがpassword login、WAF、refresh/reauthには不向き |
| Cloudflare Containers | 条件付き    | browser bootstrap/parser隔離は可能。mobile device trustは提供しない               |
| OCI container         | 条件付き    | digest固定、secret store、read-only FS、egress allowlistでWeb replay試験可能      |
| Kubernetes            | 過剰        | CronJob/Secret/NetworkPolicyは可能だが単一Opal collectorには運用cost過大          |
| Android実機           | app調査に適 | 正規app/device state。定常UI automationはwrite隣接と更新で脆い                    |

Workersへpassword/card security codeを置かない。owner browserで得たsource-scoped、短命、read-only相当sessionが安全にrenewできると
実証された場合だけWeb GET replayを検討する。full browserはContainers/OCI、app-only transportはAndroidを調査用に使い、K8sは
多数sourceを統合運用する段階まで採用しない。

## 10. PR #5共通 A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| route                                                |     Level | Cost | 判定                                                    |
| ---------------------------------------------------- | --------: | ---: | ------------------------------------------------------- |
| registered Opal official download + sanitized import |         E |    1 | 最大18か月。download形式/自動化適性は未確認             |
| unregistered Opal直近10件のmanual capture            |         E |    1 | 少量だがcard number/security codeを扱うためcloud非推奨  |
| Opal Web bearer GET replay                           |     C候補 |    3 | concrete read APIあり。token renewal/安定性/terms未確認 |
| Opal Travel app bootstrap + read replay              |     C候補 |    4 | packageのみ確認。APK/host/token/device metadata未確認   |
| full browser/app UI automation                       |         D |  4-5 | write control隣接、WAF/reCAPTCHA、UI/app更新で脆い      |
| Transport Connect manual download                    |         E |  1-2 | contactless別ledger、最大18か月。format未確認           |
| Transport Connect headless replay                    |     C候補 |    4 | auth/API/token/device-card mapping未確認                |
| documented scheduled consumer API                    | A該当なし |    5 | public official API/OAuth/scoped tokenを確認できず      |

総合は **C候補/cost 3**、安全な既定は **E/cost 1**。現行Web APIはstructured GETが具体化しているが、renewable session、
rate limit、schema stability、利用条件が実証されるまでBへ上げない。contactlessは別collectorとして独立評価する。

## 11. read-only live検証 / stop条件

1. official domain/package/version/signerを確認。credentialは本人入力し、token/card/security codeを保存しない。
2. registered Webでcard列挙、card type/state、balance/pending、activity列/filter、最古月、月跨ぎ、500件超pagination、
   download controlと実format/列を確認。実値をnoteやcaptureへ残さない。
3. 自然に存在するtrip/top-up/reversal/adjustment/incomplete/default-fareだけを読む。検証用eventを作らない。
4. 表示遅延中の既存eventがあれば48時間以内のstate名だけ観測し、新しいtop-up/tapを発生させない。
5. Transport Connectは既存登録済みaccountだけでphysical/digital card列挙、trip/detail、最大期間、download formatを確認。
   未登録formは$1 authorizationを生じ得るため開かない。
6. bank statementとの突合はredacted daily aggregationだけ。PAN/device token/場所/実額を保存しない。
7. 正規split APKとpublic JSを静的解析し、read/write host/path/token/device/integrity metadataを別表化。
8. 本人が既存balance/activityを開く1回だけnetwork metadataを観測。unknown/write候補で停止。
9. replay候補はowner device/local hostで既知GET各1回。401/403/423/429、WAF challenge、schema driftならmanualへ戻す。

stop: top-up/auto top-up、card register/link/activate/block/transfer、fare adjustment/refund、payment/profile/security変更、
password recovery、OTP/MFA/reCAPTCHA/account lock、未登録contactlessの$1 authorization、Bot challenge、pinning/attestation、
unknown host/path/redirect、POST/PUT/PATCH/DELETE（本人login bootstrapを除く）、401/403/409/423/429、PII redaction失敗、
unexpected schema/app version drift。security controlを無効化しない。

## 12. 事実・推測・未確認

**確認事実:** registered cardの最大18か月view/download、unregistered card/ contactlessの直近10件、最大48時間の反映遅延、
複数Opal card列挙、card balance/pending/activity model、Web bearer loginと3 read GET route、activity offset/`nr`/date range、
CloudFrontとlegacy Imperva、contactlessの日次集約・別ledger、official Android package、現行third-party exporterとlegacy clients。

**推測:** current bearer sessionをowner browser bootstrap後に限定GETへ安全にreplayできる可能性がある。appにも同等以上のstructured
read transportがある可能性が高い。Bitwarden autofillはusername/password bootstrapを補助し得る。いずれもlive未実証である。

**未確認:** official downloadのCSV/PDF/その他formatと列/上限、500件超pagination、activity全enumとpending/settledの公式state、
token寿命/refresh/revocation、MFA/passkey/trusted device、app version/signer/API/schema/pinning/integrity、Transport Connect auth/API/
device-token mapping、third-party利用条件とrate limit、Cloudflare/OCIからのreplay適性、stable dedupe key。
