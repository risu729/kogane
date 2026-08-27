# ANA Pay / ANA Mileage Club source assessment

調査日: 2026-08-26

## 1. Scopeと禁止事項

同じANA Mileage Club（AMC）会員関係でも、次のledgerを分離して扱う。

- **ANA Pay**: prepaid残高、チャージ、Visa/iD等の決済、取消・返金、利用履歴
- **AMC**: マイル口座グループ別残高、積算・利用明細、個別有効期限、プレミアムポイント等
- **ANAカードファミリーマイル**: 家族の個人口座を特典交換時に合算する制度境界
- **予約/航空券/ANA SKY コイン/ANAカード請求**: それぞれ別source。残高・明細と混同しない

支払、チャージ、マイルからANA Payへの交換、特典交換、予約、取消、家族登録、profile/認証設定変更は
行わない。AMC番号、wallet/device ID、氏名、予約、token、cookie、OTP、passkey material、実残高・実額を
保存せず、security controlを回避しない。

## 2. 調査方法と公式URL

- ANA/ANA Xの公式ページ・FAQ、Google Playを優先。
- 認証不要のWebページ/header/JS入口をWSLから観測し、accountへloginしていない。
- GitHubの公開実装をpackage ID、ANA Pay host、AMC明細URLで検索し、transport/schemaをコード確認。
- APK取得/decompile、本人データのruntime captureは未実施。次実験を具体化した。

主要一次source:

- [ANA Pay](https://www.ana.co.jp/ja/jp/amc/ana-pay/)
- [ANA Payチャージ](https://www.ana.co.jp/ja/jp/amc/ana-pay/usage/charge/)
- [ANA Pay利用履歴FAQ](https://faq.ana-x.co.jp/faq/anapay/web/knowledge731.html)
- [ANA Pay残高期限FAQ](https://faq.ana-x.co.jp/faq/anapay/web/knowledge729.html)
- [マイル確認方法](https://www.ana.co.jp/ja/jp/amc/check/)
- [マイル有効期限](https://www.ana.co.jp/ja/jp/amc/valid/)
- [AMC 2段階認証](https://www.ana.co.jp/ja/my/amc/about-amc-two-steps-verification/)
- [ワンタイムパスワード](https://www.ana.co.jp/ja/jp/amc/news/info/2022/amc_login_detail.html)
- [ANAカードファミリーマイル](https://www.ana.co.jp/ja/jp/amc/anacard/familymile/)
- [ANA Mileage Club Android app](https://play.google.com/store/apps/details?id=jp.co.ana.anamile&hl=ja)
- [ANA travel app](https://play.google.com/store/apps/details?id=jp.co.ana.android.tabidachi)

## 3. 公式経路、粒度、期間、export

| 経路 | read範囲 | 粒度/state | 期間/件数/export | tradeoff |
| --- | --- | --- | --- | --- |
| ANA Mileage Club app / ANA Pay home | ANA Pay残高、利用履歴、チャージ、決済 | wallet event。取消・返金/cashbackを含む | 原則12か月。iOS最大999件、Android全履歴表示。app外確認・印刷不可 | 公式正本だがdevice-bound |
| ANA Pay internal read API候補 | 残高、登録source状態、履歴 | JSON event、pageNumber/pageSize | 公開実装はpaginationを実装。公式APIではない | headless候補だがdevice ID/token境界が重い |
| AMC Web | グループ別マイル残高、積算/利用実績、有効期限、PP、SKY コイン | accrual/redemption単位。用途・期間限定groupを分離 | live UIの選択期間/件数上限は未確認。公式CSV/PDF未確認 | browser bootstrap後のDOM/export候補 |
| AMC app | マイル/期限/PP、ANA Pay入口、デジタル会員証 | mobile summary/detail | export未確認 | account統合表示は便利、UI automationは高コスト |
| 公式通知/email | 積算/期限等の通知 | event通知、ledgerではない | 網羅性なし | 補助証拠のみ |
| ANAカードファミリーマイル | 特典利用時の家族合算可能額 | 個人口座の所有権/期限を維持したpool | family全履歴exportではない | 家族明細をprime会員個人口座に混ぜない |

### ANA Pay

公式FAQは、homeの「利用履歴」でチャージと決済を確認でき、原則利用から12か月、iOSは999件まで、
Androidは全利用履歴を表示可能とする。タイミングにより12か月より前が見える場合があるがretention保証と
みなさない。印刷もapp外確認も不可。月間チャージ額には購入取消の返金やcampaign cashbackも含まれるため、
「チャージ」表示を外部資金流入だけと解釈しない。

ANA Pay残高の有効期限は、最後に残高を使用またはチャージした翌月から48か月。AMCマイルをANA Payへ
移すと別wallet残高・別期限になるため、交換前AMC event、交換後ANA Pay charge、支払を別eventとして扱う。
pending/settledの公式field名は未確認。authorization、売上確定、取消、返金、cashbackを残高差だけで推測しない。

### AMCマイル

AMCマイルは口座グループ1〜4で利用可能特典と期限が異なる。通常マイルは積算月から36か月後の月末まで
という公式原則があるが、用途・期間限定や例外は各group/lotのexpiryを正本とする。totalだけでなく、
積算日、利用日、明細type、増減、利用後残高、失効予定月/groupを必要schemaとする。

ファミリーマイルは家族のマイル所有権を恒久移転する共通walletではなく、登録家族の個人口座を対象特典の
申込時に合算する制度。各人の積算・期限・利用明細は各AMC sourceに残る。prime会員の残高に家族全員分を
加算保存せず、pool membershipと特典時の利用配分を別relationshipとして扱う。

## 4. 認証、MFA、passkey、Bitwarden

AMC WebはAMC番号等とWeb passwordを基本にし、一部serviceでは登録emailへone-time passwordを送る
2段階認証を公式案内している。OTPの対象画面、trusted-device/session寿命、ANA Pay appへのsession handoff、
refresh policyはlive未確認。公式sourceでpasskey対応を確認できなかったため、対応/非対応を断定しない。

BitwardenはWeb passwordを保存できるが、email OTP、app biometric/device ID、ANA Pay wallet IDを代替しない。
当該accountにBitwarden item/passkeyが存在する事実も確認していない。vault、email session、OTP、device ID、
refresh tokenをcloudへ置かない。本人browser/appでbootstrapし、read-only reusable sessionが確認できた場合のみ
暗号化したsource-scoped envelopeを使う。OTP、本人確認、account lock、password変更要求で停止する。

## 5. WAF / JS / APK / deobfuscation

公開 `www.ana.co.jp` はWSLから200となり、`_abck`/`bm_sz` cookieを設定したためAkamai Bot Managerがedgeに
いる証拠となる。旧AMC gateway `cam.ana.co.jp`は`Server: AkamaiNetStorage`。これは公開Web経路の事実で、
ANA Pay APIが同じWAF/policyとは限らない。FAQはGETとHEADで応答が異なり、client/method差を観測した。

公開Web JSはnav、login gateway、analyticsを含む大規模bundleで、認証前静的解析だけではmember read APIを
確定していない。source map、route/config、XHR/fetch、GraphQL/REST keyをread-onlyで調べる。challenge token、
Bot Manager cookie生成、fingerprintを模倣・迂回しない。

主Android packageはANA Mileage Club/ANA Payの`jp.co.ana.anamile`。旅行予約app
`jp.co.ana.android.tabidachi`は予約/搭乗中心の別packageで、ANA Pay/AMC sourceと混ぜない。所有端末または
正規Play flowからsplit APKを取得し署名/version/hashを確認後、aapt2/apkanalyzer、JADX/apktool、native
strings/readelfでmanifest、host/path、JSON/protobuf、token store、WebView、pinning/attestationを調べる。
R8難読化はresource、Retrofit/Alamofire相当schema、call graph、runtime metadataを照合し、mappingを捏造しない。

本人が既存残高/履歴を開く1回のdynamic observationではhost/path/method/status/header名とredacted keyだけ
記録する。支払/チャージ/交換/予約endpointは名前だけdeny分類しpayloadを作らない。pinning/attestationで
観測不能なら解除・hookせず、その障壁を結果にする。

## 6. 公開third-party clientのtransport/auth

### ANA Pay: `dvcrn/pocketsmith-anapay` / `moneymoney-anapay-extension`

- [pocketsmith-anapay](https://github.com/dvcrn/pocketsmith-anapay)
- [moneymoney-anapay-extension](https://github.com/dvcrn/moneymoney-anapay-extension)

両実装は `https://teikei1.api.mkpst.com` を使う。`POST /ana/accounts/login`へ`anaWalletId`と`deviceId`を
JSON送信し、access/refresh token、scope、expiry等を受ける。以後Bearer tokenで
`GET /accounts?balanceReferenceFlag=1&nfcStatusReferenceFlag=1`から残高・登録source/NFC/eKYC状態、
`GET /salesDetails?pageSize=N&pageNumber=N&historyType=&settlementType=`からpaged履歴を取得する。
履歴schemaはsaleDatetime、settlementType、dealType、descriptionType、shopName、amount、wallet settlement
番号/sub番号、point conversion amount等。

これは具体的transport prior artだが公式documented APIではない。公開Go実装はaccount responseを標準出力へ
出し得てPII/秘密漏えいとなり、明確なlicenseも確認できないためcodeを採用しない。login自体は認証POSTだが、
wallet/device IDをpassword同等に保護し、書込scopeのtokenをそのままcollectorに渡さない。refresh tokenの実際の
更新endpoint/rotation、device binding、現行app互換、pinningは未確認。

### AMC: `tuckn/userscript-ana-mile-csv-export`

[repository](https://github.com/tuckn/userscript-ana-mile-csv-export) はログイン済み
`cam.ana.co.jp/psz/amcj/jsp/renew/mile/reference.jsp`上で`#meisaitable`等のDOMを読み、表示中明細をBOM付き
CSVとしてlocal downloadする。network login/APIを実装せずambient browser sessionに依存する。2026年にも
更新され、現行DOM evidenceとして有用だがlicenseを確認できずcodeは取り込まない。表示期間を変えるwrite相当
form送信や全期間paginationは別途live確認する。

航空便検索/予約、partner/法人APIは個人AMCマイル・ANA Pay consumer ledger APIとして転用しない。

## 7. read/write隔離

- ANA Pay allowlist候補はBearer付き`GET /accounts`と`GET /salesDetails`のみ。login bootstrapは本人端末の別境界。
- hostを`teikei1.api.mkpst.com`に固定し、path/query schema、response content-typeを検証。任意URL/汎用POST禁止。
- payment source登録、charge、pay、refund要求、mile conversion、NFC登録、eKYC、profile/device操作をdeny。
- AMCは残高/実績照会GETまたは観測済みreadだけ。特典交換、予約、家族登録、移行、password変更をdeny。
- raw response、wallet/device ID、token、AMC番号、店名、予約、実額をlog/trace/crash dumpへ出さない。
- 401/403/409/429、OTP、Bot challenge、schema/version/host差、write scopeだけのtokenで停止。

## 8. Runtime適性

| runtime | 適性 | 判断 |
| --- | --- | --- |
| local browser / owner device | 最適 | OTP/device bootstrap、公式表示、redacted observation |
| Local WSL | 適 | APK/JS/DOM parser、暗号化artifact処理 |
| Cloudflare Workers | 条件付き | proven ANA Pay GET/AMC replayなら可能。bootstrap、Akamai、device ID/token運用が課題 |
| Cloudflare Containers | 適 | browser/parserを隔離できるがdevice trustはない |
| OCI container | 適 | digest固定、secret store、read-only FS、egress allowlistでreplay実験向き |
| Kubernetes | 過剰 | CronJob/Secret/NetworkPolicyは可能だが単一accountにはcost大 |
| Android実機 | ANA Pay調査に必須 | 正規app/device state。定常UI automationは更新・生体・write UIで脆い |

## 9. PR #5共通 A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| route | Level | Cost | 判定 |
| --- | ---: | ---: | --- |
| AMC表示明細をuserscript/manual CSV化 | E | 1-2 | 安全な初期経路。表示期間/retention未確認 |
| ANA Pay app履歴manual capture | E | 2 | 12か月・platform件数制限。公式exportなし |
| ANA Pay local bootstrap + GET replay | C候補 | 4 | endpoint/schema具体的。token renewal/device binding未確認 |
| AMC browser bootstrap + DOM/read replay | C | 3-4 | 現行DOM実装あり。OTP/Akamai/session寿命が課題 |
| ANA Pay/AMC app UI automation | D | 5 | device、生体、頻繁な更新、write隣接 |
| documented consumer API | A該当なし | 5 | 公開公式API/exportなし |

総合は **C候補/cost 4**。安全な初期経路はAMCがE/cost 1-2、ANA PayがE/cost 2。ANA Pay read APIの
renewalとscope/device bindingを実証できればB候補へ再評価する。

## 10. read-only live検証 / stop条件

1. 公式domain/package/version/signer、login方式、2FA triggerだけ確認。password/OTPは本人入力し記録しない。
2. ANA Payで残高field、expiry、履歴type/status、12か月境界、件数、detail、取消/返金/cashback表示をschemaだけ記録。
3. iOS/Android差は所有端末だけで確認し、新規transactionを作らない。app外export不可を現行versionで再確認。
4. AMC Webでgroup別残高、lot expiry、積算/利用列、期間filter、pagination、row上限、CSV/PDF controlを確認。
5. Family Milesはmember count、pool表示、個人残高との関係だけ確認し、登録/特典交換画面へ進まない。
6. 正規split APK/公開JSを静的解析し、read/write endpointとtoken lifecycleを別表にする。
7. 本人が既存履歴を開く1回だけredacted metadata観測。ANA Payの2 GET候補以外は送信せず停止。
8. 同一端末session→同一local host→OCIの順で各1回read replay。renewal endpointはschema確認後も自動実行せず、
   まずtoken失効を停止条件として寿命を測る。

即時stop: 支払/チャージ/交換/特典/予約/取消/家族・設定操作、OTP/recovery、PIN/生体、Bot challenge、
pinning/attestation、未知host/path、POST/PUT/PATCH/DELETE（本人loginを除く）、401/403/409/429、account lock、
PII redaction失敗、response schema drift。controlを迂回せずmanual routeへ戻す。

## 11. 事実・推測・未確認

**確認事実:** ANA Payは12か月、iOS999件/Android全件、app外確認/印刷不可、残高期限48か月。AMCは
group別残高/期限と2段階認証。Family Milesは特典時の家族合算。Akamai Web edge。公開実装のANA Pay
Bearer JSON GET/paginationとAMC DOM→CSV transport。

**推測:** ANA Payの2 GETはread collectorに適合し得るが、公開実装だけで安定性・正規scope・現行互換を
保証できない。AMC family poolは各個人口座eventの二重計上を避けるrelationshipとして表現すべき。

**未確認:** ANA Pay pending/settled全state、API現行version、refresh rotation、device/integrity/pinning、
AMC明細期間・件数・公式export、session寿命、passkey/Bitwarden適合、family利用配分、Web/app schema一致。
